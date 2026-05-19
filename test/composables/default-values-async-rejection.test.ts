// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { waitUntil } from '../utils/form-harness'

/**
 * Function-form `defaultValues` — factory rejection path.
 *
 * When a factory throws or its promise rejects, the form keeps its
 * schema slim defaults and surfaces the error on `form.hydrateError`.
 * `isHydrating` still flips to `false` (the load attempt is done,
 * even if it failed). The form remains fully functional — consumers
 * can show an error banner, offer a retry button, and let users
 * proceed manually.
 */

type ApiFor<Schema extends z.ZodObject> = UseFormReturnType<z.output<Schema>>

function mountForm<Schema extends z.ZodObject>(
  schema: Schema,
  defaultValues: NonNullable<UseFormConfigV4<Schema>['defaultValues']>
): { app: App; api: ApiFor<Schema> } {
  const handle: { api?: ApiFor<Schema> } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema,
        key: `async-defaults-rej-${Math.random().toString(36).slice(2)}`,
        defaultValues,
      }) as unknown as ApiFor<Schema>
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, api: handle.api as ApiFor<Schema> }
}

describe('useForm — function-form defaultValues, rejection path', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  const schema = z.object({
    email: z.string(),
    name: z.string(),
  })

  it('surfaces a thrown sync-factory error on hydrateError', async () => {
    const boom = new Error('fetch failed')
    const factory = (): { email: string; name: string } => {
      throw boom
    }
    const { app, api } = mountForm(schema, factory)
    apps.push(app)
    await waitUntil(() => (api.isHydrating.value === false ? true : null))
    expect(api.hydrateError.value).toBe(boom)
    expect(api.isHydrating.value).toBe(false)
    expect(api.meta.submitError).toBeNull()
  })

  it('surfaces a thrown async-factory error on hydrateError', async () => {
    // `async fn() { throw e }` wraps the throw into a rejected promise
    // at the language level; this test pins that the runtime treats
    // it identically to the explicit `() => Promise.reject(e)` case.
    const boom = new Error('async fetch failed')
    const factory = async (): Promise<{ email: string; name: string }> => {
      throw boom
    }
    const { app, api } = mountForm(schema, factory)
    apps.push(app)
    await waitUntil(() => (api.isHydrating.value === false ? true : null))
    expect(api.hydrateError.value).toBe(boom)
    expect(api.isHydrating.value).toBe(false)
    expect(api.meta.submitError).toBeNull()
  })

  it('surfaces a rejected async-factory promise on hydrateError', async () => {
    const boom = new Error('network down')
    const { app, api } = mountForm(schema, () => Promise.reject(boom))
    apps.push(app)
    await waitUntil(() => (api.isHydrating.value === false ? true : null))
    expect(api.hydrateError.value).toBe(boom)
    expect(api.meta.submitError).toBeNull()
  })

  it('leaves the form usable with schema slim defaults after rejection', async () => {
    const { app, api } = mountForm(schema, () => Promise.reject(new Error('boom')))
    apps.push(app)
    await waitUntil(() => (api.isHydrating.value === false ? true : null))
    expect(api.values.email).toBe('')
    expect(api.values.name).toBe('')
    // Consumers can still mutate the form post-rejection.
    api.setValue('email', 'recover@example.com')
    expect(api.values.email).toBe('recover@example.com')
  })

  it('handleSubmit fires post-rejection so consumers can recover manually', async () => {
    const { app, api } = mountForm(schema, () => Promise.reject(new Error('boom')))
    apps.push(app)
    await waitUntil(() => (api.isHydrating.value === false ? true : null))

    // Consumer fills the form by hand and submits. The mount-time
    // factory failure should not block the submit channel; the form
    // is "broken default load + intact submit pipeline."
    api.setValue('email', 'recover@example.com')
    api.setValue('name', 'Alex')
    const onSubmit = vi.fn()
    const onError = vi.fn()
    await api.handleSubmit(onSubmit, onError)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})
