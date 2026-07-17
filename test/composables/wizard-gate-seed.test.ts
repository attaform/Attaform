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
 * Seed-clearing provenance (#528, #529).
 *
 * A form gate's initial clearance is established two ways, and inference is
 * NOT one of them:
 *   - a member form's clean SUBMIT (confirmation), or
 *   - an explicit `useWizard({ defaultStatuses: { [key]: { gate: 'cleared' } } })`
 *     seed (an SSR restore of a prerequisite the server already recorded).
 *
 * What used to clear a gate and no longer does: the member form's values
 * happening to validate at mount. "Value valid" and "prerequisite confirmed"
 * are separate facts (#529). Keying clearance on validity opened the gate on
 * a value that is the opposite of consent — a bare `z.boolean` seeded
 * `{ accepted: false }` reads valid, yet `false` withholds consent (#528). So
 * a valid-but-unconfirmed seed keeps the rail sealed; only a submit or an
 * explicit seed opens it. Exercised against both Zod adapters.
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

  // `consentDefaults` omitted models a fresh consent; present-but-valid models
  // the rehydrated form that used to auto-clear (now must not). `fnSlots`
  // toggles function-wrapped steps, which resolve the gate lazily and were
  // the case the leading-signal hole first surfaced through. `defaultStatuses`
  // is the new explicit seed channel. A downstream `data` step reads the
  // freeze/lock.
  function mount(opts: {
    fnSlots?: boolean
    consentDefaults?: Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consentSchema?: any
    defaultStatuses?: Record<string, { valid?: boolean; gate?: 'cleared' | 'uncleared' }>
  }): {
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
          schema: opts.consentSchema ?? z.object({ accepted: z.literal(true) }),
          ...(opts.consentDefaults !== undefined ? { defaultValues: opts.consentDefaults } : {}),
        })
        const data = useForm({
          key: 'data',
          schema: z.object({ name: z.string().min(1) }),
          defaultValues: { name: '' },
        })
        const steps = opts.fnSlots ? [() => gate(consent), () => data] : [gate(consent), data]
        handle.consent = consent
        handle.wizard = useWizard({
          steps,
          persist: false,
          ...(opts.defaultStatuses !== undefined ? { defaultStatuses: opts.defaultStatuses } : {}),
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

  it('does NOT clear a fresh consent (no defaultValues) when the box is checked', async () => {
    const { consent, wizard } = mount({ fnSlots: false })
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')

    // Check the box, never submit. The schema fills `accepted: true` as its
    // sole-inhabitant default, so the LIVE verdict is valid here, but a value
    // going valid is not confirmation, so the gate stays sealed.
    consent.setValue(['accepted'], true)
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(consent.meta.disabled).toBe(false)
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT clear through a lazily-resolved (function) gate slot either', async () => {
    const { consent, wizard } = mount({ fnSlots: true })
    await awaitSettle()

    consent.setValue(['accepted'], true)
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT clear when the onSubmit callback throws', async () => {
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

  it('does NOT clear on a throwing submit even with seeded defaults', async () => {
    // Defaults present isolates the SUBMIT path: a throwing onSubmit must
    // not confirm the gate regardless of the seeded values.
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

  it('DOES seed-clear a gate from defaultStatuses at mount (server-truth restore)', async () => {
    // The server records that this session already met the prerequisite and
    // seeds it directly; the gate renders open from t=0 with no submit and no
    // reliance on the member form's values validating.
    const { consent, wizard } = mount({
      fnSlots: false,
      defaultStatuses: { consent: { gate: 'cleared' } },
    })
    await awaitSettle()

    expect(consent.meta.submitted).toBe(false)
    expect(wizard.statuses.consent.gate).toBe('cleared')
    expect(wizard.statuses.data.locked).toBe(false)
  })

  it('DOES seed-clear through a lazily-resolved (function) gate slot', async () => {
    const { wizard } = mount({
      fnSlots: true,
      defaultStatuses: { consent: { gate: 'cleared' } },
    })
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('cleared')
    expect(wizard.statuses.data.locked).toBe(false)
  })

  it('treats a gate: "uncleared" seed as a no-op (the default)', async () => {
    const { wizard } = mount({
      fnSlots: false,
      defaultStatuses: { consent: { gate: 'uncleared' } },
    })
    await awaitSettle()
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT pre-clear from a valid consumer seed (inference retired)', async () => {
    // A rehydrated-valid member form used to auto-clear the gate at mount.
    // That inference is gone: valid values are not confirmation, so the gate
    // stays sealed until a submit or an explicit `defaultStatuses` seed.
    const { consent, wizard } = mount({ fnSlots: false, consentDefaults: { accepted: true } })
    await awaitSettle()
    expect(consent.meta.valid).toBe(true)
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })

  it('does NOT pre-clear the z.boolean + { accepted: false } trap', async () => {
    // #528/#529: `false` is a VALID boolean, so the old inference opened the
    // gate on a value that is the opposite of consent. Retiring it closes the
    // class — a valid-but-unconfirmed seed keeps the rail sealed.
    const { consent, wizard } = mount({
      fnSlots: false,
      consentSchema: z.object({ accepted: z.boolean() }),
      consentDefaults: { accepted: false },
    })
    await awaitSettle()
    expect(consent.meta.valid).toBe(true)
    expect(wizard.statuses.consent.gate).toBe('uncleared')
    expect(wizard.statuses.data.locked).toBe(true)
  })
})
