import type { z } from 'zod'
import { slimKindOf } from '../../core/slim-primitive-gate'
import { mergeDeep } from '../../core/merge-deep'
import { deriveDefaultWalk } from '../../core/walk-derive-default'
import { getDiscriminatedUnionFirstOption, unwrapToDiscriminatedUnion } from './discriminator'
import { slimPrimitivesOf } from './slim-primitives'
import {
  getArrayElement,
  getDiscriminatedOptions,
  getDiscriminator,
  getIntersectionLeft,
  getIntersectionRight,
  getLiteralValues,
  getObjectShape,
  getRecordValueType,
  getTupleItems,
  getUnionOptions,
  isCoercePrimitive,
  isPreprocessNode,
  kindOf,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
} from './introspect'
import { V4_INTROSPECTOR } from './walker-introspector'

/**
 * Derive a default value for any Zod v4 schema.
 *
 * Thin wrapper around the shared `deriveDefaultWalk` core walker —
 * v3 and v4 dispatch through the same body via their respective
 * `SchemaIntrospector` instance. See `core/walk-derive-default.ts`
 * for the per-kind dispatch rules, including the
 * `peelEmbeddedDefault` chain-walk that closes the v3↔v4 parity gap
 * on `Optional(Default('x'))` / `Nullable(Default('x'))` / etc.
 *
 * When `useDefault` is false, `.default(x)` wrappers are skipped so
 * the walker produces the underlying leaf's empty value instead —
 * useful when the caller wants a "blank" initial state rather than
 * the schema's declared defaults.
 *
 * `maxRecursionDepth` caps descent through `z.lazy()`: the counter
 * bumps only when the walker crosses a lazy boundary.
 */
export function deriveDefault(
  schema: z.ZodType,
  useDefault: boolean,
  maxRecursionDepth: number
): unknown {
  return deriveDefaultWalk(schema, useDefault, V4_INTROSPECTOR, maxRecursionDepth, {
    // v4 has an exhaustive switch against `SchemaIntrospector.kindOf`;
    // unknown kinds genuinely shouldn't appear, so return undefined.
    unsupportedKindFallback: () => undefined,
    // v4 historically recurses into the inner on `useDefault=false`
    // so a `.catch(v)` slot returns the leaf empty rather than the
    // fallback. Pinned by `test/adapters/zod-v4/unsupported-kinds.test.ts`
    // (`z.catch falls through to inner leaf default when useDefault=false`).
    catchOnUseDefaultFalse: 'recurseInner',
  })
}

export type GetDefaultValuesOptions = {
  // `z.ZodType`, not `z.ZodObject`: the derivation walk is generic over
  // the root kind (object, record, discriminated-union), and the
  // algorithm bottoms out at `deriveDefault` which handles each.
  schema: z.ZodType
  useDefaultSchemaValues: boolean
  constraints: unknown
  maxRecursionDepth: number
}

export type DefaultValuesResult<Form> = {
  data: Form
  success: boolean
}

/**
 * getDefaultValuesFromZodSchema — produces a form's starting value.
 *
 * Walk the schema to derive blank defaults, merge constraints, then
 * run the DU-aware structural fix walk (sign-off 7) over the merged
 * tree: at every node whose value's slim-primitive kind falls outside
 * the schema's accept set, the value is replaced with that node's
 * derived default; matching containers recurse. No schema is rebuilt
 * and no `safeParse` runs, so:
 *
 *  - user refinements and transforms NEVER fire during construction
 *    (a `.refine(fn)` returning a Promise from a sync fn used to be
 *    the crash case the slim rebuild dodged; now nothing calls it),
 *  - constraint keys the schema doesn't declare are preserved
 *    verbatim rather than dropped by Zod's unknown-key stripping —
 *    EXCEPT at discriminated-union values, where keys foreign to the
 *    value's selected variant are removed (the variant-memory and
 *    reshape machinery treat present keys as the active variant's
 *    state, so a first-variant residue from the schema-blind
 *    `mergeDeep` would corrupt them),
 *  - async refines / async transforms need no special casing — the
 *    fix walk works identically for them, and refinement enforcement
 *    stays where it always was (the adapter's strict-mode pass and
 *    the post-mount async pass).
 *
 * `success` reports whether the walk left (or produced) a
 * structurally coherent tree: `false` means some mismatch could not
 * be fixed (an unsupported kind derived `undefined`, say) and the
 * partially-fixed data shipped anyway — better than an exception at
 * mount time.
 */
export function getDefaultValuesFromZodSchema<Form>(
  opts: GetDefaultValuesOptions
): DefaultValuesResult<Form> {
  const { schema, useDefaultSchemaValues, constraints, maxRecursionDepth } = opts
  const initial = deriveDefault(schema, useDefaultSchemaValues, maxRecursionDepth)
  const merged = mergeDeep(initial, constraints) as unknown

  const ctx: FixContext = {
    useDefault: useDefaultSchemaValues,
    maxDepth: maxRecursionDepth,
    clean: true,
  }
  const data = fixNode(schema, merged, ctx, 0)
  return { data: data as Form, success: ctx.clean }
}

type FixContext = {
  useDefault: boolean
  maxDepth: number
  clean: boolean
}

/**
 * The DU-aware structural fix walk. Descends the merged DATA alongside
 * the schema:
 *
 *  1. Schema-side input normalizers (`z.coerce.X()`, `z.preprocess`)
 *     accept raw consumer writes verbatim — their whole subtree passes
 *     through untouched (the no-write-mutation contract).
 *  2. A value whose slim-primitive kind is outside the node's accept
 *     set is replaced wholesale with the node's derived default —
 *     discriminated unions derive the variant the VALUE selects when
 *     its discriminator is usable, first option otherwise.
 *  3. A matching container recurses per child. Object recursion visits
 *     every DECLARED key (a constraint that set a declared key to a
 *     mismatched value — `undefined` included — gets that key's
 *     default filled in); undeclared keys are left alone. DU recursion
 *     first removes keys foreign to the selected variant, then
 *     recurses the variant's shape. Plain unions can't be routed and
 *     pass through, matching the old refinement-level skip.
 *
 * Refinement-level violations (enum membership, `.email()`, `.min(N)`,
 * custom refines) are invisible to the walk by construction — the
 * accept-set check is purely structural, so user starting data is
 * preserved verbatim and the strict-mode pass owns surfacing those.
 */
function fixNode(schema: z.ZodType, value: unknown, ctx: FixContext, lazyDepth: number): unknown {
  if (isCoercePrimitive(schema) || isPreprocessNode(schema)) return value

  const kinds = slimPrimitivesOf(schema, ctx.maxDepth)
  if (kinds.size > 0 && !kinds.has(slimKindOf(value))) {
    const replacement = deriveFixValue(schema, value, ctx)
    if (kinds.has(slimKindOf(replacement))) return replacement
    // The derived replacement is itself outside the accept set (an
    // unsupported kind deriving `undefined`, say): record the miss and
    // ship the replacement anyway.
    ctx.clean = false
    return replacement
  }

  const kind = kindOf(schema)
  switch (kind) {
    case 'optional':
    case 'nullable': {
      // The wrapper admitted `undefined` / `null` via the accept set;
      // only a present value recurses against the inner shape.
      if (value === undefined || value === null) return value
      const inner = unwrapInner(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth)
    }
    case 'default':
    case 'readonly':
    case 'catch': {
      const inner = unwrapInner(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth)
    }
    case 'pipe': {
      // Preprocess-shaped pipes returned above; a `.transform()` pipe
      // stores its source on the IN side — fix structure against it.
      const pipeIn = unwrapPipeIn(schema)
      if (pipeIn === undefined || kindOf(pipeIn) === 'transform') return value
      return fixNode(pipeIn, value, ctx, lazyDepth)
    }
    case 'lazy': {
      if (lazyDepth >= ctx.maxDepth) return value
      const inner = unwrapLazy(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth + 1)
    }
    case 'discriminated-union': {
      if (value === null || typeof value !== 'object') return value
      const variant = selectVariantByValue(schema, value)
      if (variant === undefined) return value
      const record = value as Record<string, unknown>
      const shape = getObjectShape(variant)
      for (const key of Object.keys(record)) {
        if (!(key in shape)) delete record[key]
      }
      for (const [key, sub] of Object.entries(shape)) {
        record[key] = fixNode(sub, record[key], ctx, lazyDepth)
      }
      return value
    }
    case 'object': {
      if (value === null || typeof value !== 'object') return value
      const record = value as Record<string, unknown>
      for (const [key, sub] of Object.entries(getObjectShape(schema as z.ZodObject))) {
        record[key] = fixNode(sub, record[key], ctx, lazyDepth)
      }
      return value
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      const element = getArrayElement(schema as z.ZodArray)
      for (let i = 0; i < value.length; i++) {
        value[i] = fixNode(element, value[i], ctx, lazyDepth)
      }
      return value
    }
    case 'tuple': {
      if (!Array.isArray(value)) return value
      const items = getTupleItems(schema)
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item !== undefined) value[i] = fixNode(item, value[i], ctx, lazyDepth)
      }
      return value
    }
    case 'record': {
      if (value === null || typeof value !== 'object') return value
      const valueType = getRecordValueType(schema)
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        record[key] = fixNode(valueType, record[key], ctx, lazyDepth)
      }
      return value
    }
    case 'intersection': {
      const left = getIntersectionLeft(schema)
      const right = getIntersectionRight(schema)
      let out = value
      if (left !== undefined) out = fixNode(left, out, ctx, lazyDepth)
      if (right !== undefined) out = fixNode(right, out, ctx, lazyDepth)
      return out
    }
    // Leaves and plain unions (no discriminator to route by).
    case 'union':
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'date':
    case 'enum':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'any':
    case 'unknown':
    case 'nan':
    case 'void':
    case 'never':
    case 'set':
    case 'promise':
    case 'custom':
    case 'template-literal':
    case 'transform':
    case 'file':
    case 'map':
    case 'symbol':
    case 'function':
      return value
  }
}

/**
 * Replacement value for a structural mismatch at `schema`.
 * Discriminated unions are VALUE-directed: when the offending value
 * already carries the union's discriminator key and it selects a
 * declared variant, the fix derives THAT variant's default —
 * first-option is only the fallback for values that select nothing.
 */
function deriveFixValue(schema: z.ZodType, value: unknown, ctx: FixContext): unknown {
  const du = unwrapToDiscriminatedUnion(schema)
  if (du !== undefined) {
    const selected = selectVariantByValue(du, value) ?? getDiscriminatedUnionFirstOption(du)
    if (selected !== undefined) {
      return deriveDefault(selected, ctx.useDefault, ctx.maxDepth)
    }
  }
  return deriveDefault(schema, ctx.useDefault, ctx.maxDepth)
}

/**
 * Resolve the DU variant the value itself selects: the option whose
 * discriminator literal includes `value[discriminatorKey]`. Returns
 * `undefined` when the value carries no usable discriminator — the
 * caller falls back to the first option.
 */
function selectVariantByValue(du: z.ZodType, value: unknown): z.ZodObject | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const discKey = getDiscriminator(du)
  if (discKey === undefined) return undefined
  const discValue = (value as Record<string, unknown>)[discKey]
  if (discValue === undefined) return undefined
  for (const opt of getDiscriminatedOptions(du)) {
    const litSchema = getObjectShape(opt)[discKey]
    if (litSchema === undefined || kindOf(litSchema) !== 'literal') continue
    if (getLiteralValues(litSchema).includes(discValue)) return opt
  }
  return undefined
}

/**
 * Exported for callers who want the discriminated-union option set for
 * path resolution (used by the adapter's getSchemasAtPath).
 */
export { getDiscriminatedOptions, getUnionOptions }
