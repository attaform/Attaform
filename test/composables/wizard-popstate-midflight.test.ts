// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Mid-flight popstate safety. The wizard's one-shot activation contract
 * must hold even when external state (URL, custom restore signal) flips
 * back-and-forth between steps while a step's async factory is still
 * pending. Under eager activation every factory fires once at
 * construction; this probe confirms a popstate-driven re-restore does
 * not re-trigger an in-flight factory.
 */

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

describe('useWizard — popstate mid-flight safety', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('async factory fires exactly once even under back-and-forth restore signals', async () => {
    let factoryCalls = 0
    let resolveFactory: ((value: { b: string }) => void) | undefined
    const factoryPromise = new Promise<{ b: string }>((resolve) => {
      resolveFactory = resolve
    })
    const restoreRef = ref<string | undefined>(undefined)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'mf-a', defaultValues: { a: 'a-set' } })
      const b = useForm({
        schema: schemaB,
        key: 'mf-b',
        defaultValues: () => {
          factoryCalls += 1
          return factoryPromise
        },
      })
      return {
        wizard: useWizard({
          steps: [a, b],
          restore: () => ({ step: restoreRef.value }),
          persist: false,
        }),
        a,
        b,
      }
    })
    apps.push(app)
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (factoryCalls > 0) break
    }
    expect(factoryCalls).toBe(1)
    expect(result.b.hydrating).toBe(true)

    restoreRef.value = 'mf-b'
    await nextTick()
    expect(result.wizard.currentStep).toBe('mf-b')

    restoreRef.value = 'mf-a'
    await nextTick()
    expect(result.wizard.currentStep).toBe('mf-a')

    resolveFactory!({ b: 'fetched' })
    await factoryPromise
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (!result.b.hydrating) break
    }
    expect(result.b.hydrating).toBe(false)

    restoreRef.value = 'mf-b'
    await nextTick()
    expect(result.wizard.currentStep).toBe('mf-b')
    expect(factoryCalls).toBe(1)
  })

  it('rapid restore flips do not re-fire an unresolved factory', async () => {
    let factoryCalls = 0
    const factoryPromise = new Promise<{ b: string }>(() => {
      // Never resolves — proves the factory holds in `hydrating: true`
      // throughout this probe.
    })
    const restoreRef = ref<string | undefined>(undefined)
    const { app } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'mf-deref-a', defaultValues: { a: 'a' } })
      const b = useForm({
        schema: schemaB,
        key: 'mf-deref-b',
        defaultValues: () => {
          factoryCalls += 1
          return factoryPromise
        },
      })
      return useWizard({
        steps: [a, b],
        restore: () => ({ step: restoreRef.value }),
        persist: false,
      })
    })
    apps.push(app)
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (factoryCalls > 0) break
    }
    expect(factoryCalls).toBe(1)
    for (const key of ['mf-deref-b', 'mf-deref-a', 'mf-deref-b', 'mf-deref-a']) {
      restoreRef.value = key
      await nextTick()
    }
    expect(factoryCalls).toBe(1)
  })
})
