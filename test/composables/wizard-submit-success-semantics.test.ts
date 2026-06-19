// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Parity with `form.handleSubmit` success semantics (#438), applied to
 * `wizard.handleSubmit`. A wizard callback that leaves errors on a
 * processed step form has NOT submitted that step successfully:
 *
 *   - Final step: `wizard.done` must stay `false` (a server rejection
 *     is not completion).
 *   - Intermediate step: the wizard must NOT advance past a step the
 *     server just rejected.
 *   - `onError` must fire in both cases.
 *
 * The clean-return positive controls guard against over-correction:
 * a final submit that leaves no errors completes, and an intermediate
 * one advances.
 */

const accountSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(8),
})
const reviewSchema = z.object({ tos: z.literal(true) })

const validAccount = { email: 'a@b.c', password: 'passw0rd' }

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

describe('wizard.handleSubmit success semantics (#438)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('final-step setErrors inside onSubmit leaves wizard.done false', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'ws-final-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'ws-final-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    result.wizard.goTo('ws-final-review')

    const onError = vi.fn()
    await result.wizard.handleSubmit(() => {
      result.review.setErrors([{ message: 'Payment declined.' }])
    }, onError)(new Event('submit'))

    expect(result.wizard.done).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('intermediate setErrors inside onSubmit does not advance past the rejected step', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'ws-mid-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'ws-mid-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('ws-mid-account')

    const onError = vi.fn()
    await result.wizard.handleSubmit(() => {
      result.account.setErrors([{ message: 'This email is already taken.' }])
    }, onError)(new Event('submit'))

    expect(result.wizard.currentStep).toBe('ws-mid-account')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('positive control: a clean final submit completes the wizard', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'ws-ok-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'ws-ok-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    result.wizard.goTo('ws-ok-review')

    const onError = vi.fn()
    await result.wizard.handleSubmit(() => {}, onError)(new Event('submit'))

    expect(result.wizard.done).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it('positive control: a clean intermediate submit advances to the next step', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'ws-adv-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'ws-adv-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('ws-adv-account')

    await result.wizard.handleSubmit(() => {})(new Event('submit'))

    expect(result.wizard.currentStep).toBe('ws-adv-review')
  })
})
