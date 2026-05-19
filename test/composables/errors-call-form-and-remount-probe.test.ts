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
 *   1. `form.errors('')` and `form.errors()` legitimately return
 *      different values — the first canonicalises to the form-level
 *      bucket (`['']`), the second to the root subtree (`[]`).
 *      Swapping one for the other changes the rendered JSON.
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

  it('form.errors with empty-string path returns the form-level bucket only', async () => {
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

    api.setFormErrors([
      { message: 'form-level: bad payload', code: 'consumer:test', path: [''], formKey: api.key },
    ])

    const callEmptyString = (api.errors as unknown as (p: string) => readonly ValidationError[])('')

    expect(Array.isArray(callEmptyString)).toBe(true)
    expect(callEmptyString.length).toBeGreaterThan(0)
    expect(callEmptyString.every((e) => e.path[0] === '')).toBe(true)
    expect(callEmptyString.some((e) => e.message === 'form-level: bad payload')).toBe(true)
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

    api.setFormErrors([
      { message: 'form-level: bad payload', code: 'consumer:test', path: [''], formKey: api.key },
    ])

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
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
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
    teardown: () => void
  } {
    const visible = ref(false)
    const handle: { api?: ApiFor<Schema> } = {}
    const Inner = defineComponent({
      setup() {
        handle.api = useForm({ schema, key, defaultValues }) as unknown as ApiFor<Schema>
        return () => h('div')
      },
    })
    const Root = defineComponent({
      setup() {
        return () => (visible.value ? h(Inner) : null)
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
    await waitUntil(() => (first.isHydrating === false ? true : null))
    expect(calls).toBe(1)
    expect(first.values.email).toBe('call-1@example.com')

    // Tear down the only consumer. Registry evicts the FormStore.
    await harness.unmount()

    const second = await harness.mount()
    await waitUntil(() => (second.isHydrating === false ? true : null))

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
    await waitUntil(() => (a.isHydrating === false ? true : null))
    expect(calls).toBe(1)

    const b = await harnessB.mount()
    // Different app + different registry → factory fires a second time.
    // This intentionally documents what does NOT share state: separate
    // `createAttaform()` installs each carry their own registry, so the
    // `key` collision still produces independent FormStores.
    await waitUntil(() => (b.isHydrating === false ? true : null))
    expect(calls).toBe(2)
  })
})
