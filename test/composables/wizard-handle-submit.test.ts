// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { WizardSubmitContext } from '../../src/runtime/types/types-wizard'

/**
 * `wizard.handleSubmit` + Phase 4 state signals (`complete`,
 * `submitting`, `submissionAttempts`, `canAdvance`, `canGoBack`,
 * `reset`).
 *
 * Coverage hits the plan's RED test list for Phase 4:
 *  - happy-path handleSubmit fires `onSubmit(ctx)` with `values`,
 *    typed `get(form)`, and BFS-ordered `path`.
 *  - failed-path aggregates errors, increments `submissionAttempts`,
 *    navigates to first failure when `navigateToFirstError !== false`,
 *    and fires the failing form's `applyInvalidSubmitPolicy()`.
 *  - `complete` flips `true` on success and flips back to `false` on
 *    a post-submit write to any walked form (driven by
 *    `meta.updatedAt`, NOT a deep-equal snapshot).
 *  - re-entrancy guard: a second `handleSubmit` invocation while the
 *    first is still in flight dev-warns and resolves no-op.
 *  - activation failure during the walk surfaces as a synthetic
 *    `ValidationError` with `code: 'atta:activation-failed'`.
 *  - `canAdvance` is graph-structural (not validation-state).
 *  - `wizard.reset()` zeros lifecycle and calls `form.reset()` on
 *    every reachable form.
 *  - per-form `meta.submitting` stays `false` during the wizard walk
 *    (the wizard calls `process()`, not each form's `handleSubmit`).
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

describe('useWizard — handleSubmit + lifecycle signals', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('happy-path: onSubmit receives ctx with values, typed get(form), BFS-ordered path', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-1-review',
        defaultValues: { tos: true as const },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-1-profile',
        defaultValues: { name: 'Ada', city: 'Cambridge' },
        next: review,
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-1-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: profile,
      })
      const wizard = useWizard(account)
      return { wizard, account, profile, review }
    })
    apps.push(app)
    const submit = result.wizard.handleSubmit(onSubmit)
    await submit()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    expect(Object.keys(ctx.values)).toEqual(['hs-1-account', 'hs-1-profile', 'hs-1-review'])
    expect(ctx.values['hs-1-account']).toEqual({ email: 'a@b.c', password: 'passw0rd' })
    expect(ctx.values['hs-1-profile']).toEqual({ name: 'Ada', city: 'Cambridge' })
    expect(ctx.values['hs-1-review']).toEqual({ tos: true })
    expect(ctx.path.map((f) => f.key)).toEqual(['hs-1-account', 'hs-1-profile', 'hs-1-review'])
    expect(ctx.get(result.account)).toEqual({ email: 'a@b.c', password: 'passw0rd' })
    expect(result.wizard.complete).toBe(true)
    expect(result.wizard.submitting).toBe(false)
    expect(result.wizard.submissionAttempts).toBe(1)
  })

  it('failed-path: aggregates errors, navigates to first failure, and fires policy', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const onError = vi.fn()
    const policyFns: Record<string, ReturnType<typeof vi.fn>> = {}
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-2-review',
        defaultValues: { tos: true as const },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-2-profile',
        // name is required; leave blank to trip validation
        defaultValues: { city: 'Cambridge' },
        next: review,
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-2-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: profile,
      })
      // Spy on each form's policy method so we can assert it fired.
      for (const f of [account, profile, review]) {
        const spy = vi.fn(f.applyInvalidSubmitPolicy)
        ;(f as unknown as { applyInvalidSubmitPolicy: typeof spy }).applyInvalidSubmitPolicy = spy
        policyFns[f.key] = spy
      }
      const wizard = useWizard(account)
      return { wizard }
    })
    apps.push(app)
    const submit = result.wizard.handleSubmit(onSubmit, onError)
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] as { formKey: string; message: string }[]
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((e) => e.formKey === 'hs-2-profile')).toBe(true)
    expect(result.wizard.current).toBe('hs-2-profile')
    expect(policyFns['hs-2-profile']).toHaveBeenCalledTimes(1)
    expect(result.wizard.complete).toBe(false)
    expect(result.wizard.submissionAttempts).toBe(1)
  })

  it('navigateToFirstError: false leaves current step alone on failure', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-3-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-3-account',
        // missing password → validation fails
        defaultValues: { email: 'a@b.c' },
        next: review,
      })
      const wizard = useWizard(account, { navigateToFirstError: false })
      return { wizard }
    })
    apps.push(app)
    const submit = result.wizard.handleSubmit(vi.fn(), vi.fn())
    await submit()
    expect(result.wizard.current).toBe('hs-3-account')
  })

  it('complete flips back to false when a walked form is edited after success', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-4-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-4-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: review,
      })
      const wizard = useWizard(account)
      return { wizard, account }
    })
    apps.push(app)
    await result.wizard.handleSubmit(vi.fn())()
    expect(result.wizard.complete).toBe(true)
    result.account.setValue('email', 'b@c.d')
    // Two ticks: one flushes the form's field-state batch, one flushes
    // the wizard's `meta.updatedAt` watcher that flips `complete` back.
    await nextTick()
    await nextTick()
    expect(result.wizard.complete).toBe(false)
  })

  it('re-entrancy: a second handleSubmit while in flight dev-warns + no-ops', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-5-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-5-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: review,
      })
      return { wizard: useWizard(account) }
    })
    apps.push(app)
    const submit = result.wizard.handleSubmit(onSubmit)
    const first = submit()
    const second = submit()
    await Promise.all([first, second])
    warnSpy.mockRestore()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(warnings.some((w) => w.includes('re-entrant'))).toBe(true)
  })

  it('activation failure during walk surfaces a form-level error', async () => {
    const onError = vi.fn()
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-6-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-6-account',
        defaultValues: async () => {
          throw new Error('factory exploded')
        },
        next: review,
      })
      return { wizard: useWizard(account) }
    })
    apps.push(app)
    await result.wizard.handleSubmit(vi.fn(), onError)()
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] as { formKey: string; code?: string }[]
    const activationError = errors.find(
      (e) => e.formKey === 'hs-6-account' && e.code === 'atta:activation-failed'
    )
    expect(activationError).toBeDefined()
  })

  it('per-form meta.submitting stays false during wizard submit walk', async () => {
    const observedAccountSubmitting: boolean[] = []
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-7-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-7-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: review,
      })
      return { wizard: useWizard(account), account }
    })
    apps.push(app)
    // Watch the per-form submitting flag for the duration of the wizard walk.
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

  it('canAdvance reflects graph structure (entry has next → true; terminal → false)', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-8-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-8-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: review,
      })
      return { wizard: useWizard(account) }
    })
    apps.push(app)
    expect(result.wizard.canAdvance).toBe(true)
    expect(result.wizard.canGoBack).toBe(false)
    await result.wizard.next()
    expect(result.wizard.current).toBe('hs-8-review')
    expect(result.wizard.canAdvance).toBe(false)
    expect(result.wizard.canGoBack).toBe(true)
  })

  it('wizard.reset() zeros lifecycle and calls reset on every reachable form', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-9-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-9-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: review,
      })
      return { wizard: useWizard(account), account, review }
    })
    apps.push(app)
    await result.wizard.handleSubmit(vi.fn())()
    expect(result.wizard.complete).toBe(true)
    expect(result.wizard.submissionAttempts).toBe(1)
    result.account.setValue('email', 'edited@b.c')
    expect(result.account.meta.dirty).toBe(true)
    result.wizard.reset()
    expect(result.wizard.complete).toBe(false)
    expect(result.wizard.submissionAttempts).toBe(0)
    expect(result.account.meta.dirty).toBe(false)
    expect(result.account.values.email).toBe('a@b.c')
  })

  it('mid-submission next/back/goTo dev-warn + no-op', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-10-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-10-account',
        defaultValues: { email: 'a@b.c', password: 'passw0rd' },
        next: review,
      })
      return { wizard: useWizard(account) }
    })
    apps.push(app)
    const inFlight = result.wizard.handleSubmit(onSubmit)()
    expect(result.wizard.submitting).toBe(true)
    const startKey = result.wizard.current
    void result.wizard.next()
    result.wizard.back()
    result.wizard.goTo('hs-10-review')
    expect(result.wizard.current).toBe(startKey)
    await inFlight
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('useWizard.next'))).toBe(true)
    expect(warnings.some((w) => w.includes('useWizard.back'))).toBe(true)
    expect(warnings.some((w) => w.includes('useWizard.goTo'))).toBe(true)
  })

  it('wizard.next() with invalid form does not advance and triggers policy', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-11-review',
        defaultValues: { tos: true as const },
      })
      const account = useForm({
        schema: accountSchema,
        key: 'hs-11-account',
        // missing password — process() will fail
        defaultValues: { email: 'a@b.c' },
        next: review,
      })
      const spy = vi.fn(account.applyInvalidSubmitPolicy)
      ;(account as unknown as { applyInvalidSubmitPolicy: typeof spy }).applyInvalidSubmitPolicy =
        spy
      return { wizard: useWizard(account), policy: spy }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.wizard.current).toBe('hs-11-account')
    expect(result.policy).toHaveBeenCalledTimes(1)
  })

  it('branching success walks only the picked subgraph', async () => {
    const onSubmit = vi.fn<(ctx: WizardSubmitContext) => void>()
    const { app, result } = mountHarness(() => {
      const review = useForm({
        schema: reviewSchema,
        key: 'hs-12-review',
        defaultValues: { tos: true as const },
      })
      const profile = useForm({
        schema: profileSchema,
        key: 'hs-12-profile',
        defaultValues: { name: 'Ada', city: 'Cambridge' },
        next: review,
      })
      const organization = useForm({
        schema: z.object({ org: z.string().min(1) }),
        key: 'hs-12-organization',
        defaultValues: { org: 'Acme' },
        next: review,
      })
      const account = useForm({
        schema: z.object({ role: z.enum(['individual', 'org']) }),
        key: 'hs-12-account',
        defaultValues: { role: 'individual' as const },
        next: {
          pick: (parsed) => (parsed.role === 'org' ? organization : profile),
          forms: [profile, organization] as const,
        },
      })
      return { wizard: useWizard(account), account }
    })
    apps.push(app)
    await result.wizard.handleSubmit(onSubmit)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as WizardSubmitContext
    expect(ctx.path.map((f) => f.key)).toEqual(['hs-12-account', 'hs-12-profile', 'hs-12-review'])
    // Cache only includes the walked branch.
    expect(Object.keys(ctx.values).sort()).toEqual([
      'hs-12-account',
      'hs-12-profile',
      'hs-12-review',
    ])
  })

  it('branching failure walks ALL declared subgraphs in parallel', async () => {
    const onError = vi.fn()
    const branchDurationsMs: number[] = []
    function makeBranchSchema(key: string) {
      return z.object({
        value: z
          .string()
          .min(1, `branch ${key} required`)
          .refine(async () => {
            const start = Date.now()
            await new Promise((r) => setTimeout(r, 50))
            branchDurationsMs.push(Date.now() - start)
            return true
          }, 'async check failed'),
      })
    }
    const { app, result } = mountHarness(() => {
      const branchA = useForm({
        schema: makeBranchSchema('a'),
        key: 'hs-13-a',
        defaultValues: { value: '' },
      })
      const branchB = useForm({
        schema: makeBranchSchema('b'),
        key: 'hs-13-b',
        defaultValues: { value: '' },
      })
      const entry = useForm({
        schema: z.object({ kind: z.string().min(1, 'kind required') }),
        key: 'hs-13-entry',
        // Empty default → min(1) fails → entry invalid → parallel-walk
        // both branches.
        defaultValues: { kind: '' },
        next: {
          pick: (parsed) => (parsed.kind === 'a' ? branchA : branchB),
          forms: [branchA, branchB] as const,
        },
      })
      return { wizard: useWizard(entry) }
    })
    apps.push(app)
    const t0 = Date.now()
    await result.wizard.handleSubmit(vi.fn(), onError)()
    const elapsed = Date.now() - t0
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] as { formKey: string; message: string }[]
    const failedKeys = new Set(errors.map((e) => e.formKey))
    expect(failedKeys.has('hs-13-entry')).toBe(true)
    // Both branches walked → both surfaced their min(1) errors.
    expect(failedKeys.has('hs-13-a')).toBe(true)
    expect(failedKeys.has('hs-13-b')).toBe(true)
    // Parallel: total elapsed under 150ms (well below the 50ms * 2 = 100ms sequential floor + slack).
    expect(elapsed).toBeLessThan(150)
  })
})
