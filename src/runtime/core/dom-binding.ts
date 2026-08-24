import { reactive, markRaw } from 'vue'
import { canonicalizePath, type Path, type PathKey } from './paths'
import { INTERACTIVE_TAG_NAMES } from './interactive-tags'
import type { ElementRecord } from './store-records'
import type {
  AttaformDomBinding,
  DomBindingKernel,
  RegisterValue,
  WriteMeta,
} from '../types/types-api'

/**
 * The form store's DOM slice, extracted so the kernel never pays for it.
 *
 * Element registration, no-latch host anchors, the DOM-order sort cache,
 * focus/blur listeners, and first-error focus resolution all live here —
 * a module in the directive cluster's lazy graph. The kernel keeps a
 * `domBinding` slot (a shallow ref, `null` until armed) plus the narrow
 * field-record transitions (`noteDomConnected` / `noteDomDisconnected`)
 * this module drives; eager readers (`field.element` / `field.elements`,
 * invalid-submit focus, `focusFirstError` / `scrollToFirstError`) read
 * through the slot and treat `null` as "nothing registered" — which is
 * the truth: with no directive and no `useRegister` in the app, nothing
 * could have registered an element.
 *
 * Arming is explicit dependency injection: the directive and
 * `useRegister` pass `createDomBinding` into the RegisterValue's
 * internal `ensureDomBinding` before any element call (see
 * `armDomBinding`). An import-time module-slot side effect would be
 * tree-shaken under the package's `"sideEffects": false`, and per-call
 * injection also keeps duplicate-package-copy apps coherent: whichever
 * copy's cluster runs arms the store it is actually bound to.
 */

// `Symbol.for(...)` so duplicate copies of attaform agree on the
// element-property key for stashed focus/blur handlers — see
// `assignKey` in core/directive.ts for the same reasoning.
const attaformListenersSymbol: unique symbol = Symbol.for('attaform:focus-listeners')

type ElementWithListeners = HTMLElement & {
  [attaformListenersSymbol]?: {
    handleFocus: (event: FocusEvent) => void
    handleBlur: (event: FocusEvent) => void
  }
}

// Focusable candidates inside a no-latch component host, in the order the
// browser would tab through them (document order at query time). A composite
// widget exposes its entry point as a genuinely focusable element -- a
// roving-tabindex group's active item (`[tabindex="0"]`), a `role="slider"`
// thumb, a listbox/combobox trigger `<button>`, or a real `<input>` segment --
// so match natively focusable elements plus anything given a non-negative
// tabindex. `type="hidden"` inputs and `tabindex="-1"` mirrors (reka-ui's
// BubbleInput and the like) are excluded: they can never be the user's focus
// target. Disabled controls are filtered at resolve time.
const HOST_FOCUS_TARGET_SELECTOR = [
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'button',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ')

/**
 * The focus-first-error target for a no-latch `v-register` component host. The
 * host binds a value but owns no single control, so resolve its root to the
 * first visible, enabled focusable descendant -- the tab stop a keyboard user
 * entering the widget lands on (the first radio of a group, a slider thumb, a
 * listbox trigger, the first pin segment). Falls back to the host root itself
 * when nothing focusable is found, so `scrollToFirstError` still has a target
 * even if `focus()` can't land. `offsetParent === null` mirrors
 * `getFirstErrorElement`'s own visibility gate (skips `display:none` subtrees).
 */
function resolveHostFocusTarget(hostRoot: HTMLElement): HTMLElement {
  const candidates = hostRoot.querySelectorAll<HTMLElement>(HOST_FOCUS_TARGET_SELECTOR)
  for (const el of candidates) {
    if (!el.isConnected) continue
    if (el.offsetParent === null) continue
    if (el.matches(':disabled')) continue
    return el
  }
  return hostRoot
}

function attachFocusListeners(
  kernel: DomBindingKernel,
  segments: Path,
  element: HTMLElement,
  instanceMeta: WriteMeta['instance'] | undefined
): void {
  const target = element as ElementWithListeners
  if (target[attaformListenersSymbol] !== undefined) return
  const focusMeta = instanceMeta !== undefined ? { instance: instanceMeta } : undefined
  const handleFocus = (): void => kernel.markFocused(segments, true, focusMeta)
  const handleBlur = (): void => kernel.markFocused(segments, false, focusMeta)
  element.addEventListener('focus', handleFocus)
  element.addEventListener('blur', handleBlur)
  target[attaformListenersSymbol] = { handleFocus, handleBlur }
  // Catch-up probe: the browser applies `autofocus` and dispatches the
  // resulting `focus` event during HTML parse, BEFORE Vue's directive
  // lifecycle runs and we attach the listeners above. Programmatic
  // `.focus()` from a parent component's `onMounted` has the same race.
  // In both cases, by the time we wire up, the focus event has come and
  // gone and our handler never runs. Probe `document.activeElement`
  // (ShadowRoot-aware, mirroring the lookup at directive.ts:881) once
  // immediately after attaching, so the freshly-rendered field's
  // FieldState reflects DOM truth instead of the optimistic
  // `focused: false` seeded at registration.
  const rootNode = element.getRootNode()
  const activeElement =
    rootNode instanceof Document || rootNode instanceof ShadowRoot ? rootNode.activeElement : null
  if (activeElement === element) {
    kernel.markFocused(segments, true, focusMeta)
  }
}

function detachFocusListeners(element: HTMLElement): void {
  const target = element as ElementWithListeners
  const listeners = target[attaformListenersSymbol]
  if (listeners === undefined) return
  element.removeEventListener('focus', listeners.handleFocus)
  element.removeEventListener('blur', listeners.handleBlur)
  delete target[attaformListenersSymbol]
}

/**
 * Build one store's DOM binding. Called through the RegisterValue's
 * internal `ensureDomBinding` (see `armDomBinding`), which writes the
 * result into the kernel's `domBinding` slot exactly once per store.
 */
export function createDomBinding(kernel: DomBindingKernel): AttaformDomBinding {
  const elements = reactive(new Map<PathKey, ElementRecord>()) as Map<PathKey, ElementRecord>

  // Per-element form-instance tag. WeakMap so detached elements GC
  // without bookkeeping. Read by `getFirstErrorElement` to scope
  // focus/scroll targets to the registering `useForm()` instance —
  // important when two instances share a `key` and both register into
  // the same `elements` Map.
  const elementToFormInstance = new WeakMap<HTMLElement, string>()

  // No-latch component-host focus anchors. A host that binds value via
  // the v-model channel but latches no inner control enters no
  // `elements` record and would be invisible to `getFirstErrorElement`.
  // Keyed by path; the anchor resolves to a focusable descendant at
  // submit time, and `formInstanceId` scopes it the same way a
  // registered control is scoped. A path never holds both an anchor
  // and a registered element — `attach` drops the anchor when a
  // control latches.
  const hostTargets = new Map<
    PathKey,
    { path: Path; hostRoot: HTMLElement; formInstanceId: string }
  >()

  // DOM-order sort cache for the `getFirstErrorElement` read. The cache
  // amortises the sort across submits; every registration mutation
  // invalidates it.
  let sortedRegistrationsCache: Array<{
    path: Path
    element: HTMLElement
    host: boolean
    formInstanceId: string
  }> | null = null

  function attach(
    segments: Path,
    element: HTMLElement,
    formInstanceId: string,
    instanceMeta: WriteMeta['instance'] | undefined
  ): void {
    // Form-element semantics (registration + focus listeners) are gated
    // behind the interactive tag set — prevents accidental registration
    // of component wrapper divs when fallthrough attributes carry the
    // directive past the intended `<input>` / `<select>` / `<textarea>`.
    if (!INTERACTIVE_TAG_NAMES.has(element.tagName)) return
    const { key } = canonicalizePath(segments)
    const record = elements.get(key)
    // `markRaw` keeps HTMLElement out of Vue's auto-proxy machinery
    // (DOM nodes have circular refs and external state that fight
    // reactivity, and consumers comparing `===` against the original
    // ref expect to get back what they registered). The Set itself
    // is reactive so add/delete on an existing record fires
    // FieldState's `element` / `elements` accessors.
    const raw = markRaw(element)
    if (record === undefined) {
      elements.set(key, { path: segments, elements: reactive(new Set([raw])) })
    } else {
      if (record.elements.has(raw)) return
      record.elements.add(raw)
    }
    elementToFormInstance.set(element, formInstanceId)
    // A real control now owns this path's focus target, so drop any no-latch
    // host anchor for it: a late self-heal supersede (a single control that
    // rendered after mount) latches here after `markHostConnected` recorded
    // the root. The two focus channels are mutually exclusive per path.
    hostTargets.delete(key)
    sortedRegistrationsCache = null
    kernel.noteDomConnected(segments)
    attachFocusListeners(kernel, segments, element, instanceMeta)
  }

  function detach(segments: Path, element: HTMLElement): void {
    detachFocusListeners(element)
    const { key } = canonicalizePath(segments)
    const record = elements.get(key)
    if (record === undefined) return
    const removed = record.elements.delete(element)
    if (removed) {
      elementToFormInstance.delete(element)
      sortedRegistrationsCache = null
    }
    if (record.elements.size === 0) {
      elements.delete(key)
      // Disconnect transition: `focused` / `blurred` are DOM-state and
      // meaningless with no element attached, so the kernel flips them
      // back to `null` (interaction history stays).
      kernel.noteDomDisconnected(segments)
      // The last binding for this path just unmounted: abort any
      // in-flight async transform so its late resolve can't commit to a
      // detached field. Gated on the empty record, so a sibling element
      // still bound to the same path keeps its run alive.
      kernel.cancelTransformsUnder(segments)
    }
  }

  function markHostConnected(
    segments: Path,
    connected: boolean,
    hostEl: HTMLElement,
    formInstanceId: string
  ): void {
    // Client-side connected marking for a `v-register` component host that
    // binds value through the v-model channel but exposes no single inner
    // control to latch (a composite widget, or none discovered). The
    // directive calls this from its mount / unmount on the client, so it is
    // the authoritative connect/disconnect for a no-latch host -- there's no
    // element-Set entry to carry `connected` for it.
    const { key } = canonicalizePath(segments)
    if (connected) {
      // Record the host root as this path's focus-first-error anchor even if
      // `connected` is already true (a re-mark): the element may have changed.
      // Skipped when a real control already owns the path (`attach` dropped
      // any anchor and owns the focus target now).
      if (!elements.has(key)) {
        hostTargets.set(key, { path: segments, hostRoot: hostEl, formInstanceId })
        sortedRegistrationsCache = null
      }
      if (kernel.getFieldRecord(segments)?.connected === true) return
      kernel.noteDomConnected(segments)
    } else {
      // Drop the focus anchor first, unconditionally: the host root is
      // detaching regardless of whether the field record still reads
      // connected (a latch supersede may have flipped it via the element Set).
      if (hostTargets.delete(key)) sortedRegistrationsCache = null
      if (kernel.getFieldRecord(segments)?.connected !== true) return
      kernel.noteDomDisconnected(segments)
    }
  }

  function rebuildSortedRegistrations(): Array<{
    path: Path
    element: HTMLElement
    host: boolean
    formInstanceId: string
  }> {
    const flat: Array<{ path: Path; element: HTMLElement; host: boolean; formInstanceId: string }> =
      []
    for (const [, record] of elements) {
      for (const el of record.elements) {
        flat.push({
          path: record.path,
          element: el,
          host: false,
          formInstanceId: elementToFormInstance.get(el) ?? '',
        })
      }
    }
    // No-latch host roots. `attach` drops the anchor when a control
    // latches, so a path is never in both maps; guard anyway so a rebuild
    // between a latch and the anchor delete never double-lists a path.
    for (const [key, target] of hostTargets) {
      if (elements.has(key)) continue
      flat.push({
        path: target.path,
        element: target.hostRoot,
        host: true,
        formInstanceId: target.formInstanceId,
      })
    }
    // `compareDocumentPosition` returns a bitmask. The
    // `DOCUMENT_POSITION_FOLLOWING` bit (0x04) is set when the argument
    // node FOLLOWS the receiver in document order, which means the
    // receiver comes first → return -1 to keep `a` before `b`. A host root
    // and a control are distinct elements across fields (a no-latch host has
    // no registered descendant), so the comparison is always a clean
    // before/after, never a containment tie.
    flat.sort((a, b) =>
      a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )
    return flat
  }

  function getFirstErrorElement(
    formInstanceId: string
  ): { path: Path; element: HTMLElement } | null {
    // Single-pass DOM-order walk over every registered element plus every
    // no-latch host root. The sort cache is rebuilt lazily on the first read
    // after a register/deregister or host connect/disconnect; subsequent
    // calls amortise to O(n) until the next mutation.
    sortedRegistrationsCache ??= rebuildSortedRegistrations()

    for (const entry of sortedRegistrationsCache) {
      // Scope to this form instance — when two `useForm()` calls share
      // a key, both write into `elements` / `hostTargets`; this filter keeps
      // each form's submit from focusing the other's field. The instance tag
      // is denormalised onto the entry at rebuild time.
      if (entry.formInstanceId !== formInstanceId) continue

      // `el.isConnected` covers "component was unmounted, element
      // removed from DOM" cases that lag the FieldRecord.connected
      // flag. `el.offsetParent === null` catches `display:none` and
      // its ancestor chain — the browser won't focus or scroll to a
      // hidden element anyway, so we keep walking. For a host entry the
      // element is the host root; a hidden host is skipped the same way.
      if (!entry.element.isConnected) continue
      if (entry.element.offsetParent === null) continue

      // Route through the canonical merged read so focus / scroll target
      // exactly the paths that surface an error in `form.errors` /
      // `field.errors`. The blank-required class lives only in
      // `derivedBlankErrors` (never `schemaErrors`), so consulting the
      // schema / user stores alone silently skipped the first empty
      // required field — the very class this policy exists to jump to
      // (#468). `getErrorsForPath` folds in all three channels, keeping the
      // focus target and the visible error set from ever drifting apart.
      if (kernel.getErrorsForPath(entry.path).length === 0) continue

      // A registered control is its own focus target. A no-latch host owns
      // no single control, so resolve its root to the first focusable
      // descendant (the tab stop a user entering the widget would land on);
      // the resolver falls back to the root itself, keeping scroll-to-error
      // a target even when nothing inside can take focus.
      const element = entry.host ? resolveHostFocusTarget(entry.element) : entry.element
      return { path: entry.path, element }
    }
    return null
  }

  return {
    elements,
    attach,
    detach,
    markHostConnected,
    getFirstErrorElement,
  }
}

/**
 * Arm a RegisterValue's store with this module's DOM binding. The
 * directive's entry hooks and `useRegister` call it before any element
 * registration, so by the time `rv.registerElement` runs, the kernel's
 * `domBinding` slot is live. A hand-rolled RegisterValue (custom
 * integration, test fixture) has no `ensureDomBinding` and manages its
 * own elements — the optional call skips it.
 */
export function armDomBinding(value: RegisterValue): void {
  value.ensureDomBinding?.(createDomBinding)
}
