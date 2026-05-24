// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Default URL synchronization. When the consumer omits both `restore`
 * and `persist`, the wizard wires a `?step=<key>` round-trip via
 * `wizard-history.ts`:
 *
 *   - `next()` / `back()` / `goTo()` → `replaceState` on the URL via
 *     the default `persist` watcher (the in-memory wizard state is the
 *     source of truth, so new history entries per step do not earn
 *     their keep over a stable URL bar).
 *   - `popstate` → the URL mirror updates, the restore lambda
 *     reactively re-applies the new step.
 *   - Initial URL with `?step=<knownKey>` seeds the active step.
 *   - On a cold load with no `?step=` query, the wizard writes the
 *     first step's key so a refresh reflects the position.
 */

const ORIGINAL_URL = 'http://localhost:3000/wizard'

const schemaA = z.object({ a: z.string() })
const schemaB = z.object({ b: z.string() })
const schemaC = z.object({ c: z.string() })

function mountHarness<R>(setup: () => R): { app: App; result: R } {
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

describe('useWizard — default URL sync via ?step=<key>', () => {
  const apps: App[] = []

  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('next() writes the new step key into the URL', async () => {
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-next-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hw-next-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    replaceSpy.mockClear()
    await result.next()
    expect(replaceSpy).toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-next-b')
    replaceSpy.mockRestore()
  })

  it('goTo() writes the chosen step key into the URL', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-go-a' })
      const b = useForm({ schema: schemaB, key: 'hw-go-b' })
      const c = useForm({ schema: schemaC, key: 'hw-go-c' })
      return useWizard({ steps: [a, b, c] })
    })
    apps.push(app)
    result.goTo('hw-go-c')
    await nextTick()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-go-c')
    result.goTo('hw-go-a')
    await nextTick()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-go-a')
  })

  it('popstate re-applies the URL step through the restore lambda', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-pop-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hw-pop-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    await result.next()
    expect(result.currentStep).toBe('hw-pop-b')
    // Default persist uses replaceState, so window.history.back() will
    // not retrace the navigation. Drive popstate directly with a URL
    // rewrite + manual event dispatch.
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hw-pop-a`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.currentStep).toBe('hw-pop-a')
  })

  it('seeds initial currentStep from `?step=<knownKey>` on mount', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hw-seed-b`)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-seed-a' })
      const b = useForm({ schema: schemaB, key: 'hw-seed-b' })
      const c = useForm({ schema: schemaC, key: 'hw-seed-c' })
      return useWizard({ steps: [a, b, c] })
    })
    apps.push(app)
    expect(result.currentStep).toBe('hw-seed-b')
  })

  it('writes the URL step param on mount when the URL is cold (no ?step=)', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-init-a' })
      const b = useForm({ schema: schemaB, key: 'hw-init-b' })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-init-a')
    expect(result.currentStep).toBe('hw-init-a')
  })

  it('ignores unknown step keys from the URL and falls back to the first step', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=notreal`)
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-unknown-a' })
      const b = useForm({ schema: schemaB, key: 'hw-unknown-b' })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    warnSpy.mockRestore()
    expect(result.currentStep).toBe('hw-unknown-a')
    expect(warnings.some((w) => w.includes('notreal'))).toBe(true)
  })

  it('preserves other query params already on the URL', async () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?utm=campaign&step=hw-other-a`)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-other-a' })
      const b = useForm({ schema: schemaB, key: 'hw-other-b' })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    await result.next()
    await nextTick()
    await new Promise((r) => setTimeout(r, 10))
    const url = new URL(window.location.href)
    expect(url.searchParams.get('step')).toBe('hw-other-b')
    expect(url.searchParams.get('utm')).toBe('campaign')
  })
})
