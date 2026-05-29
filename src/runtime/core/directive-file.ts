import { effectScope, warn, watch } from 'vue'
import type { RegisterModelDynamicCustomDirective, RegisterValue } from '../types/types-api'
import { __DEV__ } from './dev'
import { addTrackedListener, noteInteraction, removeTrackedListeners } from './directive-listeners'
import type { PathKey } from './paths'
import type { PersistOptInRegistry } from './persistence/opt-in-registry'
import { isRegisterValue } from './directive'

/**
 * True for any value the file directive treats as "no file selected":
 * `null`, `undefined`, the empty array (multi-input cleared), and an
 * empty `FileList`. Strict equality short-circuits the common cases;
 * the FileList check covers the case where a host wrote the live DOM
 * FileList back into storage (rare, but cheap to handle).
 */
function isBlankFileValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value) && value.length === 0) return true
  if (typeof FileList !== 'undefined' && value instanceof FileList && value.length === 0)
    return true
  return false
}

/**
 * Read the current selection off a file input and reshape to the
 * directive's canonical storage form: `File[]` when the element has
 * the `multiple` attribute, `File | null` otherwise. `el.files` is
 * `null` on programmatically-detached inputs and the FileList is
 * empty when the user picked nothing — both collapse to the blank
 * shape.
 */
function readFilesFromInput(el: HTMLInputElement): File[] | File | null {
  const files = el.files
  if (el.multiple) {
    return files === null ? [] : Array.from(files)
  }
  if (files === null || files.length === 0) return null
  return files.item(0)
}

/**
 * Per-form dedupe for the persisted-file-input dev warning. Keyed on
 * the form's `PersistOptInRegistry` (every form has its own instance)
 * so the warning fires once per (form, path) — a single noisy hint
 * during development rather than per-mount, per-keystroke noise.
 */
const warnedPersistedFileForms: WeakMap<PersistOptInRegistry, Set<PathKey>> | null = __DEV__
  ? new WeakMap<PersistOptInRegistry, Set<PathKey>>()
  : null

function maybeWarnPersistedFile(value: RegisterValue): void {
  if (!__DEV__ || warnedPersistedFileForms === null) return
  if (value.persist !== true) return
  let warnedPaths = warnedPersistedFileForms.get(value.persistOptIns)
  if (warnedPaths === undefined) {
    warnedPaths = new Set<PathKey>()
    warnedPersistedFileForms.set(value.persistOptIns, warnedPaths)
  }
  if (warnedPaths.has(value.path)) return
  warnedPaths.add(value.path)
  warn(
    `[attaform] register('${value.path}', { persist: true }) on <input type="file"> — ` +
      `files can't ride a refresh (browsers block programmatic writes to ` +
      `<input type="file">), so this path won't be saved. For long-lived ` +
      `flows, upload on selection and persist the resulting URL or ID in a ` +
      `sibling string field.`
  )
}

/**
 * Symbol slot for the per-element effect-scope teardown function. The
 * blank-resync watcher inside `created` runs in its own scope so we
 * can stop it on `beforeUnmount` without depending on the surrounding
 * component still being alive.
 */
const fileScopeKey: unique symbol = Symbol.for('attaform:file-scope')
type FileScopeCarrier = { [fileScopeKey]?: () => void }

/**
 * Real `v-register` variant for `<input type="file">`. Reads
 * `event.target.files` into form state as `File | null` (single) or
 * `File[]` (multiple). Storage is the canonical blank shape (`null` /
 * `[]`) when no file is selected, with the path marked in
 * `blankPaths` so the friendly "No value supplied" error surfaces
 * through `derivedBlankErrors` on required-file fields — same channel
 * as required numbers / bigints.
 *
 * The persistence carve-out lives in `syncPersistOptIn`: file paths
 * never enter `persistOptIns`, never serialize, never rehydrate. The
 * `beforeUpdate` hook keeps the DOM in lockstep with storage by
 * clearing `el.value` when storage transitions to blank — the only
 * programmatic write browsers permit on file inputs.
 */
export const vRegisterFile: RegisterModelDynamicCustomDirective = {
  created(el, { value }) {
    if (!isRegisterValue(value)) return
    // `resolveDynamicModel` routes here only when `el.tagName === 'INPUT'`
    // and `el.type === 'file'`. The variant union type widens to include
    // select/textarea, so narrow once per hook.
    const input = el as HTMLInputElement
    value.registerElement(input)
    maybeWarnPersistedFile(value)

    // Seed the blank-path channel on register. Storage shape gets
    // canonicalised to `null` / `[]` whenever the consumer's default
    // is loosely blank (e.g. `undefined` for a non-nullable
    // `z.file()` schema), so reads return a uniform shape regardless
    // of how the user expressed "optional file" in their schema.
    const currentRaw = value.innerRef.value
    if (isBlankFileValue(currentRaw)) {
      const blankShape: File[] | null = input.multiple ? [] : null
      value.setValueWithInternalPath(blankShape, { blank: true })
    }

    addTrackedListener(input, 'change', () => {
      noteInteraction(value)
      const next = readFilesFromInput(input)
      const blank = isBlankFileValue(next)
      value.setValueWithInternalPath(next, blank ? { blank: true } : undefined)
    })

    // Watch storage for programmatic transitions to the blank shape
    // (`form.clear(path)` / `form.reset()` / hydrate). Re-mark the
    // path blank and clear the DOM input. `beforeUpdate` covers the
    // common parent-re-render case; this watcher catches storage
    // mutations that don't trigger a parent re-render. Runs in its
    // own effect scope so we can stop it from `beforeUnmount`
    // independent of the surrounding component.
    const scope = effectScope(true)
    scope.run(() => {
      watch(
        value.innerRef,
        (next) => {
          if (!isBlankFileValue(next)) return
          value.setValueWithInternalPath(next, { blank: true })
          if (input.value !== '') input.value = ''
        },
        { flush: 'post' }
      )
    })
    ;(input as FileScopeCarrier)[fileScopeKey] = (): void => scope.stop()
  },
  beforeUpdate(el, { value }) {
    if (!isRegisterValue(value)) return
    const input = el as HTMLInputElement
    // Storage → DOM + blankPaths sync. Two responsibilities:
    //
    //   1. Clear the DOM input when storage went blank
    //      (`form.clear(path)` / `form.reset()` / hydrate). `el.value
    //      = ''` is the one programmatic mutation browsers allow on
    //      `<input type="file">`.
    //
    //   2. Re-mark the path blank in the store so `derivedBlankErrors`
    //      keeps firing the friendly "No value supplied" message after
    //      programmatic clears. `form.clear` writes the schema's empty
    //      value (`null`) but doesn't propagate `meta.blank: true`, so
    //      the path would otherwise drift out of `blankPaths`. The
    //      store's `Set.add` is idempotent, and identity-equal writes
    //      don't trigger re-renders — safe to call on every update.
    const currentRaw = value.innerRef.value
    if (isBlankFileValue(currentRaw)) {
      value.setValueWithInternalPath(currentRaw, { blank: true })
      if (input.value !== '') input.value = ''
    }
  },
  beforeUnmount(el, { value }) {
    removeTrackedListeners(el)
    const stop = (el as FileScopeCarrier)[fileScopeKey]
    if (stop !== undefined) {
      stop()
      delete (el as FileScopeCarrier)[fileScopeKey]
    }
    if (!isRegisterValue(value)) return
    value.deregisterElement(el)
  },
}
