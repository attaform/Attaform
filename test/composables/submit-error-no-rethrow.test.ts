// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { SubmitErrorHandlerError } from '../../src/runtime/core/errors'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { waitUntil } from '../utils/form-harness'

/**
 * `handleSubmit` returns a function consumers bind to `@submit.prevent`
 * / `@click`. When the consumer's `onSubmit` (or its `onError`) rejects,
 * the returned handler must NOT re-throw: a rejected promise bound to a
 * DOM event surfaces as a `window` unhandledrejection, which error
 * monitors flag as a phantom crash for what is usually an already-handled
 * server failure. The contract instead:
 *
 *   - resolves the returned promise (never rejects);
 *   - parks the thrown value on `meta.submitError`, COERCED to a real
 *     `Error` (a non-Error throw is wrapped, original preserved on
 *     `.cause`) so the slot is `Error | null`, never `unknown`;
 *   - keeps `meta.submitError` distinct from the curated user-error
 *     store (no auto-inject) — it is the `hydrateError` twin, rendered
 *     with a one-liner where the consumer chooses;
 *   - preserves the no-stranded-button guarantee: `submitting` resets and
 *     `submissionAttempts` increments regardless of the throw.
 *
 * A throwing `onError` converges on the same slot, wrapped in
 * `SubmitErrorHandlerError` so inspection can tell "my error handler
 * crashed" apart from "my submit body failed". The asymmetry is
 * deliberate: a thrown `onSubmit` lands RAW (its message is the real
 * server failure you would render); a thrown `onError` lands WRAPPED
 * (the rare developer bug, original on `.cause`).
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
        key: `no-rethrow-${Math.random().toString(36).slice(2)}`,
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

describe('handleSubmit — a rejecting callback does not re-throw', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  const schema = z.object({ email: z.email() })
  const valid = { email: 'user@example.com' }

  it('resolves (does not reject) when onSubmit throws', async () => {
    const { app, api } = mountForm(schema, valid)
    apps.push(app)
    const handler = api.handleSubmit(async () => {
      throw new Error('boom')
    })
    await expect(handler(new Event('submit'))).resolves.toBeUndefined()
  })

  it('does not fire a window unhandledrejection when onSubmit throws', async () => {
    const { app, api } = mountForm(schema, valid)
    apps.push(app)

    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent | { reason: unknown }): void => {
      unhandled.push((e as { reason: unknown }).reason)
    }
    window.addEventListener('unhandledrejection', onUnhandled as EventListener)

    const handler = api.handleSubmit(async () => {
      throw new Error('boom')
    })
    // Fire as a floating promise — exactly how a DOM-bound
    // `@submit.prevent="submit"` invokes it. The old contract re-threw,
    // surfacing here as an unhandledrejection.
    void handler(new Event('submit'))
    await new Promise((r) => setTimeout(r, 50))

    window.removeEventListener('unhandledrejection', onUnhandled as EventListener)
    expect(unhandled).toHaveLength(0)
  })

  it('parks a thrown Error on meta.submitError, coerced and identity-preserved', async () => {
    const { app, api } = mountForm(schema, valid)
    apps.push(app)
    const err = new Error('server exploded')
    const handler = api.handleSubmit(async () => {
      throw err
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitError !== null)
    expect(api.meta.submitError).toBeInstanceOf(Error)
    expect(api.meta.submitError).toBe(err)
    expect(api.meta.submitting).toBe(false)
    expect(api.meta.submitted).toBe(false)
    expect(api.meta.submissionAttempts).toBe(1)
  })

  it('coerces a thrown string into an Error, preserving the original on cause', async () => {
    const { app, api } = mountForm(schema, valid)
    apps.push(app)
    const handler = api.handleSubmit(async () => {
      throw 'plain string failure'
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitError !== null)
    const captured = api.meta.submitError
    expect(captured).toBeInstanceOf(Error)
    expect(captured?.message).toBe('plain string failure')
    expect(captured?.cause).toBe('plain string failure')
  })

  it('coerces a thrown non-Error object into an Error, original on cause', async () => {
    const { app, api } = mountForm(schema, valid)
    apps.push(app)
    const thrown = { code: 500, detail: 'upstream' }
    const handler = api.handleSubmit(async () => {
      throw thrown
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitError !== null)
    const captured = api.meta.submitError
    expect(captured).toBeInstanceOf(Error)
    expect(captured?.cause).toBe(thrown)
  })

  it('routes a thrown onError to submitError as SubmitErrorHandlerError (validation errors intact)', async () => {
    const { app, api } = mountForm(schema, { email: '' })
    apps.push(app)
    const original = new Error('handler crash')
    const handler = api.handleSubmit(
      async () => {},
      async () => {
        throw original
      }
    )
    await expect(handler(new Event('submit'))).resolves.toBeUndefined()
    await waitUntil(() => api.meta.submitError !== null)
    const captured = api.meta.submitError
    expect(captured).toBeInstanceOf(SubmitErrorHandlerError)
    expect(captured?.cause).toBe(original)
    // The wrapper discriminates "onError crashed" from "onSubmit crashed";
    // the underlying validation failure is still surfaced.
    expect(api.meta.errors.length).toBeGreaterThan(0)
  })

  it('clears submitError on the next fresh submit', async () => {
    const { app, api } = mountForm(schema, valid)
    apps.push(app)
    const failing = api.handleSubmit(async () => {
      throw new Error('first')
    })
    await failing(new Event('submit'))
    await waitUntil(() => api.meta.submitError !== null)
    expect(api.meta.submitError).toBeInstanceOf(Error)

    await api.handleSubmit(async () => {})(new Event('submit'))
    await waitUntil(() => api.meta.submitError === null)
    expect(api.meta.submitError).toBeNull()
    expect(api.meta.submitted).toBe(true)
  })
})
