import type { RegisterValue } from '../types/types-api'

/**
 * Per-element bag of listener tuples added by the active directive
 * variant in `created`. `vRegisterDynamic.beforeUnmount` (and the file
 * variant's `beforeUnmount`) drain the bag so reused elements
 * (KeepAlive, v-show) don't accumulate orphaned handlers across
 * activation cycles. Shared between every directive variant — both
 * the multi-tag variants in `directive.ts` and the file variant in
 * `directive-file.ts` — so the carrier symbol lives here and the
 * single `addEventListener` / `removeTrackedListeners` pair routes
 * every variant through one tracked path.
 *
 * `Symbol.for(...)` so duplicate copies of attaform agree on the
 * slot (a single-window app with two pinned versions, or an
 * SSR-hydration race where the bundles haven't fully agreed yet,
 * still see one bag per element).
 */
const listenersKey: unique symbol = Symbol.for('attaform:directive-listeners')

type TrackedListener = {
  event: string
  handler: EventListener
  // Explicitly `undefined`-able so `exactOptionalPropertyTypes` lets us
  // stash tuples where the caller didn't pass options.
  options: EventListenerOptions | undefined
}

type ListenerCarrier = { [listenersKey]?: TrackedListener[] }

/**
 * Attach an event listener and remember the tuple on the element so a
 * matching `removeTrackedListeners` later can detach it. A bare
 * `addEventListener` without tracking would leak across KeepAlive
 * re-activations where the DOM node is reused.
 */
export function addTrackedListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
): void {
  el.addEventListener(event, handler, options)
  const carrier = el as ListenerCarrier
  const bag = carrier[listenersKey] ?? []
  bag.push({ event, handler, options })
  carrier[listenersKey] = bag
}

/**
 * Detach every listener the active directive variant attached in
 * `created`, regardless of whether the binding is still a valid
 * RegisterValue. Called from `beforeUnmount` so an element re-used by
 * KeepAlive / v-show starts clean on its next activation cycle.
 */
export function removeTrackedListeners(el: Element): void {
  const carrier = el as ListenerCarrier
  const bag = carrier[listenersKey]
  if (bag === undefined) return
  for (const { event, handler, options } of bag) {
    el.removeEventListener(event, handler, options)
  }
  delete carrier[listenersKey]
}

/**
 * First genuine user-input event flips the field's sticky `interacted`
 * bit — the signal `defaultDisplayState` reads to keep a clean
 * tab-through quiet while still engaging validation the moment the
 * user edits. Routed only through DOM listeners, so hydration and
 * programmatic setValue never trip it. Idempotent and store-guarded
 * on the RegisterValue side.
 *
 * Takes `unknown` rather than `RegisterValue` so directive variants
 * can call it on `binding.value` without re-running the type guard at
 * every event firing site.
 */
export function noteInteraction(value: unknown): void {
  if (isRegisterValueLike(value)) value.markInteracted()
}

function isRegisterValueLike(val: unknown): val is RegisterValue {
  return (
    typeof val === 'object' &&
    val !== null &&
    'markInteracted' in val &&
    typeof (val as { markInteracted: unknown }).markInteracted === 'function'
  )
}
