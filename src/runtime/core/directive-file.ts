import { effectScope, watch, type VNode } from 'vue'
import type {
  CustomDirectiveRegisterAssignerFn,
  RegisterModelDynamicCustomDirective,
} from '../types/types-api'
import { addTrackedListener, noteInteraction, removeTrackedListeners } from './directive-listeners'
import { fireAssigner, setAssignFunction } from './assigner-pipeline'
import { isRegisterValue, isTransforming } from './register-protocol'

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
 * Whether this file input is `multiple`, reliably at any lifecycle point.
 *
 * The DOM `el.multiple` property is NOT yet applied inside a directive's
 * `created` hook (Vue patches an element's attributes AFTER its directive
 * `created` hooks run), so the created-time blank-seed can't trust it — a
 * stale `false` makes it seed the single-file shape (`null`) into an array
 * path, which the slim-primitive gate rejects with a dev warning. Read the
 * authored vnode prop instead, falling back to the DOM property for the
 * post-mount callers where it IS live. `multiple` is a boolean attribute:
 * present as `true` or `''`, absent otherwise.
 */
function isMultipleInput(el: HTMLInputElement, vnode: VNode): boolean {
  if (el.multiple) return true
  const authored = vnode.props?.['multiple']
  return authored === true || authored === ''
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
 * The `beforeUpdate` hook keeps the DOM in lockstep with storage by
 * clearing `el.value` when storage transitions to blank — the only
 * programmatic write browsers permit on file inputs.
 */
export const vRegisterFile: RegisterModelDynamicCustomDirective = {
  created(el, { value }, vnode) {
    if (!isRegisterValue(value)) return
    // `resolveDynamicModel` routes here only when `el.tagName === 'INPUT'`
    // and `el.type === 'file'`. The variant union type widens to include
    // select/textarea, so narrow once per hook. The dynamic directive's `el`
    // (unlike the `CustomRegisterDirective` variants) doesn't carry the
    // assign-key symbol index, so widen to the assigner carrier here — the
    // shared `setAssignFunction` / `fireAssigner` both read `el[assignKey]`.
    const input = el as HTMLInputElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn }
    value.registerElement(input)
    // Install the shared assigner (the default writer, or a consumer
    // `@update:registerValue` override) so a file selection routes through the
    // same transform + coerce + async-orchestration pipeline as every other
    // input variant. A `transforms: [...]` chain on a file path now runs
    // (sync or async); an async transform drives the busy / pending / settle
    // machinery exactly as on a text input.
    setAssignFunction(input, vnode, value)

    // Seed the blank-path channel on register. Storage shape gets
    // canonicalised to `null` / `[]` whenever the consumer's default
    // is loosely blank (e.g. `undefined` for a non-nullable
    // `z.file()` schema), so reads return a uniform shape regardless
    // of how the user expressed "optional file" in their schema.
    const currentRaw = value.innerRef.value
    if (isBlankFileValue(currentRaw)) {
      const blankShape: File[] | null = isMultipleInput(input, vnode) ? [] : null
      value.setValueWithInternalPath(blankShape, { blank: true })
    }

    addTrackedListener(input, 'change', () => {
      noteInteraction(value)
      const next = readFilesFromInput(input)
      // A cleared selection (no file) is a clear, not a normalize: commit the
      // canonical blank shape directly and skip the pipeline. Only a real
      // selection flows through `fireAssigner`, so `transforms: [...]` runs and
      // `coerce` post-fixes the normalized result. An async transform returns
      // the queued sentinel here; the deferred orchestrator commits the
      // resolved value once it lands (latest-pick-wins on a rapid re-select).
      if (isBlankFileValue(next)) {
        value.setValueWithInternalPath(next, { blank: true })
        return
      }
      fireAssigner(input, value, next)
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
    //
    // Skip entirely while an async transform is in flight: storage is
    // transiently still the blank shape (the deferred commit hasn't landed)
    // even though the user already has a file selected. Re-marking blank here
    // would funnel through the write chokepoint and cancel the live run, and
    // clearing `el.value` would erase the selection mid-flight. The deferred
    // commit (or an explicit clear) settles both once the run lands.
    const currentRaw = value.innerRef.value
    if (isBlankFileValue(currentRaw) && !isTransforming(value)) {
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
