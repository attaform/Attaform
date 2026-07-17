// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm, gate } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'
import type { FormStatusSeed } from '../../src/runtime/types/types-wizard'

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
 *   1. store.defaultsResolved === true → derive from form.meta
 *   2. noop form (string slot)         → built-in always-valid
 *   3. defaultStatuses resolved        → frozen seed
 *   4. else                            → pending sentinel
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

const validSeed: FormStatusSeed = {
  valid: true,
  dirty: false,
  submitted: false,
  errorCount: 0,
}

const dirtySeed: FormStatusSeed = {
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
        defaultValues: () => new Promise<{ a: string }>(() => {}),
      })
      const b = useForm({
        schema: schemaB,
        key: 'ds-plain-b',
        defaultValues: () => new Promise<{ b: string }>(() => {}),
      })
      return useWizard({
        steps: [a, b],
        defaultStatuses: { 'ds-plain-a': validSeed, 'ds-plain-b': dirtySeed },
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.statuses['ds-plain-a']!.valid).toBe(true)
    expect(result.statuses['ds-plain-b']!.dirty).toBe(true)
    expect(result.statuses['ds-plain-b']!.errorCount).toBe(1)
  })

  it('accepts a sync function seed', () => {
    let calls = 0
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: schemaA,
        key: 'ds-fn-a',
        defaultValues: () => new Promise<{ a: string }>(() => {}),
      })
      const b = useForm({
        schema: schemaB,
        key: 'ds-fn-b',
        defaultValues: () => new Promise<{ b: string }>(() => {}),
      })
      return useWizard({
        steps: [a, b],
        defaultStatuses: () => {
          calls += 1
          return { 'ds-fn-a': validSeed, 'ds-fn-b': dirtySeed }
        },
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(calls).toBe(1)
    expect(result.statuses['ds-fn-a']!.valid).toBe(true)
    expect(result.statuses['ds-fn-b']!.dirty).toBe(true)
  })

  it('accepts an async function seed that lands later', async () => {
    let resolveSeed!: (value: {
      'ds-async-a': FormStatusSeed
      'ds-async-b': FormStatusSeed
    }) => void
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
      const b = useForm({
        schema: schemaB,
        key: 'ds-async-b',
        defaultValues: () => new Promise<{ b: string }>(() => {}),
      })
      return {
        wizard: useWizard({
          steps: [a, b],
          defaultStatuses: () =>
            new Promise((r) => {
              resolveSeed = r
            }),
          restore: false,
          persist: false,
        }),
        a,
        b,
      }
    })
    apps.push(app)
    expect(result.wizard.statuses['ds-async-a']!.valid).toBe(false)
    expect(result.wizard.statuses['ds-async-a']!.errorCount).toBe(0)

    resolveSeed({ 'ds-async-a': validSeed, 'ds-async-b': dirtySeed })
    await waitUntil(() => (result.wizard.statuses['ds-async-a']!.valid ? true : null))
    expect(result.wizard.statuses['ds-async-a']!.valid).toBe(true)
    expect(result.wizard.statuses['ds-async-b']!.dirty).toBe(true)
    expect(result.wizard.statuses['ds-async-b']!.errorCount).toBe(1)

    resolveA({ a: 'A' })
    await waitUntil(() => (result.a.hydrating === false ? true : null))
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      if (!result.a.meta.validating) break
    }
    expect(result.wizard.statuses['ds-async-b']!.dirty).toBe(true)
    expect(result.wizard.statuses['ds-async-a']).toEqual({
      valid: result.a.meta.valid,
      dirty: result.a.meta.dirty,
      submitted: result.a.meta.submitted,
      errorCount: result.a.meta.errorCount,
      locked: false,
      gate: null,
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
        wizard: useWizard({
          steps: [a],
          defaultStatuses: { 'ds-over-a': dirtySeed },
          restore: false,
          persist: false,
        }),
        a,
      }
    })
    apps.push(app)
    expect(result.wizard.statuses['ds-over-a']!.dirty).toBe(false)
    expect(result.wizard.statuses['ds-over-a']!.errorCount).toBe(0)
  })

  it('noop forms ignore the seed and surface as always-valid', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: schemaA, key: 'ds-noop-a' })
      return useWizard({
        steps: ['ds-noop-intro', a],
        defaultStatuses: { 'ds-noop-intro': dirtySeed },
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.statuses['ds-noop-intro']!.valid).toBe(true)
    expect(result.statuses['ds-noop-intro']!.dirty).toBe(false)
    expect(result.statuses['ds-noop-intro']!.errorCount).toBe(0)
  })

  it('unknown seed key is ignored with a dev-warn (no throw)', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    let captured: unknown
    const { app, result } = mountHarness(() => {
      try {
        const a = useForm({
          schema: schemaA,
          key: 'ds-unk-a',
          defaultValues: () => new Promise<{ a: string }>(() => {}),
        })
        const b = useForm({
          schema: schemaB,
          key: 'ds-unk-b',
          defaultValues: () => new Promise<{ b: string }>(() => {}),
        })
        return {
          wizard: useWizard({
            steps: [a, b],
            defaultStatuses: {
              'ds-unk-a': validSeed,
              'ds-unk-typo': dirtySeed,
            },
            restore: false,
            persist: false,
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
    expect(result.wizard?.statuses['ds-unk-a']!.valid).toBe(true)
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('ds-unk-typo'))).toBe(true)
  })

  // `gate` in a seed is a WRITE-only latch signal, not a status field echoed
  // on read: `{ gate: 'cleared' }` clears the gate at (plain/sync) construction
  // or (async) resolution; the live `gate` overlay owns the read.
  it('gate seed (plain object) clears the gate at construction', () => {
    const { app, result } = mountHarness(() => {
      const consent = useForm({ schema: z.object({ ok: z.literal(true) }), key: 'ds-gate-plain' })
      const data = useForm({ schema: schemaA, key: 'ds-gate-plain-data', defaultValues: { a: '' } })
      return useWizard({
        steps: [gate(consent), data],
        defaultStatuses: { 'ds-gate-plain': { gate: 'cleared' } },
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.statuses['ds-gate-plain']!.gate).toBe('cleared')
    expect(result.statuses['ds-gate-plain-data']!.locked).toBe(false)
  })

  it('gate seed (sync function) clears the gate at construction', () => {
    const { app, result } = mountHarness(() => {
      const consent = useForm({ schema: z.object({ ok: z.literal(true) }), key: 'ds-gate-fn' })
      const data = useForm({ schema: schemaA, key: 'ds-gate-fn-data', defaultValues: { a: '' } })
      return useWizard({
        steps: [gate(consent), data],
        defaultStatuses: () => ({ 'ds-gate-fn': { gate: 'cleared' } }),
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.statuses['ds-gate-fn']!.gate).toBe('cleared')
    expect(result.statuses['ds-gate-fn-data']!.locked).toBe(false)
  })

  it('gate seed (async function) clears only after the promise resolves (client-only)', async () => {
    let resolveSeed!: (value: Record<string, FormStatusSeed>) => void
    const { app, result } = mountHarness(() => {
      const consent = useForm({ schema: z.object({ ok: z.literal(true) }), key: 'ds-gate-async' })
      const data = useForm({ schema: schemaA, key: 'ds-gate-async-data', defaultValues: { a: '' } })
      return useWizard({
        steps: [gate(consent), data],
        defaultStatuses: () =>
          new Promise<Record<string, FormStatusSeed>>((r) => {
            resolveSeed = r
          }),
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    // The async factory is fire-and-forget: uncleared until it resolves, so it
    // is NOT available for a first-byte SSR render (the sync/plain form is
    // required there).
    expect(result.statuses['ds-gate-async']!.gate).toBe('uncleared')
    expect(result.statuses['ds-gate-async-data']!.locked).toBe(true)

    resolveSeed({ 'ds-gate-async': { gate: 'cleared' } })
    await waitUntil(() => (result.statuses['ds-gate-async']!.gate === 'cleared' ? true : null))
    expect(result.statuses['ds-gate-async']!.gate).toBe('cleared')
    expect(result.statuses['ds-gate-async-data']!.locked).toBe(false)
  })
})
