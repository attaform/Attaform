// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

/**
 * Activation-lifecycle contract for `useWizard` under eager activation.
 * Every form listed in `steps` activates at wizard creation. The
 * SSR-prefetch coordination still gates only the active step's
 * factory for `onServerPrefetch` (covered in `wizard-ssr-prefetch`),
 * but on the client every async `defaultValues` factory fires once at
 * construction.
 *
 * Activation is idempotent — navigating to a step whose factory has
 * already resolved does not re-fire it. `form.rehydrate()` is the
 * explicit re-fire escape hatch.
 */

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

describe('useWizard — eager activation lifecycle', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('fires every form factory exactly once at construction', async () => {
    let aCalls = 0
    let bCalls = 0
    let cCalls = 0
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'wizard-act-a',
        defaultValues: () => {
          aCalls += 1
          return Promise.resolve({ a: 'A' })
        },
      })
      const b = useForm({
        schema: schemaB,
        key: 'wizard-act-b',
        defaultValues: () => {
          bCalls += 1
          return Promise.resolve({ b: 'B' })
        },
      })
      const c = useForm({
        schema: schemaC,
        key: 'wizard-act-c',
        defaultValues: () => {
          cCalls += 1
          return Promise.resolve({ c: 'C' })
        },
      })
      return {
        wizard: useWizard({ steps: [a, b, c], restore: false, persist: false }),
        a,
        b,
        c,
      }
    })
    apps.push(app)
    await waitUntil(() => (result.a.hydrating === false ? true : null))
    await waitUntil(() => (result.b.hydrating === false ? true : null))
    await waitUntil(() => (result.c.hydrating === false ? true : null))
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)
    expect(cCalls).toBe(1)
    expect(result.a.values.a).toBe('A')
    expect(result.b.values.b).toBe('B')
    expect(result.c.values.c).toBe('C')
  })

  it('navigation does not re-fire a factory', async () => {
    let bCalls = 0
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'wizard-react-a' })
      const b = useForm({
        schema: schemaB,
        key: 'wizard-react-b',
        defaultValues: () => {
          bCalls += 1
          return Promise.resolve({ b: 'B' })
        },
      })
      return { wizard: useWizard({ steps: [a, b], restore: false, persist: false }), a, b }
    })
    apps.push(app)
    await waitUntil(() => (result.b.hydrating === false ? true : null))
    expect(bCalls).toBe(1)
    await result.wizard.next()
    await Promise.resolve()
    result.wizard.back()
    await result.wizard.next()
    await Promise.resolve()
    expect(bCalls).toBe(1)
  })

  it('form.rehydrate() re-fires the factory on demand', async () => {
    let bCalls = 0
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'wizard-rehyd-a' })
      const b = useForm({
        schema: schemaB,
        key: 'wizard-rehyd-b',
        defaultValues: () => {
          bCalls += 1
          return Promise.resolve({ b: `B-${bCalls}` })
        },
      })
      return { wizard: useWizard({ steps: [a, b], restore: false, persist: false }), a, b }
    })
    apps.push(app)
    await waitUntil(() => (result.b.hydrating === false ? true : null))
    expect(bCalls).toBe(1)
    expect(result.b.values.b).toBe('B-1')

    await result.b.rehydrate()
    expect(bCalls).toBe(2)
    expect(result.b.values.b).toBe('B-2')
  })
})
