import type { AbstractSchema, UnionDiscriminatorContext } from '../types/types-api'
import { isPlainRecord } from './path-walker'
import { type Segment } from './paths'
import { safeAssign, safeOwnHas, safeOwnRead } from './safe-assign'

/**
 * Sparse-over-defaults hydration merge. Folds a partial value (a subset
 * of the form's paths) onto the schema's slim defaults during the
 * activate / rehydrate hydration path, with discriminated-union-aware
 * rebasing and prototype-pollution-safe key assignment.
 */

/**
 * Merge a sparse partial value over schema defaults. Returns a new
 * object — neither input is mutated. Used by the activate / rehydrate
 * hydration path when the incoming value only contains a subset of the
 * form's paths.
 *
 * Object keys are merged recursively (sparse keys override defaults).
 * Arrays are REPLACED wholesale: if a path resolves to an array in the
 * sparse value, it overrides the schema's array entirely. This is the
 * simpler rule for the common cases (a whole-array entry overrides; a
 * partial object at an array index implicitly accepts that schema
 * defaults for sibling leaves at that index won't be filled).
 *
 * Primitives in the sparse value override defaults. `null` and explicit
 * primitive values pass through (a sparse `null` is meaningful).
 *
 * **Discriminated unions:** when a path resolves to a DU in the
 * schema AND the sparse value's discriminator differs from the
 * defaults' discriminator (i.e. the sparse value was produced against a
 * different active variant than the schema's first-variant default), the
 * merge REBASES on the matching variant's slim default rather than
 * deep-merging across variants. Without this, deep merge would produce
 * an inconsistent shape carrying BOTH variants' keys (e.g. `{channel:
 * 'sms', number: '...', address: ''}`) — violates the DU's per-variant
 * shape contract and surfaces ghost fields in `form.values`.
 */
export function mergeSparseHydration<F>(
  schemaDefaults: F,
  sparse: unknown,
  schema?: AbstractSchema<unknown, unknown>
): F {
  return mergeDeep(schemaDefaults, sparse, [], schema) as F
}

function mergeDeep(
  target: unknown,
  source: unknown,
  path: readonly Segment[],
  schema: AbstractSchema<unknown, unknown> | undefined
): unknown {
  if (source === undefined) return target
  if (source === null || typeof source !== 'object') return source
  if (Array.isArray(source)) return source
  if (!isPlainRecord(source)) return source
  // At a discriminated-union path the plain deep-merge can't keep the
  // shape consistent across variants, so hand off to the DU-aware merge.
  // Skipped when no schema is provided (callers without an adapter
  // handle, including older tests) — those fall through to the plain
  // object merge below.
  if (schema !== undefined) {
    const du = schema.getUnionDiscriminatorAtPath(path as Segment[])
    if (du !== undefined) return mergeDuAwareKeys(source, path, schema, du)
  }
  return mergeObjectKeys(target, source, path, schema)
}

/**
 * DU-aware merge at a discriminated-union path. Three sub-cases the
 * plain deep-merge can't get right on its own:
 *   1. source's disc selects a different variant than target's →
 *      rebase target onto the matched variant's slim default so the
 *      prior variant's keys don't bleed alongside the new ones.
 *   2. source's disc is unknown to the schema → collapse to a
 *      disc-only stub `{ [discKey]: discValue }` (mirrors the
 *      runtime stub-state contract; validation surfaces the
 *      mismatch on the first committing parse).
 *   3. source carries foreign keys (sibling-variant fields the
 *      active variant doesn't declare) → drop them; the merge only
 *      keeps source keys that exist in the matched variant default.
 */
function mergeDuAwareKeys(
  source: Record<string, unknown>,
  path: readonly Segment[],
  schema: AbstractSchema<unknown, unknown>,
  du: UnionDiscriminatorContext
): unknown {
  const sourceDisc = source[du.discriminatorKey]
  if (sourceDisc !== undefined && !du.isVariantSelected(sourceDisc)) {
    return { [du.discriminatorKey]: sourceDisc }
  }
  if (sourceDisc !== undefined) {
    const variantDefault = du.getVariantDefault(sourceDisc)
    if (isPlainRecord(variantDefault)) {
      return mergeVariantKeys(source, variantDefault, path, schema, du)
    }
  }
  // No (usable) disc in source — empty stub keeps the slot in a "between
  // selections" state so a subsequent disc write reshapes cleanly.
  return {}
}

/**
 * Merge the sparse `source` over the matched variant's slim
 * `variantDefault`: spread the variant default, then fold in only the
 * source keys the variant declares (plus the discriminator), dropping
 * foreign sibling-variant fields.
 */
function mergeVariantKeys(
  source: Record<string, unknown>,
  variantDefault: Record<string, unknown>,
  path: readonly Segment[],
  schema: AbstractSchema<unknown, unknown>,
  du: UnionDiscriminatorContext
): Record<string, unknown> {
  // Object spread carries `variantDefault`'s own properties via
  // `CreateDataProperty`, bypassing the inherited `__proto__` setter —
  // so a variant default that legitimately declares `__proto__` is
  // copied through without reassigning the result's prototype chain.
  // Per-key writes route through `safeAssign`: a literal `__proto__`
  // key from a hostile source value (when the variant declares it)
  // lands as an own data property. The variant-filter below
  // (`key in variantDefault`) still excludes prototype-corrupting keys
  // for the DU-variant case unless the schema legitimately declares them.
  const out: Record<string, unknown> = { ...variantDefault }
  for (const key of Object.keys(source)) {
    // Own-property check — the variant-filter must treat inherited slots
    // as absent so `'__proto__' in variantDefault` doesn't smuggle a
    // hostile source key into the merge.
    if (!safeOwnHas(variantDefault, key) && key !== du.discriminatorKey) continue
    safeAssign(
      out,
      key,
      mergeDeep(safeOwnRead(out, key), safeOwnRead(source, key), [...path, key], schema)
    )
  }
  return out
}

/**
 * Plain recursive object merge for non-DU paths: spread `target` (when
 * it's a record), then fold every `source` key over it via `safeAssign`
 * with a recursive `mergeDeep` on each value.
 */
function mergeObjectKeys(
  target: unknown,
  source: Record<string, unknown>,
  path: readonly Segment[],
  schema: AbstractSchema<unknown, unknown> | undefined
): Record<string, unknown> {
  // Object spread carries `target`'s own properties via
  // `CreateDataProperty`, which bypasses the `__proto__` setter
  // inherited from `Object.prototype`. The per-key `safeAssign` lands
  // a literal `__proto__` key smuggled into the source value as an
  // own data property here too, with no path to `Object.prototype`.
  // Legitimate `prototype` / `constructor` / `__proto__` fields in a
  // consumer schema are preserved at their declared path.
  const out: Record<string, unknown> = isPlainRecord(target) ? { ...target } : {}
  for (const key of Object.keys(source)) {
    safeAssign(
      out,
      key,
      mergeDeep(safeOwnRead(out, key), safeOwnRead(source, key), [...path, key], schema)
    )
  }
  return out
}
