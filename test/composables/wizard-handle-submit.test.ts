// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type {
  WizardAggregateError,
  WizardSubmitContext,
} from '../../src/runtime/types/types-wizard'

/**
 * `wizard.handleSubmit` — universal submit handler that always validates
 * the entire step list, from any step.
 *
 *  - Validates every compiled form (in parallel) regardless of which
 *    step fired the submit, and never advances the pin; the consumer's
 *    `onSubmit` ships values via `ctx.values` + `ctx.get(form)`, and a
 *    clean submit latches `done`.
 *  - Gating advance on a step's own validity is the composition
 *    `activeForm.handleSubmit(() => wizard.next())`, exercised in
 *    wizard-active-form.test.ts.
 *  - `submitting` gates re-entrance globally; navigation also refuses
 *    while a submit is in flight.
 *  - `focusFirstError` (default true) routes to the first failing form
 *    and fires that form's `applyInvalidSubmitPolicy()`.
 *  - String slots (noop forms) validate trivially.
 */

const accountSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(8, 'At least 8 characters'),
})

const profileSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  city: z.string(),
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

describe('useWizard — handleSubmit on the final step', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('happy-path: onSubmit receives ctx with namespaced values, get(form), currentKey, isFinal=true', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-1-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-1-profile',
        defaultValues: { name: 'Ada', city: 'Cambridge' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-1-review',
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
    result.wizard.goTo('hs-1-review')
    expect(result.wizard.isFinalStep).toBe(true)
    const submit = result.wizard.handleSubmit(onSubmit)
    await submit()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    expect(ctx.isFinal).toBe(true)
    expect(ctx.currentKey).toBe('hs-1-review')
    expect(Object.keys(ctx.values).sort()).toEqual(['hs-1-account', 'hs-1-profile', 'hs-1-review'])
    expect(ctx.values['hs-1-account']).toEqual({ email: 'a@b.c', password: 'passw0rd' })
    expect(ctx.values['hs-1-profile']).toEqual({ name: 'Ada', city: 'Cambridge' })
    expect(ctx.values['hs-1-review']).toEqual({ tos: true })
    expect(ctx.get(result.account)).toEqual({ email: 'a@b.c', password: 'passw0rd' })
    expect(result.wizard.complete).toBe(true)
    expect(result.wizard.submitting).toBe(false)
    expect(result.wizard.submissionAttempts).toBe(1)
  })

  it('failed-path: aggregates errors and routes to the first failing form with focusFirstError', async () => {
    const onSubmit = vi.fn()
    const onError = vi.fn()
    let profilePolicySpy: ReturnType<typeof vi.fn> | undefined
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-2-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-2-profile',
        defaultValues: { city: 'Cambridge' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-2-review',
        defaultValues: { tos: true as const },
      })
      const spy = vi.fn(profile.applyInvalidSubmitPolicy)
      ;(profile as unknown as { applyInvalidSubmitPolicy: typeof spy }).applyInvalidSubmitPolicy =
        spy
      profilePolicySpy = spy
      return {
        wizard: useWizard({
          steps: [account, profile, review],
          restore: false,
          persist: false,
        }),
      }
    })
    apps.push(app)
    result.wizard.goTo('hs-2-review')
    const submit = result.wizard.handleSubmit(onSubmit, onError)
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] as { formKey: string; message: string }[]
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((e) => e.formKey === 'hs-2-profile')).toBe(true)
    expect(result.wizard.currentStep).toBe('hs-2-profile')
    expect(profilePolicySpy!).toHaveBeenCalledTimes(1)
    expect(result.wizard.complete).toBe(false)
    expect(result.wizard.submissionAttempts).toBe(1)
  })

  it('focusFirstError: false leaves the active step where the user left it on failure', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-3-account',
        defaultValues: { email: 'a@b.c' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-3-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({
          steps: [account, review],
          focusFirstError: false,
          restore: false,
          persist: false,
        }),
      }
    })
    apps.push(app)
    result.wizard.goTo('hs-3-review')
    const submit = result.wizard.handleSubmit(vi.fn(), vi.fn())
    await submit()
    expect(result.wizard.currentStep).toBe('hs-3-review')
  })

  it('complete tracks forward-looking validity without requiring a submission', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-4-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-4-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({ steps: [account, review], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    // No submission yet. Land on the final step with every form valid
    // by default → complete reads true purely from validity + position.
    result.wizard.goTo('hs-4-review')
    await nextTick()
    expect(result.wizard.submissionAttempts).toBe(0)
    expect(result.wizard.complete).toBe(true)
    // Drop the account below `min(8)` → complete flips off in lockstep
    // with the form's meta.valid. Still no submission required.
    result.account.setValue('password', '')
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (!result.account.meta.validating && result.account.meta.valid === false) break
    }
    expect(result.account.meta.valid).toBe(false)
    expect(result.wizard.complete).toBe(false)
  })

  it('done is a monotonic latch: stays true after a walked form goes invalid', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-4b-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-4b-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({ steps: [account, review], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    // Pre-submit: never been done.
    expect(result.wizard.done).toBe(false)
    result.wizard.goTo('hs-4b-review')
    // Still pre-submit, even after landing on the final step.
    expect(result.wizard.done).toBe(false)
    await result.wizard.handleSubmit(vi.fn())()
    expect(result.wizard.done).toBe(true)
    // Invalidate after success. `done` is monotonic — the historical
    // fact "submission landed" does not flip back.
    result.account.setValue('password', '')
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (!result.account.meta.validating && result.account.meta.valid === false) break
    }
    expect(result.account.meta.valid).toBe(false)
    expect(result.wizard.done).toBe(true)
    // reset() is the only thing that flips it back.
    result.wizard.reset()
    await nextTick()
    expect(result.wizard.done).toBe(false)
  })

  it('a submit fired from an intermediate step validates the whole wizard and does not advance', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-5-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-5-profile',
        // Valid: handleSubmit validates EVERY step, so profile must pass
        // even though the wizard is parked on `account`.
        defaultValues: { name: 'Ada', city: 'Cambridge' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-5-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({
          steps: [account, profile, review],
          restore: false,
          persist: false,
        }),
      }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('hs-5-account')
    expect(result.wizard.isFinalStep).toBe(false)
    await result.wizard.handleSubmit(onSubmit)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    // `isFinal` is positional (fired from an intermediate step), but the
    // whole wizard was validated: every step's values are present.
    expect(ctx.isFinal).toBe(false)
    expect(ctx.currentKey).toBe('hs-5-account')
    expect(ctx.values['hs-5-profile']).toMatchObject({ name: 'Ada' })
    expect(ctx.values['hs-5-review']).toMatchObject({ tos: true })
    // Never advances the pin; a clean whole-wizard submit latches `done`.
    expect(result.wizard.currentStep).toBe('hs-5-account')
    expect(result.wizard.done).toBe(true)
  })

  it('intermediate step: failed validation keeps the active step and bumps submissionAttempts', async () => {
    const onSubmit = vi.fn()
    const onError = vi.fn()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-6-account',
        // Missing password — whole-wizard validation must fail.
        defaultValues: { email: 'a@b.c' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-6-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({
          steps: [account, review],
          restore: false,
          persist: false,
        }),
      }
    })
    apps.push(app)
    await result.wizard.handleSubmit(onSubmit, onError)()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(result.wizard.currentStep).toBe('hs-6-account')
    expect(result.wizard.submissionAttempts).toBe(1)
  })

  it('back-edit: submitting from a stepped-back position validates the whole list and latches done', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-back-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-back-profile',
        defaultValues: { name: 'Ada', city: 'Cambridge' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-back-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({ steps: [account, profile, review], restore: false, persist: false }),
        profile,
      }
    })
    apps.push(app)
    // Walk to the final step, then step back and edit a middle field.
    result.wizard.goTo('hs-back-review')
    result.wizard.goTo('hs-back-profile')
    expect(result.wizard.isFinalStep).toBe(false)
    result.profile.setValue('city', 'Oxford')
    await nextTick()

    // Submitting from the middle still processes the whole wizard.
    await result.wizard.handleSubmit(onSubmit)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    // `isFinal` reports where the submit fired (false), not what validated.
    expect(ctx.isFinal).toBe(false)
    expect(ctx.currentKey).toBe('hs-back-profile')
    expect(ctx.values['hs-back-account']).toMatchObject({ email: 'a@b.c' })
    expect(ctx.values['hs-back-profile']).toMatchObject({ city: 'Oxford' })
    expect(ctx.values['hs-back-review']).toMatchObject({ tos: true })
    expect(result.wizard.done).toBe(true)
  })

  it('a failed whole-wizard submit reports errors spanning every step, not just the active one', async () => {
    const onError = vi.fn<(errors: readonly WizardAggregateError[]) => void>()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-allerr-account',
        // Invalid: missing password.
        defaultValues: { email: 'a@b.c' },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-allerr-profile',
        // Invalid: empty name.
        defaultValues: { city: 'Cambridge' },
      })
      return {
        wizard: useWizard({ steps: [account, profile], restore: false, persist: false }),
      }
    })
    apps.push(app)
    // Fired from the FIRST step; pre-#471 this saw only the active form's errors.
    expect(result.wizard.currentStep).toBe('hs-allerr-account')
    await result.wizard.handleSubmit(() => {}, onError)()
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] ?? []
    const failedKeys = new Set(errors.map((e) => e.formKey))
    expect(failedKeys.has('hs-allerr-account')).toBe(true)
    expect(failedKeys.has('hs-allerr-profile')).toBe(true)
  })

  it('re-entrancy: a second handleSubmit while in flight dev-warns and no-ops', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-7-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-7-review',
        defaultValues: { tos: true as const },
      })
      return useWizard({ steps: [account, review], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('hs-7-review')
    const submit = result.handleSubmit(onSubmit)
    const first = submit()
    const second = submit()
    await Promise.all([first, second])
    warnSpy.mockRestore()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(warnings.some((w) => w.includes('re-entrant'))).toBe(true)
  })

  it('activation failure during the final-step walk surfaces a synthetic ValidationError', async () => {
    const onError = vi.fn()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-8-account',
        defaultValues: async () => {
          throw new Error('factory exploded')
        },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-8-review',
        defaultValues: { tos: true as const },
      })
      return useWizard({ steps: [account, review], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('hs-8-review')
    await result.handleSubmit(vi.fn(), onError)()
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] as { formKey: string; code?: string }[]
    const activationError = errors.find(
      (e) => e.formKey === 'hs-8-account' && e.code === 'atta:activation-failed'
    )
    expect(activationError).toBeDefined()
  })

  it('final-step submission bumps submissionAttempts on every form and reveals errors across the wizard', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({ schema: accountSchema, key: 'hs-show-account' })
      const profile = useForm({ schema: profileSchema, key: 'hs-show-profile' })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-show-review',
        defaultValues: { tos: false as unknown as true },
      })
      return {
        account,
        profile,
        review,
        wizard: useWizard({
          steps: [account, profile, review],
          restore: () => ({ step: 'hs-show-review' }),
          persist: false,
          focusFirstError: false,
        }),
      }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('hs-show-review')
    expect(result.account.meta.submissionAttempts).toBe(0)
    expect(result.profile.meta.submissionAttempts).toBe(0)
    expect(result.review.meta.submissionAttempts).toBe(0)
    expect(result.account.fields.email.showErrors).toBe(false)
    expect(result.profile.fields.name.showErrors).toBe(false)
    expect(result.review.fields.tos.showErrors).toBe(false)

    const onSubmit = vi.fn()
    const onError = vi.fn()
    await result.wizard.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(result.account.meta.submissionAttempts).toBe(1)
    expect(result.profile.meta.submissionAttempts).toBe(1)
    expect(result.review.meta.submissionAttempts).toBe(1)
    expect(result.account.fields.email.showErrors).toBe(true)
    expect(result.account.fields.password.showErrors).toBe(true)
    expect(result.profile.fields.name.showErrors).toBe(true)
    expect(result.review.fields.tos.showErrors).toBe(true)
  })
})

describe('useWizard — handleSubmit lifecycle signals', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('per-form meta.submitting stays false during the wizard walk', async () => {
    const observedAccountSubmitting: boolean[] = []
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-9-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-9-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({ steps: [account, review], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    result.wizard.goTo('hs-9-review')
    const interval = setInterval(() => {
      observedAccountSubmitting.push(result.account.meta.submitting)
    }, 2)
    try {
      await result.wizard.handleSubmit(onSubmit)()
    } finally {
      clearInterval(interval)
    }
    expect(observedAccountSubmitting.every((v) => v === false)).toBe(true)
  })

  it('canAdvance + canGoBack reflect positional structure (not validation state)', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-10-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-10-review',
        defaultValues: { tos: true as const },
      })
      return useWizard({ steps: [account, review], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.canAdvance).toBe(true)
    expect(result.canGoBack).toBe(false)
    await result.next()
    expect(result.currentStep).toBe('hs-10-review')
    expect(result.canAdvance).toBe(false)
    expect(result.canGoBack).toBe(true)
  })

  it('wizard.reset() zeros lifecycle and calls reset on every step form', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-11-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-11-review',
        defaultValues: { tos: true as const },
      })
      return {
        wizard: useWizard({ steps: [account, review], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    result.wizard.goTo('hs-11-review')
    await result.wizard.handleSubmit(vi.fn())()
    expect(result.wizard.complete).toBe(true)
    expect(result.wizard.submissionAttempts).toBe(1)
    result.account.setValue('email', 'edited@b.c')
    expect(result.account.meta.dirty).toBe(true)
    result.wizard.reset()
    expect(result.wizard.submissionAttempts).toBe(0)
    expect(result.wizard.currentStep).toBe('hs-11-account')
    expect(result.account.meta.dirty).toBe(false)
    expect(result.account.values.email).toBe('a@b.c')
  })

  it('mid-submission next/back/goTo dev-warn and refuse to move', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-12-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-12-review',
        defaultValues: { tos: true as const },
      })
      return useWizard({ steps: [account, review], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('hs-12-review')
    const startKey = result.currentStep
    const inFlight = result.handleSubmit(onSubmit)()
    expect(result.submitting).toBe(true)
    void result.next()
    result.back()
    result.goTo('hs-12-account')
    expect(result.currentStep).toBe(startKey)
    await inFlight
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('wizard.next'))).toBe(true)
    expect(warnings.some((w) => w.includes('wizard.back'))).toBe(true)
    expect(warnings.some((w) => w.includes('wizard.goTo'))).toBe(true)
  })

  it('onSubmit throwing clears submitting, records submitError, and lets navigation resume', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-13-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-13-review',
        defaultValues: { tos: true as const },
      })
      return useWizard({ steps: [account, review], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('hs-13-review')
    const onSubmit = vi.fn(() => {
      throw new Error('handler threw')
    })
    // The handler resolves (no re-throw); the throw lands on `submitError`.
    // See wizard-submit-no-rethrow.test.ts for the full contract.
    await expect(result.handleSubmit(onSubmit)()).resolves.toBeUndefined()
    expect(result.submitError).toBeInstanceOf(Error)
    expect(result.submitting).toBe(false)
    // Navigation resumes after the throw.
    result.back()
    expect(result.currentStep).toBe('hs-13-account')
  })
})

describe('useWizard — handleSubmit on string slots (noop forms)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('handleSubmit fired from an intermediate string slot validates the whole wizard and does not advance', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-noop-1-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      return useWizard({
        steps: ['hs-noop-1-intro', account, 'hs-noop-1-thanks'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.currentStep).toBe('hs-noop-1-intro')
    await result.handleSubmit(onSubmit)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    expect(ctx.currentKey).toBe('hs-noop-1-intro')
    expect(ctx.isFinal).toBe(false)
    // The whole wizard is processed (account included); the pin stays on
    // the intro slot.
    expect(ctx.values['hs-noop-1-account']).toMatchObject({ email: 'a@b.c' })
    expect(result.currentStep).toBe('hs-noop-1-intro')
    expect(result.done).toBe(true)
  })

  it('handleSubmit on a final string slot fires onSubmit with every step in values', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'hs-noop-2-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
      })
      return useWizard({
        steps: [account, 'hs-noop-2-thanks'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    result.goTo('hs-noop-2-thanks')
    expect(result.isFinalStep).toBe(true)
    await result.handleSubmit(onSubmit)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    expect(ctx.isFinal).toBe(true)
    expect(Object.keys(ctx.values).sort()).toEqual(['hs-noop-2-account', 'hs-noop-2-thanks'])
    expect(ctx.values['hs-noop-2-account']).toEqual({ email: 'a@b.c', password: 'passw0rd' })
  })

  it('handleSubmit submission counters bump for noops too (always-bump policy)', async () => {
    const { app, result } = mountHarness(() => {
      return useWizard({ steps: ['hs-noop-3-only'], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.submissionAttempts).toBe(0)
    await result.handleSubmit(vi.fn())()
    expect(result.submissionAttempts).toBe(1)
    await result.handleSubmit(vi.fn())()
    expect(result.submissionAttempts).toBe(2)
  })
})

/**
 * Standing regression for the v-if step-swap focus race: `goTo()`
 * updates `wizard.currentStep` synchronously, but the failed step's
 * form doesn't mount until Vue's next render flush. The wizard
 * awaits one `nextTick` before firing `applyInvalidSubmitPolicy()`
 * so the focus call lands on a registered, connected input rather
 * than walking an empty registration set. Without the wait,
 * `getFirstErrorElement` returns `null` and the focus policy
 * silently no-ops.
 */
describe('useWizard — focusFirstError lands focus through v-if step swap', () => {
  const apps: App[] = []
  let focusSpy: ReturnType<typeof vi.spyOn>
  let offsetParentDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.isConnected ? document.body : null
      },
    })
  })

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    focusSpy.mockRestore()
    if (offsetParentDescriptor !== undefined) {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor)
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetParent']
    }
  })

  it("focuses the failed step's first error field after the step mounts", async () => {
    const handle: {
      wizard?: ReturnType<typeof useWizard>
    } = {}

    const App = defineComponent({
      setup() {
        const account = useForm({
          schema: accountSchema,
          key: 'vif-account',
          defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        })
        const profile = useForm({
          schema: profileSchema,
          // `name` is required; blank default trips validation on the
          // final-step walk.
          key: 'vif-profile',
          defaultValues: { city: 'Cambridge' },
        })
        const review = useForm({
          schema: reviewSchema,
          key: 'vif-review',
          defaultValues: { tos: true as const },
        })
        const wizard = useWizard({
          steps: [account, profile, review],
          restore: false,
          persist: false,
        })
        handle.wizard = wizard
        // Pre-position on the final step so the submit walks the whole
        // wizard and routes back to the failing profile step.
        wizard.goTo('vif-review')

        return () => {
          if (wizard.currentStep === 'vif-account') {
            const reg = account.register('email')
            return h('form', [
              h('input', {
                ref: (el: unknown) => {
                  if (el instanceof HTMLInputElement) reg.registerElement(el)
                },
                'data-field': 'account-email',
              }),
            ])
          }
          if (wizard.currentStep === 'vif-profile') {
            const reg = profile.register('name')
            return h('form', [
              h('input', {
                ref: (el: unknown) => {
                  if (el instanceof HTMLInputElement) reg.registerElement(el)
                },
                'data-field': 'profile-name',
              }),
            ])
          }
          return h('div')
        }
      },
    })

    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)

    expect(document.querySelector('[data-field="profile-name"]')).toBeNull()

    await handle.wizard!.handleSubmit(vi.fn(), vi.fn())()

    expect(handle.wizard!.currentStep).toBe('vif-profile')
    const target = document.querySelector('[data-field="profile-name"]') as HTMLInputElement | null
    expect(target).not.toBeNull()
    expect(focusSpy).toHaveBeenCalled()
    const focused = focusSpy.mock.instances as HTMLElement[]
    expect(focused[focused.length - 1]).toBe(target)
  })
})
