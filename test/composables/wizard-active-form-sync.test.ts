// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Regression guard: under eager activation, sync `defaultValues` on
 * every step (current and non-current) must be visible immediately
 * at construction. Sync values resolve at `buildFreshState` — before
 * any microtask flush — so they are already in `form.values` by the
 * time `useWizard` initialises.
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

describe('useWizard — sync defaults across all steps', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('sync defaults on step 0 are visible at construction', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'wizard-sync-a',
        defaultValues: { a: 'A-sync' },
      })
      const b = useForm({ schema: schemaB, key: 'wizard-sync-b' })
      return { wizard: useWizard({ steps: [a, b], restore: false, persist: false }), a, b }
    })
    apps.push(app)
    expect(result.a.values.a).toBe('A-sync')
    expect(result.a.hydrating).toBe(false)
  })

  it('sync defaults on a non-current step are visible at construction', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'wizard-sync-2-a' })
      const b = useForm({
        schema: schemaB,
        key: 'wizard-sync-2-b',
        defaultValues: { b: 'B-sync' },
      })
      return { wizard: useWizard({ steps: [a, b], restore: false, persist: false }), a, b }
    })
    apps.push(app)
    expect(result.b.values.b).toBe('B-sync')
    expect(result.b.hydrating).toBe(false)
  })
})
