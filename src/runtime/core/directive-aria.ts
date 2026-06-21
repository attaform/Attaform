import { effectScope, watch, type VNode } from 'vue'
import type { DisplayState, RegisterValue } from '../types/types-api'
import { INTERACTIVE_TAG_NAMES } from './interactive-tags'
import { isArray, isSet } from './vue-shared-shim'

/**
 * The aria attributes the directive keeps in sync with the field's
 * gated display state. Each is managed independently so authoring one
 * (e.g. a hand-written `aria-describedby`) never disables the others.
 */
const MANAGED_ARIA_ATTRS = [
  'aria-invalid',
  'aria-busy',
  'aria-required',
  'aria-describedby',
] as const

/**
 * Per-element symbol slots. `ariaLockKey` records which managed attrs
 * the author wrote (off-limits for the binding's lifetime);
 * `ariaScopeKey` holds the teardown for the reactive watch. Both
 * `Symbol.for(...)` so duplicate copies of attaform agree on the slot.
 */
const ariaLockKey: unique symbol = Symbol.for('attaform:aria-locks')
const ariaScopeKey: unique symbol = Symbol.for('attaform:aria-scope')
export type AriaCarrier = HTMLElement & {
  [ariaLockKey]?: Set<string>
  [ariaScopeKey]?: () => void
}

const EMPTY_ARIA_LOCKS: ReadonlySet<string> = new Set()

/**
 * "Respect your markup": detect authored aria attributes at the vnode
 * props level rather than the DOM, so a dynamic `:aria-invalid="x"` is
 * caught even when `x` is falsy at mount. Locks only ever accumulate —
 * once an attribute is authored, the directive leaves it alone for the
 * binding's lifetime.
 */
export function mergeAriaLocks(el: AriaCarrier, vnode: VNode): Set<string> {
  let locks = el[ariaLockKey]
  if (locks === undefined) {
    locks = new Set<string>()
    el[ariaLockKey] = locks
  }
  const props = vnode.props
  if (props !== null) {
    for (const attr of MANAGED_ARIA_ATTRS) {
      if (attr in props) locks.add(attr)
    }
  }
  return locks
}

function setAriaAttr(el: HTMLElement, attr: string, value: string | null): void {
  if (value === null) el.removeAttribute(attr)
  else el.setAttribute(attr, value)
}

/**
 * The desired value for one managed aria attribute given the binding's
 * required flag and gated display state, or `null` when the attribute
 * should be absent. Shared by the DOM path (`applyAria`) so the
 * screen-reader signal stays in lockstep with the visible error state.
 * Binding to the gated display state (not raw `errors`) keeps the
 * signal honest about whether the consumer's `getDisplayState`
 * predicate has admitted the verdict for surfacing. `suppressRequired`
 * withholds `aria-required` for array / set checkbox groups, where no
 * single member is individually required (#381).
 */
function resolveAriaValue(
  attr: string,
  rv: RegisterValue,
  ds: DisplayState,
  suppressRequired: boolean
): string | null {
  switch (attr) {
    case 'aria-invalid':
      return ds === 'error' ? 'true' : null
    case 'aria-busy':
      return ds === 'pending' ? 'true' : null
    case 'aria-required':
      return rv.isRequired === true && !suppressRequired ? 'true' : null
    case 'aria-describedby':
      return ds === 'error' && rv.aria?.errorId !== undefined ? rv.aria.errorId : null
    default:
      return null
  }
}

/**
 * Whether `aria-required` must be withheld for this binding. A checkbox
 * that aggregates into an array / set model is one member of a group:
 * no single member is individually required, an empty selection is
 * valid, and `aria-required` on a checkbox specifically announces "this
 * box must be checked." So the required signal is suppressed for array /
 * set checkbox members (#381), while a single boolean checkbox and a
 * multi-select `<select>` (both valid `aria-required` carriers) keep it.
 * The collection check reads the seeded model value, mirroring the
 * `vRegisterCheckbox` array / set detection.
 */
function suppressesRequired(rv: RegisterValue, isCheckbox: boolean): boolean {
  if (!isCheckbox) return false
  const model = rv.innerRef.value
  return isArray(model) || isSet(model)
}

/**
 * A native checkbox input, identified by tag name (uppercase, matching
 * `el.tagName`) and resolved `type`. The type is sourced from the vnode
 * props rather than the DOM: Vue's `created` directive hook runs before
 * props are patched, so `el.type` is not yet `'checkbox'` at the first
 * aria paint (the same reason `resolveDynamicModel` reads
 * `vnode.props.type`).
 */
function isCheckboxInput(tagName: string, type: unknown): boolean {
  return tagName === 'INPUT' && typeof type === 'string' && type.toLowerCase() === 'checkbox'
}

/**
 * Reflect the binding's gated display state onto the unmanaged aria
 * attributes. Each managed attr is set or removed independently.
 */
export function applyAria(el: AriaCarrier, rv: RegisterValue, vnode: VNode | null): void {
  if (rv.ariaEnabled !== true || rv.ariaDisplayState === undefined) return
  // Only real form controls carry autoAria (see setupAria). (#404)
  if (!INTERACTIVE_TAG_NAMES.has(el.tagName)) return
  const locks = el[ariaLockKey] ?? EMPTY_ARIA_LOCKS
  const ds = rv.ariaDisplayState.value
  const vnodeType = vnode?.props?.['type']
  const checkbox = isCheckboxInput(
    el.tagName,
    typeof vnodeType === 'string' ? vnodeType : (el as HTMLInputElement).type
  )
  const suppressRequired = suppressesRequired(rv, checkbox)
  for (const attr of MANAGED_ARIA_ATTRS) {
    if (!locks.has(attr)) setAriaAttr(el, attr, resolveAriaValue(attr, rv, ds, suppressRequired))
  }
}

/**
 * Begin managing aria for a binding: lock authored attrs, paint the
 * initial state, and watch `ariaDisplayState` in its own effect scope
 * so async validation ticks update the attributes even when no parent
 * re-render fires. No-op when this binding has aria disabled.
 */
export function setupAria(el: AriaCarrier, rv: RegisterValue, vnode: VNode): void {
  if (rv.ariaEnabled !== true || rv.ariaDisplayState === undefined) return
  // autoAria only manages real form controls. When v-register lands on a
  // component host (a presentational wrapper such as a <div>), the attrs
  // would be invalid ARIA on a role-less element; the inner control the
  // component re-binds via useRegister carries them instead. (#404)
  if (!INTERACTIVE_TAG_NAMES.has(el.tagName)) return
  mergeAriaLocks(el, vnode)
  applyAria(el, rv, vnode)
  const displayState = rv.ariaDisplayState
  const scope = effectScope(true)
  scope.run(() => {
    watch(displayState, () => applyAria(el, rv, vnode), { flush: 'post' })
  })
  el[ariaScopeKey] = (): void => scope.stop()
}

/**
 * Seed the authored-attr lock set from the element's current DOM
 * attributes. Used for a runtime-discovered control (a third-party
 * component host's latched inner control) that has no vnode: any managed
 * aria attribute already present on the element was authored by the host
 * component and stays off-limits for the binding's lifetime. The read is
 * a one-time snapshot, so a managed attr the component toggles on later
 * (from absent) is not detected; that is the inherent cost of having no
 * vnode to lock against.
 */
function seedLocksFromDom(el: AriaCarrier): void {
  let locks = el[ariaLockKey]
  if (locks === undefined) {
    locks = new Set<string>()
    el[ariaLockKey] = locks
  }
  for (const attr of MANAGED_ARIA_ATTRS) {
    if (el.hasAttribute(attr)) locks.add(attr)
  }
}

/**
 * Begin managing aria for a binding whose control was discovered at
 * runtime, with no vnode available. Mirrors `setupAria` but reads the
 * authored-attr locks from live DOM attributes (`seedLocksFromDom`)
 * instead of vnode props, and paints with a `null` vnode so `applyAria`
 * resolves the checkbox type from `el.type` (the control is fully mounted
 * by latch time). Shares the same effect scope and `ariaScopeKey`, so
 * `teardownAria` releases it unchanged. (#404 follow-up)
 */
export function setupAriaLive(el: AriaCarrier, rv: RegisterValue): void {
  if (rv.ariaEnabled !== true || rv.ariaDisplayState === undefined) return
  // The discovered control is an interactive element by construction (the
  // host latch gates on input / select / textarea), but keep the tag gate
  // for parity with setupAria / applyAria.
  if (!INTERACTIVE_TAG_NAMES.has(el.tagName)) return
  seedLocksFromDom(el)
  applyAria(el, rv, null)
  const displayState = rv.ariaDisplayState
  const scope = effectScope(true)
  scope.run(() => {
    watch(displayState, () => applyAria(el, rv, null), { flush: 'post' })
  })
  el[ariaScopeKey] = (): void => scope.stop()
}

/**
 * Compute the aria props that should be emitted into the rendered
 * markup for an SSR / static render. Mirrors `applyAria`'s computation
 * but returns a props bag instead of mutating the DOM, so Vue's
 * `getSSRProps` directive hook can pass the same managed attributes
 * through the server's render pipeline. Authored attrs are honoured at
 * the vnode-prop level (the same source of truth `mergeAriaLocks`
 * reads on the client). Returns `undefined` when the binding has no
 * aria opt-in to mirror the directive contract that "no aria" means
 * "no SSR props."
 */
export function getSSRAriaProps(
  rv: RegisterValue,
  vnode: VNode | null
): Record<string, string> | undefined {
  if (rv.ariaEnabled !== true || rv.ariaDisplayState === undefined) return undefined
  const props = vnode?.props ?? null
  const ds = rv.ariaDisplayState.value
  const tagName = typeof vnode?.type === 'string' ? vnode.type.toUpperCase() : ''
  const suppressRequired = suppressesRequired(rv, isCheckboxInput(tagName, props?.['type']))
  const out: Record<string, string> = {}
  for (const attr of MANAGED_ARIA_ATTRS) {
    if (props !== null && attr in props) continue
    const value = resolveAriaValue(attr, rv, ds, suppressRequired)
    if (value !== null) out[attr] = value
  }
  return out
}

/**
 * Stop managing aria: tear down the watch and clear only the attributes
 * the directive set (authored attrs stay). Gated on an active scope so
 * a binding that never managed aria leaves the element's attributes
 * untouched.
 */
export function teardownAria(el: AriaCarrier): void {
  const stop = el[ariaScopeKey]
  if (stop === undefined) return
  stop()
  delete el[ariaScopeKey]
  const locks = el[ariaLockKey] ?? EMPTY_ARIA_LOCKS
  for (const attr of MANAGED_ARIA_ATTRS) {
    if (!locks.has(attr)) el.removeAttribute(attr)
  }
  delete el[ariaLockKey]
}
