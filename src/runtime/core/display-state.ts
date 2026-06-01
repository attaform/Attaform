import type { DisplayCtx, GetDisplayState } from '../types/types-api'

/**
 * The settled half of the display verdict: the value a field should show
 * once nothing is in flight. Pending is deliberately absent — it is a
 * timing decision the reducer layers on top, never a property of the
 * settled state.
 */
type Verdict = 'idle' | 'error' | 'success'

/**
 * The gate + precedence rules, with pending factored out. Resolves the
 * settled verdict from a field's reactive state:
 *
 * 1. **Timing gate.** `gateOpen` once the form has been submitted
 *    (`submissionAttempts > 0`) OR the field has been edited and then left
 *    (`blurredAfterInteraction === true`). Before the gate opens the
 *    verdict is `'idle'` regardless of errors — the "reward early, punish
 *    late" rule: a clean tab-through never engages, the first pass stays
 *    quiet until the user leaves the field, and recovery is live (the bit
 *    is sticky and carries no not-focused term, so a shown error clears
 *    the instant the value becomes valid).
 * 2. **Error.** An own-path error (one whose path equals the field's own
 *    path) resolves to `'error'`. The own-path filter keeps a container
 *    from duplicating an error a more-specific descendant already renders.
 * 3. **Success.** No error, `valid === true`, and the green check is
 *    earned: the field is non-blank and `dirty`. Gating on `dirty && !blank`
 *    keeps the check meaningful — an empty field that happens to pass, a
 *    pre-filled field merely tabbed through, and the post-submit flood of
 *    every valid field all stay `'idle'` rather than greening for free.
 * 4. **Idle.** Anything else.
 *
 * `'pending'` (the spinner) is owned by `makeDefaultDisplayState` below,
 * which decides — from the validation clock — when to surface it and how
 * long to hold it. This function is consulted both for the settled verdict
 * and, during a validation streak, for the verdict to hold under the
 * spinner once it lands.
 */
function isGateOpen(field: DisplayCtx['field'], formMeta: DisplayCtx['formMeta']): boolean {
  return formMeta.submissionAttempts > 0 || field.blurredAfterInteraction === true
}

function computeVerdict(field: DisplayCtx['field'], formMeta: DisplayCtx['formMeta']): Verdict {
  if (!isGateOpen(field, formMeta)) return 'idle'
  const hasOwnError = field.errors.some(
    (e) => e.path.length === field.path.length && e.path.every((s, i) => s === field.path[i])
  )
  if (hasOwnError) return 'error'
  if (field.valid === true && field.blank !== true && field.dirty === true) return 'success'
  return 'idle'
}

/**
 * Anti-flash timing for the library-default display reducer.
 *
 * - `showDelay` — how long a validation may run before its spinner is
 *   allowed to show. A validation that settles inside this window never
 *   reveals `'pending'` at all, so a fast (often synchronous) check does
 *   not flash a spinner on every keystroke.
 * - `minVisible` — once shown, the minimum time the spinner stays up. A
 *   validation that lands just past `showDelay` is held here so the
 *   spinner does not itself flash on and immediately off.
 *
 * Both are milliseconds.
 */
export type DisplayTimings = { readonly showDelay: number; readonly minVisible: number }

/**
 * Library-default anti-flash timings. `showDelay: 100` cleanly swallows
 * synchronous, microtask-resolved, and tiny-async validators (no spinner
 * for any of them); `minVisible: 120` keeps a shown spinner snappy.
 * Retune via {@link makeDefaultDisplayState} without touching the engine.
 */
export const DEFAULT_TIMINGS: DisplayTimings = { showDelay: 100, minVisible: 120 }

/**
 * Build a default `getDisplayState` reducer with custom anti-flash timing.
 * Power users who want a tighter or looser spinner than {@link DEFAULT_TIMINGS}
 * pass their own `{ showDelay, minVisible }`:
 *
 * ```ts
 * import { makeDefaultDisplayState } from 'attaform'
 *
 * useForm({
 *   schema,
 *   getDisplayState: makeDefaultDisplayState({ showDelay: 50, minVisible: 200 }),
 * })
 * ```
 *
 * The returned reducer is pure: the engine injects `now` and threads the
 * previous machine, so the same `(prev, ctx)` always yields the same next
 * machine. It shapes only the display projection — `errors`, `valid`,
 * `validating`, and the underlying validation run exactly as before.
 */
export function makeDefaultDisplayState({
  showDelay,
  minVisible,
}: DisplayTimings): GetDisplayState {
  return (prev, { field, formMeta, validatingSince, now }) => {
    const verdict = computeVerdict(field, formMeta)
    // The reveal gate governs the spinner too: until it opens, a field stays
    // idle — no spinner mid-first-entry — exactly as errors and success are
    // withheld. computeVerdict already returns idle for a closed gate; this
    // short-circuit keeps a still-closed gate out of the timed-pending machine.
    if (!isGateOpen(field, formMeta)) return { display: verdict }
    // Settled — nothing in flight. Show the true verdict, unless a spinner
    // is still inside its minimum-visible window: hold it so a validation
    // that landed just past the show-delay does not flash on and off.
    if (validatingSince === null) {
      if (prev.display === 'pending') {
        const shownAt = prev.pendingShownAt ?? now
        if (now < shownAt + minVisible)
          return { display: 'pending', pendingShownAt: shownAt, reviewAt: shownAt + minVisible }
      }
      return { display: verdict }
    }
    // Validating, spinner already up: keep it. No `reviewAt` — the next
    // re-evaluation comes from the run settling (a reactive change), so
    // there is nothing for the engine's timer to wait on.
    if (prev.display === 'pending')
      return { display: 'pending', pendingShownAt: prev.pendingShownAt ?? now }
    // Validating, still inside the show-delay window: hold whatever was on
    // screen before the run began (`prev.display`) rather than the in-flight
    // verdict, which reads `valid: false` only because a check is running.
    // A fast validation settles before `reviewAt` and the spinner never shows.
    if (now - validatingSince < showDelay)
      return { display: prev.display, reviewAt: validatingSince + showDelay }
    // Window elapsed and still validating: the spinner has earned its place.
    return { display: 'pending', pendingShownAt: now, reviewAt: now + minVisible }
  }
}

/**
 * Library-default `getDisplayState` reducer. Resolves every path's
 * `field.displayState` — and thus `field.show*` and the `form.meta`
 * rollups — whenever the consumer has not configured an override at the
 * per-form or plugin level. Built from {@link DEFAULT_TIMINGS}; publicly
 * re-exported so an override can compose with it (a layered reducer that
 * special-cases a subtree but otherwise defers picks up future
 * refinements for free):
 *
 * ```ts
 * import { defaultDisplayState } from 'attaform'
 *
 * useForm({
 *   schema,
 *   getDisplayState: (prev, ctx) => {
 *     const next = defaultDisplayState(prev, ctx)
 *     return next.display === 'success' && ctx.field.path[0] === 'username'
 *       ? { display: 'idle' }
 *       : next
 *   },
 * })
 * ```
 */
export const defaultDisplayState: GetDisplayState = makeDefaultDisplayState(DEFAULT_TIMINGS)

/**
 * Resolve a `getDisplayState` config (function | undefined) to a concrete
 * reducer. `undefined` falls back to the library default. Called once at
 * form construction; the resolved reducer is then stored on `FormStore`
 * for the field-state computeds to read directly.
 */
export function resolveGetDisplayState(config: GetDisplayState | undefined): GetDisplayState {
  return config ?? defaultDisplayState
}
