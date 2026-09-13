/**
 * Timer compression for the docs-demos smoke suite.
 *
 * Fifteen demos under `apps/site/docs-demos/**` simulate server latency
 * with a real `setTimeout`, from 350ms up to 1200ms, ~8.6 seconds in
 * total. That delay exists so a human reading the docs can watch a
 * pending state appear; it teaches nothing to a test that only asserts
 * the settled DOM, and the suite pays it on every CI job.
 *
 * It also made the suite's slowest case indistinguishable from a
 * broken one. `async-refinements` settles in 701-709ms locally
 * (measured over 40 consecutive runs, 8ms of spread, and identical
 * under coverage instrumentation because a real timer does not care
 * about CPU load). Its wait budget is 5000ms. The only way to exceed
 * that is a multi-second event-loop stall on a contended runner, so a
 * timeout there said "this runner was starved" and "this pipeline is
 * broken" in exactly the same voice, and the response twice was to
 * raise the ceiling.
 *
 * Compressing the delay removes that ambiguity rather than hiding it.
 * Once the demo's cosmetic 700ms is 70ms, a subsequent timeout cannot
 * be explained by slowness, so it means a genuine hang and should be
 * read as one. The async path still runs asynchronously: same promise,
 * same macrotask, same ordering, same pending states. Only the
 * duration changes.
 *
 * Scaled rather than clamped to a constant, because a demo can stage
 * two delays whose ORDER is the point (`autosave` debounces, then
 * saves). Dividing preserves every ordering a constant would flatten.
 */

/**
 * Delays at or above this are treated as simulated network latency.
 *
 * Attaform's own timers sit well below it: `DEFAULT_TIMINGS` is
 * `{ showDelay: 120, minVisible: 120 }` and `debounceMs` defaults to
 * `0`. The smallest demo latency is 350ms. The gap is wide enough in
 * both directions that the runtime's real timing behaviour is never
 * compressed, which is what keeps the smoke test honest about
 * display-state transitions.
 */
const LATENCY_THRESHOLD_MS = 300

/**
 * Divisor applied above the threshold. 700ms becomes 70ms.
 *
 * Chosen so every compressed delay stays clearly ABOVE
 * `FOCUS_OUT_GRACE` (16ms), the window that decides whether a spinner
 * appears after blur. The demos' real delays are all far above it, so
 * keeping the compressed ones above it too means the suite exercises
 * the same display path a human sees: pending appears, then resolves.
 *
 * A larger factor is tempting and wrong. At 50 the smallest demo delay
 * lands on 7ms and the 700ms one on 14ms, straddling the 16ms grace, so
 * whether a spinner appeared became a coin flip per run and the suite's
 * timings went bimodal. Compression is meant to remove wall-clock cost,
 * not to change which branch of the display machine the test takes.
 */
const COMPRESSION_FACTOR = 10

/**
 * Patch `globalThis.setTimeout` so demo-scale delays run compressed,
 * and return the restore function.
 *
 * Install per test and restore afterwards rather than globally: the
 * patch is visible to vitest's own timer use while it is in place, and
 * a suite-wide install would make that permanent.
 *
 * An unqualified `setTimeout(...)` inside a compiled SFC resolves
 * through the scope chain to the global at call time, so replacing the
 * binding here reaches the demos without their knowing.
 */
export function compressDemoLatency(): () => void {
  const original = globalThis.setTimeout

  const patched = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const requested = timeout ?? 0
    const effective =
      requested >= LATENCY_THRESHOLD_MS ? Math.round(requested / COMPRESSION_FACTOR) : requested
    return original(handler, effective, ...args)
  }) as typeof globalThis.setTimeout

  globalThis.setTimeout = patched
  return () => {
    globalThis.setTimeout = original
  }
}

/** Exposed for the helper's own tests. */
export const DEMO_LATENCY_THRESHOLD_MS = LATENCY_THRESHOLD_MS
export const DEMO_LATENCY_COMPRESSION_FACTOR = COMPRESSION_FACTOR
