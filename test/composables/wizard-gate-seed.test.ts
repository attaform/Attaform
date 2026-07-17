// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { gate } from '../../src/runtime/core/wizard-gate'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle } from '../utils/form-harness'

/**
 * Seed-clearing provenance (#528).
 *
 * A form gate pre-clears at mount ONLY from a seed the consumer asserted:
 * `useForm({ defaultValues })` that rehydrates the member form valid (the
 * SSR-restore path). It must never pre-clear from
 *   - a live in-session edit that happens to make the form valid, or
 *   - the schema's own structural default (a bare `z.literal(true)` fills
 *     `true` as its sole inhabitant, so a fresh consent with no
 *     `defaultValues` would otherwise read "seed-valid").
 *
 * The regression: `gate()` originally keyed the seed sample on the member
 * form's LIVE validity, sampled at the first settled verdict. For a gate
 * whose defaults do not settle valid at mount (no `defaultValues`, async
 * defaults, a deferred first pass), that first sample lands AFTER the value
 * has been edited, so it cleared off the edit, reopening the leading-signal
 * hole `gate()` exists to close. The clear now reads the store's latched
 * `defaultsValid`, which freezes the instant a write moves the form off its
 * seed. Exercised against both Zod adapters.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any
const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)('gate() seed-clearing — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
    document.body.innerHTML = ''
  })

  // `consentDefaults` omitted entirely models a fresh consent (the #528
  // shape). `fnSlots` toggles function-wrapped steps, which resolve the
  // gate lazily and were the case the leading-signal hole first surfaced
  // through. A downstream `data` step reads the freeze/lock.
  function mount(opts: { fnSlots?: boolean; consentDefaults?: { accepted: boolean } }): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consent: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wizard: any
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        const consent = useForm({
          key: 'consent',
          schema: z.object({ accepted: z.literal(true) }),
          ...(opts.consentDefaults !== undefined ? { defaultValues: opts.consentDefaults } : {}),
        })
        const data = useForm({
          key: 'data',
          schema: z.object({ name: z.string().min(1) }),
          defaultValues: { name: '' },
        })
        const steps = opts.fnSlots ? [() => gate(consent), () => data] : [gate(consent), data]
        handle.consent = consent
        handle.wizard = useWizard({ steps, persist: false })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle
  }

  it('does NOT seed-clear a fresh consent (no defaultValues) when the box is checked', async () => {
    const { consent, wizard } = mount({ fnSlots: false })
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')

    // Check the box, never submit. The schema fills `accepted: true` as its
    // sole-inhabitant default, so the LIVE verdict is valid here, but the
    // consumer never asserted a seed, so the gate stays sealed.
    consent.setValue(['accepted'], true)
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(consent.meta.disabled).toBe(false)
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT seed-clear through a lazily-resolved (function) gate slot either', async () => {
    const { consent, wizard } = mount({ fnSlots: true })
    await awaitSettle()

    consent.setValue(['accepted'], true)
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT clear when the onSubmit callback throws (the #528 repro)', async () => {
    const { consent, wizard } = mount({ fnSlots: true })
    await awaitSettle()

    consent.setValue(['accepted'], true)
    await awaitSettle()

    await consent
      .handleSubmit(async () => {
        throw new Error('server rejected the confirmation')
      })()
      .catch(() => {})
    await awaitSettle()

    // `submitted` never flipped (documented contract), and the gate agrees:
    // parse-success is not confirmation.
    expect(consent.meta.submitted).toBe(false)
    expect(consent.meta.disabled).toBe(false)
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT clear on a throwing submit even with invalid seeded defaults', async () => {
    // Defaults present but invalid isolates the SUBMIT path from the
    // seed path: a throwing onSubmit must not confirm the gate.
    const { consent, wizard } = mount({ fnSlots: true, consentDefaults: { accepted: false } })
    await awaitSettle()

    consent.setValue(['accepted'], true)
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')

    await consent
      .handleSubmit(async () => {
        throw new Error('boom')
      })()
      .catch(() => {})
    await awaitSettle()
    expect(consent.meta.submitted).toBe(false)
    expect(wizard.statuses.consent.gate).toBe('uncleared')
  })

  it('DOES clear a fresh consent on a clean submit', async () => {
    const { consent, wizard } = mount({ fnSlots: true })
    await awaitSettle()

    consent.setValue(['accepted'], true)
    await awaitSettle()

    await consent.handleSubmit(async () => {})()
    await awaitSettle()

    expect(consent.meta.submitted).toBe(true)
    expect(wizard.statuses.consent.gate).toBe('cleared')
    expect(wizard.statuses.data.locked).toBe(false)
  })

  it('DOES seed-clear from a consumer-asserted valid seed at mount (SSR restore)', async () => {
    // The server re-seeds a persisted consent as `defaultValues`; the gate
    // renders open from t=0 with no submit this session.
    const { consent, wizard } = mount({ fnSlots: false, consentDefaults: { accepted: true } })
    await awaitSettle()

    expect(consent.meta.submitted).toBe(false)
    expect(wizard.statuses.consent.gate).toBe('cleared')
    expect(wizard.statuses.data.locked).toBe(false)
  })

  it('does NOT seed-clear from an invalid consumer seed', async () => {
    const { wizard } = mount({ fnSlots: false, consentDefaults: { accepted: false } })
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })
})
