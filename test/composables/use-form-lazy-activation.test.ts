// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { wait, waitUntil } from '../utils/form-harness'

/**
 * Lazy activation contract for `useForm`. The factory passed via
 * function-form `defaultValues` does NOT fire on mount; it fires only
 * when something reactively interacts with the form. The activation
 * rule covers every public getter and method except `form.key`.
 *
 * Touch-points covered here:
 *  - dormant form (no interaction) → factory never fires
 *  - reading `form.key` only → factory still does not fire
 *  - reading `form.values.<path>` → fires factory
 *  - reading `form.fields.<path>` → fires factory
 *  - reading `form.meta.<anything>` → fires factory
 *  - reading `form.errors` → fires factory
 *  - reading `form.hydrating` → fires factory
 *  - reading `form.hydrateError` → fires factory
 *  - reading `form.ready` → fires factory
 *  - calling `form.setValue(...)` → fires factory
 *  - calling `form.register(...)` → fires factory
 *  - calling `form.handleSubmit(...)` → fires factory
 */

const schema = z.object({ email: z.string(), name: z.string() })

type Shape = z.output<typeof schema>
type CapturedForm = UseFormReturnType<Shape>

function mountInert(factoryBody: () => Promise<Shape>): {
  app: App
  api: CapturedForm
  calls: { count: number }
} {
  const captured: { api?: CapturedForm } = {}
  const calls = { count: 0 }
  const counter = (): Promise<Shape> => {
    calls.count += 1
    return factoryBody()
  }
  const App = defineComponent({
    setup() {
      const form = useForm({
        schema,
        key: `lazy-${Math.random().toString(36).slice(2)}`,
        defaultValues: counter,
      })
      captured.api = form as unknown as CapturedForm
      // Template renders no form state — keeps the form dormant unless
      // the test body explicitly touches it.
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, api: captured.api as CapturedForm, calls }
}

describe('useForm — lazy activation', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('dormant form: factory does not fire on mount or after microtask flush', async () => {
    const { app, calls } = mountInert(() => Promise.resolve({ email: 'fetched@x.io', name: 'Z' }))
    apps.push(app)
    // Drain any historical microtask defer window so a residual fire
    // would show up here, not on a later expect.
    await wait(30)
    expect(calls.count).toBe(0)
  })

  it('reading form.key alone does not activate', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    expect(api.key).toMatch(/^lazy-/)
    await wait(30)
    expect(calls.count).toBe(0)
  })

  it('reading form.values activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.values.email
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('reading form.fields activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.fields.email
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('reading form.meta activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.meta.valid
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('reading form.errors activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.errors
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('reading form.hydrating activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.hydrating
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('reading form.hydrateError activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.hydrateError
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('reading form.ready activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void (api as unknown as { ready: boolean }).ready
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('calling form.setValue activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    api.setValue('email', 'typed@x.io')
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('calling form.register activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.register('email')
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })

  it('calling form.handleSubmit activates the factory', async () => {
    const { app, api, calls } = mountInert(() => Promise.resolve({ email: 'a@b', name: 'A' }))
    apps.push(app)
    await wait(20)
    expect(calls.count).toBe(0)
    void api.handleSubmit(() => {})
    await waitUntil(() => (calls.count >= 1 ? true : null))
    expect(calls.count).toBe(1)
  })
})
