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
 *    earned: the field is non-blank and the value was engaged with, meaning
 *    `dirty` (it differs from its baseline) OR `interacted` (the user edited
 *    it, or `form.interact()` simulated that). Gating on
 *    `(dirty || interacted) && !blank` keeps the check meaningful — an empty
 *    field that happens to pass, a pre-filled field merely tabbed through
 *    (which sets `touched`, never `interacted`), and the post-submit flood of
 *    every valid field all stay `'idle'` rather than greening for free.
 *    Reading `interacted` alongside `dirty` is what keeps engagement, not
 *    net value change, the thing being rewarded: a user who types and then
 *    reverts to the original value has still engaged, and `form.interact()`
 *    means "treat this subtree as engaged" without the caller having to know
 *    that success secretly hinged on dirtiness.
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
  // A disabled field is inert: no error / success verdict, so the
  // heuristic settles to `'idle'`.
  if (field.disabled === true) return 'idle'
  if (!isGateOpen(field, formMeta)) return 'idle'
  const hasOwnError = field.errors.some(
    (e) => e.path.length === field.path.length && e.path.every((s, i) => s === field.path[i])
  )
  if (hasOwnError) return 'error'
  if (
    field.valid === true &&
    field.blank !== true &&
    (field.dirty === true || field.interacted === true)
  ) {
    return 'success'
  }
  return 'idle'
}

/**
 * The earlier of two in-flight clocks, ignoring `null` (a clock that is not
 * running). Returns `null` only when neither is running. Folds the validation
 * clock and the async-transform clock into one anti-flash timer: the spinner
 * tracks whichever piece of work started first and settles only once both are
 * done, so a field that is validating and transforming at once shows a single
 * continuous `'pending'` rather than flickering between the two.
 */
function earliestNonNull(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return a < b ? a : b
}

/**
 * Anti-flash timings for the display reducer, in milliseconds.
 *
 * - `showDelay` — how long in-flight work (a validation run or an async
 *   register transform) may run before its spinner is allowed to show. Work
 *   that settles inside this window never reveals `'pending'` at all, so a
 *   fast (often synchronous) check does not flash a spinner on every keystroke.
 *   `120` cleanly swallows synchronous, microtask-resolved, and tiny-async work.
 * - `minVisible` — once shown, the minimum time the spinner stays up. Work
 *   that lands just past `showDelay` is held here so the spinner does not
 *   itself flash on and immediately off. `120` keeps a shown spinner snappy.
 *
 * Exported for tests and for the demo-latency floor; not part of the
 * package surface.
 */
export const DEFAULT_TIMINGS = { showDelay: 120, minVisible: 120 } as const

const { showDelay, minVisible } = DEFAULT_TIMINGS

/**
 * How long the show-delay collapses to once the field is focused out. The
 * full `showDelay` exists to swallow the spinner during active typing; the
 * instant the user leaves the field that rationale is gone, so a still-running
 * validation should surface its spinner promptly rather than waiting out the
 * rest of a window meant for editing. This brief grace (one frame) still lets a
 * synchronous / microtask-settling check resolve to its real verdict before the
 * review fires, so a fast validation the user blurs past never flashes a
 * spinner; only one genuinely in flight a frame later reveals `'pending'`.
 * Capped at `showDelay`. Exported for tests; not part of the package surface.
 */
export const FOCUS_OUT_GRACE = 16

/**
 * The library's display reducer. Resolves every path's
 * `field.displayState` — and thus `field.show*` and the `form.meta`
 * rollups.
 *
 * Pure: the engine injects `now` and threads the previous machine, so
 * the same `(prev, ctx)` always yields the same next machine. It
 * shapes only the display projection — `errors`, `valid`,
 * `validating`, and the underlying validation run exactly as before.
 */
export const defaultDisplayState: GetDisplayState = (
  prev,
  { field, formMeta, validatingSince, transformingSince, now }
) => {
  const verdict = computeVerdict(field, formMeta)
  // The reveal gate governs the spinner too: until it opens, a field stays
  // idle — no spinner mid-first-entry — exactly as errors and success are
  // withheld. computeVerdict already returns idle for a closed gate; this
  // short-circuit keeps a still-closed gate out of the timed-pending machine.
  //
  // Load-bearing for hydration: at first paint the gate is closed (no submit
  // yet, not yet blurred-after-interaction), so a field validating on the
  // client renders the same idle verdict the server produced with `now`
  // frozen — no display-projection mismatch. Opening the gate during SSR (or
  // at first client render) would surface a timed verdict the server never
  // emitted and break that guarantee.
  if (!isGateOpen(field, formMeta)) return { display: verdict }
  // The spinner tracks one merged in-flight clock: a validation run, an
  // async register transform, or both at once (whichever started first, held
  // until both settle). Folding them here keeps a field that validates and
  // transforms together on a single continuous `'pending'`.
  const inFlightSince = earliestNonNull(validatingSince, transformingSince)
  // Settled — nothing in flight. Show the true verdict, unless a spinner
  // is still inside its minimum-visible window: hold it so work that landed
  // just past the show-delay does not flash on and off.
  if (inFlightSince === null) {
    if (prev.display === 'pending') {
      const shownAt = prev.pendingShownAt ?? now
      if (now < shownAt + minVisible)
        return {
          display: 'pending',
          pendingShownAt: shownAt,
          reviewAt: shownAt + minVisible,
        }
    }
    return { display: verdict }
  }
  // In flight, spinner already up: keep it. No `reviewAt` — the next
  // re-evaluation comes from the run settling (a reactive change), so
  // there is nothing for the engine's timer to wait on.
  if (prev.display === 'pending')
    return { display: 'pending', pendingShownAt: prev.pendingShownAt ?? now }
  // In flight, still inside the show-delay window: hold whatever was on
  // screen before the run began (`prev.display`) rather than the in-flight
  // verdict, which reads `valid: false` only because a check is running. A
  // fast run settles before `reviewAt` and the spinner never shows; a slow
  // one surfaces it at the window edge. The hold is uniform across every
  // prior verdict — error, success, idle alike — so editing a field
  // re-validates as [prior] -> pending -> [settled], never flashing idle in
  // between. Holding a green check over a value mid-edit is the same
  // anti-flash trade already accepted for a held error: the true verdict
  // lands a moment later and replaces it, so a brief stale verdict beats a
  // gratuitous idle flicker on every keystroke.
  //
  // Focus-out collapses the window to a brief settle grace (see
  // {@link FOCUS_OUT_GRACE}). While the user is typing (`focused === true`) or
  // there is no focus signal to act on (`focused === null`, a programmatic /
  // cross-field run on an unbound field) the full `showDelay` holds. The
  // instant the user focuses out, the window shrinks: a fast check settles
  // inside the grace and resolves straight to its verdict (no spinner), while
  // work still in flight past the grace surfaces `'pending'` promptly
  // instead of waiting out a window meant for editing.
  const window = field.focused === false ? Math.min(showDelay, FOCUS_OUT_GRACE) : showDelay
  if (now - inFlightSince < window) {
    return { display: prev.display, reviewAt: inFlightSince + window }
  }
  // Window elapsed and still in flight: the spinner has earned its place.
  return { display: 'pending', pendingShownAt: now, reviewAt: now + minVisible }
}
