/**
 * Shared mount harness for tests that exercise the runtime form
 * pipeline (directive, store, validation). Centralises the
 * `createApp + useForm + plugin install + mount` boilerplate so
 * test files don't reimplement it.
 *
 * Parameterised on `useFormFn` so v3 and v4 callers can pass their
 * own typed import without the harness coupling to either zod major.
 */
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Sleep for `ms` real-time milliseconds. Thin wrapper over
 * `setTimeout` for ergonomic use inside `waitUntil`'s polling loop
 * and for the rare test that legitimately needs a wall-clock pause.
 *
 * Prefer `waitUntil(predicate)` over `wait(N)` followed by an
 * assertion — a fixed-time pump can blow past its budget on a
 * contended CI runner (dynamic-imported adapters, debounced writes,
 * async refinement chains), producing flakes that pass locally and
 * fail intermittently on CI.
 */
export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Render a predicate's own source for a timeout message. The source
 * text is what identifies which wait expired, and it costs the caller
 * nothing: no label argument to thread through hundreds of call sites.
 * Collapsed to one line and capped so a long arrow body cannot bury
 * the rest of the failure output.
 */
function describePredicate(predicate: () => unknown): string {
  const source = predicate.toString().replace(/\s+/g, ' ').trim()
  return source.length > 240 ? `${source.slice(0, 240)}…` : source
}

/**
 * Poll `predicate` until it returns a non-null / non-undefined value.
 * Returns the resolved value, and THROWS when the deadline passes.
 *
 * Use this for any wait-then-assert pattern that depends on async
 * I/O — async Zod refinements and other deferred work. The classic alternative
 * (`await wait(40); expect(...)`) silently flakes when the chain
 * exceeds the fixed budget under CI contention.
 *
 * Expiry throws rather than returning `null` because a silent give-up
 * reports as the wrong failure. `docs-demos-smoke`'s async-refinement
 * case read `expected '' to contain 'taken'`, which describes a value
 * that never arrived as though the pipeline had produced a wrong one,
 * and that mis-signal cost two rounds of ceiling-raising (2000 ms, then
 * 5000 ms) before anyone questioned the budget. A timeout must be
 * legible AS a timeout, naming the budget it blew and the predicate it
 * was polling.
 *
 * To assert that a signal never fires, reach for `assertNeverSettles`.
 * It is the deliberate negative, and it says so at the call site.
 *
 * The default 1000 ms timeout covers in-process work, dynamic-imported
 * adapters, and short async-refinement chains. Raise it for tests
 * that wait on a debounce window plus an external mock with its own
 * latency budget.
 */
export async function waitUntil<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 1000,
  intervalMs = 5
): Promise<T> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let polls = 0
  for (;;) {
    const v = predicate()
    polls += 1
    if (v !== null && v !== undefined) return v
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: timed out after ${Date.now() - startedAt}ms ` +
          `(budget ${timeoutMs}ms, ${polls} polls) waiting for: ` +
          `${describePredicate(predicate)}`
      )
    }
    await wait(intervalMs)
  }
}

/**
 * The deliberate negative: poll `predicate` for `windowMs` and throw
 * the moment it produces a value. Resolving quietly means the signal
 * never fired, which is the contract under test.
 *
 * This is the case `waitUntil` used to serve by returning `null` on
 * expiry, where the timeout WAS the pass condition. Splitting it out
 * lets `waitUntil` treat expiry as the failure it almost always is,
 * and it reads better besides: the call site now states that the
 * signal must not fire instead of leaving that to a comment. It also
 * fails at the moment of the violation rather than at a later
 * assertion, so the error names what fired and when.
 *
 * `label` is required. There is no useful stack at the moment a signal
 * fires early, and the predicate source alone rarely says what the
 * signal MEANS (compare `() => api.errors.email !== undefined` with
 * "lax mode fires the construction-time async seed").
 *
 * Prefer `awaitSettle` when there is no signal to poll on at all.
 */
export async function assertNeverSettles(
  predicate: () => unknown,
  windowMs: number,
  label: string,
  intervalMs = 5
): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + windowMs
  for (;;) {
    const v = predicate()
    if (v !== null && v !== undefined && v !== false) {
      throw new Error(
        `assertNeverSettles: ${label} fired after ${Date.now() - startedAt}ms ` +
          `(window ${windowMs}ms). Predicate: ${describePredicate(predicate)}`
      )
    }
    if (Date.now() >= deadline) return
    await wait(intervalMs)
  }
}

/**
 * Yield twice through Vue's microtask queue so the directive's
 * input/change cycle (handler → gate → reactive patch → DOM sync) has
 * fired. Use for "prove the write was rejected / nothing happened"
 * assertions where there is no positive state change to poll on — a
 * `waitUntil` predicate that's structurally never true burns the full
 * timeout ceiling on every run.
 *
 * Two ticks because the cycle can be: handler fires → schedules a
 * reactive write → first nextTick flushes that write → directive's
 * model→DOM sync watcher runs on the next tick. One yield isn't enough
 * for the round-trip; three would be overkill.
 */
export async function awaitSettle(): Promise<void> {
  await nextTick()
  await nextTick()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

/**
 * Returns a thunk that mounts a fresh Vue app with `useFormFn(opts)`
 * called inside the root component's setup. Each invocation produces
 * an isolated app + form key (random suffix) so tests in the same
 * file don't collide.
 *
 * Defaults `strict: false` because the property tests focus
 * on write-gate semantics, not refinement-time validation. Override
 * via `options` for tests that need strict mode.
 */
export function makeMounter<S>(
  useFormFn: AnyUseForm,
  schema: S,
  options: Record<string, unknown> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): () => { api: any; app: App } {
  return function mount() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captured: { api?: any } = {}
    const App = defineComponent({
      setup() {
        captured.api = useFormFn({
          schema,
          key: `slim-${Math.random().toString(36).slice(2)}`,
          strict: false,
          ...options,
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { api: captured.api as any, app }
  }
}
