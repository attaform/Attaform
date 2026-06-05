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
 *   - `next()` / `back()` / `goTo()` → `pushState` on the URL via the
 *     default `persist` watcher, so each step earns a real history
 *     entry and the browser Back / Forward buttons walk the flow (the
 *     authored contract: a slow multi-step form makes Back-as-real-
 *     navigation the natural expectation). Pushes are deduped when the
 *     URL is already on the target step.
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

  it('next() pushes the new step key into the URL (real history entry)', async () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-next-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hw-next-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    pushSpy.mockClear()
    await result.next()
    expect(pushSpy).toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-next-b')
    pushSpy.mockRestore()
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

  it('builds a back-stack so a real browser Back returns to the prior step', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-pop-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hw-pop-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    // Default persist pushes (vs. replace), so next() earns a real history
    // entry. Assert the push DIRECTLY via the spy, not via
    // `history.length`: jsdom shares one `window.history` across the file,
    // and a prior test's `history.back()` can leave the cursor mid-stack,
    // where `pushState` truncates the forward entries and length does NOT
    // grow — an order-dependent (seed-dependent) flake. The spy is
    // order-independent: it proves a real entry was pushed regardless of
    // where the shared cursor happens to sit.
    const pushSpy = vi.spyOn(window.history, 'pushState')
    await result.next()
    expect(result.currentStep).toBe('hw-pop-b')
    expect(pushSpy).toHaveBeenCalled()
    pushSpy.mockRestore()
    // A *real* browser Back (not a manual popstate drive) retraces the
    // navigation back to the prior step.
    window.history.back()
    await new Promise((r) => setTimeout(r, 20))
    expect(result.currentStep).toBe('hw-pop-a')
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-pop-a')
  })

  it('the Back round-trip does not stack a duplicate entry (dedup)', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-dd-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hw-dd-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    await result.next()
    const lengthAfterNav = window.history.length
    const pushSpy = vi.spyOn(window.history, 'pushState')
    window.history.back() // -> ?step=hw-dd-a; the resulting persist must dedup
    await new Promise((r) => setTimeout(r, 20))
    expect(result.currentStep).toBe('hw-dd-a')
    expect(pushSpy).not.toHaveBeenCalled()
    expect(window.history.length).toBe(lengthAfterNav)
    pushSpy.mockRestore()
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

  it('canonicalizes a cold URL to the first step in place (replace, not push)', () => {
    // A bare `/wizard` and `/wizard?step=<first>` are the same effective
    // page — the wizard resolves an absent param to the first step. So
    // the on-mount write must REPLACE (canonicalize in place), not push
    // a dead history entry that Back would land on showing the same
    // step. Real navigations still push (covered above).
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    const lengthBeforeMount = window.history.length
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hw-init-a' })
      const b = useForm({ schema: schemaB, key: 'hw-init-b' })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    expect(result.currentStep).toBe('hw-init-a')
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-init-a')
    expect(pushSpy).not.toHaveBeenCalled()
    expect(replaceSpy).toHaveBeenCalled()
    expect(window.history.length).toBe(lengthBeforeMount)
    pushSpy.mockRestore()
    replaceSpy.mockRestore()
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
