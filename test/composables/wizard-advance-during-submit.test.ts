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
import type { StepSlot } from '../../src/runtime/types/types-wizard'

/**
 * Advancing from inside the active step's own submit.
 *
 * `wizard.activeForm.handleSubmit(() => wizard.next())` is the documented
 * composition for custom valid / invalid handling, and the docs state it
 * is what `tryNext()` is shorthand for. On a `gate()` step it was neither:
 * `next()` re-routes into `tryNext()`, which submitted a form that was
 * already submitting, so `handleSubmit`'s re-entry guard swallowed it, the
 * swallowed submit read back as "not clean", and the advance was dropped
 * with no error, no `firstOwnError` and no warning anywhere.
 *
 * `next()` / `tryNext()` now ride an in-flight submit instead of starting a
 * second one, and an already-cleared gate is plain navigation again. Both
 * exist so one user action costs the consumer's server exactly one POST:
 * a duplicate submit assumes an idempotent endpoint, and double-counts
 * every analytics event keyed on the submit lifecycle.
 *
 * The gate guarantee is unchanged: the advance still happens only when the
 * submit lands clean, so a callback that throws after calling `next()`
 * leaves the pin on the gate.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)('advancing during a submit — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
    document.body.innerHTML = ''
  })

  // `docs` is the prerequisite. Its schema carries no fields on purpose:
  // the gate is a fact on the server, so the form is the confirmation
  // channel and nothing else. `shipping` is the sealed downstream step,
  // seeded so a refused write is visible as "value unchanged".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mountWizard(gated = true): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        const docs = useForm({ key: 'docs', schema: z.object({}) })
        const shipping = useForm({
          key: 'shipping',
          schema: z.object({ addr: z.string() }),
          defaultValues: { addr: 'init-addr' },
        })
        const review = useForm({
          key: 'review',
          schema: z.object({ note: z.string() }),
          defaultValues: { note: 'init-note' },
        })
        handle.docs = docs
        handle.shipping = shipping
        handle.review = review
        handle.wizard = useWizard({
          steps: [gated ? gate(docs) : docs, shipping, review] as StepSlot[],
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
    return handle
  }

  // --- the reported defect ----------------------------------------------

  it('advances when next() is called from inside the gate form’s own submit', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()
    expect(wizard.activeIndex).toBe(0)

    let ran = 0
    await docs.handleSubmit(async () => {
      ran += 1
      await wizard.next()
    })()
    await awaitSettle()

    expect(ran).toBe(1)
    expect(wizard.activeIndex).toBe(1)
    expect(wizard.statuses.docs.gate).toBe('cleared')
  })

  it('advances for the documented activeForm.handleSubmit(() => next()) composition', async () => {
    const { wizard } = mountWizard()
    await awaitSettle()

    const onNext = wizard.activeForm.handleSubmit(() => wizard.next())
    await onNext()
    await awaitSettle()

    expect(wizard.activeIndex).toBe(1)
  })

  it('advances through tryNext() called from inside the callback', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()

    let resolved: unknown
    await docs.handleSubmit(async () => {
      resolved = await wizard.tryNext()
    })()
    await awaitSettle()

    // The pin had not moved yet when the call resolved, so the honest
    // answer at that moment is `false`; the advance lands with the submit.
    expect(resolved).toBe(false)
    expect(wizard.activeIndex).toBe(1)
  })

  // --- the gate guarantee is unchanged -----------------------------------

  it('holds the pin on the gate while the submit is still running', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()

    let indexInsideCallback = -1
    await docs.handleSubmit(async () => {
      await wizard.next()
      indexInsideCallback = wizard.activeIndex
    })()
    await awaitSettle()

    // Clearance latches on the clean resolve, so mid-callback the gate is
    // still unconfirmed and the pin must not have moved.
    expect(indexInsideCallback).toBe(0)
    expect(wizard.activeIndex).toBe(1)
  })

  it('does NOT advance when the callback throws after calling next()', async () => {
    const { wizard, docs, shipping } = mountWizard()
    await awaitSettle()

    await docs.handleSubmit(async () => {
      await wizard.next()
      throw new Error('the server has not reconciled yet')
    })()
    await awaitSettle()

    expect(wizard.activeIndex).toBe(0)
    expect(wizard.statuses.docs.gate).toBe('uncleared')
    expect(wizard.statuses.shipping.locked).toBe(true)
    expect(docs.meta.firstOwnError?.message).toBe('the server has not reconciled yet')

    // The downstream data freeze still holds.
    shipping.setValue('addr', 'sneaked-in')
    await awaitSettle()
    expect(shipping.values.addr).toBe('init-addr')
  })

  it('drops a deferral whose submit failed, so a later clean submit does not move the pin', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()

    await docs.handleSubmit(async () => {
      await wizard.next()
      throw new Error('refused')
    })()
    await awaitSettle()
    expect(wizard.activeIndex).toBe(0)

    // A second, clean submit. It legitimately clears the gate, but the
    // advance belonged to the run that failed and must not fire here.
    await docs.handleSubmit(async () => {})()
    await awaitSettle()
    expect(wizard.statuses.docs.gate).toBe('cleared')
    expect(wizard.activeIndex).toBe(0)
  })

  // --- one action, one submission ----------------------------------------

  it('costs exactly one submission when advancing from inside the callback', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()

    await docs.handleSubmit(async () => {
      await wizard.next()
    })()
    await awaitSettle()

    expect(docs.meta.submissionAttempts).toBe(1)
  })

  it('treats next() on an already-cleared gate as plain navigation', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()

    await docs.handleSubmit(async () => {})()
    await awaitSettle()
    expect(wizard.statuses.docs.gate).toBe('cleared')
    expect(docs.meta.submissionAttempts).toBe(1)

    await wizard.next()
    await awaitSettle()

    // A cleared gate has nothing left to confirm, so the advance must not
    // re-run the whole submit lifecycle to re-ask.
    expect(wizard.activeIndex).toBe(1)
    expect(docs.meta.submissionAttempts).toBe(1)
  })

  it('advances exactly one step for repeated next() calls in one submit', async () => {
    const { wizard, docs } = mountWizard()
    await awaitSettle()

    await docs.handleSubmit(async () => {
      await wizard.next()
      await wizard.next()
      await wizard.next()
    })()
    await awaitSettle()

    expect(wizard.activeIndex).toBe(1)
  })

  // --- the plain-step path is untouched ----------------------------------

  it('leaves a non-gate step advancing immediately from inside its callback', async () => {
    const { wizard, docs } = mountWizard(false)
    await awaitSettle()

    let indexInsideCallback = -1
    await docs.handleSubmit(async () => {
      await wizard.next()
      indexInsideCallback = wizard.activeIndex
    })()
    await awaitSettle()

    // Navigation on a plain step never waited on a submit, and still does
    // not: `handleSubmit` already ruled the values valid by the time the
    // callback runs.
    expect(indexInsideCallback).toBe(1)
    expect(wizard.activeIndex).toBe(1)
  })
})
