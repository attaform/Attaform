// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle } from '../utils/form-harness'
import type { WizardLockCtx, WizardRestoreFn } from '../../src/runtime/types/types-wizard'

/**
 * `useWizard({ locked })` — the visitation gate.
 *
 * A locked step's member form is FROZEN through Part 1's `externalLock`
 * channel, so its value writes no-op at the data layer no matter the
 * write origin. That is the load-bearing guarantee: a hard prerequisite
 * (a Terms acceptance, say) leaves every downstream step un-fillable
 * until it clears, and no navigation trick reaches around it. The lock
 * also surfaces on `wizard.statuses[key].locked` and, once the
 * activation funnel lands, refuses navigation onto a locked step.
 *
 * Exercised against both Zod adapters: the freeze lives below the
 * adapter layer, so parity is the contract.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any
type LockPolicy = (ctx: WizardLockCtx) => readonly string[]

// zV3 cast to v4's static type so the shared describe.each loop
// type-checks; the real v3 runtime runs identically at the value layer.
const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)('useWizard({ locked }) — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
    document.body.innerHTML = ''
  })

  // A three-step wizard modelled on the Cubic Housing gate: `terms` is
  // the prerequisite, `shipping` / `payment` are the sensitive
  // downstream steps. Each member form seeds a default so a frozen write
  // is visible as "value unchanged." `extra.restore` drives the
  // deep-link / back-forward paths; `extra.termsDefaults` swaps the gate
  // to async defaults for the readiness-defer cases.
  function mountGatedWizard(
    locked?: LockPolicy,
    extra: { restore?: WizardRestoreFn | false; termsDefaults?: unknown } = {}
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        const terms = useForm({
          key: 'terms',
          schema: z.object({ accepted: z.boolean() }),
          defaultValues: extra.termsDefaults ?? { accepted: true },
        })
        const shipping = useForm({
          key: 'shipping',
          schema: z.object({ addr: z.string() }),
          defaultValues: { addr: 'init-addr' },
        })
        const payment = useForm({
          key: 'payment',
          schema: z.object({ card: z.string() }),
          defaultValues: { card: 'init-card' },
        })
        handle.terms = terms
        handle.shipping = shipping
        handle.payment = payment
        handle.wizard = useWizard({
          steps: [terms, shipping, payment],
          restore: extra.restore ?? false,
          persist: false,
          ...(locked !== undefined ? { locked } : {}),
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle
  }

  // The canonical gate: lock everything after `terms` until it submits.
  // (Bracket access + optional chain to satisfy the library's strict
  // index-signature flags; consumer code in looser tsconfigs writes the
  // dotted `ctx.forms.terms.submitted` shown in the docblock.)
  const gateAfterTerms: LockPolicy = (ctx) =>
    ctx.forms['terms']?.submitted === true ? [] : ctx.after('terms')

  it('freezes a locked step at the data layer across every write origin', async () => {
    const { wizard, shipping } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    expect(wizard.statuses.shipping.locked).toBe(true)

    // Programmatic write no-ops.
    shipping.setValue('addr', 'via-set')
    await awaitSettle()
    expect(shipping.values.addr).toBe('init-addr')

    // Host + directive write origins no-op (they return false).
    const rv = shipping.register('addr')
    expect(rv.setValueFromHost('via-host')).toBe(false)
    expect(rv.setValueWithInternalPath('via-directive')).toBe(false)
    await awaitSettle()
    expect(shipping.values.addr).toBe('init-addr')
  })

  it('leaves the gate step itself fillable (never in its own after-set)', async () => {
    const { wizard, terms } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    expect(wizard.statuses.terms.locked).toBe(false)
    terms.setValue('accepted', false)
    await awaitSettle()
    expect(terms.values.accepted).toBe(false)
  })

  it('surfaces locked on statuses[key] and tracks the policy live', async () => {
    const { wizard, terms, shipping } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    expect(wizard.statuses.shipping.locked).toBe(true)
    expect(wizard.statuses.payment.locked).toBe(true)

    // Clearing the gate (a resolved submit flips `terms.submitted`)
    // releases the downstream freeze and unlocks the statuses.
    await terms.handleSubmit(() => {})()
    await awaitSettle()

    expect(wizard.statuses.shipping.locked).toBe(false)
    expect(wizard.statuses.payment.locked).toBe(false)

    // The released form now accepts writes again.
    shipping.setValue('addr', 'now-editable')
    await awaitSettle()
    expect(shipping.values.addr).toBe('now-editable')
  })

  it('locks nothing when no policy is configured', async () => {
    const { wizard, shipping } = mountGatedWizard()
    await awaitSettle()

    expect(wizard.statuses.terms.locked).toBe(false)
    expect(wizard.statuses.shipping.locked).toBe(false)
    shipping.setValue('addr', 'freely-set')
    await awaitSettle()
    expect(shipping.values.addr).toBe('freely-set')
  })

  it('fails closed when the locked policy throws', async () => {
    const errors: string[] = []
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => errors.push(args.map((a) => String(a)).join(' ')))

    const { wizard, shipping } = mountGatedWizard(() => {
      throw new Error('policy boom')
    })
    await awaitSettle()

    // Active step (terms, index 0) stays reachable; everything else locks.
    expect(wizard.statuses.terms.locked).toBe(false)
    expect(wizard.statuses.shipping.locked).toBe(true)
    expect(wizard.statuses.payment.locked).toBe(true)
    expect(errors.some((e) => e.includes('failing closed'))).toBe(true)

    // The freeze is real even on the fail-closed path.
    shipping.setValue('addr', 'blocked')
    await awaitSettle()
    expect(shipping.values.addr).toBe('init-addr')

    errSpy.mockRestore()
  })

  // --- navigation gate (the activation funnel) --------------------------

  it('redirects a deep link into a locked step to the gate', async () => {
    const { wizard } = mountGatedWizard(gateAfterTerms, {
      restore: () => ({ step: 'payment' }),
    })
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })

  it('refuses goTo onto a locked step and holds at the gate', async () => {
    const warnings: string[] = []
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) =>
        warnings.push(args.map((a) => String(a)).join(' '))
      )

    const { wizard } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')

    wizard.goTo('payment')
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
    expect(warnings.some((w) => w.includes('goTo("payment")') && w.includes('locked'))).toBe(true)

    warnSpy.mockRestore()
  })

  it('blocks next() from advancing past the gate while locked', async () => {
    const { wizard } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    await wizard.next()
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })

  it('bounces a restore-sync (back/forward) onto a locked step', async () => {
    const stepRef = ref<string>('terms')
    const { wizard } = mountGatedWizard(gateAfterTerms, {
      restore: () => ({ step: stepRef.value }),
    })
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')

    // Simulate a back/forward landing on a locked step.
    stepRef.value = 'payment'
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })

  it('advances normally once the gate clears', async () => {
    const { wizard, terms } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    await terms.handleSubmit(() => {})()
    await awaitSettle()

    await wizard.next()
    await awaitSettle()
    expect(wizard.currentStep).toBe('shipping')
  })

  it('unlocks reactively when the gate value is set, then advances in one call', async () => {
    // A values-keyed gate unlocks the moment the acceptance value lands
    // (reactively, before any submit), so the very next advance succeeds.
    const valuesGate: LockPolicy = (ctx) =>
      ctx.forms['terms']?.values['accepted'] === true ? [] : ctx.after('terms')
    const { wizard, terms } = mountGatedWizard(valuesGate, {
      termsDefaults: { accepted: false },
    })
    await awaitSettle()
    expect(wizard.statuses.shipping.locked).toBe(true)

    // User accepts the terms.
    terms.setValue('accepted', true)
    await awaitSettle()
    expect(wizard.statuses.shipping.locked).toBe(false)

    const advanced = await wizard.tryNext()
    await awaitSettle()
    expect(advanced).toBe(true)
    expect(wizard.currentStep).toBe('shipping')
  })

  it('a submit-gate clears in one tryNext (submit settles before the advance)', async () => {
    // tryNext confirms the gate's submit ran clean and advances afterward,
    // so the `submitted`-keyed lock has released by the time the pin moves.
    const { wizard, terms } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    const advanced = await wizard.tryNext()
    await awaitSettle()
    expect(terms.meta.submitted).toBe(true)
    expect(advanced).toBe(true)
    expect(wizard.currentStep).toBe('shipping')
  })

  it('reset returns to the gate', async () => {
    const { wizard } = mountGatedWizard(gateAfterTerms)
    await awaitSettle()

    wizard.reset()
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })

  it('bounces off a step that becomes locked under the user', async () => {
    const lockShipping = ref(false)
    const policy: LockPolicy = () => (lockShipping.value ? ['shipping'] : [])
    const { wizard } = mountGatedWizard(policy)
    await awaitSettle()

    wizard.goTo('shipping')
    await awaitSettle()
    expect(wizard.currentStep).toBe('shipping')

    // Lock the current step out from under the user.
    lockShipping.value = true
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })

  // Readiness defer: a deep link should not bounce while the gate is
  // still hydrating (async defaults), and the outcome once it settles
  // depends on the durability of the gate check.

  it('defers the bounce while the gate hydrates, then keeps a durable value', async () => {
    let resolveTerms!: (v: { accepted: boolean }) => void
    const durable: LockPolicy = (ctx) =>
      ctx.forms['terms']?.values['accepted'] === true ? [] : ctx.after('terms')

    const { wizard } = mountGatedWizard(durable, {
      restore: () => ({ step: 'payment' }),
      termsDefaults: () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          resolveTerms = resolve
        }),
    })
    // Gate mid-hydration: the deep link stays on the (frozen) target
    // rather than bouncing off a not-yet-settled gate.
    await awaitSettle()
    expect(wizard.currentStep).toBe('payment')
    expect(wizard.statuses.payment.locked).toBe(true)

    // Gate resolves to a durable "accepted" → downstream unlocks and the
    // user keeps the step they deep-linked to.
    resolveTerms({ accepted: true })
    await awaitSettle()
    expect(wizard.currentStep).toBe('payment')
    expect(wizard.statuses.payment.locked).toBe(false)
  })

  it('bounces after the gate hydrates when the check still locks', async () => {
    let resolveTerms!: (v: { accepted: boolean }) => void
    const bySubmit: LockPolicy = (ctx) =>
      ctx.forms['terms']?.submitted === true ? [] : ctx.after('terms')

    const { wizard } = mountGatedWizard(bySubmit, {
      restore: () => ({ step: 'payment' }),
      termsDefaults: () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          resolveTerms = resolve
        }),
    })
    await awaitSettle()
    expect(wizard.currentStep).toBe('payment')

    // Gate settles, but `submitted` is still false, so the lock stands and
    // the corrector bounces to the gate.
    resolveTerms({ accepted: true })
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })
})
