// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { SubmitErrorHandlerError } from '../../src/runtime/core/errors'

/**
 * Parity with `form.handleSubmit` (see submit-error-no-rethrow.test.ts):
 * `wizard.handleSubmit` returns a function bound to `@submit.prevent`, so
 * a rejecting `onSubmit` / `onError` must NOT re-throw — that would
 * surface as a `window` unhandledrejection. The wizard instead:
 *
 *   - resolves the returned promise (never rejects);
 *   - parks the throw on `wizard.submitError`, coerced to a real `Error`
 *     (a non-Error throw keeps its origin on `.cause`);
 *   - wraps a thrown `onError` in `SubmitErrorHandlerError` as the
 *     discriminator, converging on the same slot;
 *   - keeps the no-stranded-state guarantee: `submitting` resets and
 *     navigation resumes regardless of the throw.
 */

const accountSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(8, 'At least 8 characters'),
})

const reviewSchema = z.object({
  tos: z.literal(true, 'Accept the terms to continue'),
})

function mountHarness<R>(setup: () => R): { app: App; result: R } {
  const handle: { result?: R } = {}
  const App = defineComponent({
    setup() {
      handle.result = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, result: handle.result as R }
}

function validWizard(suffix: string) {
  const account = useForm({
    schema: accountSchema,
    key: `wnr-${suffix}-account`,
    defaultValues: { email: 'a@b.c', password: 'passw0rd' },
  })
  const review = useForm({
    schema: reviewSchema,
    key: `wnr-${suffix}-review`,
    defaultValues: { tos: true as const },
  })
  return useWizard({ steps: [account, review], restore: false, persist: false })
}

describe('wizard.handleSubmit — a rejecting callback does not re-throw', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('resolves (does not reject) when a final-step onSubmit throws', async () => {
    const { app, result } = mountHarness(() => validWizard('resolve'))
    apps.push(app)
    result.goTo('wnr-resolve-review')
    const onSubmit = vi.fn(() => {
      throw new Error('boom')
    })
    await expect(result.handleSubmit(onSubmit)(new Event('submit'))).resolves.toBeUndefined()
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(result.submitting).toBe(false)
  })

  it('does not fire a window unhandledrejection when onSubmit throws', async () => {
    const { app, result } = mountHarness(() => validWizard('uhr'))
    apps.push(app)
    result.goTo('wnr-uhr-review')

    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent | { reason: unknown }): void => {
      unhandled.push((e as { reason: unknown }).reason)
    }
    window.addEventListener('unhandledrejection', onUnhandled as EventListener)

    const submit = result.handleSubmit(() => {
      throw new Error('boom')
    })
    void submit(new Event('submit'))
    await new Promise((r) => setTimeout(r, 50))

    window.removeEventListener('unhandledrejection', onUnhandled as EventListener)
    expect(unhandled).toHaveLength(0)
  })

  it('parks a thrown Error on wizard.submitError, coerced and identity-preserved', async () => {
    const { app, result } = mountHarness(() => validWizard('park'))
    apps.push(app)
    result.goTo('wnr-park-review')
    const err = new Error('server exploded')
    await result.handleSubmit(() => {
      throw err
    })(new Event('submit'))
    expect(result.submitError).toBeInstanceOf(Error)
    expect(result.submitError).toBe(err)
    expect(result.submitting).toBe(false)
    expect(result.submissionAttempts).toBe(1)
  })

  it('coerces a thrown non-Error into an Error, original on cause', async () => {
    const { app, result } = mountHarness(() => validWizard('coerce'))
    apps.push(app)
    result.goTo('wnr-coerce-review')
    const thrown = { code: 500 }
    await result.handleSubmit(() => {
      throw thrown
    })(new Event('submit'))
    expect(result.submitError).toBeInstanceOf(Error)
    expect(result.submitError?.cause).toBe(thrown)
  })

  it('routes a thrown onError to submitError as SubmitErrorHandlerError', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wnr-onerr-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'wnr-onerr-review',
        // Invalid: literal(true) fails, so final-step validation fails and
        // onError fires.
        defaultValues: { tos: false as unknown as true },
      })
      return useWizard({ steps: [account, review], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('wnr-onerr-review')
    const original = new Error('onError crash')
    const onError = vi.fn(() => {
      throw original
    })
    await expect(
      result.handleSubmit(vi.fn(), onError)(new Event('submit'))
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
    expect(result.submitError).toBeInstanceOf(SubmitErrorHandlerError)
    expect(result.submitError?.cause).toBe(original)
    expect(result.submitting).toBe(false)
  })

  it('an onSubmit throw from an intermediate step parks the error without advancing or latching done', async () => {
    const { app, result } = mountHarness(() => validWizard('intermediate'))
    apps.push(app)
    expect(result.currentStep).toBe('wnr-intermediate-account')
    await result.handleSubmit(() => {
      throw new Error('intermediate boom')
    })(new Event('submit'))
    expect(result.submitError).toBeInstanceOf(Error)
    // The whole-wizard submit threw in the callback: pin unmoved, no done.
    expect(result.currentStep).toBe('wnr-intermediate-account')
    expect(result.done).toBe(false)
    expect(result.submitting).toBe(false)
  })

  it('clears submitError on the next fresh submit, and reset() clears it', async () => {
    const { app, result } = mountHarness(() => validWizard('clear'))
    apps.push(app)
    result.goTo('wnr-clear-review')
    await result.handleSubmit(() => {
      throw new Error('first')
    })(new Event('submit'))
    expect(result.submitError).toBeInstanceOf(Error)

    // A fresh successful submit clears it.
    await result.handleSubmit(vi.fn())(new Event('submit'))
    expect(result.submitError).toBeNull()

    // And so does reset().
    await result.handleSubmit(() => {
      throw new Error('again')
    })(new Event('submit'))
    expect(result.submitError).toBeInstanceOf(Error)
    result.reset()
    expect(result.submitError).toBeNull()
  })
})
