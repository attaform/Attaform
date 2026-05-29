import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { getAtPath } from './path-walker'
import type { Segment } from './paths'

/**
 * Live keys for the form data at a container path. Powers
 * `Object.keys(form.fields.items)` / `Object.keys(form.errors.items)`,
 * `v-for` iteration over array field proxies, and the container
 * enumeration paths in errors-proxy.
 *
 * Reads happen inside the consumer's active effect, so Vue tracks
 * `state.form.value`: appending or removing items re-enumerates on the
 * next render. Returns array indices as numeric-looking strings
 * (`'0'`, `'1'`, …) for array values and the object keys directly for
 * records / objects; primitives and nullish values yield `[]`.
 */
export function liveKeysAtPath<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  segments: readonly Segment[]
): readonly string[] {
  const value = getAtPath(state.form.value, segments)
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    const keys = new Array<string>(value.length)
    for (let i = 0; i < value.length; i += 1) keys[i] = String(i)
    return keys
  }
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>)
  return []
}

/**
 * Whether the path resolves to an array container RIGHT NOW. The live
 * form value is the source of truth so a discriminated-union variant
 * switch that swaps the shape at this path produces a freshly-targeted
 * proxy on the next read. The container cache keys off this same
 * predicate (see `containerProxyAt` in surface-proxy.ts), so a shape
 * flip surfaces a freshly-targeted proxy through `form.fields.X` /
 * `form.errors.X`.
 *
 * Root path (`segments.length === 0`) reports false — the form root
 * is always a container, never an array target.
 */
export function isArrayPath<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  segments: readonly Segment[]
): boolean {
  if (segments.length === 0) return false
  return Array.isArray(getAtPath(state.form.value, segments))
}
