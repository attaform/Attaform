// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { gate } from '../../src/runtime/core/wizard-gate'
import { lazy } from '../../src/runtime/core/wizard-lazy'
import { createAttaform } from '../../src/runtime/core/plugin'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import { awaitSettle } from '../utils/form-harness'
import type { AnyForm, StepSlot, WizardRestoreFn } from '../../src/runtime/types/types-wizard'

/**
 * `gate(step)`: the safe-by-construction hard prerequisite.
 *
 * A gate seals every step positioned AFTER it until the gate CLEARS, and
 * clearance is submission-triggered: a member form's clean submit
 * (confirmation) or a seeded-valid form gate at mount, never a live value
 * edit (intent). That split is the whole point: the retired `locked(ctx)`
 * policy let a consumer key the gate on a leading `values` signal, so a
 * checked-but-unsubmitted consent opened the rail and a downstream step
 * could collect data before the prerequisite was confirmed. `gate()`
 * removes the choice.
 *
 * Downstream steps are frozen through Part 1's `externalLock` channel, so
 * their writes no-op at the data layer no matter the origin, and once a
 * gate clears its OWN form freezes too (a back-navigation is a read-only
 * review, never a withdrawal path). Exercised against both Zod adapters:
 * the freeze lives below the adapter layer, so parity is the contract.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Forms = { terms: any; shipping: any; payment: any }
type BuildSteps = (forms: Forms) => StepSlot[]

// zV3 cast to v4's static type so the shared describe.each loop
// type-checks; the real v3 runtime runs identically at the value layer.
const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)('useWizard gate() — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
    document.body.innerHTML = ''
  })

  // A three-step wizard modelled on the Cubic Housing gate: `terms` is the
  // prerequisite, `shipping` / `payment` are the sensitive downstream
  // steps. Each member form seeds a default so a frozen write is visible
  // as "value unchanged." `terms` defaults INVALID (a fresh consent), so
  // by default the gate is uncleared until it submits. `buildSteps` swaps
  // in the composition under test; `extra` drives deep-link / async cases.
  function mountWizard(
    buildSteps: BuildSteps = ({ terms, shipping, payment }) => [gate(terms), shipping, payment],
    extra: {
      restore?: WizardRestoreFn | false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      termsSchema?: (zz: typeof zV4) => any
      termsDefaults?: unknown
    } = {}
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        const terms = useForm({
          key: 'terms',
          schema: extra.termsSchema
            ? extra.termsSchema(z)
            : z.object({ accepted: z.literal(true) }),
          defaultValues: extra.termsDefaults ?? { accepted: false },
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
          steps: buildSteps({ terms, shipping, payment }),
          restore: extra.restore ?? false,
          persist: false,
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

  // --- the freeze (downstream) ------------------------------------------

  it('freezes every downstream step at the data layer while the gate is uncleared', async () => {
    const { wizard, shipping } = mountWizard()
    await awaitSettle()

    expect(wizard.statuses.shipping.locked).toBe(true)
    expect(wizard.statuses.payment.locked).toBe(true)

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

  it('leaves the gate step itself fillable and navigable (never in its own lock)', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    expect(wizard.statuses.terms.locked).toBe(false)
    terms.setValue('accepted', true)
    await awaitSettle()
    expect(terms.values.accepted).toBe(true)
  })

  // --- the fix: intent must not open the rail ---------------------------

  it('does NOT unlock when the gate value merely goes valid (checking the box)', async () => {
    const { wizard, terms, shipping } = mountWizard()
    await awaitSettle()
    expect(wizard.statuses.shipping.locked).toBe(true)

    // The attack: check the box, never submit. Under the old leading-signal
    // policy the rail opened here; now it stays sealed. The value lands
    // (the gate form is not frozen), but the gate is unconfirmed.
    terms.setValue('accepted', true)
    await awaitSettle()
    expect(terms.values.accepted).toBe(true)
    expect(terms.meta.submitted).toBe(false)
    expect(wizard.statuses.shipping.locked).toBe(true)
    expect(wizard.statuses.payment.locked).toBe(true)

    // And the freeze still holds: a downstream write is still refused.
    shipping.setValue('addr', 'sneaked-in')
    await awaitSettle()
    expect(shipping.values.addr).toBe('init-addr')
  })

  it('clears only on a clean submit, releasing the downstream freeze', async () => {
    const { wizard, terms, shipping } = mountWizard()
    await awaitSettle()

    // A submit with an invalid gate value does not clear.
    await terms.handleSubmit(() => {})()
    await awaitSettle()
    expect(wizard.statuses.shipping.locked).toBe(true)

    // Accept + submit clean → gate clears, downstream unlocks + thaws.
    terms.setValue('accepted', true)
    await terms.handleSubmit(() => {})()
    await awaitSettle()
    expect(wizard.statuses.shipping.locked).toBe(false)
    expect(wizard.statuses.payment.locked).toBe(false)

    shipping.setValue('addr', 'now-editable')
    await awaitSettle()
    expect(shipping.values.addr).toBe('now-editable')
  })

  // --- freeze-after-clear -----------------------------------------------

  it('freezes the gate form once cleared (back-navigation is read-only)', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    terms.setValue('accepted', true)
    const advanced = await wizard.tryNext()
    await awaitSettle()
    expect(advanced).toBe(true)
    expect(wizard.currentStep).toBe('shipping')

    // Navigate back to the cleared gate: reachable (not "locked"), but its
    // form is frozen, so there is no withdrawal path.
    wizard.goTo('terms')
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
    expect(wizard.statuses.terms.locked).toBe(false)

    const rv = terms.register('accepted')
    expect(rv.setValueFromHost(false)).toBe(false)
    terms.setValue('accepted', false)
    await awaitSettle()
    expect(terms.values.accepted).toBe(true)
  })

  // --- next() = tryNext() on a gate -------------------------------------

  it('makes next() behave like tryNext() on a gate (bare next cannot skip it)', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    // Invalid gate: next() submits, the submit fails, the pin holds.
    await wizard.next()
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
    expect(terms.meta.submissionAttempts).toBeGreaterThan(0)

    // Valid gate: next() submits clean, clears the gate, and advances.
    terms.setValue('accepted', true)
    await wizard.next()
    await awaitSettle()
    expect(terms.meta.submitted).toBe(true)
    expect(wizard.currentStep).toBe('shipping')
  })

  it('clears a gate in one tryNext (submit settles before the advance)', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    terms.setValue('accepted', true)
    const advanced = await wizard.tryNext()
    await awaitSettle()
    expect(terms.meta.submitted).toBe(true)
    expect(advanced).toBe(true)
    expect(wizard.currentStep).toBe('shipping')
  })

  // --- seeded-valid form gate (skip-if-seeded) --------------------------

  it('treats a seeded-valid form gate as pre-cleared at mount', async () => {
    const { wizard, terms } = mountWizard(
      ({ terms, shipping, payment }) => [gate(terms), shipping, payment],
      { termsDefaults: { accepted: true } }
    )
    await awaitSettle()

    // Rehydrated consent: the gate is already cleared, so downstream is
    // open from t=0, and the gate form is frozen (freeze-after-clear).
    expect(wizard.statuses.shipping.locked).toBe(false)
    expect(wizard.statuses.payment.locked).toBe(false)
    terms.setValue('accepted', false)
    await awaitSettle()
    expect(terms.values.accepted).toBe(true)
  })

  it('lets a seeded-valid gate accept a deep link into a downstream step', async () => {
    const { wizard } = mountWizard(
      ({ terms, shipping, payment }) => [gate(terms), shipping, payment],
      { termsDefaults: { accepted: true }, restore: () => ({ step: 'payment' }) }
    )
    await awaitSettle()
    expect(wizard.currentStep).toBe('payment')
  })

  // --- affordance gate (bare string) ------------------------------------

  it('re-prompts an affordance gate each session (never seeded-cleared)', async () => {
    const { wizard } = mountWizard(({ shipping, payment }) => [gate('welcome'), shipping, payment])
    await awaitSettle()

    // An affordance gate is trivially valid but NOT pre-cleared: acknowledging
    // it is the clearance, so it seals downstream until the user advances.
    expect(wizard.currentStep).toBe('welcome')
    expect(wizard.statuses.shipping.locked).toBe(true)

    await wizard.next()
    await awaitSettle()
    expect(wizard.currentStep).toBe('shipping')
    expect(wizard.statuses.shipping.locked).toBe(false)
  })

  // --- navigation gate (the activation funnel) --------------------------

  it('redirects a deep link past an uncleared gate to the gate', async () => {
    const { wizard } = mountWizard(undefined, { restore: () => ({ step: 'payment' }) })
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
  })

  it('refuses goTo onto a downstream-locked step and holds at the gate', async () => {
    const warnings: string[] = []
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) =>
        warnings.push(args.map((a) => String(a)).join(' '))
      )

    const { wizard } = mountWizard()
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')

    wizard.goTo('payment')
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
    expect(warnings.some((w) => w.includes('goTo("payment")') && w.includes('gate'))).toBe(true)

    warnSpy.mockRestore()
  })

  // --- handleSubmit completeness guard ----------------------------------

  it('refuses to complete the wizard while a gate is uncleared', async () => {
    // The narrow hole the guard closes: the gate value is VALID (checked)
    // but unconfirmed, and every downstream step is valid-by-default, so a
    // whole-wizard finish would otherwise succeed past an unconfirmed
    // prerequisite. handleSubmit must route it through onError instead.
    const { wizard, terms } = mountWizard()
    await awaitSettle()
    terms.setValue('accepted', true)
    await awaitSettle()

    const onSubmit = vi.fn()
    let reported: readonly { formKey: string; code?: string }[] = []
    await wizard.handleSubmit(onSubmit, (errs: readonly { formKey: string; code?: string }[]) => {
      reported = errs
    })()
    await awaitSettle()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(wizard.done).toBe(false)
    expect(
      reported.some((e) => e.formKey === 'terms' && e.code === AttaformErrorCode.GateNotCleared)
    ).toBe(true)
  })

  it('completes once the gate has cleared and every step is valid', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    terms.setValue('accepted', true)
    await wizard.tryNext()
    await awaitSettle()

    const onSubmit = vi.fn()
    await wizard.handleSubmit(onSubmit)()
    await awaitSettle()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(wizard.done).toBe(true)
  })

  // --- reset ------------------------------------------------------------

  it('re-gates on reset', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    terms.setValue('accepted', true)
    await wizard.tryNext()
    await awaitSettle()
    expect(wizard.currentStep).toBe('shipping')
    expect(wizard.statuses.shipping.locked).toBe(false)

    wizard.reset()
    await awaitSettle()
    expect(wizard.currentStep).toBe('terms')
    expect(wizard.statuses.shipping.locked).toBe(true)
  })

  // --- composition + commutativity --------------------------------------

  it('locks downstream through gate(lazy(fn)) and lazy(ctx => gate(fn))', async () => {
    for (const build of [
      // gate wrapping lazy
      ({ terms, shipping, payment }: Forms): StepSlot[] => [
        gate(lazy(() => terms as AnyForm)),
        shipping,
        payment,
      ],
      // lazy wrapping gate, the commutative twin
      ({ terms, shipping, payment }: Forms): StepSlot[] => [
        lazy(() => gate(terms as AnyForm)),
        shipping,
        payment,
      ],
    ]) {
      const { wizard, terms, shipping } = mountWizard(build)
      await awaitSettle()

      // Same shape both ways: the wrapped `terms` gates, downstream frozen.
      expect(wizard.currentStep).toBe('terms')
      expect(wizard.statuses.shipping.locked).toBe(true)
      shipping.setValue('addr', 'nope')
      await awaitSettle()
      expect(shipping.values.addr).toBe('init-addr')

      // And both clear on the wrapped form's clean submit.
      terms.setValue('accepted', true)
      const advanced = await wizard.tryNext()
      await awaitSettle()
      expect(advanced).toBe(true)
      expect(wizard.currentStep).toBe('shipping')

      for (const app of apps.splice(0)) app.unmount()
      document.body.innerHTML = ''
    }
  })

  it('gates conditionally from a function slot (the KYC threshold pattern)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        const transfer = useForm({
          key: 'transfer',
          schema: z.object({ amount: z.number() }),
          defaultValues: { amount: 500 },
        })
        const kyc = useForm({
          key: 'kyc',
          schema: z.object({ id: z.string().min(1) }),
          defaultValues: { id: '' },
        })
        const confirm = useForm({
          key: 'confirm',
          schema: z.object({ ok: z.literal(true) }),
          defaultValues: { ok: true },
        })
        handle.transfer = transfer
        handle.kyc = kyc
        handle.wizard = useWizard({
          steps: [transfer, () => (transfer.values.amount > 10_000 ? gate(kyc) : kyc), confirm],
          restore: false,
          persist: false,
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    await awaitSettle()

    // Below threshold: kyc is an ordinary step, `confirm` is reachable,
    // and kyc carries no gate role.
    expect(handle.wizard.statuses.confirm.locked).toBe(false)
    expect(handle.wizard.statuses.kyc.gate).toBe(null)

    // Cross the threshold: the same slot resolves to gate(kyc) → `confirm`
    // seals until kyc submits, and kyc now reads as an uncleared gate.
    handle.transfer.setValue('amount', 25_000)
    await awaitSettle()
    expect(handle.wizard.statuses.confirm.locked).toBe(true)
    expect(handle.wizard.statuses.kyc.gate).toBe('uncleared')

    // Back under the threshold: the gate drops, `confirm` reopens, and
    // kyc's gate role reverts to null.
    handle.transfer.setValue('amount', 100)
    await awaitSettle()
    expect(handle.wizard.statuses.confirm.locked).toBe(false)
    expect(handle.wizard.statuses.kyc.gate).toBe(null)
  })

  // --- the .gate status field (readable gate role) ----------------------

  it('exposes a step gate role: null for plain, uncleared then cleared for a gate', async () => {
    const { wizard, terms } = mountWizard()
    await awaitSettle()

    // A gate reports its own role; plain downstream steps report null. The
    // callable single-key form and the drilled form agree.
    expect(wizard.statuses.terms.gate).toBe('uncleared')
    expect(wizard.statuses('terms').gate).toBe('uncleared')
    expect(wizard.statuses.shipping.gate).toBe(null)
    expect(wizard.statuses.payment.gate).toBe(null)

    // Checking the box (intent) does NOT clear it: still 'uncleared'.
    terms.setValue('accepted', true)
    await awaitSettle()
    expect(wizard.statuses.terms.gate).toBe('uncleared')

    // A clean submit (confirmation) flips it to 'cleared'.
    await terms.handleSubmit(() => {})()
    await awaitSettle()
    expect(wizard.statuses.terms.gate).toBe('cleared')

    // reset re-arms the gate.
    wizard.reset()
    await awaitSettle()
    expect(wizard.statuses.terms.gate).toBe('uncleared')
  })

  it('reads gate and locked as independent axes (a later gate is both uncleared and locked)', async () => {
    // welcome (affordance) gates first; terms (form) is itself a gate AND
    // sits behind the uncleared welcome, so it reads uncleared + locked.
    const { wizard } = mountWizard(({ terms, shipping, payment }) => [
      gate('welcome'),
      gate(terms),
      shipping,
      payment,
    ])
    await awaitSettle()

    // The first uncleared gate is reachable; a later gate is sealed behind
    // it yet still reports its own uncleared role.
    expect(wizard.statuses.welcome.gate).toBe('uncleared')
    expect(wizard.statuses.welcome.locked).toBe(false)
    expect(wizard.statuses.terms.gate).toBe('uncleared')
    expect(wizard.statuses.terms.locked).toBe(true)
    expect(wizard.statuses.shipping.gate).toBe(null)
    expect(wizard.statuses.shipping.locked).toBe(true)

    // Acknowledge welcome: it clears, terms becomes the reachable gate but
    // is still its own uncleared prerequisite.
    await wizard.next()
    await awaitSettle()
    expect(wizard.statuses.welcome.gate).toBe('cleared')
    expect(wizard.statuses.welcome.locked).toBe(false)
    expect(wizard.statuses.terms.gate).toBe('uncleared')
    expect(wizard.statuses.terms.locked).toBe(false)
  })

  it('reads a seeded-valid form gate as cleared from mount', async () => {
    const { wizard } = mountWizard(
      ({ terms, shipping, payment }) => [gate(terms), shipping, payment],
      { termsDefaults: { accepted: true } }
    )
    await awaitSettle()

    // Rehydrated consent is pre-cleared, so its gate role reads 'cleared'
    // synchronously (the timing the SSR landing relies on).
    expect(wizard.statuses.terms.gate).toBe('cleared')
    expect(wizard.statuses.shipping.gate).toBe(null)
  })
})
