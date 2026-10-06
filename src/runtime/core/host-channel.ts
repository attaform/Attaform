/**
 * The write policy for a `v-register` component host. A host's value
 * arrives through emits the compile-time bridge transform wires to the
 * RegisterValue (`update:modelValue`, and `input` for components that
 * report every keystroke), so nothing on the native per-tag path sees it.
 * This module gives those writes the native contract:
 *
 *   - `.number` casts a string emit the way the native text listener
 *     does, marking the field blank on an empty or non-numeric string.
 *   - `.trim` writes the raw emit and commits the trimmed form when focus
 *     leaves the host, the native deferred trim.
 *   - `.lazy` buffers emits while focus is inside the host and commits
 *     the last one when focus leaves.
 *   - Register `transforms` and schema coercion run on every commit,
 *     through the skeleton the native default assigner uses.
 *
 * The channel lives on the DOM binding, in the directive cluster's lazy
 * graph, and the eager RegisterValue only delegates to it. Its state is
 * per form store, keyed by path.
 */
import { looseToNumber } from './vue-shared-shim'
import { wrapWithTransforms } from './assigner-pipeline'
import type { PathKey } from './paths'
import type { HostChannel, HostModifiers, RegisterValue } from '../types/types-api'

function commit(rv: RegisterValue, raw: unknown, modifiers: HostModifiers): boolean {
  let value = raw
  if (modifiers.number === true && typeof value === 'string') {
    const cast = looseToNumber(value)
    // A non-numeric string, the empty string included, reads as a clear:
    // the field goes blank, as it does for a cleared native `.number`
    // input. An overflow to Infinity is refused and storage keeps its last
    // finite value, matching the native listener.
    if (typeof cast !== 'number') return rv.markBlank()
    if (!Number.isFinite(cast)) return false
    value = cast
  }
  // Absent signals are not values to normalize, so they skip transforms
  // and coercion, as the native default assigner skips them for
  // `undefined`. `commitFromHost` marks the field blank when the schema
  // does not admit the signal.
  if (value == null || (value === '' && !rv.acceptsString)) return rv.commitFromHost(value)
  return wrapWithTransforms(value, rv, (coerced) => rv.commitFromHost(coerced), undefined) !== false
}

export function createHostChannel(): HostChannel {
  const editing = new Set<PathKey>()
  const pending = new Map<PathKey, unknown>()

  return {
    write(rv, value, modifiers) {
      if (modifiers.lazy === true && editing.has(rv.path)) {
        pending.set(rv.path, value)
        return true
      }
      return commit(rv, value, modifiers)
    },

    writeInput(rv, payload, modifiers) {
      // PrimeVue's own forms layer reads an `input` emit the same way: a
      // payload owning `value` carries the live value, while a native
      // Event reaching a fallthrough listener is already covered by the
      // v-model and native paths.
      if (
        typeof payload !== 'object' ||
        payload === null ||
        payload instanceof Event ||
        !('value' in payload) ||
        !Object.hasOwn(payload, 'value')
      ) {
        return false
      }
      return rv.setValueFromHost(payload.value, modifiers)
    },

    markEditing(rv, isEditing, modifiers) {
      if (isEditing) {
        editing.add(rv.path)
        return
      }
      editing.delete(rv.path)
      if (pending.has(rv.path)) {
        const buffered = pending.get(rv.path)
        pending.delete(rv.path)
        commit(
          rv,
          modifiers.trim === true && typeof buffered === 'string' ? buffered.trim() : buffered,
          modifiers
        )
        return
      }
      if (modifiers.trim === true) {
        const current = rv.innerRef.value
        if (typeof current === 'string' && current !== current.trim()) {
          commit(rv, current.trim(), modifiers)
        }
      }
    },

    release(rv) {
      editing.delete(rv.path)
      pending.delete(rv.path)
    },
  }
}
