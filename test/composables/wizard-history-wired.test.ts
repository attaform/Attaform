// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Browser-history integration. By default, `useWizard` records each
 * navigation in `window.history` so the browser back/forward buttons
 * walk through wizard steps and reload preserves the current step.
 *
 *   - `next`/`back`/`goTo` → `pushState` (new entry by default).
 *   - `{ replace: true }` → `replaceState` (no new entry).
 *   - `popstate` → restores `current.value` from the URL.
 *   - Initial URL with `?step=<knownKey>` seeds the active step.
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

describe('useWizard — history wired', () => {
  const apps: App[] = []

  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('next() calls pushState with the new step key', async () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: schemaB, key: 'hw-next-b', defaultValues: { b: 'b' } })
      const a = useForm({ schema: schemaA, key: 'hw-next-a', defaultValues: { a: 'a' }, next: b })
      return useWizard(a, {})
    })
    apps.push(app)
    pushSpy.mockClear()
    await result.next()
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-next-b')
    pushSpy.mockRestore()
  })

  it('goTo(key) pushes; goTo(key, { replace: true }) replaces', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    const { app, result } = mountHarness(() => {
      const c = useForm({ schema: schemaC, key: 'hw-go-c' })
      const b = useForm({ schema: schemaB, key: 'hw-go-b', next: c })
      const a = useForm({ schema: schemaA, key: 'hw-go-a', next: b })
      return useWizard(a, {})
    })
    apps.push(app)
    pushSpy.mockClear()
    replaceSpy.mockClear()
    result.goTo('hw-go-b')
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).not.toHaveBeenCalled()
    pushSpy.mockClear()
    replaceSpy.mockClear()
    result.goTo('hw-go-c', { replace: true })
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-go-c')
    pushSpy.mockRestore()
    replaceSpy.mockRestore()
  })

  it('popstate restores current.value to the URL key', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: schemaB, key: 'hw-pop-b', defaultValues: { b: 'b' } })
      const a = useForm({ schema: schemaA, key: 'hw-pop-a', defaultValues: { a: 'a' }, next: b })
      return useWizard(a, {})
    })
    apps.push(app)
    await result.next()
    expect(result.current).toBe('hw-pop-b')
    window.history.back()
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current).toBe('hw-pop-a')
  })

  it('seeds initial current.value from `?step=<knownKey>` on mount', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hw-seed-b`)
    const { app, result } = mountHarness(() => {
      const c = useForm({ schema: schemaC, key: 'hw-seed-c' })
      const b = useForm({ schema: schemaB, key: 'hw-seed-b', next: c })
      const a = useForm({ schema: schemaA, key: 'hw-seed-a', next: b })
      return useWizard(a, {})
    })
    apps.push(app)
    expect(result.current).toBe('hw-seed-b')
  })

  it('writes the URL step param on mount to reflect the initial step', () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: schemaB, key: 'hw-init-b' })
      const a = useForm({ schema: schemaA, key: 'hw-init-a', next: b })
      return useWizard(a, {})
    })
    apps.push(app)
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hw-init-a')
    expect(result.current).toBe('hw-init-a')
  })

  it('ignores unknown step keys from URL — falls back to forms[0]', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=notreal`)
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: schemaB, key: 'hw-unknown-b' })
      const a = useForm({ schema: schemaA, key: 'hw-unknown-a', next: b })
      return useWizard(a, {})
    })
    apps.push(app)
    expect(result.current).toBe('hw-unknown-a')
  })
})
