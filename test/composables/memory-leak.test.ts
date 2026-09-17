// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { useAbstractForm as useForm } from '../../src/abstract'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Registry cleanup on scope dispose. `useForm` pairs
 * `registry.trackConsumer(key)` with an `onScopeDispose` release, and
 * the registry evicts the FormStore once the last consumer disposes.
 * Two invariants:
 *   1. The sole consumer unmounts and the entry is gone.
 *   2. Consumers sharing a key clear it only on the last unmount.
 *
 * Storing every form in `registry.forms` on mount without removing it
 * leaks: a long-lived SPA mounting and unmounting form-heavy pages
 * accumulates detached FormStore instances, each holding a reactive
 * `form` ref, an `originals` Map, an `errors` Map and field records, for
 * the lifetime of the app.
 */

type Form = { name: string }

function mountProbe(registry: ReturnType<typeof createRegistry>, key: string) {
  const Probe = defineComponent({
    setup() {
      useForm<Form>({
        schema: fakeSchema<Form>({ name: '' }),
        key,
      })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, registry)
  app.mount(document.createElement('div'))
  return app
}

describe('useForm: registry cleanup on scope dispose', () => {
  // Eviction is deferred to the next microtask once the last consumer
  // disposes: a new consumer claiming the same key in the same tick
  // cancels the schedule and reuses the live FormStore (HMR / KeepAlive
  // safety). `await Promise.resolve()` drains the microtask queue so
  // we can assert post-eviction state in tests.

  it('releases the FormStore on the next microtask after the sole consumer unmounts', async () => {
    const registry = createRegistry()
    const app = mountProbe(registry, 'gc-solo')

    expect(registry.forms.has('gc-solo')).toBe(true)
    app.unmount()
    // Synchronous read still sees the store, eviction is queued, not
    // applied.
    expect(registry.forms.has('gc-solo')).toBe(true)
    await Promise.resolve()
    expect(registry.forms.has('gc-solo')).toBe(false)
  })

  it('ref-counts shared-key consumers: only the last unmount queues eviction', async () => {
    const registry = createRegistry()
    const app1 = mountProbe(registry, 'gc-shared')
    const app2 = mountProbe(registry, 'gc-shared')

    expect(registry.forms.has('gc-shared')).toBe(true)

    app1.unmount()
    // Second consumer still active; the FormStore must stay reachable so
    // reactive subscriptions in app2 keep working.
    await Promise.resolve()
    expect(registry.forms.has('gc-shared')).toBe(true)

    app2.unmount()
    await Promise.resolve()
    expect(registry.forms.has('gc-shared')).toBe(false)
  })

  it('after full eviction (microtask flushed), a remount rebuilds fresh state', async () => {
    const registry = createRegistry()
    const app = mountProbe(registry, 'gc-remount')
    const firstState = registry.forms.get('gc-remount')
    expect(firstState).toBeDefined()
    app.unmount()
    // Drain the microtask queue so the deferred eviction actually
    // runs; without this, the next mount would reuse the live store.
    await Promise.resolve()
    expect(registry.forms.has('gc-remount')).toBe(false)

    const app2 = mountProbe(registry, 'gc-remount')
    const secondState = registry.forms.get('gc-remount')
    expect(secondState).toBeDefined()
    // Identity check: the new mount created a NEW FormStore, not reused
    // the evicted one. Confirms the eviction + rebuild path is wired.
    expect(secondState).not.toBe(firstState)
    app2.unmount()
  })

  it('remount within the same tick cancels eviction and reuses the live FormStore', async () => {
    // Counterpart to the previous test: when no microtask elapses
    // between unmount and remount, the eviction schedule is cancelled
    // and the second mount resolves to the same FormStore. This is
    // the HMR re-mount path; the docs-demo fixed-flash test relies on
    // it indirectly via `harness.remount()`.
    const registry = createRegistry()
    const app = mountProbe(registry, 'gc-cancel')
    const firstState = registry.forms.get('gc-cancel')
    expect(firstState).toBeDefined()

    app.unmount() // queues eviction microtask
    const app2 = mountProbe(registry, 'gc-cancel') // cancels it synchronously
    const secondState = registry.forms.get('gc-cancel')
    expect(secondState).toBe(firstState)

    await Promise.resolve()
    // Microtask fires but the schedule was cancelled, store stays.
    expect(registry.forms.get('gc-cancel')).toBe(firstState)
    app2.unmount()
  })
})
