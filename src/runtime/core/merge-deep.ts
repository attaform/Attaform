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
import { safeAssign, safeOwnRead } from './safe-assign'

export function mergeDeep(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (!isPlainRecord(override)) return override
  if (!isPlainRecord(base)) return override

  // Object spread carries `base`'s own properties through the
  // spec's `CreateDataProperty` step, which bypasses the
  // `__proto__` setter — so a `base` carrying a literal
  // `__proto__` own property (e.g. from JSON-parsed adapter
  // defaults that round-tripped through storage) survives the
  // spread without reassigning the result's prototype. The
  // per-key reads route through `safeOwnRead` so a
  // `key === '__proto__'` doesn't resolve via the inherited
  // accessor on the regular target. The per-key `safeAssign` lands
  // an `override`'s `__proto__` entry as an own data property via
  // `Object.defineProperty`; every other key takes the plain
  // bracket-assign branch. Legitimate consumer-schema fields named
  // `prototype` / `constructor` / `__proto__` flow through default-
  // value derivation alongside every other key, and
  // `Object.prototype` stays untouched.
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const oVal = safeOwnRead(override, key)
    const bVal = safeOwnRead(base, key)
    if (isPlainRecord(oVal) && isPlainRecord(bVal)) {
      safeAssign(result, key, mergeDeep(bVal, oVal))
    } else {
      safeAssign(result, key, oVal)
    }
  }
  return result
}
