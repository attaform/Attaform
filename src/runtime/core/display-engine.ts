import { ref, type Ref } from 'vue'
import type { DisplayCtx, DisplayMachine, GetDisplayState } from '../types/types-api'
import { __DEV__ } from './dev'
import type { PathKey } from './paths'

/**
 * Per-form display engine: owns the clock and the timers that the pure
 * `getDisplayState` reducer policy needs, so the reducer itself stays a
 * deterministic `(prev, ctx) => next` function.
 *
 * It keeps a `Map` of the machines that are still *active* (a spinner is
 * showing, a verdict is being held, or a `reviewAt` deadline is pending),
 * a single reactive `tick` ref, and a single `setTimeout` aimed at the
 * nearest `reviewAt` across every active field. When a field-state
 * computed reads `resolve`, it subscribes to `tick`; when the timer
 * fires, `tick` bumps and every dependent computed re-runs the reducer,
 * so a field whose deadline elapsed transitions (verdict → spinner, or
 * spinner → settled verdict) without any per-field watcher.
 *
 * Eviction: a machine is dropped once it reaches a terminal *idle* state
 * with no pending review. Error / success / pending machines are retained
 * so the reducer can hold the prior verdict under the show-delay window of
 * the *next* validation streak (no success → idle → success flicker). The
 * retained set is bounded by the rendered non-idle fields; none of them
 * arm a timer, so retention costs memory, never CPU.
 *
 * Untrusted reducer: `getDisplayState` is consumer-overridable, so the
 * engine treats the returned `reviewAt` as untrusted. A non-finite deadline
 * (NaN / ±Infinity from a custom predicate's bad arithmetic) is ignored
 * rather than handed to `setTimeout`, where it coerces to 0 and spins; an
 * over-large finite deadline is clamped below the 32-bit `setTimeout`
 * overflow; and the timer refuses to re-arm for the exact deadline it just
 * fired, so a predicate re-emitting a fixed or past `reviewAt` can't drive an
 * infinite fire loop. None of these arise from the library default, which
 * always advances its deadline or drops it.
 *
 * Background tabs: `setTimeout` is throttled to >= 1s while a tab is hidden,
 * so a min-visible hold can overshoot. A `visibilitychange` listener bumps
 * the clock on return to the foreground, so any overdue deadline resolves at
 * once instead of lingering.
 *
 * SSR: no clock, no timers, no listener. With `now` frozen and nothing
 * validating at render, the reducer returns the plain verdict (never
 * pending) and the engine stores nothing, so the server HTML and the
 * client's first render agree — no hydration mismatch on the display
 * projection.
 */
export type DisplayEngine = {
  /**
   * Resolve a path's next `DisplayMachine`. Subscribes the calling
   * computed to the engine clock, threads the path's previous machine
   * through `reducer`, persists or evicts the result, and re-arms the
   * single timer to the nearest deadline.
   */
  resolve(key: PathKey, ctx: DisplayCtx, reducer: GetDisplayState): DisplayMachine
  /** Drop every retained machine and cancel the timer (used by `reset()`). */
  clear(): void
  /** Tear down for good: `clear()` plus detaching the visibility listener. */
  dispose(): void
  /** Introspection for tests: count of retained machines. Dev builds only. */
  size?(): number
  /** Introspection for tests: whether a path has a retained machine. Dev builds only. */
  has?(key: PathKey): boolean
  /** Introspection for tests: whether a deadline timer is armed. Dev builds only. */
  hasTimer?(): boolean
}

const IDLE: DisplayMachine = Object.freeze({ display: 'idle' })

// `setTimeout` truncates a delay past 2^31-1 ms to a 32-bit int (firing
// almost immediately); clamp below it so an over-large `reviewAt` waits
// quietly instead of busy-firing.
const MAX_DELAY = 2_147_483_647

export function createDisplayEngine(ssr: boolean): DisplayEngine {
  const machines = new Map<PathKey, DisplayMachine>()
  const tick: Ref<number> = ref(0)
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerTarget: number | null = null
  // The deadline the live timer most recently fired for. The forward-progress
  // guard in `rearm` refuses to re-arm for this exact value, so a reducer that
  // re-emits one fixed `reviewAt` can't drive an infinite fire loop.
  let lastFiredTarget: number | null = null

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
      timerTarget = null
    }
  }

  function nearestReviewAt(): number | null {
    let min: number | null = null
    for (const m of machines.values()) {
      // Ignore an absent or non-finite deadline: a custom reducer may return
      // `reviewAt: NaN` / `Infinity`, which must never reach `setTimeout`.
      if (m.reviewAt === undefined || !Number.isFinite(m.reviewAt)) continue
      if (min === null || m.reviewAt < min) min = m.reviewAt
    }
    return min
  }

  function rearm(now: number): void {
    const target = nearestReviewAt()
    if (target === null) {
      clearTimer()
      return
    }
    // Already aimed at this deadline — leave the live timer alone so a
    // flush that re-resolves many fields doesn't churn clear/set.
    if (timer !== null && timerTarget === target) return
    // Forward-progress guard: never re-arm for the exact deadline we just
    // fired. Legit timing always advances the deadline (show-delay → pending,
    // pending → settled) or drops it, so this only blocks a misbehaving
    // reducer that re-emits a fixed or past `reviewAt`.
    if (target === lastFiredTarget) {
      clearTimer()
      return
    }
    clearTimer()
    timerTarget = target
    timer = setTimeout(
      () => {
        timer = null
        timerTarget = null
        lastFiredTarget = target
        tick.value++
      },
      Math.min(MAX_DELAY, Math.max(0, target - now))
    )
  }

  function resolve(key: PathKey, ctx: DisplayCtx, reducer: GetDisplayState): DisplayMachine {
    // Subscribe the caller's computed to the clock: a fired deadline bumps
    // `tick` and re-invalidates it. Read before the reducer call so the
    // subscription is registered even if the reducer throws.
    void tick.value
    const prev = machines.get(key) ?? IDLE
    const machine = reducer(prev, ctx)
    // Server render: never persist, never schedule. `prev` is always IDLE
    // here (nothing stored), nothing is validating, so `machine` is the
    // plain verdict the client reproduces on hydration.
    if (ssr) return machine
    // Retain anything non-idle, plus an idle machine that still carries a
    // usable (finite) deadline. An idle machine whose only claim to be kept
    // is a non-finite `reviewAt` is junk — evict it.
    const active =
      machine.display !== 'idle' ||
      (machine.reviewAt !== undefined && Number.isFinite(machine.reviewAt))
    if (active) machines.set(key, machine)
    else machines.delete(key)
    rearm(ctx.now)
    return machine
  }

  function clear(): void {
    machines.clear()
    clearTimer()
    lastFiredTarget = null
  }

  // Background tabs throttle `setTimeout` to >= 1s, so a min-visible hold can
  // overshoot when hidden. On return to the foreground, bump the clock so
  // every held machine re-evaluates against the real `now` and any overdue
  // deadline resolves at once. Client-only; SSR keeps no clock to nudge.
  let detachVisibility: (() => void) | null = null
  if (!ssr && typeof document !== 'undefined') {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && machines.size > 0) tick.value++
    }
    document.addEventListener('visibilitychange', onVisible)
    detachVisibility = () => document.removeEventListener('visibilitychange', onVisible)
  }

  function dispose(): void {
    clear()
    if (detachVisibility !== null) {
      detachVisibility()
      detachVisibility = null
    }
  }

  const engine: DisplayEngine = { resolve, clear, dispose }
  if (__DEV__) {
    // Introspection hooks the test suites read; the prod flavor drops
    // them with the flag.
    engine.size = () => machines.size
    engine.has = (key) => machines.has(key)
    engine.hasTimer = () => timer !== null
  }
  return engine
}
