// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `useWizard` exposes the current step as a triple:
 *
 *   - `currentStep` — the active step's key. Always defined (steps list
 *                     is non-empty by construction).
 *   - `activeForm`  — a live facade over the active step's form. Always
 *                     defined (noop forms cover string slots); reports
 *                     the active step but is not `===` the raw handle.
 *   - `activeIndex` — the active step's 0-based index.
 *
 * `activeForm` and `activeIndex` are derived getters — they update
 * synchronously when `goTo` / `next` / `back` flips `currentStep`. The
 * `activeForm` facade is built once and late-binds `handleSubmit`, so a
 * handler captured at setup time always targets the current step.
 */

const schema = z.object({ email: z.string().optional() })

function mountWizardHarness<R>(setup: () => R): { app: App; result: R } {
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

describe('useWizard — activeForm + activeIndex', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('activeForm is the form whose key matches currentStep', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      const c = useForm({ schema, key: 'c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.activeForm!.key).toBe('a')
    await result.next()
    expect(result.activeForm!.key).toBe('b')
    result.goTo('c')
    expect(result.activeForm!.key).toBe('c')
    result.back()
    expect(result.activeForm!.key).toBe('b')
  })

  it('activeIndex is the 0-based index of the active step', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      const c = useForm({ schema, key: 'c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.activeIndex).toBe(0)
    await result.next()
    expect(result.activeIndex).toBe(1)
    result.goTo('c')
    expect(result.activeIndex).toBe(2)
    result.back()
    expect(result.activeIndex).toBe(1)
  })

  it('activeForm is a live facade keyed to the active step; forms[key] keeps raw identity', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    // The facade reports the active step's key but is NOT the raw handle.
    expect(result.activeForm?.key).toBe('a')
    expect(result.activeForm).not.toBe(result.steps[0]?.form)
    // The raw per-step handle stays reachable (and identity-stable) via forms[key].
    expect(result.forms.a).toBe(result.steps[0]?.form)
    await result.next()
    expect(result.activeForm?.key).toBe('b')
    expect(result.forms.b).toBe(result.steps[1]?.form)
  })

  it('facade reads (key / values) reflect the active step, with a stable identity', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    result.forms.a.setValue('email', 'a-val')
    result.forms.b.setValue('email', 'b-val')
    await nextTick()
    // Stable identity: every read returns the one built-once facade.
    const live = result.activeForm
    expect(result.activeForm).toBe(live)
    // The captured reference tracks the active step's key + values live.
    expect(live?.key).toBe('a')
    expect(live?.values['email']).toBe('a-val')
    await result.next()
    expect(live?.key).toBe('b')
    expect(live?.values['email']).toBe('b-val')
  })

  it('a handler captured from activeForm on step 1 validates whichever step is active when it runs', async () => {
    const requiredSchema = z.object({ email: z.string().min(1, 'Required') })
    let onNext: (event?: Event) => Promise<void> = async () => {}
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema: requiredSchema, key: 'a' })
      const b = useForm({ schema: requiredSchema, key: 'b' })
      const c = useForm({ schema: requiredSchema, key: 'c' })
      const wizard = useWizard({ steps: [a, b, c], restore: false, persist: false })
      // Captured ONCE, on step 1: the canonical gated-advance composition.
      onNext = wizard.activeForm.handleSubmit(() => wizard.next())
      return wizard
    })
    apps.push(app)

    // Move to step 2 without using onNext.
    result.goTo('b')
    await nextTick()
    expect(result.currentStep).toBe('b')

    // The step-1-captured handler validates step 2 (the current step), not
    // step 1: b is empty so it stays put, b counts the attempt, a is untouched.
    await onNext()
    expect(result.currentStep).toBe('b')
    expect(result.forms.b.meta.errorCount).toBeGreaterThan(0)
    expect(result.forms.b.meta.submissionAttempts).toBe(1)
    expect(result.forms.a.meta.submissionAttempts).toBe(0)

    // Make step 2 valid, invoke again: the same captured handler now
    // advances from step 2 to step 3.
    result.forms.b.setValue('email', 'b@example.com')
    await nextTick()
    await onNext()
    expect(result.currentStep).toBe('c')
  })

  it('activeForm tracks string-slot noop forms', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      return useWizard({ steps: ['intro', a], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.activeForm!.key).toBe('intro')
    result.goTo('a')
    expect(result.activeForm!.key).toBe('a')
    result.goTo('intro')
    expect(result.activeForm!.key).toBe('intro')
  })
})
