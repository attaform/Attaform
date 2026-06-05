import { effectScope, watch } from 'vue'
import type { RegisterValue } from '../types/types-api'

/**
 * Per-element teardown slot for the value-sync watch. `Symbol.for(...)`
 * so duplicate copies of attaform agree on the slot across bundles.
 */
const valueSyncScopeKey: unique symbol = Symbol.for('attaform:value-sync-scope')
type ValueSyncCarrier = HTMLElement & {
  [valueSyncScopeKey]?: () => void
}

/**
 * ShadowRoot-aware "is this element the focused one" check. A
 * v-register'd input mounted inside a shadow tree reports its focus on
 * the rootNode, not on `document` — mirrors the activeElement lookup in
 * the directive's `beforeUpdate` and `register-api`'s focus probe.
 */
function isElementFocused(el: HTMLElement): boolean {
  const rootNode = el.getRootNode()
  const activeElement =
    rootNode instanceof Document || rootNode instanceof ShadowRoot ? rootNode.activeElement : null
  return activeElement === el
}

/**
 * Reactively mirror a text / number input's `displayValue` onto the DOM.
 *
 * The directive's `beforeUpdate` hook only re-syncs `el.value` when the
 * host component re-renders. A form mutation that originates OUTSIDE the
 * component never triggers that re-render on its own:
 *
 *   - cross-tab sync (`applyFormReplacement` from the multi-tab module),
 *   - a sibling component's `setValue` / `reset` / `clear`,
 *   - any imperative store write while the bound component's template
 *     reads no field state (a display-only form never re-renders).
 *
 * In all of these the store and `displayValue` update correctly, but the
 * `<input>` would stay stale. Watching `displayValue` in its own effect
 * scope closes the gap — the same way the aria and file directives watch
 * their reactive sources for ticks that don't ride a parent re-render.
 *
 * Skipped while the element is focused or mid-IME-composition so the
 * watch never overwrites the user's in-flight edit or moves their caret;
 * the keystroke path and `beforeUpdate` own the focused case. The
 * `el.value !== next` guard keeps the write idempotent, and a
 * programmatic `el.value` assignment doesn't dispatch `input`, so there's
 * no write-back echo loop.
 */
export function setupValueSync(
  el: HTMLInputElement | HTMLTextAreaElement,
  rv: RegisterValue
): void {
  const scope = effectScope(true)
  scope.run(() => {
    watch(
      rv.displayValue,
      (next) => {
        if ((el as { composing?: boolean }).composing === true) return
        if (isElementFocused(el)) return
        if (el.value !== next) el.value = next
      },
      { flush: 'post' }
    )
  })
  ;(el as ValueSyncCarrier)[valueSyncScopeKey] = (): void => scope.stop()
}

/**
 * Stop the value-sync watch. Gated on an active scope so an element that
 * never set one up (checkbox / radio / select / file) is a no-op.
 */
export function teardownValueSync(el: HTMLElement): void {
  const carrier = el as ValueSyncCarrier
  const stop = carrier[valueSyncScopeKey]
  if (stop === undefined) return
  stop()
  delete carrier[valueSyncScopeKey]
}
