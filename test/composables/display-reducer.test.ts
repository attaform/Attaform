import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, watchEffect } from 'vue'
import { DEFAULT_TIMINGS, defaultDisplayState, makeDefaultDisplayState } from '../../src'
import type { DisplayCtx, DisplayMachine, GetDisplayState, ValidationError } from '../../src'
import { createDisplayEngine } from '../../src/runtime/core/display-engine'
import { FOCUS_OUT_GRACE } from '../../src/runtime/core/display-state'
import type { PathKey } from '../../src/runtime/core/paths'

/**
 * Pure-reducer lock for the anti-flash display timing.
 *
 * `makeDefaultDisplayState` returns a deterministic `(prev, ctx) => next`
 * reducer: the engine injects `now`, threads the previous `DisplayMachine`,
 * and supplies `validatingSince` (the streak anchor). Because every input
 * is explicit, the show-delay / min-visible behaviour is testable without
 * a clock or a mounted form — that is the backbone these tests pin down.
 * Integration coverage (a real form, real timers) lives in
 * `display-state.test.ts`.
 */

const { showDelay, minVisible } = DEFAULT_TIMINGS
const IDLE: DisplayMachine = { display: 'idle' }
const PENDING_AT = (shownAt: number): DisplayMachine => ({
  display: 'pending',
  pendingShownAt: shownAt,
})

const ownError: ValidationError = { path: ['x'], message: 'm', formKey: 'k', code: 'c' }
const descendantError: ValidationError = { path: ['x', 'y'], message: 'm', formKey: 'k', code: 'c' }

function field(over: Record<string, unknown> = {}): DisplayCtx['field'] {
  return {
    errors: [],
    touched: false,
    interacted: false,
    blurredAfterInteraction: false,
    focused: null,
    validating: false,
    valid: false,
    blank: false,
    dirty: false,
    path: ['x'],
    ...over,
  } as unknown as DisplayCtx['field']
}
function meta(over: Record<string, unknown> = {}): DisplayCtx['formMeta'] {
  return { submissionAttempts: 0, ...over } as unknown as DisplayCtx['formMeta']
}
function ctx(over: Partial<DisplayCtx> = {}): DisplayCtx {
  return {
    field: field(),
    formMeta: meta(),
    validatingSince: null,
    transformingSince: null,
    now: 0,
    ...over,
  }
}

describe('default reducer — settled verdict (validatingSince: null)', () => {
  // The gate / error / earned-success / container matrix. With nothing in
  // flight the reducer collapses to the documented heuristic, and `now`
  // never changes the answer (the SSR-equivalence guarantee).
  it('gate closed: idle even with an own error', () => {
    expect(defaultDisplayState(IDLE, ctx({ field: field({ errors: [ownError] }) })).display).toBe(
      'idle'
    )
  })

  it('edited-and-left opens the gate: own error → error, regardless of dirty', () => {
    expect(
      defaultDisplayState(
        IDLE,
        ctx({ field: field({ errors: [ownError], blurredAfterInteraction: true }) })
      ).display
    ).toBe('error')
  })

  it('re-focused after engaging keeps the error (sticky bit, no not-focused term)', () => {
    expect(
      defaultDisplayState(
        IDLE,
        ctx({
          field: field({ errors: [ownError], blurredAfterInteraction: true, focused: true }),
        })
      ).display
    ).toBe('error')
  })

  it('clean tab-through (touched, never edited) stays idle', () => {
    expect(
      defaultDisplayState(IDLE, ctx({ field: field({ errors: [ownError], touched: true }) }))
        .display
    ).toBe('idle')
  })

  it('mid-first-entry (interacted + focused, not yet left) stays idle', () => {
    expect(
      defaultDisplayState(
        IDLE,
        ctx({
          field: field({ errors: [ownError], interacted: true, touched: true, focused: true }),
        })
      ).display
    ).toBe('idle')
  })

  it('after a submit attempt: own error → error regardless of focus/touch', () => {
    expect(
      defaultDisplayState(
        IDLE,
        ctx({
          field: field({ errors: [ownError], focused: true }),
          formMeta: meta({ submissionAttempts: 1 }),
        })
      ).display
    ).toBe('error')
  })

  it('earned valid (dirty + non-blank) with the gate open → success', () => {
    expect(
      defaultDisplayState(
        IDLE,
        ctx({
          field: field({ valid: true, blank: false, dirty: true, blurredAfterInteraction: true }),
        })
      ).display
    ).toBe('success')
  })

  it('valid but unearned stays idle (blank, or not dirty, or post-submit flood)', () => {
    const earned = { valid: true, blank: false, dirty: true, blurredAfterInteraction: true }
    expect(
      defaultDisplayState(IDLE, ctx({ field: field({ ...earned, valid: false }) })).display
    ).toBe('idle')
    expect(
      defaultDisplayState(IDLE, ctx({ field: field({ ...earned, blank: true }) })).display
    ).toBe('idle')
    expect(
      defaultDisplayState(IDLE, ctx({ field: field({ ...earned, dirty: false }) })).display
    ).toBe('idle')
    expect(
      defaultDisplayState(
        IDLE,
        ctx({
          field: field({ valid: true, blank: false, dirty: false }),
          formMeta: meta({ submissionAttempts: 1 }),
        })
      ).display
    ).toBe('idle')
  })

  it('container with ONLY descendant errors stays idle (own-path filter)', () => {
    expect(
      defaultDisplayState(
        IDLE,
        ctx({
          field: field({ errors: [descendantError], path: ['x'] }),
          formMeta: meta({ submissionAttempts: 1 }),
        })
      ).display
    ).toBe('idle')
  })

  it('the verdict is independent of `now` (SSR-equivalence)', () => {
    const settled = ctx({ field: field({ errors: [ownError], blurredAfterInteraction: true }) })
    expect(defaultDisplayState(IDLE, { ...settled, now: 0 }).display).toBe('error')
    expect(defaultDisplayState(IDLE, { ...settled, now: 9_999_999 }).display).toBe('error')
  })

  it('terminal settled machines carry no reviewAt', () => {
    const next = defaultDisplayState(
      IDLE,
      ctx({ field: field({ errors: [ownError], blurredAfterInteraction: true }) })
    )
    expect(next.reviewAt).toBeUndefined()
    expect(next.display).toBe('error')
  })
})

describe('default reducer — the reveal gate governs the spinner', () => {
  it('gate closed + validating past show-delay stays idle (no spinner mid-first-entry)', () => {
    // No submit, not blurred-after-interaction: the gate is closed. Even a
    // slow validation must not surface a spinner before the user engages,
    // matching how errors and success are withheld.
    const next = defaultDisplayState(
      { display: 'idle' },
      ctx({ field: field({ errors: [ownError] }), validatingSince: 0, now: showDelay + 50 })
    )
    expect(next.display).toBe('idle')
    expect(next.reviewAt).toBeUndefined()
  })

  it('gate open + validating past show-delay does surface the spinner', () => {
    const next = defaultDisplayState(
      { display: 'idle' },
      ctx({
        field: field({ errors: [ownError], blurredAfterInteraction: true }),
        validatingSince: 0,
        now: showDelay,
      })
    )
    expect(next.display).toBe('pending')
  })

  it('hydration-safe: a gate-closed validating field is idle for both SSR now=0 and a real client clock', () => {
    // At first paint the gate is closed (submissionAttempts=0, not yet
    // blurred-after-interaction), so a mid-validation field renders idle
    // regardless of `now`. The server (now=0) and the client's first render
    // (now=Date.now()) therefore agree — no hydration mismatch on the display
    // projection. Locks the load-bearing constraint that the gate stays closed
    // through SSR / first client render.
    const validatingClosed = ctx({
      field: field({ errors: [ownError], validating: true }),
      validatingSince: 0,
    })
    expect(defaultDisplayState(IDLE, { ...validatingClosed, now: 0 }).display).toBe('idle')
    expect(defaultDisplayState(IDLE, { ...validatingClosed, now: 9_999_999 }).display).toBe('idle')
  })
})

describe('default reducer — show-delay window', () => {
  const gatedError = field({ errors: [ownError], blurredAfterInteraction: true })

  it('fast validation holds the prior verdict and schedules a review at the window edge', () => {
    const prev: DisplayMachine = { display: 'error' }
    const next = defaultDisplayState(
      prev,
      ctx({ field: gatedError, validatingSince: 1000, now: 1000 })
    )
    // Held — no spinner — and the engine is told to look again at +showDelay.
    expect(next.display).toBe('error')
    expect(next.reviewAt).toBe(1000 + showDelay)
    expect(next.pendingShownAt).toBeUndefined()
  })

  it('holds a headless (focused: null) success through the window (no blur signal)', () => {
    // A re-validation with no focus to act on — a programmatic / cross-field run
    // on a field with no bound element — keeps the full show-delay: the prior
    // `success` is held (not recomputed to idle), exactly as for a focused edit.
    const prev: DisplayMachine = { display: 'success' }
    const inFlight = field({ valid: false, blurredAfterInteraction: true, focused: null })
    const next = defaultDisplayState(
      prev,
      ctx({ field: inFlight, validatingSince: 1000, now: 1050 })
    )
    expect(next.display).toBe('success')
    expect(next.reviewAt).toBe(1000 + showDelay)
  })

  it('focus-out collapses the window to the settle grace (holds briefly, reviews at the grace edge)', () => {
    // The instant the user focuses out, the show-delay (which exists to swallow
    // the spinner during typing) collapses to a brief settle grace. The prior
    // verdict is still held for that grace — a fast validation settling inside
    // it resolves to its real verdict with no spinner — but the review is now
    // scheduled at the grace edge, not the far show-delay edge.
    const prev: DisplayMachine = { display: 'success' }
    const blurred = field({ valid: false, blurredAfterInteraction: true, focused: false })
    const next = defaultDisplayState(
      prev,
      ctx({ field: blurred, validatingSince: 1000, now: 1000 + FOCUS_OUT_GRACE - 1 })
    )
    expect(next.display).toBe('success')
    expect(next.reviewAt).toBe(1000 + FOCUS_OUT_GRACE) // grace edge, not 1000 + showDelay
  })

  it('focus-out past the settle grace, still validating → pending at once', () => {
    // The grace elapsed and the validation is still in flight: it outlived the
    // grace, so it is genuinely async — surface the spinner now rather than
    // waiting out the rest of a window the user has left.
    const prev: DisplayMachine = { display: 'success' }
    const blurred = field({ valid: false, blurredAfterInteraction: true, focused: false })
    const next = defaultDisplayState(
      prev,
      ctx({ field: blurred, validatingSince: 1000, now: 1000 + FOCUS_OUT_GRACE })
    )
    expect(next.display).toBe('pending')
    expect(next.pendingShownAt).toBe(1000 + FOCUS_OUT_GRACE)
    expect(next.reviewAt).toBe(1000 + FOCUS_OUT_GRACE + minVisible)
  })

  it('holds a FOCUSED success through the window (no success → idle flicker while editing)', () => {
    // Editing a valid field re-validates it; inside the show-delay window the
    // in-flight field reads `valid: false` only because a check is running, so
    // the reducer holds the prior `success` rather than recomputing idle. The
    // window holds every prior verdict uniformly — focus is not special — so a
    // value edited toward another still-valid value never flickers
    // success → idle → success; it goes success → pending → success.
    const prev: DisplayMachine = { display: 'success' }
    const editing = field({ valid: false, blurredAfterInteraction: true, focused: true })
    const next = defaultDisplayState(
      prev,
      ctx({ field: editing, validatingSince: 1000, now: 1050 })
    )
    expect(next.display).toBe('success')
    expect(next.reviewAt).toBe(1000 + showDelay)
  })

  it('holds a FOCUSED error through the window (the window holds every prior verdict)', () => {
    // The window holds whatever was on screen, focus included: a stale error
    // while the user fixes the field is conservative (it was wrong, we are
    // re-checking), exactly as a stale success is held while editing toward a
    // still-valid value.
    const prev: DisplayMachine = { display: 'error' }
    const editing = field({ errors: [ownError], blurredAfterInteraction: true, focused: true })
    const next = defaultDisplayState(
      prev,
      ctx({ field: editing, validatingSince: 1000, now: 1050 })
    )
    expect(next.display).toBe('error')
    expect(next.reviewAt).toBe(1000 + showDelay)
  })

  it('regression: editing a valid value goes success → pending → success, never idle', () => {
    // Live report: a filled, valid (success) field, re-focused and edited to
    // another still-valid value, flashed `idle` before the spinner. The window
    // must hold the prior `success`, so the only transitions a slow
    // re-validation produces are success → pending → success — no idle frame.
    const editing = field({
      valid: false,
      blurredAfterInteraction: true,
      focused: true,
      dirty: true,
    })

    // 1. Inside the show-delay window: the prior success is HELD (not idle).
    const inWindow = defaultDisplayState(
      { display: 'success' },
      ctx({ field: editing, validatingSince: 1000, now: 1000 })
    )
    expect(inWindow.display).toBe('success')

    // 2. Past the show-delay, still validating: the spinner earns its place.
    const pastWindow = defaultDisplayState(
      inWindow,
      ctx({ field: editing, validatingSince: 1000, now: 1000 + showDelay })
    )
    expect(pastWindow.display).toBe('pending')

    // 3. Settles valid past min-visible: success — never having shown idle.
    const settled = field({
      valid: true,
      blurredAfterInteraction: true,
      focused: true,
      dirty: true,
    })
    const released = defaultDisplayState(
      pastWindow,
      ctx({ field: settled, validatingSince: null, now: 1000 + showDelay + minVisible })
    )
    expect(released.display).toBe('success')
  })

  it('settling inside the window returns the fresh verdict with no reviewAt', () => {
    const prev: DisplayMachine = { display: 'error', reviewAt: 1000 + showDelay }
    const next = defaultDisplayState(
      prev,
      ctx({ field: gatedError, validatingSince: null, now: 1050 })
    )
    expect(next.display).toBe('error')
    expect(next.reviewAt).toBeUndefined()
  })
})

describe('default reducer — slow validation surfaces pending', () => {
  it('past the show-delay, still validating → pending, anchored now, held for min-visible', () => {
    const prev: DisplayMachine = { display: 'error' }
    const now = 1000 + showDelay
    const next = defaultDisplayState(
      prev,
      ctx({
        field: field({ errors: [ownError], blurredAfterInteraction: true }),
        validatingSince: 1000,
        now,
      })
    )
    expect(next.display).toBe('pending')
    expect(next.pendingShownAt).toBe(now)
    expect(next.reviewAt).toBe(now + minVisible)
  })

  it('while the spinner is up and still validating: held, with no timer to wait on', () => {
    const prev = PENDING_AT(2000)
    const next = defaultDisplayState(
      prev,
      ctx({
        field: field({ errors: [ownError], blurredAfterInteraction: true }),
        validatingSince: 1900,
        now: 2200,
      })
    )
    expect(next.display).toBe('pending')
    expect(next.pendingShownAt).toBe(2000)
    // No reviewAt: the next move comes from the run settling (reactive),
    // not from a timer — so the engine schedules nothing and can't busy-loop.
    expect(next.reviewAt).toBeUndefined()
  })
})

describe('default reducer — min-visible hold', () => {
  it('settled but inside min-visible → still pending', () => {
    const prev = PENDING_AT(2000)
    const next = defaultDisplayState(
      prev,
      ctx({
        field: field({ valid: true, dirty: true, blurredAfterInteraction: true }),
        validatingSince: null,
        now: 2000 + minVisible - 1,
      })
    )
    expect(next.display).toBe('pending')
    expect(next.pendingShownAt).toBe(2000)
    expect(next.reviewAt).toBe(2000 + minVisible)
  })

  it('once min-visible elapses → the settled verdict is released', () => {
    const prev = PENDING_AT(2000)
    const next = defaultDisplayState(
      prev,
      ctx({
        field: field({ valid: true, blank: false, dirty: true, blurredAfterInteraction: true }),
        validatingSince: null,
        now: 2000 + minVisible,
      })
    )
    expect(next.display).toBe('success')
    expect(next.reviewAt).toBeUndefined()
  })
})

describe('default reducer — cross-episode continuity', () => {
  it('a new validation starting mid-spinner keeps the spinner anchored (no flicker)', () => {
    const prev = PENDING_AT(2000)
    // A fresh streak opened at 2050, while the spinner from 2000 is still up.
    const next = defaultDisplayState(
      prev,
      ctx({
        field: field({ errors: [ownError], blurredAfterInteraction: true }),
        validatingSince: 2050,
        now: 2050,
      })
    )
    expect(next.display).toBe('pending')
    expect(next.pendingShownAt).toBe(2000)
  })
})

describe('makeDefaultDisplayState — custom timings', () => {
  it('{ showDelay: 0, minVisible: 0 } reproduces immediate, un-held pending (regression bridge)', () => {
    const immediate = makeDefaultDisplayState({ showDelay: 0, minVisible: 0 })
    const opened = immediate(
      { display: 'error' },
      ctx({
        field: field({ errors: [ownError], blurredAfterInteraction: true }),
        validatingSince: 500,
        now: 500,
      })
    )
    expect(opened.display).toBe('pending')
    // min-visible 0 → released the instant validation settles.
    const released = immediate(
      PENDING_AT(500),
      ctx({
        field: field({ errors: [ownError], blurredAfterInteraction: true }),
        validatingSince: null,
        now: 500,
      })
    )
    expect(released.display).toBe('error')
  })

  it('honours a tighter window than the default', () => {
    const tight = makeDefaultDisplayState({ showDelay: 30, minVisible: 90 })
    const gated = field({ errors: [ownError], blurredAfterInteraction: true })
    // Held just before 30ms, pending at 30ms.
    expect(
      tight({ display: 'error' }, ctx({ field: gated, validatingSince: 0, now: 29 })).display
    ).toBe('error')
    const shown = tight({ display: 'error' }, ctx({ field: gated, validatingSince: 0, now: 30 }))
    expect(shown.display).toBe('pending')
    expect(shown.reviewAt).toBe(30 + 90)
  })
})

describe('createDisplayEngine', () => {
  const KEY = 'x' as PathKey

  describe('client', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('evicts terminal idle machines but retains a verdict for the next streak', () => {
      const engine = createDisplayEngine(false)
      // idle → not retained.
      engine.resolve(KEY, ctx({ field: field() }), defaultDisplayState)
      expect(engine.has(KEY)).toBe(false)
      expect(engine.size()).toBe(0)
      // error → retained (so a later show-delay window can hold it).
      engine.resolve(
        KEY,
        ctx({ field: field({ errors: [ownError], blurredAfterInteraction: true }) }),
        defaultDisplayState
      )
      expect(engine.has(KEY)).toBe(true)
      // back to idle → evicted again.
      engine.resolve(KEY, ctx({ field: field() }), defaultDisplayState)
      expect(engine.has(KEY)).toBe(false)
      engine.dispose()
    })

    it('arms exactly one timer for a field inside the show-delay window', () => {
      const engine = createDisplayEngine(false)
      engine.resolve(
        KEY,
        ctx({
          field: field({ errors: [ownError], blurredAfterInteraction: true }),
          validatingSince: 0,
          now: 0,
        }),
        defaultDisplayState
      )
      expect(engine.hasTimer()).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
      engine.dispose()
      expect(engine.hasTimer()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('clear() drops machines and cancels the timer', () => {
      const engine = createDisplayEngine(false)
      engine.resolve(
        KEY,
        ctx({
          field: field({ errors: [ownError], blurredAfterInteraction: true }),
          validatingSince: 0,
          now: 0,
        }),
        defaultDisplayState
      )
      expect(engine.size()).toBe(1)
      expect(engine.hasTimer()).toBe(true)
      engine.clear()
      expect(engine.size()).toBe(0)
      expect(engine.hasTimer()).toBe(false)
    })
  })

  describe('ssr', () => {
    it('never stores a machine or arms a timer', () => {
      const engine = createDisplayEngine(true)
      // Even a ctx the reducer would turn into a held spinner stores nothing.
      const machine = engine.resolve(
        KEY,
        ctx({
          field: field({ errors: [ownError], blurredAfterInteraction: true }),
          validatingSince: 0,
          now: showDelay,
        }),
        defaultDisplayState
      )
      expect(machine.display).toBe('pending') // the reducer still computes
      expect(engine.size()).toBe(0) // but the engine persists nothing
      expect(engine.has(KEY)).toBe(false)
      expect(engine.hasTimer()).toBe(false)
    })
  })
})

describe('createDisplayEngine — untrusted reducer reviewAt (robustness)', () => {
  // `getDisplayState` is consumer-overridable; a custom predicate can return a
  // pathological `reviewAt` (bad arithmetic → NaN/Infinity, a unit slip → a
  // huge value, a fixed/past timestamp). The try/catch in field-state-api only
  // covers THROWS — a bad RETURN value must not reach setTimeout and spin the
  // engine. None of these arise from the library default.
  const KEY = 'x' as PathKey
  const gated = () => field({ blurredAfterInteraction: true })

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ignores a NaN reviewAt — never armed into setTimeout', () => {
    const engine = createDisplayEngine(false)
    const bad: GetDisplayState = () => ({ display: 'pending', reviewAt: NaN })
    engine.resolve(KEY, ctx({ field: gated(), validatingSince: 0, now: 0 }), bad)
    expect(engine.hasTimer()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    engine.dispose()
  })

  it('ignores an Infinity reviewAt', () => {
    const engine = createDisplayEngine(false)
    const bad: GetDisplayState = () => ({ display: 'pending', reviewAt: Infinity })
    engine.resolve(KEY, ctx({ field: gated(), validatingSince: 0, now: 0 }), bad)
    expect(engine.hasTimer()).toBe(false)
    engine.dispose()
  })

  it('drops an idle machine kept alive only by a non-finite reviewAt', () => {
    const engine = createDisplayEngine(false)
    const bad: GetDisplayState = () => ({ display: 'idle', reviewAt: NaN })
    engine.resolve(KEY, ctx({ field: gated(), validatingSince: 0, now: 0 }), bad)
    expect(engine.has(KEY)).toBe(false)
    expect(engine.size()).toBe(0)
    engine.dispose()
  })

  it('clamps an over-large finite reviewAt below the setTimeout overflow (no immediate fire)', () => {
    const engine = createDisplayEngine(false)
    const farFuture: GetDisplayState = (_p, c) => ({ display: 'pending', reviewAt: c.now + 1e15 })
    engine.resolve(KEY, ctx({ field: gated(), validatingSince: 0, now: 0 }), farFuture)
    expect(engine.hasTimer()).toBe(true)
    // A normal advance must NOT fire it — an un-clamped 1e15 ms would overflow
    // a 32-bit setTimeout and fire almost immediately, then re-arm and loop.
    vi.advanceTimersByTime(10_000)
    expect(engine.hasTimer()).toBe(true)
    engine.dispose()
  })

  it('refuses to re-arm for the exact deadline it just fired — no fire loop', () => {
    const engine = createDisplayEngine(false)
    let calls = 0
    // A misbehaving predicate that re-emits the same past deadline forever.
    const stuck: GetDisplayState = () => {
      calls++
      return { display: 'pending', reviewAt: 500 }
    }
    const scope = effectScope()
    scope.run(() => {
      // A sync effect stands in for the field-state computed: a `tick` bump
      // re-invokes `resolve`, which is exactly the loop vector in production.
      watchEffect(
        () => {
          engine.resolve(KEY, ctx({ field: gated(), validatingSince: 0, now: 1000 }), stuck)
        },
        { flush: 'sync' }
      )
    })
    // The first (0-delay) timer fires once; the forward-progress guard then
    // refuses to re-arm for the same deadline. Without it this loops until
    // vitest aborts at its 10k-timer ceiling.
    vi.advanceTimersByTime(1000)
    expect(calls).toBeLessThanOrEqual(3)
    expect(engine.hasTimer()).toBe(false)
    scope.stop()
    engine.dispose()
  })
})
