import type { z } from 'zod'
import { getAtPath, setAtPath } from '../../core/path-walker'
import { slimKindOf } from '../../core/slim-primitive-gate'
import { mergeDeep } from '../../core/merge-deep'
import { deriveDefaultWalk } from '../../core/walk-derive-default'
import { getDiscriminatedUnionFirstOption, unwrapToDiscriminatedUnion } from './discriminator'
import { slimPrimitivesOf } from './slim-primitives'
import {
  getDiscriminatedOptions,
  getUnionOptions,
  isCoercePrimitive,
  kindOf,
  unwrapPipeIn,
} from './introspect'
import { getNestedZodSchemasAtPath } from './path-walker'
import { getSlimSchema } from './strip'
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

// `defaultForKind` body lifted to `core/walk-derive-default.ts`; this
// module now just adapts the result to the v4-specific
// `getDefaultValuesFromZodSchema` validate-then-fix loop.

// `mergeDeep` lifted to `core/merge-deep.ts` so v3 and v4 share one
// body. Re-exported below as `mergeDeep` for backwards-compatible
// internal callers (the v4 strict-mode flow still consults it).

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
  slimSchema: z.ZodType
}

/**
 * getDefaultValuesFromZodSchema — produces a form's starting value.
 *
 * The algorithm mirrors v3's: walk the schema to derive blank defaults,
 * merge constraints, then run the schema's `safeParse`. On failure, walk
 * the resulting issues and fill in issue-specific defaults at each
 * complaining path — e.g. `invalid_type` with `issue.expected === 'string'`
 * fills in `''`, `invalid_value` picks the first allowed value, etc. Re-
 * parse and return.
 *
 * Refinements are always stripped from the slim schema — this helper's
 * concern is producing usable starting data, not surfacing refinement
 * errors. Refinement enforcement (in strict mode) lives upstream in
 * `adapter.ts`'s `rootSchema.safeParse(data)` pass, which uses the full
 * schema. Stripping here is also what keeps `safeParse` from throwing
 * synchronously when the schema contains an async refine.
 */
export function getDefaultValuesFromZodSchema<Form>(
  opts: GetDefaultValuesOptions
): DefaultValuesResult<Form> {
  const { schema, useDefaultSchemaValues, constraints, maxRecursionDepth } = opts
  const initial = deriveDefault(schema, useDefaultSchemaValues, maxRecursionDepth)
  const merged = mergeDeep(initial, constraints) as unknown

  // Strip wrappers, including refinements. The slim schema is for
  // *default-value derivation* — its job is to produce usable starting
  // data, not to surface refinement errors. Refinement errors are the
  // domain of the strict-mode pass downstream (`adapter.ts`'s
  // `rootSchema.safeParse(data)`), which uses the full schema.
  //
  // Crucially, this also avoids `safeParse` throwing synchronously when
  // the schema contains an async refine (zod's "Encountered Promise
  // during synchronous parse" error) — which would otherwise crash
  // construction for any strict-mode form with `z.string().refine(async …)`.
  const slimSchema = getSlimSchema(
    schema,
    {
      stripDefaultValues: true,
      stripPipe: true,
      stripRefinements: true,
    },
    maxRecursionDepth
  )

  const firstParse = slimSchema.safeParse(merged)
  if (firstParse.success) {
    return { data: firstParse.data as Form, success: true, slimSchema }
  }

  // Validate-then-fix: walk issues and fill defaults per path. Under
  // the slim-primitive write contract, we only fix issues that violate
  // STRUCTURAL or PRIMITIVE-TYPE shape. Refinement-level issues (enum
  // membership, literal equality, .email/.min(N)/regex, custom
  // refines, unrecognized_keys) pass THROUGH unchanged — the user's
  // defaultValues are preserved verbatim and the strict-mode
  // validation pass downstream surfaces the error at construction.
  //
  // The discriminant: look up the actual offending value at the
  // issue's path and check its slim primitive kind against the
  // candidate schema's slim primitive set. If the value's kind IS in
  // the set, the issue is refinement-level → skip. If it's NOT in
  // the set, the issue is primitive/structural → fix. This unifies
  // every issue code under one check rather than enumerating refinement
  // codes (which differ between Zod versions and grow over time).
  let fixedData = merged as Record<string, unknown>
  for (const issue of firstParse.error.issues) {
    const pathSegments = issue.path.map((seg) => (typeof seg === 'number' ? seg : String(seg))) as (
      | string
      | number
    )[]
    // Schema-side input normalizers (preprocess pipes, coerce-flagged
    // primitives) are slim-stripped, so the slim-schema sees only the
    // post-strip leaf and complains when storage is `undefined`. Look
    // up the ORIGINAL schema at the path; if it's such a wrapper, the
    // `undefined` is intentional under the no-write-mutation contract
    // and we leave it alone.
    const originalCandidate = getNestedZodSchemasAtPath(schema, pathSegments, maxRecursionDepth)[0]
    if (originalCandidate !== undefined) {
      if (isCoercePrimitive(originalCandidate)) continue
      if (kindOf(originalCandidate) === 'pipe') {
        const pipeIn = unwrapPipeIn(originalCandidate)
        if (pipeIn !== undefined && kindOf(pipeIn) === 'transform') continue
      }
    }

    // Pass the structured path directly — joining with '.' would merge
    // a literal-dot key (`['profile.name']`) into two segments and
    // target the wrong sub-schema during fix-up.
    const candidates = getNestedZodSchemasAtPath(slimSchema, pathSegments, maxRecursionDepth)
    if (candidates.length === 0) continue
    const candidate = candidates[0]
    if (candidate === undefined) continue

    // Refinement-vs-primitive classification.
    const valueAtPath = getAtPath(merged, pathSegments)
    const slimKinds = slimPrimitivesOf(candidate, maxRecursionDepth)
    if (slimKinds.size > 0 && slimKinds.has(slimKindOf(valueAtPath))) {
      // Refinement-level: pass through unchanged.
      continue
    }

    // Some issues don't carry a type path: fall back to deriving a default
    // for the schema at that location.
    const fixValue = defaultFromIssue(issue, candidate, useDefaultSchemaValues, maxRecursionDepth)
    if (fixValue === SKIP) continue
    fixedData = (
      pathSegments.length === 0 ? fixValue : setAtPath(fixedData, pathSegments, fixValue)
    ) as Record<string, unknown>
  }

  const secondParse = slimSchema.safeParse(fixedData)
  if (secondParse.success) {
    return { data: secondParse.data as Form, success: true, slimSchema }
  }

  // Last-resort: hand back what we constructed even if it still doesn't
  // parse. Better a partially-valid form than an exception at mount time.
  return { data: fixedData as unknown as Form, success: false, slimSchema }
}

const SKIP = Symbol('atta:skip-fix')

/**
 * Map a Zod v4 issue to a concrete replacement value for the path the
 * issue points at. Falls back to the candidate subschema's walker default
 * when the issue code doesn't carry enough info.
 */
function defaultFromIssue(
  issue: z.core.$ZodIssue,
  candidate: z.ZodType,
  useDefaultSchemaValues: boolean,
  maxRecursionDepth: number
): unknown {
  if (issue.code === 'invalid_type') {
    // If the candidate is (or wraps) a discriminated union, prefer the
    // first-option default over `undefined` — matches v3's behaviour.
    const du = unwrapToDiscriminatedUnion(candidate)
    if (du !== undefined) {
      const first = getDiscriminatedUnionFirstOption(du)
      if (first !== undefined)
        return deriveDefault(first, useDefaultSchemaValues, maxRecursionDepth)
    }
    return deriveDefault(candidate, useDefaultSchemaValues, maxRecursionDepth)
  }
  if (issue.code === 'invalid_value') {
    const values = (issue as unknown as { values?: readonly unknown[] }).values
    if (values !== undefined && values.length > 0) return values[0]
    return deriveDefault(candidate, useDefaultSchemaValues, maxRecursionDepth)
  }
  // Other issue codes (too_small/too_big/invalid_format) only fire in strict
  // mode since lax mode strips refinements. Fall back to the walker default.
  return deriveDefault(candidate, useDefaultSchemaValues, maxRecursionDepth)
}

/**
 * Exported for callers who want the discriminated-union option set for
 * path resolution (used by the adapter's getSchemasAtPath).
 */
export { getDiscriminatedOptions, getUnionOptions }
