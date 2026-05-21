// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'
import type { FormStatus } from '../../src/runtime/types/types-wizard'

/**
 * `defaultStatuses` seeds `wizard.statuses[key]` BEFORE each form's
 * meta becomes live. Useful for resumable wizards — a server-sent
 * status payload says "step cargo: valid, step review: dirty" and
 * the wizard renders the right step-gate hints from first paint.
 *
 * Trichotomy mirrors `defaultValues`:
 *   - plain object → applied at construction
 *   - sync function → invoked at construction
 *   - async function → applied when the promise resolves; while
 *     pending, the participating form's status falls back to the
 *     pending sentinel
 *
 * Status resolution priority (per form):
 *   1. form.hydrating === false  → derive from form.meta
 *   2. defaultStatuses resolved   → frozen seed
 *   3. else                       → pending sentinel
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

function mountAndCaptureSetupError(setup: () => unknown): unknown {
  let captured: unknown
  const App = defineComponent({
    setup() {
      try {
        setup()
      } catch (error) {
        captured = error
      }
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  app.unmount()
  return captured
}

const validSeed: FormStatus = {
  valid: true,
  dirty: false,
  submitted: false,
  errorCount: 0,
}

const dirtySeed: FormStatus = {
  valid: false,
  dirty: true,
  submitted: false,
  errorCount: 1,
}

describe('useWizard — defaultStatuses', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('accepts a plain-object seed', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'ds-plain-a',
        defaultValues: () => Promise.resolve({ a: 'A' }),
      })
      const b = useForm({
        schema: schemaB,
        key: 'ds-plain-b',
        defaultValues: () => Promise.resolve({ b: 'B' }),
      })
      return useWizard([a, b], {
        defaultStatuses: { 'ds-plain-a': validSeed, 'ds-plain-b': dirtySeed },
      })
    })
    apps.push(app)
    // Both forms have async defaults pending → seed should be visible.
    expect(result.statuses['ds-plain-a'].valid).toBe(true)
    expect(result.statuses['ds-plain-b'].dirty).toBe(true)
    expect(result.statuses['ds-plain-b'].errorCount).toBe(1)
  })

  it('accepts a sync function seed', () => {
    let calls = 0
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'ds-fn-a',
        defaultValues: () => Promise.resolve({ a: 'A' }),
      })
      const b = useForm({
        schema: schemaB,
        key: 'ds-fn-b',
        defaultValues: () => Promise.resolve({ b: 'B' }),
      })
      return useWizard([a, b], {
        defaultStatuses: () => {
          calls += 1
          return { 'ds-fn-a': validSeed, 'ds-fn-b': dirtySeed }
        },
      })
    })
    apps.push(app)
    expect(calls).toBe(1)
    expect(result.statuses['ds-fn-a'].valid).toBe(true)
    expect(result.statuses['ds-fn-b'].dirty).toBe(true)
  })

  it('accepts an async function seed that lands later', async () => {
    let resolveSeed!: (value: { 'ds-async-a': FormStatus; 'ds-async-b': FormStatus }) => void
    let resolveA!: (value: { a: string }) => void
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'ds-async-a',
        defaultValues: () =>
          new Promise<{ a: string }>((r) => {
            resolveA = r
          }),
      })
      // Step b is non-current — its factory defers until activation.
      const b = useForm({
        schema: schemaB,
        key: 'ds-async-b',
        defaultValues: () => Promise.resolve({ b: 'B' }),
      })
      return {
        wizard: useWizard([a, b], {
          defaultStatuses: () =>
            new Promise((r) => {
              resolveSeed = r
            }),
        }),
        a,
        b,
      }
    })
    apps.push(app)
    // Both forms unresolved + seed pending → status pending sentinel.
    expect(result.wizard.statuses['ds-async-a'].valid).toBe(false)
    expect(result.wizard.statuses['ds-async-a'].errorCount).toBe(0)

    // Seed resolves while neither form has resolved — seed takes over.
    resolveSeed({ 'ds-async-a': validSeed, 'ds-async-b': dirtySeed })
    await waitUntil(() => (result.wizard.statuses['ds-async-a'].valid ? true : null))
    expect(result.wizard.statuses['ds-async-a'].valid).toBe(true)
    expect(result.wizard.statuses['ds-async-b'].dirty).toBe(true)
    expect(result.wizard.statuses['ds-async-b'].errorCount).toBe(1)

    // Once form a's hydration settles, its meta takes over — `defaultsResolved`
    // flips and the status follows meta. Form b is still deferred (non-current)
    // so its seed entry continues to surface.
    resolveA({ a: 'A' })
    await waitUntil(() => (result.a.hydrating === false ? true : null))
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      if (!result.a.meta.validating) break
    }
    expect(result.wizard.statuses['ds-async-b'].dirty).toBe(true)
    expect(result.wizard.statuses['ds-async-a']).toEqual({
      valid: result.a.meta.valid,
      dirty: result.a.meta.dirty,
      submitted: result.a.meta.submitted,
      errorCount: result.a.meta.errorCount,
    })
  })

  it('seed is overridden once the form becomes non-hydrating', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'ds-over-a',
        defaultValues: { a: 'A-sync' },
      })
      return {
        wizard: useWizard([a], {
          defaultStatuses: { 'ds-over-a': dirtySeed },
        }),
        a,
      }
    })
    apps.push(app)
    // Sync-default form is not hydrating → meta wins from the start.
    expect(result.wizard.statuses['ds-over-a'].dirty).toBe(false)
    expect(result.wizard.statuses['ds-over-a'].errorCount).toBe(0)
  })

  it('unknown seed key is ignored with a dev-warn (no throw)', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    let captured: unknown
    const { app, result } = mountHarness(() => {
      try {
        const a = useForm({ schema: schemaA, key: 'ds-unk-a' })
        const b = useForm({ schema: schemaB, key: 'ds-unk-b' })
        return {
          wizard: useWizard([a, b], {
            defaultStatuses: {
              'ds-unk-a': validSeed,
              'ds-unk-typo': dirtySeed,
            } as unknown as { 'ds-unk-a': FormStatus; 'ds-unk-b': FormStatus },
          }),
        }
      } catch (error) {
        captured = error
        return { wizard: undefined }
      }
    })
    apps.push(app)
    expect(captured).toBeUndefined()
    expect(result.wizard).toBeDefined()
    // The known seed still applied; the unknown key did not crash.
    expect(result.wizard?.statuses['ds-unk-a'].valid).toBe(true)
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('ds-unk-typo'))).toBe(true)
  })
})
