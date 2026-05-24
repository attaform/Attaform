// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { AttaformRegistry } from '../../src/runtime/core/registry'
import type { UseWizardReturnType } from '../../src/runtime/types/types-wizard'

/**
 * `useWizard({ key })` registration + lifecycle. The registry hook
 * mirrors `useForm`'s shared-store mechanics:
 *   - keyed wizards land in `registry.wizards` for cross-component
 *     lookup
 *   - anonymous wizards stay off the registry entirely
 *   - duplicate keys are first-wins-silently with a dev-warn on the
 *     second registration
 *   - consumer ref-counting keeps the handle alive until every
 *     consumer (the originating useWizard scope + any injectWizard
 *     descendants) has unmounted
 *
 * `injectWizard` behaviour gets its own test file
 * (`inject-wizard.test.ts`). This file exercises the registry-side of
 * the contract directly so the surfaces stay independently
 * observable.
 */

const schema = z.object({ email: z.string().optional() })

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

function registryOf(app: App): AttaformRegistry {
  return (app as unknown as { _attaform: AttaformRegistry })._attaform
}

describe('useWizard({ key }) — registry registration', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('exposes wizard.key when options.key is provided', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'r-1-a' })
      const b = useForm({ schema, key: 'r-1-b' })
      return useWizard({ steps: [a, b], key: 'r-1-wiz', restore: false, persist: false })
    })
    apps.push(app)
    expect(result.key).toBe('r-1-wiz')
  })

  it('resolves wizard.key to a synthetic SSR-stable key when options.key is omitted', () => {
    const { app, result } = mountHarness(() => {
      const only = useForm({ schema, key: 'r-2-only' })
      return useWizard({ steps: [only], restore: false, persist: false })
    })
    apps.push(app)
    expect(typeof result.key).toBe('string')
    expect(result.key.startsWith('__atta:anon-wizard:')).toBe(true)
  })

  it('keyed wizard registers under registry.wizards', () => {
    const { app, result } = mountHarness(() => {
      const only = useForm({ schema, key: 'r-3-only' })
      return useWizard({ steps: [only], key: 'r-3-wiz', restore: false, persist: false })
    })
    apps.push(app)
    const registry = registryOf(app)
    expect(registry.wizards.get('r-3-wiz')).toBe(result)
  })

  it('anonymous wizard registers under a synthetic SSR-stable key', () => {
    const { app, result } = mountHarness(() => {
      const only = useForm({ schema, key: 'r-4-only' })
      return useWizard({ steps: [only], restore: false, persist: false })
    })
    apps.push(app)
    const registry = registryOf(app)
    // The synthetic key lives inside the reserved `__atta:anon-wizard:`
    // namespace so consumer keys never collide with it.
    expect(registry.wizards.size).toBe(1)
    expect(result.key.startsWith('__atta:anon-wizard:')).toBe(true)
    expect(registry.wizards.get(result.key)).toBe(result)
  })
})

describe('useWizard({ key }) — duplicate-key registration', () => {
  const apps: App[] = []
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    warnSpy.mockRestore()
  })

  it('keeps the first-registered handle and dev-warns on the second', () => {
    const { app, result } = mountHarness(() => {
      const a1 = useForm({ schema, key: 'dup-1-a' })
      const a2 = useForm({ schema, key: 'dup-1-b' })
      const first = useWizard({ steps: [a1], key: 'dup-wiz', restore: false, persist: false })
      const second = useWizard({ steps: [a2], key: 'dup-wiz', restore: false, persist: false })
      return { first, second }
    })
    apps.push(app)
    const registry = registryOf(app)
    expect(registry.wizards.get('dup-wiz')).toBe(result.first)
    expect(registry.wizards.get('dup-wiz')).not.toBe(result.second)
    const duplicateWarn = warnSpy.mock.calls.find((args: readonly unknown[]) =>
      String(args[0] ?? '').includes('already registered')
    )
    expect(duplicateWarn).toBeDefined()
  })
})

describe('useWizard({ key }) — consumer ref-counting + eviction', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('evicts the wizard handle from the registry on the next microtask after unmount', async () => {
    const Root = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'lt-1-only' })
        useWizard({ steps: [only], key: 'lifetime-wiz', restore: false, persist: false })
        return () => h('div')
      },
    })
    const app = createApp(Root).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)

    const registry = registryOf(app)
    expect(registry.wizards.has('lifetime-wiz')).toBe(true)

    app.unmount()
    apps.pop()
    await Promise.resolve()
    expect(registry.wizards.has('lifetime-wiz')).toBe(false)
  })
})

describe('useWizard({ key }) — cross-app isolation', () => {
  it('two unrelated apps with the same wizard key are isolated', () => {
    const harnessA = mountHarness(() => {
      const only = useForm({ schema, key: 'iso-a-only' })
      return useWizard({
        steps: [only],
        key: 'shared-wiz-key',
        restore: false,
        persist: false,
      })
    })
    const harnessB = mountHarness(() => {
      const only = useForm({ schema, key: 'iso-b-only' })
      return useWizard({
        steps: [only],
        key: 'shared-wiz-key',
        restore: false,
        persist: false,
      })
    })
    try {
      const registryA = registryOf(harnessA.app)
      const registryB = registryOf(harnessB.app)
      const handleA = registryA.wizards.get('shared-wiz-key') as UseWizardReturnType
      const handleB = registryB.wizards.get('shared-wiz-key') as UseWizardReturnType
      expect(handleA).toBe(harnessA.result)
      expect(handleB).toBe(harnessB.result)
      expect(handleA).not.toBe(handleB)
    } finally {
      harnessA.app.unmount()
      harnessB.app.unmount()
    }
  })
})
