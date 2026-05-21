// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseWizardReturnType, AnyForm } from '../../src/runtime/types/types-wizard'

/**
 * `useWizard` — basic navigation. Three forms keyed `a / b / c`,
 * mounted in setup order. The wizard records its forms and
 * exposes:
 *
 *   - `count`, `current`, `forms` (introspection)
 *   - `next()` / `back()` — silent no-op past ends with a dev-warn
 *   - `goTo(key)` — silent no-op + dev-warn on unknown key
 *   - duplicate keys / empty forms / empty-key forms — dev-warn + degrade
 *
 * The wizard never throws on construction or navigation. A
 * third-party library wired into someone's checkout or signup
 * shouldn't crash an app for shapes that are clearly a mistake.
 * Dev warns surface the problem; the wizard either filters the bad
 * input or returns a no-op handle, depending on the case.
 */

const schema = z.object({ email: z.string() })

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

/**
 * Like `mountWizardHarness`, but captures any error thrown inside
 * `setup` and re-throws it on the test thread. The app's
 * `errorHandler` otherwise swallows setup-time throws — we want
 * `expect(() => ...).toThrow()` to actually see them.
 */
function mountAndCaptureSetupError(setup: () => unknown): void {
  let captured: unknown
  const App = defineComponent({
    setup() {
      try {
        setup()
      } catch (error) {
        captured = error
      }
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  app.unmount()
  if (captured !== undefined) throw captured
}

type WizardWithForms<Keys extends readonly string[]> = UseWizardReturnType<
  ReadonlyArray<AnyForm & { readonly key: Keys[number] }>
>

describe('useWizard — basic navigation', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('exposes count, forms, and initial current', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      const c = useForm({ schema, key: 'c' })
      return useWizard([a, b, c], {}) as WizardWithForms<['a', 'b', 'c']>
    })
    apps.push(app)
    expect(result.count).toBe(3)
    expect(result.forms.length).toBe(3)
    expect(result.current).toBe('a')
  })

  it('next() advances and back() retreats', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      const c = useForm({ schema, key: 'c' })
      return useWizard([a, b, c], {}) as WizardWithForms<['a', 'b', 'c']>
    })
    apps.push(app)
    result.next()
    expect(result.current).toBe('b')
    result.next()
    expect(result.current).toBe('c')
    result.back()
    expect(result.current).toBe('b')
  })

  it('goTo(key) jumps directly', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      const c = useForm({ schema, key: 'c' })
      return useWizard([a, b, c], {}) as WizardWithForms<['a', 'b', 'c']>
    })
    apps.push(app)
    result.goTo('c')
    expect(result.current).toBe('c')
    result.goTo('a')
    expect(result.current).toBe('a')
  })

  it('next() at last step is a no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      return useWizard([a, b], {}) as WizardWithForms<['a', 'b']>
    })
    apps.push(app)
    result.next()
    expect(result.current).toBe('b')
    result.next()
    expect(result.current).toBe('b')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('useWizard'))).toBe(true)
  })

  it('back() at first step is a no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      return useWizard([a, b], {}) as WizardWithForms<['a', 'b']>
    })
    apps.push(app)
    result.back()
    expect(result.current).toBe('a')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('useWizard'))).toBe(true)
  })

  it('goTo(unknown) is a silent no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'b' })
      return useWizard([a, b], {}) as WizardWithForms<['a', 'b']>
    })
    apps.push(app)
    expect(() => (result.goTo as (key: string) => void)('typo')).not.toThrow()
    expect(result.current).toBe('a')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('typo'))).toBe(true)
  })

  it('useWizard([]) returns a no-op wizard and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    let wizard: UseWizardReturnType<readonly AnyForm[]> | undefined
    expect(() => {
      mountAndCaptureSetupError(() => {
        wizard = useWizard([] as readonly AnyForm[], {}) as UseWizardReturnType<readonly AnyForm[]>
      })
    }).not.toThrow()
    expect(wizard).toBeDefined()
    expect(wizard?.count).toBe(0)
    expect(wizard?.current).toBeUndefined()
    expect(wizard?.activeForm).toBeUndefined()
    expect(wizard?.activeIndex).toBe(-1)
    expect(wizard?.allErrors).toEqual([])
    expect(wizard?.progress).toBe(0)
    expect(() => wizard?.next()).not.toThrow()
    expect(() => wizard?.back()).not.toThrow()
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('useWizard'))).toBe(true)
  })

  it('duplicate keys are filtered with a dev-warn (keep first occurrence)', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const b = useForm({ schema, key: 'a' })
      return useWizard([a, b], {})
    })
    apps.push(app)
    expect(result.count).toBe(1)
    expect(result.forms.length).toBe(1)
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.toLowerCase().includes('duplicate'))).toBe(true)
  })

  it('empty-key forms are filtered with a dev-warn', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    // useForm({ key: '' }) auto-allocates an anonymous synthetic key,
    // so we can't construct an empty-key form via the normal path.
    // Pass a raw form-shaped object to exercise the wizard's input
    // filter directly.
    const emptyKeyForm: AnyForm = { key: '' }
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a' })
      const c = useForm({ schema, key: 'c' })
      return useWizard([a, emptyKeyForm, c], {})
    })
    apps.push(app)
    expect(result.count).toBe(2)
    expect(result.forms.map((f) => f.key)).toEqual(['a', 'c'])
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.toLowerCase().includes('empty'))).toBe(true)
  })
})
