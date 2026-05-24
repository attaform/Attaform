// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `useWizard` exposes the current step as a triple:
 *
 *   - `currentStep` — the active step's key. Always defined (steps list
 *                     is non-empty by construction).
 *   - `activeForm`  — the active step's form handle. Always defined
 *                     (noop forms cover string slots).
 *   - `activeIndex` — the active step's 0-based index.
 *
 * `activeForm` and `activeIndex` are derived getters — they update
 * synchronously when `goTo` / `next` / `back` flips `currentStep`.
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

  it('activeForm tracks the same form identity as the steps[i].form entry', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.activeForm).toBe(result.steps[0]?.form)
    await result.next()
    expect(result.activeForm).toBe(result.steps[1]?.form)
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
