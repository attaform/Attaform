// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `useWizard` — basic navigation. Three forms keyed `a / b / c`,
 * declared bottom-up with `next:` identity refs so the wizard's graph
 * walker discovers them in `a → b → c` BFS order from the entry. The
 * wizard records its reachable set and exposes:
 *
 *   - `count`, `current`, `allForms`, `entry` (introspection)
 *   - `next()` / `back()` — silent no-op past ends with a dev-warn
 *   - `goTo(key)` — silent no-op + dev-warn on unknown key
 *   - cycles in the graph — throw `WizardCycleError` at construction
 *
 * The wizard tolerates degenerate-but-legal shapes (a single-step
 * entry with no `next`) by dev-warning and falling back to a sane
 * single-step handle. Real graph anomalies (cycles, out-of-list pick
 * returns) throw at construction — they indicate a wiring bug the
 * consumer needs to fix. The graph-algorithm coverage for those
 * anomalies lives in `wizard-graph.test.ts`.
 */

// Permissive schema so the validation gate on `wizard.next()` does not
// block navigation in tests that only exercise the BFS-order walk.
// Validation behavior has its own coverage in `wizard-handle-submit`.
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

  it('exposes count, allForms, and initial current', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'a-1-c' })
      const b = useForm({ schema, key: 'a-1-b', next: c })
      const a = useForm({ schema, key: 'a-1-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.count).toBe(3)
    expect(result.allForms.length).toBe(3)
    expect(result.allForms.map((f) => f.key)).toEqual(['a-1-a', 'a-1-b', 'a-1-c'])
    expect(result.current).toBe('a-1-a')
  })

  it('next() advances and back() retreats', async () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'a-2-c' })
      const b = useForm({ schema, key: 'a-2-b', next: c })
      const a = useForm({ schema, key: 'a-2-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    await result.next()
    expect(result.current).toBe('a-2-b')
    await result.next()
    expect(result.current).toBe('a-2-c')
    result.back()
    expect(result.current).toBe('a-2-b')
  })

  it('goTo(key) jumps directly', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'a-3-c' })
      const b = useForm({ schema, key: 'a-3-b', next: c })
      const a = useForm({ schema, key: 'a-3-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    result.goTo('a-3-c')
    expect(result.current).toBe('a-3-c')
    result.goTo('a-3-a')
    expect(result.current).toBe('a-3-a')
  })

  it('next() at last step is a no-op and dev-warns', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'a-4-b' })
      const a = useForm({ schema, key: 'a-4-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    await result.next()
    expect(result.current).toBe('a-4-b')
    await result.next()
    expect(result.current).toBe('a-4-b')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('useWizard.next'))).toBe(true)
  })

  it('back() at first step is a no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'a-5-b' })
      const a = useForm({ schema, key: 'a-5-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    result.back()
    expect(result.current).toBe('a-5-a')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('useWizard.back'))).toBe(true)
  })

  it('goTo(unknown) is a silent no-op and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'a-6-b' })
      const a = useForm({ schema, key: 'a-6-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(() => result.goTo('typo')).not.toThrow()
    expect(result.current).toBe('a-6-a')
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('typo'))).toBe(true)
  })

  it('single-step entry (no `next`) returns a sane handle and dev-warns', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'a-7-only' })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.count).toBe(1)
    expect(result.current).toBe('a-7-only')
    expect(result.activeForm?.key).toBe('a-7-only')
    expect(result.activeIndex).toBe(0)
    expect(result.allErrors).toEqual([])
    expect(() => void result.next()).not.toThrow()
    expect(() => result.back()).not.toThrow()
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('single-step'))).toBe(true)
  })
})
