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
 * Success semantics of `handleSubmit` (#438). The documented
 * server-rejection pattern is `setErrors(...) + return`
 * (server-side-errors.md), so a callback that resolves AFTER leaving
 * errors in the user-error layer has NOT submitted successfully:
 *
 *   - `meta.submitted` must stay `false`.
 *   - `onError` must fire with the errors that were set.
 *
 * A clean return that leaves no errors behind is the only success
 * (the positive control guards against over-correction). Validation
 * passes before the callback runs in every case here, so the only
 * thing distinguishing success from failure is what the callback
 * leaves in `form.errors()`.
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
        key: `submit-semantics-${Math.random().toString(36).slice(2)}`,
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

describe('handleSubmit success semantics (#438)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  const schema = z.object({ email: z.email() })

  it('setErrors + return inside onSubmit leaves submitted false', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {
      // The documented server-rejection pattern: hand the server's
      // verdict to setErrors and bail. Validation already passed, so
      // this is the only signal that the submission did not succeed.
      api.setErrors([{ message: 'Incorrect email or password.' }])
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 1)
    expect(api.meta.submitted).toBe(false)
  })

  it('scoped setErrors(path, …) inside onSubmit leaves submitted false', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {
      api.setErrors('email', [{ message: 'Already registered.' }])
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 1)
    expect(api.meta.submitted).toBe(false)
  })

  it('fires onError with the errors the callback left behind', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const onError = vi.fn()
    const handler = api.handleSubmit(async () => {
      api.setErrors([{ message: 'Service unavailable, try again shortly.' }])
    }, onError)
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 1)
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(
      errors.some(
        (e: { message: string }) => e.message === 'Service unavailable, try again shortly.'
      )
    ).toBe(true)
  })

  it('positive control: a clean return that leaves no errors submits successfully', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const onError = vi.fn()
    const handler = api.handleSubmit(async () => {
      // No setErrors: the destination accepted the payload.
    }, onError)
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitted)
    expect(api.meta.submitted).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not park a submitError when the failure came from setErrors, not a throw', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {
      api.setErrors([{ message: 'Incorrect email or password.' }])
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 1)
    // setErrors is the expected-rejection channel; submitError stays the
    // thrown-exception channel and remains null here.
    expect(api.meta.submitError).toBe(null)
  })
})
