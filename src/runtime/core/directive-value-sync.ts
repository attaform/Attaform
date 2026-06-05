import { effectScope, watch, type WatchSource } from 'vue'

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
 * v-register'd control mounted inside a shadow tree reports its focus on
 * the rootNode, not on `document` — mirrors the activeElement lookup in
 * the directive's `beforeUpdate` and `register-api`'s focus probe.
 */
function isElementFocused(el: HTMLElement): boolean {
  const rootNode = el.getRootNode()
  const activeElement =
    rootNode instanceof Document || rootNode instanceof ShadowRoot ? rootNode.activeElement : null
  return activeElement === el
}

export interface ValueSyncOptions {
  /**
   * Skip the write while the element is focused. Set for text / textarea
   * so the watch never overwrites the user's in-flight edit or moves
   * their caret — the keystroke path and `beforeUpdate` own the focused
   * case. Left off for checkbox / radio / select: their DOM writes are
   * atomic and idempotent, so an external change must reflect even on a
   * focused control (that's the failure surface this closes), and the
   * in-flight-interaction window is guarded by `apply` itself (the
   * select's `_assigning` flag).
   */
  skipWhileFocused?: boolean
}

/**
 * Reactively mirror a register binding's reactive source onto the DOM for
 * changes that DON'T ride a host re-render:
 *
 *   - cross-tab sync (`applyFormReplacement` from the multi-tab module),
 *   - a sibling component's `setValue` / `reset` / `clear`,
 *   - any imperative store write while the bound component's template
 *     reads no field state (a display-only form never re-renders).
 *
 * The directive's `beforeUpdate` / `updated` hooks only fire on a host
 * re-render, so without this the store updates but the control stays
 * stale. `apply` performs the type-specific DOM write — `el.value` for
 * text, `el.checked` for checkbox / radio, `<option>.selected` for select
 * — and is the SAME write the re-render path runs, so both stay in
 * lockstep. Runs in its own effect scope, torn down by
 * `teardownValueSync` from the dispatcher's `beforeUnmount`.
 *
 * Mid-IME-composition writes are always skipped (text only; inert
 * elsewhere). A programmatic DOM write doesn't dispatch `input` / `change`,
 * so there's no write-back echo loop.
 */
export function setupValueSync(
  el: HTMLElement,
  source: WatchSource,
  apply: () => void,
  options: ValueSyncOptions = {}
): void {
  const skipWhileFocused = options.skipWhileFocused === true
  const scope = effectScope(true)
  scope.run(() => {
    watch(
      source,
      () => {
        if ((el as { composing?: boolean }).composing === true) return
        if (skipWhileFocused && isElementFocused(el)) return
        apply()
      },
      { flush: 'post' }
    )
  })
  ;(el as ValueSyncCarrier)[valueSyncScopeKey] = (): void => scope.stop()
}

/**
 * Stop the value-sync watch. Gated on an active scope so an element that
 * never set one up is a no-op.
 */
export function teardownValueSync(el: HTMLElement): void {
  const carrier = el as ValueSyncCarrier
  const stop = carrier[valueSyncScopeKey]
  if (stop === undefined) return
  stop()
  delete carrier[valueSyncScopeKey]
}
