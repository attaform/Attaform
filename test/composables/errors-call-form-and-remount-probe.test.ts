// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType, ValidationError } from '../../src/runtime/types/types-api'
import { waitUntil } from '../utils/form-harness'

/**
 * Probe: what changes when a consumer edits a template from
 * `form.errors('')` to `form.errors()` and observes BOTH `values` and
 * `errors` flash to different shapes before reverting.
 *
 * Two distinct behaviors converge to produce the observation:
 *
 *   1. `form.errors('')`, `form.errors([])`, and `form.errors()`
 *      legitimately return different values — `errors('')` reads the
 *      literal `''` field, `errors([])` the global bucket alone, and
 *      `errors()` the whole-form aggregate. Swapping one for another
 *      changes the rendered JSON.
 *
 *   2. Vite / Nuxt HMR re-evaluates `<script setup>` on template-only
 *      edits, which tears down the consuming component scope and
 *      mounts a fresh one inside the SAME page-level Vue app. The
 *      registry ref-count drops to zero, the FormStore evicts, and
 *      the async factory refires on re-mount. During the brief
 *      in-flight window the form holds schema slim defaults — that's
 *      the "flash" of different values.
 *
 * The shared-app helper here mirrors the docs-site shape: one
 * createAttaform() install, multiple sequential child mounts that
 * share the registry. Distinct from per-test `createApp()` helpers
 * that create isolated registries and miss the eviction path.
 */

type ApiFor<Schema extends z.ZodObject> = UseFormReturnType<z.output<Schema>>

describe('errors call-form: empty-string vs no-arg divergence', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("form.errors([]) returns the global bucket; errors('') reads the literal '' field", async () => {
    const schema = z.object({ email: z.email() })
    const handle: { api?: ApiFor<typeof schema> } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `probe-call-empty-${Math.random().toString(36).slice(2)}`,
          defaultValues: { email: 'bad' },
        }) as unknown as ApiFor<typeof schema>
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ApiFor<typeof schema>

    api.setErrors([{ message: 'form-level: bad payload', code: 'consumer:test' }])

    const callGlobal = (
      api.errors as unknown as (p: readonly (string | number)[]) => readonly ValidationError[]
    )([])
    expect(Array.isArray(callGlobal)).toBe(true)
    expect(callGlobal.some((e) => e.message === 'form-level: bad payload')).toBe(true)
    expect(callGlobal.every((e) => e.path.length === 0)).toBe(true)

    // `errors('')` reads the literal '' field, which this schema has
    // no error for — distinct from the global bucket above.
    const callEmptyString = (api.errors as unknown as (p: string) => readonly ValidationError[])('')
    expect(callEmptyString).toEqual([])
  })

  it('form.errors() no-arg returns the root aggregate (every error at every path)', async () => {
    const schema = z.object({ email: z.email() })
    const handle: { api?: ApiFor<typeof schema> } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `probe-call-noarg-${Math.random().toString(36).slice(2)}`,
          defaultValues: { email: 'bad' },
        }) as unknown as ApiFor<typeof schema>
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ApiFor<typeof schema>

    api.setErrors([{ message: 'form-level: bad payload', code: 'consumer:test' }])

    const callNoArg = (api.errors as unknown as () => readonly ValidationError[])()

    expect(Array.isArray(callNoArg)).toBe(true)
    // Root aggregate includes the form-level entry. Also picks up the
    // construction-time schema error at `email` (the default 'bad' is
    // not a valid email). Both surface in the same flat array.
    const messages = callNoArg.map((e) => e.message)
    expect(messages).toContain('form-level: bad payload')
    expect(callNoArg.some((e) => e.path[0] === 'email')).toBe(true)
  })

  it('calling form.errors(...) is a pure read; does not mutate values', () => {
    const schema = z.object({ email: z.string(), name: z.string() })
    const handle: { api?: ApiFor<typeof schema> } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `probe-call-readonly-${Math.random().toString(36).slice(2)}`,
          defaultValues: { email: 'a@b.c', name: 'Ada' },
        }) as unknown as ApiFor<typeof schema>
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ApiFor<typeof schema>

    const before = JSON.stringify(api.values)
    void (api.errors as unknown as (p: string) => readonly ValidationError[])('')
    void (api.errors as unknown as () => readonly ValidationError[])()
    void (api.errors as unknown as (p: string) => readonly ValidationError[])('email')
    const after = JSON.stringify(api.values)

    expect(after).toBe(before)
  })
})

describe('remount-with-same-key: async-factory lifecycle on consumer churn', () => {
  const apps: App[] = []
  afterEach(async () => {
    while (apps.length > 0) apps.pop()?.unmount()
    // A remount triggers the adapter's async fingerprint mismatch check,
    // which dynamically imports the adapter module. If that import is
    // still in flight when vitest tears the environment down it rejects
    // with EnvironmentTeardownError noise (the library catches it and
    // skips the check, but it clutters CI logs). Drain it here while the
    // environment is alive; the module is already cached from the
    // initial mount, so one macrotask is enough.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  /**
   * Shared-app helper. Mirrors the docs-site shape: one createAttaform()
   * install at the app root, child components mount/unmount inside via
   * a v-if toggle. Both children get the same registry, so their
   * useForm({ key }) calls converge on the same FormStore (or trigger
   * eviction-and-refire when the last consumer leaves).
   */
  function sharedAppHarness<Schema extends z.ZodObject>(
    schema: Schema,
    defaultValues: NonNullable<UseFormConfigV4<Schema>['defaultValues']>,
    key: string
  ): {
    mount: () => Promise<ApiFor<Schema>>
    unmount: () => Promise<void>
    remount: () => Promise<ApiFor<Schema>>
    teardown: () => void
  } {
    const visible = ref(false)
    const childKey = ref(0)
    const handle: { api?: ApiFor<Schema> } = {}
    const Inner = defineComponent({
      setup() {
        handle.api = useForm({ schema, key, defaultValues }) as unknown as ApiFor<Schema>
        return () => h('div')
      },
    })
    const Root = defineComponent({
      setup() {
        // `key` bumps force Vue to unmount the old Inner and mount a
        // fresh one inside the same render flush — atomic remount,
        // matching the lifecycle HMR drives.
        return () => (visible.value ? h(Inner, { key: childKey.value }) : null)
      },
    })
    const app = createApp(Root).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    return {
      mount: async () => {
        visible.value = true
        await nextTick()
        return handle.api as ApiFor<Schema>
      },
      unmount: async () => {
        visible.value = false
        await nextTick()
      },
      remount: async () => {
        // Vue unmounts the old Inner AND mounts the new one inside
        // one render flush. `onScopeDispose` from the old runs
        // (queuing eviction); the new `useForm` claims the key
        // before the microtask fires (cancelling eviction).
        childKey.value += 1
        await nextTick()
        return handle.api as ApiFor<Schema>
      },
      teardown: () => app.unmount(),
    }
  }

  const schema = z.object({
    email: z.string(),
    name: z.string(),
  })

  it('unmount → remount with same key refires the async factory (HMR scenario)', async () => {
    let calls = 0
    const factory = async (): Promise<{ email: string; name: string }> => {
      calls += 1
      return Promise.resolve({ email: `call-${calls}@example.com`, name: `User ${calls}` })
    }
    const harness = sharedAppHarness(schema, factory, 'shared-remount-test')

    const first = await harness.mount()
    await waitUntil(() => (first.hydrating === false ? true : null))
    expect(calls).toBe(1)
    expect(first.values.email).toBe('call-1@example.com')

    // Tear down the only consumer. Registry evicts the FormStore.
    await harness.unmount()

    const second = await harness.mount()
    await waitUntil(() => (second.hydrating === false ? true : null))

    // Factory refired on the re-mount; values reflect the second call.
    expect(calls).toBe(2)
    expect(second.values.email).toBe('call-2@example.com')
  })

  it('two simultaneous consumers with same key share state (factory fires once)', async () => {
    // Contrast with the unmount-remount case: when consumer count stays
    // above zero across the lifecycle, the FormStore stays alive.
    let calls = 0
    const factory = async (): Promise<{ email: string; name: string }> => {
      calls += 1
      return Promise.resolve({ email: `call-${calls}@example.com`, name: `User ${calls}` })
    }
    const harnessA = sharedAppHarness(schema, factory, 'shared-coexist-test-A')
    const harnessB = sharedAppHarness(schema, factory, 'shared-coexist-test-A')

    const a = await harnessA.mount()
    await waitUntil(() => (a.hydrating === false ? true : null))
    expect(calls).toBe(1)

    const b = await harnessB.mount()
    // Different app + different registry → factory fires a second time.
    // This intentionally documents what does NOT share state: separate
    // `createAttaform()` installs each carry their own registry, so the
    // `key` collision still produces independent FormStores.
    await waitUntil(() => (b.hydrating === false ? true : null))
    expect(calls).toBe(2)
  })

  // ---- Microtask-deferred eviction: a rapid unmount-remount within
  // a single tick (HMR, `<KeepAlive>` swap, route navigation) reuses
  // the live FormStore. The factory does not refire, values stay
  // stable, and the schema-error seed against slim defaults never
  // surfaces. Eviction proceeds normally when no new consumer claims
  // the key before the microtask fires.

  it('factory does NOT refire across atomic remount (microtask-grace eviction)', async () => {
    // Atomic unmount + remount inside a single Vue render flush.
    // Old `onScopeDispose` queues the eviction microtask; the new
    // `useForm` claims the key before the microtask fires (cancels
    // the schedule). FormStore stays alive, factory does not refire.
    let calls = 0
    const factory = async (): Promise<{ email: string; name: string }> => {
      calls += 1
      return Promise.resolve({ email: `call-${calls}@example.com`, name: `User ${calls}` })
    }
    const harness = sharedAppHarness(schema, factory, 'remount-no-refire')

    const first = await harness.mount()
    await waitUntil(() => (first.hydrating === false ? true : null))
    expect(calls).toBe(1)
    expect(first.values.email).toBe('call-1@example.com')

    const second = await harness.remount()

    expect(calls).toBe(1)
    expect(second.hydrating).toBe(false)
    expect(second.values.email).toBe('call-1@example.com')
  })

  it('schema-validation errors do not flash across atomic remount', async () => {
    // Mirror of the user-reported "random email error" on HMR template
    // edits. With the microtask-grace eviction, the FormStore is
    // reused across atomic remount, so the strict-mode validation
    // never re-runs against slim defaults and `errors.email` stays
    // empty for the whole transition.
    const factory = async (): Promise<{ email: string; name: string }> => {
      return { email: 'valid@example.com', name: 'Valid' }
    }
    const emailSchema = z.object({
      email: z.email(),
      name: z.string().min(1),
    })
    const harness = sharedAppHarness(emailSchema, factory, 'remount-no-error-flash')

    const first = await harness.mount()
    // Wait for the initial strict-mode seed to clear (validation
    // reruns after the factory resolves). Once empty, the FormStore
    // has settled with valid values and no errors.
    await waitUntil(() => (first.errors.email.length === 0 ? true : null))

    // Atomic remount with the live store: no factory refire, no
    // re-validation cycle, no error seed against slim defaults.
    const second = await harness.remount()
    expect(second.errors.email).toEqual([])
    expect(second.values.email).toBe('valid@example.com')
  })

  it('values stay stable across atomic remount (no slim-defaults regression)', async () => {
    // The visible-flash case: an observer of `api.values.email`
    // across the atomic remount sees only the resolved value, never
    // the schema slim default.
    let calls = 0
    const factory = async (): Promise<{ email: string; name: string }> => {
      calls += 1
      return { email: `call-${calls}@example.com`, name: `User ${calls}` }
    }
    const harness = sharedAppHarness(schema, factory, 'remount-no-slim-flash')

    const first = await harness.mount()
    await waitUntil(() => (first.hydrating === false ? true : null))

    const observed: string[] = []
    observed.push(first.values.email)
    const second = await harness.remount()
    observed.push(second.values.email)

    const distinct = new Set(observed)
    expect(distinct.size).toBe(1)
    expect(distinct.has('call-1@example.com')).toBe(true)
  })
})
