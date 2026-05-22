// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { waitUntil } from '../utils/form-harness'

/**
 * `form.meta.submitted` is `true` once a `handleSubmit` callback has
 * resolved without throwing. It's independent of `submissionAttempts`:
 * a failed submit (validation failure or callback rejection)
 * increments attempts but leaves `submitted` at `false`.
 *
 * `form.reset()` zeroes the submission surface — `submissionAttempts`,
 * `submitted`, and `submitError` all return to their initial values.
 * Templates that want "the user has tried to submit" should read
 * `submissionAttempts > 0` directly.
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
        key: `is-submitted-${Math.random().toString(36).slice(2)}`,
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

describe('form.meta.submitted', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  const schema = z.object({
    email: z.email(),
  })

  it('starts false before any submit', () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    expect(api.meta.submitted).toBe(false)
    expect(api.meta.submissionAttempts).toBe(0)
  })

  it('flips true on the first successful submit', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {})
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitted)
    expect(api.meta.submitted).toBe(true)
    expect(api.meta.submissionAttempts).toBe(1)
  })

  it('stays false when validation fails — submissionAttempts still increments', async () => {
    const { app, api } = mountForm(schema, { email: '' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {})
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 1)
    expect(api.meta.submitted).toBe(false)
    expect(api.meta.submissionAttempts).toBe(1)
  })

  it('stays false when the consumer callback throws — submissionAttempts still increments', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {
      throw new Error('boom')
    })
    await expect(handler(new Event('submit'))).rejects.toThrow('boom')
    await waitUntil(() => api.meta.submissionAttempts === 1)
    expect(api.meta.submitted).toBe(false)
    expect(api.meta.submissionAttempts).toBe(1)
  })

  it('stays true across subsequent successful submits', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {})
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 1)
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts === 2)
    expect(api.meta.submitted).toBe(true)
  })

  it('reset() zeroes submitted, submissionAttempts, and submitError together', async () => {
    const { app, api } = mountForm(schema, { email: 'user@example.com' })
    apps.push(app)
    const handler = api.handleSubmit(async () => {})
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitted)
    expect(api.meta.submitted).toBe(true)
    expect(api.meta.submissionAttempts).toBe(1)
    api.reset()
    expect(api.meta.submitted).toBe(false)
    expect(api.meta.submissionAttempts).toBe(0)
    expect(api.meta.submitError).toBe(null)
  })
})
