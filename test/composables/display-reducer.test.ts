import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIMINGS, defaultDisplayState, makeDefaultDisplayState } from '../../src'
import type { DisplayCtx, DisplayMachine, ValidationError } from '../../src'
import { createDisplayEngine } from '../../src/runtime/core/display-engine'
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
    focused: false,
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
  return { field: field(), formMeta: meta(), validatingSince: null, now: 0, ...over }
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

  it('holds a SUCCESS verdict through the window (no success → idle flicker)', () => {
    // The in-flight field reads `valid: false` purely because a check is
    // running; the reducer must hold the prior `success`, not recompute idle.
    const prev: DisplayMachine = { display: 'success' }
    const inFlight = field({ valid: false, blurredAfterInteraction: true })
    const next = defaultDisplayState(
      prev,
      ctx({ field: inFlight, validatingSince: 1000, now: 1050 })
    )
    expect(next.display).toBe('success')
    expect(next.reviewAt).toBe(1000 + showDelay)
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
