import type { RegisterValue } from '../types/types-api'
import { isRegisterValue } from './directive'
import { getOrAssignElementId } from './persistence/opt-in-registry'
import { allowSensitivePersist } from './persistence/sensitive-names'

/**
 * Idempotent reconciliation of a single element's opt-in across the
 * directive lifecycle. Called from `created` (oldValue undefined),
 * `beforeUpdate` (oldValue the previous RegisterValue), and as a
 * convenience from `beforeUnmount` (value undefined).
 *
 * Handles every transition: persist flag flipping in either direction,
 * `register()` path changing (e.g. dynamic v-for index), and the
 * cross-form / cross-SFC case where `register()` returns a value bound
 * to a different FormStore (different `persistOptIns` instance).
 */
export function syncPersistOptIn(
  el: HTMLElement,
  value: unknown,
  oldValue: unknown,
  vnodeType: unknown
): void {
  const wasOptedIn = isRegisterValue(oldValue) && oldValue.persist === true
  // File inputs can't survive a reload — `input.files` is read-only at
  // the browser layer, so even a perfect base64 round-trip couldn't
  // restore the picked file. The registry carve-out lives here so the
  // path never enters `optedInPaths`, never reaches the serializer, and
  // a separate `vRegisterFile` hook can surface the one-time dev warn
  // pointing consumers at the upload-on-select pattern.
  //
  // Detection consults `vnode.props.type` (passed in) first, then
  // `el.type` as a fallback. During `created`, Vue may not have
  // patched the `type` property onto the element yet — the vnode's
  // prop is the authoritative pre-patch source. On `beforeUpdate` the
  // element is fully patched and `el.type` agrees.
  const isFileInput =
    el.tagName === 'INPUT' && (vnodeType === 'file' || (el as HTMLInputElement).type === 'file')
  const wantsOptIn = !isFileInput && isRegisterValue(value) && value.persist === true
  if (!wasOptedIn && !wantsOptIn) return
  const elementId = getOrAssignElementId(el)
  // Detach the old opt-in unless every dimension matches (persist still
  // requested, same canonical path, same registry instance).
  if (wasOptedIn) {
    const old = oldValue as RegisterValue
    const samePathAndRegistry =
      wantsOptIn &&
      (value as RegisterValue).path === old.path &&
      (value as RegisterValue).persistOptIns === old.persistOptIns
    if (!samePathAndRegistry) {
      old.persistOptIns.remove(elementId, old.path)
    }
  }
  // Attach the new opt-in. `add` is idempotent, so if oldValue already
  // had the same (path, registry) we just re-touch the same entry.
  // The sensitive-name check fires here (not on every keystroke) — it's
  // the act of OPTING IN that crosses the compliance threshold.
  if (wantsOptIn) {
    const v = value as RegisterValue
    // A sensitive-named path opted in without `acknowledgeSensitive` is
    // warned + skipped (never thrown — this runs in the directive update
    // path). The unpersisted secret is the safe default.
    if (allowSensitivePersist(v.path, v.acknowledgeSensitive, v.isSensitivePath)) {
      v.persistOptIns.add(elementId, v.path)
    }
  }
}

/**
 * Reconcile the multi-tab sync OPT-OUT (`register('path',
 * { multiTab: false })`) across binding lifecycle transitions.
 * Symmetric with `syncPersistOptIn` for the multi-tab dimension.
 *
 * The RV's `markNoSync` / `unmarkNoSync` closures are pre-bound to
 * the canonical path key + the FormStore's ref-counted opt-out
 * registry (see `state.incrementNoSyncOptOut`). When `multiTab !==
 * false`, both closures are `undefined` and this function noops on
 * the hot path.
 *
 * Handles every transition:
 *   - undefined → opted-out: increment
 *   - opted-out → undefined: decrement
 *   - opted-out → opted-out (same path): no-op (idempotent)
 *   - opted-out → opted-out (path changed): decrement old, increment new
 */
export function syncMultiTabOptOut(value: unknown, oldValue: unknown): void {
  const wasOptedOut = isRegisterValue(oldValue) && oldValue.unmarkNoSync !== undefined
  const wantsOptOut = isRegisterValue(value) && value.markNoSync !== undefined
  if (!wasOptedOut && !wantsOptOut) return
  if (wasOptedOut) {
    const old = oldValue as RegisterValue
    const samePath = wantsOptOut && (value as RegisterValue).path === old.path
    if (!samePath) old.unmarkNoSync?.()
  }
  if (wantsOptOut) {
    const v = value as RegisterValue
    const samePathOld = wasOptedOut && (oldValue as RegisterValue).path === v.path
    if (!samePathOld) v.markNoSync?.()
  }
}

/**
 * Migrate the element's registration entry across binding-value
 * transitions. Symmetric with `syncPersistOptIn` for the
 * persistence opt-in dimension; this one tracks element-to-path
 * registration the form's element map relies on for
 * `getFieldState(path).meta.connected`, `focusFirstError`, and
 * `scrollToFirstError`.
 *
 * Cases:
 *   - undefined → undefined: nothing to do.
 *   - undefined → RV: register the new RV's element (the per-tag
 *     `created` hook skipped this when the binding mounted with an
 *     undefined value, so we have to catch up here).
 *   - RV → undefined: deregister the old RV's element.
 *   - RV → RV (same path + same form): skip the deregister side so
 *     the `connected` flag doesn't thrash false → true on every
 *     parent re-render. STILL call `registerElement` on the new RV:
 *     `register('foo')` returns a fresh handle per render, and the
 *     new RV owns its own bound-element reference (consumed by
 *     `setValueWithInternalPath` to auto-attach per-element
 *     persistence meta). `state.registerElement(path, el)` is
 *     idempotent — a single Set membership check on the path's
 *     element record.
 *   - RV → RV (different path or different form): deregister old,
 *     register new. Covers dynamic-path templates
 *     (`v-register="form.register(\`item.${i}\`)"`) and the
 *     cross-form case where a wrapper component switches the
 *     `registerValue` it forwards.
 */
export function syncElementRegistration(el: HTMLElement, value: unknown, oldValue: unknown): void {
  const wasRegistered = isRegisterValue(oldValue)
  const isRegistered = isRegisterValue(value)
  if (!wasRegistered && !isRegistered) return

  // Same path + same store: skip the deregister-then-register sequence
  // so the `connected` flag doesn't thrash false-true on every parent
  // re-render. But STILL call `registerElement` on the freshly closed-
  // over RV — `register()` returns a new RV per render, and the new RV
  // owns its own bound-element reference (consumed by
  // `setValueWithInternalPath` to auto-attach persistence meta).
  // `state.registerElement` is idempotent on (path, element) so the
  // re-call is a single Set membership check.
  const samePathAndStore =
    wasRegistered &&
    isRegistered &&
    oldValue.path === value.path &&
    oldValue.persistOptIns === value.persistOptIns

  if (wasRegistered && !samePathAndStore) {
    oldValue.deregisterElement(el)
  }
  if (isRegistered) {
    value.registerElement(el)
  }
}
