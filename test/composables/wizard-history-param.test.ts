// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Custom `restore` / `persist` callbacks. The v2 default URL sync
 * always reads/writes `?step=<key>` (locked decision #16 + #17 in
 * the v2 plan); a consumer who needs a different param name, a
 * non-URL store (localStorage, broadcast channel), or per-wizard
 * scoping on a multi-wizard page passes its own pair.
 *
 *   - `restore: () => ({ step })` is invoked at construction and
 *     watched reactively for subsequent applies.
 *   - `persist: ({ step }) => …` fires when the wizard navigates,
 *     with a diff against the last persisted value so the
 *     restore-persist loop settles in one round.
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

describe('useWizard — custom restore / persist callbacks', () => {
  const apps: App[] = []

  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('a custom restore lambda seeds the initial step', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hp-restore-a' })
      const b = useForm({ schema: schemaB, key: 'hp-restore-b' })
      return useWizard({
        steps: [a, b],
        restore: () => ({ step: 'hp-restore-b' }),
        persist: false,
      })
    })
    apps.push(app)
    expect(result.currentStep).toBe('hp-restore-b')
  })

  it('a custom persist callback fires on navigation with the new step', async () => {
    const persisted: string[] = []
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hp-persist-a' })
      const b = useForm({ schema: schemaB, key: 'hp-persist-b' })
      return useWizard({
        steps: [a, b],
        restore: false,
        persist: ({ step }) => {
          if (step !== undefined) persisted.push(step)
        },
      })
    })
    apps.push(app)
    await result.next()
    await nextTick()
    expect(persisted).toContain('hp-persist-b')
  })

  it('custom restore + custom persist round-trip through a shared ref', async () => {
    const stepRef = ref<string | undefined>(undefined)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hp-rt-a' })
      const b = useForm({ schema: schemaB, key: 'hp-rt-b' })
      return useWizard({
        steps: [a, b],
        restore: () => (stepRef.value === undefined ? undefined : { step: stepRef.value }),
        persist: ({ step }) => {
          stepRef.value = step
        },
      })
    })
    apps.push(app)
    await result.next()
    await nextTick()
    expect(stepRef.value).toBe('hp-rt-b')
    // External actor flips the shared store: the restore watcher
    // observes the change and the wizard follows.
    stepRef.value = 'hp-rt-a'
    await nextTick()
    expect(result.currentStep).toBe('hp-rt-a')
  })

  it('custom persist with a renamed URL param writes only to that name', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'hp-rename-a' })
      const b = useForm({ schema: schemaB, key: 'hp-rename-b' })
      return useWizard({
        steps: [a, b],
        restore: () => {
          const url = new URL(window.location.href)
          const step = url.searchParams.get('wiz')
          return step === null ? undefined : { step }
        },
        persist: ({ step }) => {
          if (step === undefined) return
          const url = new URL(window.location.href)
          url.searchParams.set('wiz', step)
          window.history.replaceState(null, '', url.toString())
        },
      })
    })
    apps.push(app)
    await result.next()
    await nextTick()
    const url = new URL(window.location.href)
    expect(url.searchParams.get('wiz')).toBe('hp-rename-b')
    expect(url.searchParams.get('step')).toBeNull()
  })

  it('two wizards on one page scope through distinct persist callbacks', async () => {
    const persistedA: string[] = []
    const persistedB: string[] = []
    const { app, result } = mountHarness(() => {
      const a1 = useForm({ schema: schemaA, key: 'hp-twoA-a1' })
      const a2 = useForm({ schema: schemaB, key: 'hp-twoA-a2' })
      const b1 = useForm({ schema: schemaA, key: 'hp-twoB-b1' })
      const b2 = useForm({ schema: schemaB, key: 'hp-twoB-b2' })
      const wA = useWizard({
        steps: [a1, a2],
        restore: false,
        persist: ({ step }) => {
          if (step !== undefined) persistedA.push(step)
        },
      })
      const wB = useWizard({
        steps: [b1, b2],
        restore: false,
        persist: ({ step }) => {
          if (step !== undefined) persistedB.push(step)
        },
      })
      return { wA, wB }
    })
    apps.push(app)
    await result.wA.next()
    await nextTick()
    await result.wB.next()
    await nextTick()
    expect(persistedA).toContain('hp-twoA-a2')
    expect(persistedB).toContain('hp-twoB-b2')
    // Each wizard only sees its own keys — no cross-wizard bleed.
    expect(persistedA).not.toContain('hp-twoB-b2')
    expect(persistedB).not.toContain('hp-twoA-a2')
  })
})
