/**
 * Shared mount harness for tests that exercise the runtime form
 * pipeline (directive, store, persistence). Centralises the
 * `createApp + useForm + plugin install + mount` boilerplate so
 * test files don't reimplement it.
 *
 * Parameterised on `useFormFn` so v3 and v4 callers can pass their
 * own typed import without the harness coupling to either zod major.
 */
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createAttaform } from '../../src/runtime/core/plugin'
import { PERSISTENCE_MODULE_KEY } from '../../src/runtime/core/persistence'

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
 * Poll `predicate` until it returns a non-null / non-undefined value
 * or the timeout elapses. Returns the resolved value, or `null` if
 * the deadline passed.
 *
 * Use this for any wait-then-assert pattern that depends on async
 * I/O — debounced storage writes, dynamic-imported persistence
 * adapters, async Zod refinements. The classic alternative
 * (`await wait(40); expect(...)`) silently flakes when the chain
 * exceeds the fixed budget under CI contention.
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
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = predicate()
    if (v !== null && v !== undefined) return v
    if (Date.now() >= deadline) return null
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

/**
 * Wait until every persist-configured form mounted on `app` has wired
 * its lazily-imported persistence chunk.
 *
 * Persistence is dynamically imported off the always-on `useForm` path,
 * so the `onFormChange` subscription that drives draft writes attaches a
 * few microtasks after mount — once the chunk resolves. A test that
 * dispatches an input event before then is modelling a keystroke faster
 * than a real user can physically produce (the chunk loads long before
 * a human sees the form and presses a key), so it must establish first.
 *
 * Keyless on purpose: it awaits the `ready` promise of every form's
 * persistence handle in the app's registry, so single-form and
 * multi-form tests share one call. A form mounted without `persist:`
 * sets no handle and is simply skipped.
 */
export async function waitForPersistence(app: App): Promise<void> {
  const reg = (
    app as unknown as {
      _attaform?: { forms: Map<string, { modules: Map<string, unknown> }> }
    }
  )._attaform
  if (reg === undefined) return
  await waitUntil(() => (reg.forms.size > 0 ? true : null))
  const readies: Promise<unknown>[] = []
  for (const state of reg.forms.values()) {
    const handle = state.modules.get(PERSISTENCE_MODULE_KEY) as
      | { ready: Promise<unknown> }
      | undefined
    if (handle !== undefined) readies.push(handle.ready)
  }
  await Promise.all(readies)
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
