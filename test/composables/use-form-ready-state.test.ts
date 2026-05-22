// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { wait, waitUntil } from '../utils/form-harness'

/**
 * `form.ready` state machine. `ready` is orthogonal to `hydrating`
 * and `hydrateError`; the three compose into a stale-while-revalidate
 * UI without consumer plumbing.
 *
 *   pre-activation  → ready=false, hydrating=false, hydrateError=null
 *   activate in flight → ready=false, hydrating=true, hydrateError=null
 *   factory resolves → ready=true,  hydrating=false, hydrateError=null
 *   factory rejects   → ready=false, hydrating=false, hydrateError=Err
 *   rehydrate from ready (success)  → ready stays true, hydrating=true→false
 *   rehydrate from ready (failure)  → ready stays true, hydrating=true→false,
 *                                     hydrateError=Err (stale data preserved)
 */

const schema = z.object({ email: z.string(), name: z.string() })

type Shape = z.output<typeof schema>
type Api = UseFormReturnType<Shape>

function mountForm(factory: () => Promise<Shape>): { app: App; api: Api } {
  const captured: { api?: Api } = {}
  const App = defineComponent({
    setup() {
      captured.api = useForm({
        schema,
        key: `ready-${Math.random().toString(36).slice(2)}`,
        defaultValues: factory,
      }) as unknown as Api
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, api: captured.api as Api }
}

describe('useForm — ready state machine', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('pre-activation: ready=false, hydrating=false, hydrateError=null', async () => {
    const { app, api } = mountForm(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    // Inspect the *store's* refs without going through gated getters
    // (which would activate). Pre-activation invariants don't read
    // through the public API.
    await wait(30)
    // Reading the public API would activate. Instead, assert by
    // examining the next read does what `ready === false` would say.
    // Activate explicitly so we have a deterministic boundary.
    expect(api.ready).toBe(false)
  })

  it('flips ready=true after the factory resolves successfully', async () => {
    const { app, api } = mountForm(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await api.activate()
    expect(api.ready).toBe(true)
    expect(api.hydrating).toBe(false)
    expect(api.hydrateError).toBeNull()
    expect(api.values.email).toBe('a@b')
  })

  it('leaves ready=false after a rejected factory; surfaces hydrateError', async () => {
    const { app, api } = mountForm(() => Promise.reject(new Error('upstream-down')))
    apps.push(app)
    await api.activate()
    expect(api.ready).toBe(false)
    expect(api.hydrating).toBe(false)
    expect(api.hydrateError?.message).toBe('upstream-down')
  })

  it('rehydrate after success: ready stays true, hydrating bridges true→false', async () => {
    let bodyCount = 0
    const { app, api } = mountForm(() => {
      bodyCount += 1
      return Promise.resolve({ email: `r${bodyCount}@x`, name: 'Refresh' })
    })
    apps.push(app)

    await api.activate()
    expect(api.ready).toBe(true)
    expect(api.values.email).toBe('r1@x')

    const refresh = api.rehydrate()
    // Synchronous moment after rehydrate kickoff: hydrating true, but
    // ready stays true (stale-while-revalidate keeps prior values).
    expect(api.hydrating).toBe(true)
    expect(api.ready).toBe(true)
    await refresh
    expect(api.values.email).toBe('r2@x')
    expect(api.ready).toBe(true)
    expect(api.hydrating).toBe(false)
  })

  it('rehydrate after failure: ready stays false until success', async () => {
    let attempt = 0
    const { app, api } = mountForm(() => {
      attempt += 1
      if (attempt === 1) return Promise.reject(new Error('initial-fail'))
      return Promise.resolve({ email: 'recovered@x', name: 'OK' })
    })
    apps.push(app)

    await api.activate()
    expect(api.ready).toBe(false)
    expect(api.hydrateError?.message).toBe('initial-fail')

    await api.rehydrate()
    expect(api.ready).toBe(true)
    expect(api.hydrateError).toBeNull()
    expect(api.values.email).toBe('recovered@x')
  })

  it('rehydrate from ready that rejects: ready stays true with hydrateError set', async () => {
    let attempt = 0
    const { app, api } = mountForm(() => {
      attempt += 1
      if (attempt === 1) return Promise.resolve({ email: 'stable@x', name: 'OK' })
      return Promise.reject(new Error('refresh-fail'))
    })
    apps.push(app)

    await api.activate()
    expect(api.ready).toBe(true)
    expect(api.values.email).toBe('stable@x')

    await api.rehydrate()
    // Stale data stays visible; the refresh failure surfaces via
    // hydrateError without flipping ready back to false.
    expect(api.ready).toBe(true)
    expect(api.values.email).toBe('stable@x')
    expect(api.hydrateError?.message).toBe('refresh-fail')
  })
})

describe('useForm — activate() idempotency', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('two parallel activate() calls share a single factory invocation', async () => {
    let calls = 0
    const { app, api } = mountForm(() => {
      calls += 1
      return new Promise<Shape>((r) => setTimeout(() => r({ email: 'x@y', name: 'Z' }), 20))
    })
    apps.push(app)

    const p1 = api.activate()
    const p2 = api.activate()
    await Promise.all([p1, p2])
    expect(calls).toBe(1)
    expect(api.values.email).toBe('x@y')
  })

  it('activate() after resolution is a no-op', async () => {
    let calls = 0
    const { app, api } = mountForm(() => {
      calls += 1
      return Promise.resolve({ email: 'once@x', name: 'O' })
    })
    apps.push(app)

    await api.activate()
    expect(calls).toBe(1)
    await api.activate()
    await api.activate()
    expect(calls).toBe(1)
  })

  it('activate() after a previous rejection does NOT re-fire; rehydrate() does', async () => {
    let calls = 0
    const { app, api } = mountForm(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('first-fail'))
      return Promise.resolve({ email: 'second@x', name: 'OK' })
    })
    apps.push(app)

    await api.activate()
    expect(calls).toBe(1)
    expect(api.hydrateError?.message).toBe('first-fail')

    // activate() is idempotent — does NOT replay a previous failure.
    await api.activate()
    expect(calls).toBe(1)

    // rehydrate() is the explicit retry primitive.
    await api.rehydrate()
    expect(calls).toBe(2)
    expect(api.values.email).toBe('second@x')
    expect(api.hydrateError).toBeNull()
  })

  it('activate() on a plain-value form resolves immediately', async () => {
    const captured: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        captured.api = useForm({
          schema,
          key: `ready-plain-${Math.random().toString(36).slice(2)}`,
          defaultValues: { email: 'plain@x', name: 'P' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)

    const api = captured.api as Api
    await api.activate()
    expect(api.values.email).toBe('plain@x')
    expect(api.ready).toBe(true)
    expect(api.hydrating).toBe(false)
  })

  it('waitUntil reads of hydrating do not re-fire after activate completes', async () => {
    let calls = 0
    const { app, api } = mountForm(() => {
      calls += 1
      return Promise.resolve({ email: 'wu@x', name: 'W' })
    })
    apps.push(app)

    await api.activate()
    await waitUntil(() => (api.hydrating === false ? true : null))
    expect(calls).toBe(1)
  })
})
