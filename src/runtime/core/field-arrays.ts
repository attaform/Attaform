import type { GenericForm } from '../types/types-core'
import type { WriteMeta } from '../types/types-api'
import type { FormStore } from './create-form-store'
import { canonicalizePath } from './paths'

/**
 * Typed array helpers on top of FormStore. Each helper reads the current
 * array at the given path, produces a new copy (immutable, so that the
 * `form` ref's reactive notification goes out), and writes it back via
 * `setValueAtPath`. All downstream bookkeeping — diffAndApply patches,
 * field-record `updatedAt` stamps, error-store preservation — comes for
 * free through the normal setValueAtPath pipeline.
 *
 * Out-of-range index semantics:
 *   - `remove` / `swap` / `replace`: no-op on invalid indices. Never grow
 *     the array. Matches react-hook-form / VeeValidate precedent.
 *   - `insert`: the target index is clamped via `Array.prototype.splice`
 *     (values past `length` are treated as `length`).
 *   - `move`: invalid `from` is a no-op; `to` is clamped to `[0, length]`.
 *
 * None of the helpers mutate the existing array — every write is a fresh
 * array literal, so Vue's identity-based change detection fires. Callers
 * that need to compose mutations should batch them at the schema level
 * (build the replacement shape, call `setValue(path, shape)` once).
 */

export type FieldArrayApi = {
  append(path: string, value: unknown): boolean
  prepend(path: string, value: unknown): boolean
  insert(path: string, index: number, value: unknown): boolean
  remove(path: string, index: number): boolean
  swap(path: string, a: number, b: number): boolean
  move(path: string, from: number, to: number): boolean
  replace(path: string, index: number, value: unknown): boolean
}

export function buildFieldArrayApi<F extends GenericForm>(
  state: FormStore<F, GenericForm>
): FieldArrayApi {
  function readArray(path: string): unknown[] {
    const segments = canonicalizePath(path).segments
    const current = state.getValueAtPath(segments)
    // If the path is missing or points at a non-array (e.g. the schema
    // default was undefined), treat as an empty array. This lets
    // `append` work for arrays that haven't been initialised by the
    // schema; the alternative of throwing surfaces programmer errors
    // earlier but blocks a common consumer pattern.
    return Array.isArray(current) ? current.slice() : []
  }

  function writeArray(path: string, next: unknown[], arrayOp?: WriteMeta['arrayOp']): boolean {
    const { segments } = canonicalizePath(path)
    const meta: WriteMeta = {
      ...(arrayOp !== undefined ? { arrayOp } : {}),
    }
    return state.setValueAtPath(segments, next, meta)
  }

  return {
    append(path, value) {
      // Pure length-grow at the tail. Recorded as an insert at the tail slot
      // so the write funnel scopes its per-element work (slim gate, structural
      // completion, authoring, bookkeeping) to the one fresh element instead
      // of re-walking all N. Existing indices keep their identities; an
      // insert-at-tail remap shifts nothing.
      const next = readArray(path)
      next.push(value)
      return writeArray(path, next, { kind: 'insert', index: next.length - 1 })
    },
    prepend(path, value) {
      const next = readArray(path)
      next.unshift(value)
      // Prepend is an insert at the head: every existing element shifts up
      // by one. The `insert` op records that exact permutation.
      return writeArray(path, next, { kind: 'insert', index: 0 })
    },
    insert(path, index, value) {
      const next = readArray(path)
      // Compute the actual insertion index using JS `splice` semantics
      // BEFORE the splice runs — negative values count from the end against
      // the PRE-splice length, positive values clamp to `[0, preLen]`. Then
      // pass that same index to both `splice` and the recorded `arrayOp`,
      // so downstream consumers (variant-memory eviction, identity-token
      // applyOp, per-element migration) act on the slot the element
      // actually landed in. Pre-fix the recorded `op.index` was clamped
      // against POST-splice length, which for negative inputs yielded 0
      // even when splice had placed the element later in the array.
      const preLen = next.length
      const insertIndex = index < 0 ? Math.max(0, preLen + index) : Math.min(index, preLen)
      next.splice(insertIndex, 0, value)
      return writeArray(path, next, { kind: 'insert', index: insertIndex })
    },
    remove(path, index) {
      const next = readArray(path)
      if (index < 0 || index >= next.length) return false
      next.splice(index, 1)
      return writeArray(path, next, { kind: 'remove', index })
    },
    swap(path, a, b) {
      const next = readArray(path)
      if (a < 0 || a >= next.length) return false
      if (b < 0 || b >= next.length) return false
      if (a === b) return false
      const tmp = next[a]
      next[a] = next[b]
      next[b] = tmp
      return writeArray(path, next, { kind: 'swap', a, b })
    },
    move(path, from, to) {
      const next = readArray(path)
      if (from < 0 || from >= next.length) return false
      const [item] = next.splice(from, 1)
      const clampedTo = Math.max(0, Math.min(to, next.length))
      next.splice(clampedTo, 0, item)
      // The element leaves `from` and lands at `clampedTo`; everything
      // between shifts by one. `to` carries the clamped destination so
      // the permutation matches the array we just wrote.
      return writeArray(path, next, { kind: 'move', from, to: clampedTo })
    },
    replace(path, index, value) {
      const next = readArray(path)
      if (index < 0 || index >= next.length) return false
      next[index] = value
      return writeArray(path, next, { kind: 'replace-at', index })
    },
  }
}
