import { ref, type Ref } from 'vue'
import type { DisplayCtx, DisplayMachine, GetDisplayState } from '../types/types-api'
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
 * SSR: no clock, no timers. With `now` frozen and nothing validating at
 * render, the reducer returns the plain verdict (never pending) and the
 * engine stores nothing, so the server HTML and the client's first render
 * agree — no hydration mismatch on the display projection.
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
  /** Tear down for good — same as `clear()`, wired to `FormStore.dispose()`. */
  dispose(): void
  /** Introspection for tests: count of retained machines. */
  size(): number
  /** Introspection for tests: whether a path currently has a retained machine. */
  has(key: PathKey): boolean
  /** Introspection for tests: whether a deadline timer is currently armed. */
  hasTimer(): boolean
}

const IDLE: DisplayMachine = Object.freeze({ display: 'idle' })

export function createDisplayEngine(ssr: boolean): DisplayEngine {
  const machines = new Map<PathKey, DisplayMachine>()
  const tick: Ref<number> = ref(0)
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerTarget: number | null = null

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
      if (m.reviewAt === undefined) continue
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
    clearTimer()
    timerTarget = target
    timer = setTimeout(
      () => {
        timer = null
        timerTarget = null
        tick.value++
      },
      Math.max(0, target - now)
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
    const active = machine.display !== 'idle' || machine.reviewAt !== undefined
    if (active) machines.set(key, machine)
    else machines.delete(key)
    rearm(ctx.now)
    return machine
  }

  function clear(): void {
    machines.clear()
    clearTimer()
  }

  return {
    resolve,
    clear,
    dispose: clear,
    size: () => machines.size,
    has: (key) => machines.has(key),
    hasTimer: () => timer !== null,
  }
}
