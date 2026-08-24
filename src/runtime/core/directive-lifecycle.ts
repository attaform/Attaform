import { isRegisterValue } from './register-protocol'

/**
 * Migrate the element's registration entry across binding-value
 * transitions. Tracks the element-to-path registration the form's
 * element map relies on for `getFieldState(path).meta.connected`,
 * `focusFirstError`, and `scrollToFirstError`.
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
 *     DOM binding's attach is idempotent — a single Set membership
 *     check on the path's element record.
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
  // over RV — `register()` returns a new RV per render, and the DOM
  // binding's attach is idempotent on (path, element) so the re-call
  // is a single Set membership check.
  const samePathAndStore =
    wasRegistered &&
    isRegistered &&
    oldValue.path === value.path &&
    oldValue.formKey === value.formKey

  if (wasRegistered && !samePathAndStore) {
    oldValue.deregisterElement(el)
  }
  if (isRegistered) {
    value.registerElement(el)
  }
}
