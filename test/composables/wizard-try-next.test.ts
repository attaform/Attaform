// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `wizard.tryNext()` is the inline-bindable gated advance: validate the
 * active step, advance iff it passed, and resolve to whether the pin
 * moved. It is the shorthand for `activeForm.handleSubmit(() => next())`,
 * so it is step-scoped (only the active form validates, unlike the
 * whole-wizard `handleSubmit`) and never advances on invalid input.
 */

const requiredSchema = z.object({ email: z.string().min(1, 'Required') })

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

describe('useWizard — tryNext', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('advances and resolves true when the active step is valid', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema: requiredSchema, key: 'a' })
      const b = useForm({ schema: requiredSchema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    result.forms.a.setValue('email', 'a@example.com')
    await nextTick()
    const advanced = await result.tryNext()
    expect(advanced).toBe(true)
    expect(result.currentStep).toBe('b')
  })

  it('stays put, reveals errors, and resolves false when the active step is invalid', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema: requiredSchema, key: 'a' })
      const b = useForm({ schema: requiredSchema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    const advanced = await result.tryNext()
    expect(advanced).toBe(false)
    expect(result.currentStep).toBe('a')
    expect(result.forms.a.meta.errorCount).toBeGreaterThan(0)
    expect(result.forms.a.meta.submissionAttempts).toBe(1)
  })

  it('validates only the active step, leaving sibling forms untouched', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema: requiredSchema, key: 'a' })
      const b = useForm({ schema: requiredSchema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    // a is invalid: tryNext validates a only; b is never touched (unlike
    // whole-wizard handleSubmit, which bumps every form).
    await result.tryNext()
    expect(result.forms.a.meta.submissionAttempts).toBe(1)
    expect(result.forms.b.meta.submissionAttempts).toBe(0)
  })

  it('walks the wizard step by step, gating each advance on validity', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema: requiredSchema, key: 'a' })
      const b = useForm({ schema: requiredSchema, key: 'b' })
      const c = useForm({ schema: requiredSchema, key: 'c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    result.forms.a.setValue('email', 'a@example.com')
    await nextTick()
    expect(await result.tryNext()).toBe(true)
    expect(result.currentStep).toBe('b')
    // b is empty: tryNext refuses to advance and reveals its errors.
    expect(await result.tryNext()).toBe(false)
    expect(result.currentStep).toBe('b')
    result.forms.b.setValue('email', 'b@example.com')
    await nextTick()
    expect(await result.tryNext()).toBe(true)
    expect(result.currentStep).toBe('c')
  })

  it('no-ops to false on the final step without validating', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema: requiredSchema, key: 'a' })
      const b = useForm({ schema: requiredSchema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('b')
    await nextTick()
    expect(result.isFinalStep).toBe(true)
    const advanced = await result.tryNext()
    expect(advanced).toBe(false)
    expect(result.currentStep).toBe('b')
    // The final step is not validated: finishing is handleSubmit's job.
    expect(result.forms.b.meta.submissionAttempts).toBe(0)
  })

  it('resolves false on a degenerate (no-steps) wizard without throwing', async () => {
    const { app, result } = mountWizardHarness(() => {
      return useWizard({ steps: [], restore: false, persist: false })
    })
    apps.push(app)
    await expect(result.tryNext()).resolves.toBe(false)
  })
})
