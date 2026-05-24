// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `restore: false` + `persist: false` fully decouple the wizard from
 * the URL. Useful for embedded wizards where the host shell already
 * owns the URL, or for wizard instances rendered inside dialogs and
 * drawers where a fresh history entry per step would be surprising.
 *
 * Setting either side to `false` independently is also valid:
 *   - `persist: false` alone — read external state, do not write back.
 *   - `restore: false` alone — write internal state out, do not seed.
 */

const ORIGINAL_URL = 'http://localhost:3000/wizard'

const schemaA = z.object({ a: z.string() })
const schemaB = z.object({ b: z.string() })

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

describe('useWizard — restore: false + persist: false', () => {
  const apps: App[] = []

  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('navigation does not write to window.history when persist is off', async () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hd-nav-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hd-nav-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    pushSpy.mockClear()
    replaceSpy.mockClear()
    await result.next()
    result.back()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
    pushSpy.mockRestore()
    replaceSpy.mockRestore()
  })

  it('initial step does not seed from `?step=<key>` when restore is off', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hd-seed-b`)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hd-seed-a' })
      const b = useForm({ schema: schemaB, key: 'hd-seed-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.currentStep).toBe('hd-seed-a')
  })

  it('URL is untouched on mount and on navigation', async () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?other=stay`)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hd-url-a' })
      const b = useForm({ schema: schemaB, key: 'hd-url-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(new URL(window.location.href).searchParams.get('step')).toBeNull()
    expect(new URL(window.location.href).searchParams.get('other')).toBe('stay')
    await result.next()
    const url = new URL(window.location.href)
    expect(url.searchParams.get('step')).toBeNull()
    expect(url.searchParams.get('other')).toBe('stay')
    expect(result.currentStep).toBe('hd-url-b')
  })

  it('popstate does not move the wizard when restore is off', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hd-pop-a', defaultValues: { a: 'a' } })
      const b = useForm({ schema: schemaB, key: 'hd-pop-b', defaultValues: { b: 'b' } })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    await result.next()
    expect(result.currentStep).toBe('hd-pop-b')
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hd-pop-a`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.currentStep).toBe('hd-pop-b')
  })

  it('persist: false alone still applies external restore reads', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hd-mixed-b`)
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hd-mixed-a' })
      const b = useForm({ schema: schemaB, key: 'hd-mixed-b' })
      return useWizard({ steps: [a, b], persist: false })
    })
    apps.push(app)
    expect(result.currentStep).toBe('hd-mixed-b')
    expect(replaceSpy).not.toHaveBeenCalled()
    replaceSpy.mockRestore()
  })

  it('restore: false alone still writes the URL on navigation', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hd-write-a' })
      const b = useForm({ schema: schemaB, key: 'hd-write-b' })
      return useWizard({ steps: [a, b], restore: false })
    })
    apps.push(app)
    await result.next()
    await new Promise((r) => setTimeout(r, 10))
    expect(new URL(window.location.href).searchParams.get('step')).toBe('hd-write-b')
  })
})
