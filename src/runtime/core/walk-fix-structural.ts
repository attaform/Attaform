/**
 * The DU-aware structural fix walk (size-teardown sign-off 7) — the
 * construction-time replacement for the deleted slim-schema rebuild.
 * Descends merged default DATA alongside the schema via the adapter's
 * `SchemaIntrospector`; v3 and v4 dispatch through this one body.
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
 *     first removes keys foreign to the selected variant (the
 *     variant-memory / reshape machinery treats present keys as the
 *     active variant's state, so first-variant residue from the
 *     schema-blind `mergeDeep` would corrupt them), then recurses the
 *     variant's shape. Plain unions can't be routed and pass through.
 *
 * No schema is rebuilt and nothing parses, so user refinements and
 * transforms can never fire during construction, and refinement-level
 * violations are invisible by design — the strict-mode pass owns
 * surfacing those.
 */
import type { SchemaIntrospector } from './abstract-schema-factory'
import { slimKindOf } from './slim-primitive-gate'
import type { SlimPrimitiveKind } from '../types/types-api'

/**
 * The per-adapter delegates the walk composes with the introspector:
 * the slim-primitive accept set, the default-derivation walker, and
 * the transparent-peel to a discriminated union. Each adapter closes
 * its own recursion cap into these.
 */
export type FixStructuralServices<Schema> = {
  intro: SchemaIntrospector<Schema>
  slimPrimitivesOf(schema: Schema): ReadonlySet<SlimPrimitiveKind>
  deriveDefault(schema: Schema, useDefault: boolean): unknown
  unwrapToDiscriminatedUnion(schema: Schema): Schema | undefined
}

export type FixStructuralResult<Form> = {
  data: Form
  /**
   * `false` when some structural mismatch could not be fixed (an
   * unsupported kind deriving `undefined`, say) and the partially-
   * fixed tree shipped anyway — better than a mount-time exception.
   */
  success: boolean
}

export function fixStructuralDefaults<Form, Schema>(
  schema: Schema,
  merged: unknown,
  useDefault: boolean,
  maxRecursionDepth: number,
  services: FixStructuralServices<Schema>
): FixStructuralResult<Form> {
  const ctx: FixContext<Schema> = {
    useDefault,
    maxDepth: maxRecursionDepth,
    clean: true,
    services,
  }
  const data = fixNode(schema, merged, ctx, 0)
  return { data: data as Form, success: ctx.clean }
}

type FixContext<Schema> = {
  useDefault: boolean
  maxDepth: number
  clean: boolean
  services: FixStructuralServices<Schema>
}

function fixNode<Schema>(
  schema: Schema,
  value: unknown,
  ctx: FixContext<Schema>,
  lazyDepth: number
): unknown {
  const { intro } = ctx.services
  if (intro.isCoercePrimitive(schema) || intro.isPreprocessNode(schema)) return value

  const kinds = ctx.services.slimPrimitivesOf(schema)
  if (kinds.size > 0 && !kinds.has(slimKindOf(value))) {
    const replacement = deriveFixValue(schema, value, ctx)
    if (kinds.has(slimKindOf(replacement))) return replacement
    // The derived replacement is itself outside the accept set (an
    // unsupported kind deriving `undefined`, say): record the miss and
    // ship the replacement anyway.
    ctx.clean = false
    return replacement
  }

  switch (intro.kindOf(schema)) {
    case 'optional':
    case 'nullable': {
      // The wrapper admitted `undefined` / `null` via the accept set;
      // only a present value recurses against the inner shape.
      if (value === undefined || value === null) return value
      const inner = intro.unwrapInner(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth)
    }
    case 'default':
    case 'readonly':
    case 'catch': {
      const inner = intro.unwrapInner(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth)
    }
    case 'branded': {
      // v3-only wrapper; unwrapBranded returns undefined on v4.
      const inner = intro.unwrapBranded(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth)
    }
    case 'effects': {
      // v3-only: refine / transform wrappers fix structure against
      // their source (the input view); preprocess returned above.
      const inner = intro.unwrapEffectsSource(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth)
    }
    case 'pipe':
    case 'pipeline': {
      // Preprocess-shaped pipes returned above; a `.transform()` pipe
      // stores its source on the IN side — fix structure against it.
      const pipeIn = intro.unwrapPipeIn(schema)
      if (pipeIn === undefined || intro.kindOf(pipeIn) === 'transform') return value
      return fixNode(pipeIn, value, ctx, lazyDepth)
    }
    case 'lazy': {
      if (lazyDepth >= ctx.maxDepth) return value
      const inner = intro.unwrapLazy(schema)
      return inner === undefined ? value : fixNode(inner, value, ctx, lazyDepth + 1)
    }
    case 'discriminated-union': {
      if (value === null || typeof value !== 'object') return value
      const variant = selectVariantByValue(schema, value, intro)
      if (variant === undefined) return value
      const record = value as Record<string, unknown>
      const shape = intro.getObjectShape(variant)
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
      for (const [key, sub] of Object.entries(intro.getObjectShape(schema))) {
        record[key] = fixNode(sub, record[key], ctx, lazyDepth)
      }
      return value
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      const element = intro.getArrayElement(schema)
      if (element === undefined) return value
      for (let i = 0; i < value.length; i++) {
        value[i] = fixNode(element, value[i], ctx, lazyDepth)
      }
      return value
    }
    case 'tuple': {
      if (!Array.isArray(value)) return value
      const items = intro.getTupleItems(schema)
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item !== undefined) value[i] = fixNode(item, value[i], ctx, lazyDepth)
      }
      return value
    }
    case 'record': {
      if (value === null || typeof value !== 'object') return value
      const valueType = intro.getRecordValueType(schema)
      if (valueType === undefined) return value
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        record[key] = fixNode(valueType, record[key], ctx, lazyDepth)
      }
      return value
    }
    case 'intersection': {
      const left = intro.getIntersectionLeft(schema)
      const right = intro.getIntersectionRight(schema)
      let out = value
      if (left !== undefined) out = fixNode(left, out, ctx, lazyDepth)
      if (right !== undefined) out = fixNode(right, out, ctx, lazyDepth)
      return out
    }
    default:
      // Leaves and plain unions (no discriminator to route by).
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
function deriveFixValue<Schema>(schema: Schema, value: unknown, ctx: FixContext<Schema>): unknown {
  const du = ctx.services.unwrapToDiscriminatedUnion(schema)
  if (du !== undefined) {
    const selected =
      selectVariantByValue(du, value, ctx.services.intro) ??
      ctx.services.intro.getDiscriminatedOptions(du)[0]
    if (selected !== undefined) {
      return ctx.services.deriveDefault(selected, ctx.useDefault)
    }
  }
  return ctx.services.deriveDefault(schema, ctx.useDefault)
}

/**
 * Resolve the DU variant the value itself selects: the option whose
 * discriminator literal includes `value[discriminatorKey]`. Returns
 * `undefined` when the value carries no usable discriminator — the
 * caller falls back to the first option.
 */
function selectVariantByValue<Schema>(
  du: Schema,
  value: unknown,
  intro: SchemaIntrospector<Schema>
): Schema | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const discKey = intro.getDiscriminator(du)
  if (discKey === undefined) return undefined
  const discValue = (value as Record<string, unknown>)[discKey]
  if (discValue === undefined) return undefined
  for (const opt of intro.getDiscriminatedOptions(du)) {
    const litSchema = intro.getObjectShape(opt)[discKey]
    if (litSchema === undefined || intro.kindOf(litSchema) !== 'literal') continue
    if (intro.getLiteralValues(litSchema).includes(discValue)) return opt
  }
  return undefined
}
