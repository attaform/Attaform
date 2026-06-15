// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { ValidationError } from '../../src/runtime/types/types-api'

/**
 * Parity with `form.handleSubmit` (submit-clears-user-errors.test.ts):
 * `wizard.handleSubmit` clears user-set errors on the forms it PROCESSES
 * at entry, so a fresh attempt starts each from a clean user-error slate.
 *
 *   - A final-step submit validates every form → clears every form's
 *     user errors.
 *   - An intermediate submit validates only the active form → clears only
 *     the active form's user errors; the other steps are untouched.
 *
 * Errors set DURING the callback survive (the clear runs before the
 * callback), and the clear fires even when validation fails.
 */

const accountSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(8),
})
const profileSchema = z.object({ name: z.string().min(1) })
const reviewSchema = z.object({ tos: z.literal(true) })

const validAccount = { email: 'a@b.c', password: 'passw0rd' }
const validProfile = { name: 'Ada' }

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

const formLevel = (errors: readonly ValidationError[]): readonly ValidationError[] =>
  errors.filter((e) => e.path.length === 0)

describe('wizard.handleSubmit clears user-set errors on processed forms at entry', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a final-step submit clears every processed form’s user errors', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wc-final-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'wc-final-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    result.account.setFormErrors([{ message: 'acct server error' }])
    result.review.setFormErrors([{ message: 'review server error' }])
    result.wizard.goTo('wc-final-review')

    await result.wizard.handleSubmit(() => {})(new Event('submit'))
    expect(formLevel(result.account.meta.errors)).toHaveLength(0)
    expect(formLevel(result.review.meta.errors)).toHaveLength(0)
  })

  it('an intermediate submit clears only the active form’s user errors', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wc-mid-account',
        defaultValues: validAccount,
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'wc-mid-profile',
        defaultValues: validProfile,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'wc-mid-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({
        steps: [account, profile, review],
        restore: false,
        persist: false,
      })
      return { wizard, account, profile, review }
    })
    apps.push(app)
    // On the first (active) step; set errors on the active form and a
    // later, unprocessed one.
    result.account.setFormErrors([{ message: 'acct err' }])
    result.profile.setFormErrors([{ message: 'profile err' }])
    expect(result.wizard.currentStep).toBe('wc-mid-account')

    await result.wizard.handleSubmit(() => {})(new Event('submit'))
    // Active form's user errors cleared; the untouched step keeps its own.
    expect(formLevel(result.account.meta.errors)).toHaveLength(0)
    expect(formLevel(result.profile.meta.errors)).toHaveLength(1)
  })

  it('clears even when a final-step validation fails', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wc-fail-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'wc-fail-review',
        // Invalid: literal(true) fails → final-step validation fails.
        defaultValues: { tos: false as unknown as true },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    result.account.setFormErrors([{ message: 'stale' }])
    result.wizard.goTo('wc-fail-review')

    await result.wizard.handleSubmit(vi.fn(), vi.fn())(new Event('submit'))
    // The prior user error on account is cleared at entry despite the
    // validation failure on review.
    expect(formLevel(result.account.meta.errors)).toHaveLength(0)
  })

  it('errors set DURING the wizard callback survive (entry-clear ran before)', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wc-fresh-account',
        defaultValues: validAccount,
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'wc-fresh-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({ steps: [account, review], restore: false, persist: false })
      return { wizard, account, review }
    })
    apps.push(app)
    result.wizard.goTo('wc-fresh-review')
    await result.wizard.handleSubmit(() => {
      result.review.setFormErrors([{ message: 'fresh server error' }])
    })(new Event('submit'))
    const entries = formLevel(result.review.meta.errors)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe('fresh server error')
  })
})
