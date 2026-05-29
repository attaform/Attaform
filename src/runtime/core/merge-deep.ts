/**
 * Plain-record deep merge for default-value derivation.
 *
 * Leaf semantics (anything not a plain `{}` record is a leaf):
 *   - `undefined` override → no-op (base wins).
 *   - `null` override → replaces base (a deliberate "clear this field"
 *     signal that mustn't be merged into).
 *   - Primitives / arrays / Date / Map / class instances → replace
 *     wholesale (e.g. an array override doesn't concat).
 *
 * Recursion only when BOTH sides are plain records. The override-key
 * walk uses `Object.keys` (own enumerable) so a key with an explicit
 * `undefined` value lands here too — the consumer's choice to name the
 * path overrides the base's value, mirroring how an explicit `null`
 * would.
 *
 * Hosted in core so the v3 and v4 default-value walkers single-source
 * the intersection / constraint-merge step. Previously identical
 * `mergeDeep` / `mergeDeepV3` bodies lived per-adapter.
 */
import { isPlainRecord } from './path-walker'

export function mergeDeep(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (!isPlainRecord(override)) return override
  if (!isPlainRecord(base)) return override

  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const oVal = override[key]
    const bVal = base[key]
    if (isPlainRecord(oVal) && isPlainRecord(bVal)) {
      result[key] = mergeDeep(bVal, oVal)
    } else {
      result[key] = oVal
    }
  }
  return result
}
