// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `useWizard` — basic navigation. Three forms keyed `a / b / c` listed
 * positionally on the wizard's `steps` array. The wizard exposes:
 *
 *   - `count`, `currentStep`, `activeForm`, `activeIndex`, `isFinalStep`,
 *     `steps`, `forms` (introspection)
 *   - `next()` / `back()` — silent no-op past ends with a dev-warn
 *   - `goTo(key)` — silent no-op + dev-warn on unknown key
 *   - bare string slots — desugared to noop forms uniformly
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

describe('useWizard — basic navigation', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('exposes count, steps, and the initial active step', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-1-a' })
      const b = useForm({ schema, key: 'a-1-b' })
      const c = useForm({ schema, key: 'a-1-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.count).toBe(3)
    expect(result.steps.map((s) => s.key)).toEqual(['a-1-a', 'a-1-b', 'a-1-c'])
    expect(result.currentStep).toBe('a-1-a')
    expect(result.activeIndex).toBe(0)
    expect(result.activeForm.key).toBe('a-1-a')
    expect(result.isFinalStep).toBe(false)
    expect(result.canGoBack).toBe(false)
    expect(result.canAdvance).toBe(true)
  })

  it('next() advances and back() retreats', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-2-a' })
      const b = useForm({ schema, key: 'a-2-b' })
      const c = useForm({ schema, key: 'a-2-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    await result.next()
    expect(result.currentStep).toBe('a-2-b')
    expect(result.activeIndex).toBe(1)
    await result.next()
    expect(result.currentStep).toBe('a-2-c')
    expect(result.isFinalStep).toBe(true)
    result.back()
    expect(result.currentStep).toBe('a-2-b')
    expect(result.isFinalStep).toBe(false)
  })

  it('goTo(key) jumps directly', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-3-a' })
      const b = useForm({ schema, key: 'a-3-b' })
      const c = useForm({ schema, key: 'a-3-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('a-3-c')
    expect(result.currentStep).toBe('a-3-c')
    result.goTo('a-3-a')
    expect(result.currentStep).toBe('a-3-a')
  })

  it('next() at last step is a no-op and dev-warns', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-4-a' })
      const b = useForm({ schema, key: 'a-4-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    await result.next()
    expect(result.currentStep).toBe('a-4-b')
    await result.next()
    expect(result.currentStep).toBe('a-4-b')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('wizard.next'))).toBe(true)
  })

  it('back() at first step is a no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-5-a' })
      const b = useForm({ schema, key: 'a-5-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    result.back()
    expect(result.currentStep).toBe('a-5-a')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('wizard.back'))).toBe(true)
  })

  it('goTo(unknown) is a silent no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-6-a' })
      const b = useForm({ schema, key: 'a-6-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(() => result.goTo('typo')).not.toThrow()
    expect(result.currentStep).toBe('a-6-a')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('typo'))).toBe(true)
  })

  it('single-step wizard returns a sane handle without warning', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-7-only' })
      return useWizard({ steps: [a], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.count).toBe(1)
    expect(result.currentStep).toBe('a-7-only')
    expect(result.activeForm.key).toBe('a-7-only')
    expect(result.activeIndex).toBe(0)
    expect(result.isFinalStep).toBe(true)
    expect(result.canAdvance).toBe(false)
    expect(result.canGoBack).toBe(false)
    expect(result.allErrors['a-7-only']).toEqual([])
    warnSpy.mockRestore()
    expect(warnings).toEqual([])
  })

  it('bare string slots desugar to noop forms with default-valid status', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-8-a' })
      return useWizard({
        steps: ['a-8-intro', a, 'a-8-thanks'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.count).toBe(3)
    expect(result.steps.map((s) => s.key)).toEqual(['a-8-intro', 'a-8-a', 'a-8-thanks'])
    expect(result.currentStep).toBe('a-8-intro')
    expect(result.activeForm.key).toBe('a-8-intro')
    expect(result.statuses['a-8-intro'].valid).toBe(true)
    expect(result.statuses['a-8-thanks'].valid).toBe(true)
  })

  it('wizard.forms[key] is indexable by step key', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-9-a' })
      const b = useForm({ schema, key: 'a-9-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.forms['a-9-a']?.key).toBe('a-9-a')
    expect(result.forms['a-9-b']?.key).toBe('a-9-b')
  })
})
