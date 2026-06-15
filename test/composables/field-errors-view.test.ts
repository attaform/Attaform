// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { z } from 'zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `form.errors` is a leaf-aware drillable callable Proxy. At leaf paths
 * it terminates with `ValidationError[] | undefined`; at container
 * paths it descends without exposing leaf-keys. The "give me every
 * error" need is served by `form.meta.errors` (flat array).
 *
 *   <template>
 *     {{ form.errors.email?.[0]?.message }}        ✅ leaf access
 *     {{ form.errors('email')?.[0]?.message }}     ✅ callable form
 *     {{ form.errors['nested.path'] }}             ❌ NOT supported (single-bracket dotted)
 *     {{ form.errors.nested.path }}                ✅ chained access
 *     {{ form.errors.value.email }}                ❌ no `.value` — proxy unwraps automatically
 *   </template>
 */

const schema = z.object({
  email: z.string().email('bad email'),
  password: z.string().min(8, 'min 8 chars'),
})

type Api = UseFormReturn<typeof schema>

function mount(): { app: App; api: Api } {
  const handle: { api?: Api } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({ schema, key: 'fielderrs-view', strict: false })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  return { app, api: handle.api as Api }
}

describe('form.errors — leaf-aware drillable proxy', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('reads errors via direct dot-access at a leaf path', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])

    expect(api.errors.email?.[0]?.message).toBe('bad email')
  })

  it('returns undefined at a leaf with no errors', () => {
    const { app, api } = mount()
    apps.push(app)

    expect(api.errors.email).toEqual([])
  })

  it('reflects updates after setErrors / clearErrors', () => {
    const { app, api } = mount()
    apps.push(app)

    expect(api.errors.email).toEqual([])

    api.setErrors([{ path: ['email'], message: 'taken', code: 'api:validation' }])
    expect(api.errors.email?.[0]?.message).toBe('taken')

    api.clearErrors('email')
    expect(api.errors.email).toEqual([])
  })

  it('container paths materialise the underlying error tree (not opaque {})', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])

    // Model shape: the root container emits a nested map keyed by leaf path.
    const root = JSON.parse(JSON.stringify(api.errors))
    expect(root).toMatchObject({
      email: [{ message: 'bad email', path: ['email'] }],
    })
    // Sanity: the same data also surfaces flat through `form.meta.errors`.
    expect(api.meta.errors).toHaveLength(1)
    expect(api.meta.errors[0]?.message).toBe('bad email')
  })
})

describe('form.errors — callable form', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('callable with a dotted-string path returns the same as dot-access', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])

    const dotted = api.errors.email
    const called = (api.errors as unknown as (p: string) => unknown)('email')
    expect(called).toEqual(dotted)
  })

  it('callable with no arg returns the form-level error aggregate', () => {
    // `form.errors()` returns the aggregated errors at the root path
    // (same data `form.meta.errors` exposes). `undefined` when no
    // errors; readonly array otherwise.
    const { app, api } = mount()
    apps.push(app)

    const root = (api.errors as unknown as () => unknown)()
    expect(root).toEqual([])
  })

  it('callable with an array path resolves the same as dotted-string', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])

    const fromArray = (api.errors as unknown as (p: readonly string[]) => unknown)(['email'])
    const fromDotted = (api.errors as unknown as (p: string) => unknown)('email')
    expect(fromArray).toEqual(fromDotted)
  })
})

describe('form.errors — readonly contract', () => {
  const apps: App[] = []

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('ignores direct property assignment at a leaf (warn-and-noop)', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])

    // PASS2-4: writes through the readonly proxy warn-and-noop instead
    // of throwing `TypeError` under strict mode. The actual readonly
    // guarantee is the absence of any mutation — pinned by the entry
    // surviving below.
    expect(() => {
      // @ts-expect-error — runtime proves the trap matches the type promise.
      api.errors.email = []
    }).not.toThrow()

    // Underlying entry survives.
    expect(api.errors.email?.[0]?.message).toBe('bad email')
  })

  it('ignores delete at a leaf (warn-and-noop)', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])

    expect(() => {
      // @ts-expect-error — runtime proves the trap matches the type promise.
      delete api.errors.email
    }).not.toThrow()

    expect(api.errors.email?.[0]?.message).toBe('bad email')
  })
})

describe('form.errors — reactivity in render scope', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a component reading form.errors.email re-renders when the entry changes', async () => {
    let api!: Api
    let renderedMessage = ''
    const Reader = defineComponent({
      setup() {
        api = useForm({ schema, key: 'fielderrs-reactive', strict: false })
        return () => {
          renderedMessage = api.errors.email?.[0]?.message ?? ''
          return h('div', renderedMessage)
        }
      },
    })
    const app = createApp(Reader).use(createAttaform())
    apps.push(app)
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)

    expect(renderedMessage).toBe('')

    api.setErrors([{ path: ['email'], message: 'bad email', code: 'api:validation' }])
    await nextTick()
    expect(renderedMessage).toBe('bad email')

    api.clearErrors('email')
    await nextTick()
    expect(renderedMessage).toBe('')
  })

  // End-to-end coverage for the "Simulate API 400" flow: a server's
  // ValidationError[] handed straight to setErrors, then read back
  // through form.errors.<path>. No adapter step — the lenient input
  // shape accepts the server's entries directly.
  it('setErrors → form.errors renders the injected messages', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([
      { path: ['email'], message: 'Email is reserved.', code: 'api:unknown' },
      { path: ['password'], message: 'Profanity filter rejected this.', code: 'api:unknown' },
    ])

    expect(api.errors.email?.[0]?.message).toBe('Email is reserved.')
    expect(api.errors.email?.[0]?.code).toBe('api:unknown')
    expect(api.errors.password?.[0]?.message).toBe('Profanity filter rejected this.')
  })

  it('scoped setErrors(path, …) renders at that field with its code', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors('email', [{ message: 'taken', code: 'api:server-validation' }])

    expect(api.errors.email?.[0]?.message).toBe('taken')
    expect(api.errors.email?.[0]?.code).toBe('api:server-validation')
  })

  it('getter-form `watch` fires on entry changes', async () => {
    const { app, api } = mount()
    apps.push(app)

    const observed: (string | undefined)[] = []
    const stop = vi.fn()
    const { watch } = await import('vue')
    const watcher = watch(
      () => api.errors.email?.[0]?.message,
      (next) => {
        observed.push(next)
      }
    )

    api.setErrors([{ path: ['email'], message: 'first', code: 'api:validation' }])
    await nextTick()

    api.setErrors([{ path: ['email'], message: 'second', code: 'api:validation' }])
    await nextTick()

    api.clearErrors('email')
    await nextTick()

    watcher()
    stop()

    expect(observed).toEqual(['first', 'second', undefined])
  })
})
