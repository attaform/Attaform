// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { gate } from '../../src/runtime/core/wizard-gate'
import { lazy } from '../../src/runtime/core/wizard-lazy'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * A step slot resolver is consumer code the wizard invokes during its own
 * compile pass, so a throw from one has nowhere to land: it comes out of
 * `useWizard(...)`, or out of whatever read re-triggered the compile, and
 * takes the host component with it. Attaform must never be the reason a
 * third-party page goes down (#608).
 *
 * The contract pinned here is the one `normalizeSlot` already applies to a
 * resolver that returns itself past `MAX_SLOT_DEPTH`: report once, drop the
 * slot, keep compiling. A dropped slot is a shape the wizard already models
 * (#467 made `null` and `undefined` mean "no step here"), so nothing
 * downstream needs a new case.
 *
 * NO `app.config.errorHandler` IS INSTALLED IN THIS FILE, deliberately.
 * Every other wizard suite sets one to a no-op to quiet Vue, and that alone
 * swallows the escape and makes a probe read clean. It is why this gap
 * survived: the harness was catching what the library should have.
 */

const schema = z.object({ email: z.string().optional() })

/** Mount `setup`, capturing anything that escapes rather than silencing it. */
function mountRaw<R>(setup: () => R): { app: App; result: R | undefined; escaped: unknown } {
  const handle: { result?: R } = {}
  const App = defineComponent({
    setup() {
      handle.result = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  let escaped: unknown = null
  try {
    app.mount(document.createElement('div'))
  } catch (err) {
    escaped = err
  }
  return { app, result: handle.result, escaped }
}

const BOOM = (): never => {
  throw new Error('consumer boom')
}

describe('useWizard: a step slot resolver that throws', () => {
  const apps: App[] = []
  // Inferred from the call rather than annotated: `ReturnType<typeof
  // vi.spyOn>` instantiates the helper's generics at their constraints, so
  // `mock.calls` degrades to `any[][]` and the assertions below stop being
  // typechecked at all.
  const muteErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  let errorSpy: ReturnType<typeof muteErrors>

  beforeEach(() => {
    errorSpy = muteErrors()
  })
  afterEach(() => {
    errorSpy.mockRestore()
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('contains an eager function slot and drops it', () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'st-a' })
      const b = useForm({ schema, key: 'st-b' })
      return useWizard({ steps: [a, BOOM, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    expect(result?.steps.map((s) => s.key)).toEqual(['st-a', 'st-b'])
    expect(result?.count).toBe(2)
    expect(result?.currentStep).toBe('st-a')
  })

  it('contains a lazy() resolver and drops it', () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'lz-a' })
      const b = useForm({ schema, key: 'lz-b' })
      return useWizard({ steps: [a, lazy(BOOM), b], restore: false, persist: false })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    expect(result?.steps.map((s) => s.key)).toEqual(['lz-a', 'lz-b'])
  })

  it('contains a thrower nested inside gate()', () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'gt-a' })
      const b = useForm({ schema, key: 'gt-b' })
      return useWizard({
        steps: [a, gate(lazy(BOOM)), b],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    expect(result?.steps.map((s) => s.key)).toEqual(['gt-a', 'gt-b'])
  })

  /**
   * The report is deduped by `site|detail` in a module-level Set that
   * nothing resets, and vitest shuffles test order inside a file, so an
   * assertion on a slot index another test also breaks is order-dependent
   * and will flake. `steps[3]` is used by no other test here, which is what
   * makes this deterministic.
   */
  it('names the slot it dropped, once, however many times the wizard recompiles', async () => {
    const tick = ref(0)
    const { app, result } = mountRaw(() => {
      const a = useForm({ schema, key: 'rp-a' })
      const b = useForm({ schema, key: 'rp-b' })
      const c = useForm({ schema, key: 'rp-c' })
      return useWizard({
        steps: [
          a,
          b,
          c,
          () => {
            void tick.value
            return BOOM()
          },
        ],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    const named = (): string[] =>
      errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('steps[3]'))

    expect(named()).toHaveLength(1)
    expect(named()[0]).toContain('[attaform]')
    expect(named()[0]).toContain('function step slot threw')

    for (let i = 0; i < 3; i++) {
      tick.value += 1
      await nextTick()
      void result?.steps
    }
    expect(result?.steps.map((s) => s.key)).toEqual(['rp-a', 'rp-b', 'rp-c'])
    expect(named()).toHaveLength(1)
  })

  it('survives a slot that starts throwing after the first compile', async () => {
    const armed = ref(false)
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'lt-a' })
      const b = useForm({ schema, key: 'lt-b' })
      return useWizard({
        steps: [a, (ctx) => (armed.value ? BOOM() : ctx.forms['lt-b']), b],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(escaped, `escaped on mount: ${String(escaped)}`).toBeNull()
    expect(result?.count).toBe(2)

    let later: unknown = null
    try {
      armed.value = true
      await nextTick()
      void result?.steps
    } catch (err) {
      later = err
    }
    expect(later, `escaped on recompile: ${String(later)}`).toBeNull()
    expect(result?.steps.map((s) => s.key)).toEqual(['lt-a', 'lt-b'])
  })

  it('brings the step back once the resolver stops throwing', async () => {
    const broken = ref(true)
    const { app, result } = mountRaw(() => {
      const a = useForm({ schema, key: 'rc-a' })
      const b = useForm({ schema, key: 'rc-b' })
      return useWizard({
        steps: [a, () => (broken.value ? BOOM() : b), 'rc-end'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result?.steps.map((s) => s.key)).toEqual(['rc-a', 'rc-end'])

    broken.value = false
    await nextTick()
    expect(result?.steps.map((s) => s.key)).toEqual(['rc-a', 'rc-b', 'rc-end'])
  })

  it('keeps navigating past a dropped slot', async () => {
    const { app, result } = mountRaw(() => {
      const a = useForm({ schema, key: 'nv-a' })
      const b = useForm({ schema, key: 'nv-b' })
      return useWizard({ steps: [a, BOOM, b], restore: false, persist: false })
    })
    apps.push(app)
    result?.next()
    await nextTick()
    expect(result?.currentStep).toBe('nv-b')
    expect(result?.isFinalStep).toBe(true)
  })
})

/**
 * The step slots were the reported gap, and checking their neighbours found
 * the same shape in every other function-valued `useWizard` option. All five
 * escaped, three of them straight out of `useWizard(...)` during setup, so
 * these are one defect rather than five.
 *
 * Each fallback is the behaviour the option already has when it is omitted,
 * which is what makes the containment a contract rather than a guess.
 */
describe('useWizard: a function-valued option that throws', () => {
  const apps: App[] = []
  const muteErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  let errorSpy: ReturnType<typeof muteErrors>

  beforeEach(() => {
    errorSpy = muteErrors()
  })
  afterEach(() => {
    errorSpy.mockRestore()
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('falls back to the built-in ratio when progress() throws', () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'pg-a' })
      const b = useForm({ schema, key: 'pg-b' })
      return useWizard({ steps: [a, b], progress: BOOM, restore: false, persist: false })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    // Both member forms hold an optional field, so both read valid: the
    // built-in ratio is 2/2. A swallow that returned 0 would pass a
    // `toBeGreaterThanOrEqual(0)` and prove nothing.
    expect(result?.progress).toBe(1)
  })

  it('seeds nothing when a defaultStatuses factory throws', () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'ds-a' })
      return useWizard({ steps: [a], defaultStatuses: BOOM, restore: false, persist: false })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    expect(result?.currentStep).toBe('ds-a')
    expect(result?.statuses['ds-a']?.gate).toBeNull()
  })

  it('seeds nothing when a defaultStatuses promise rejects, with no unhandled rejection', async () => {
    const escapes: string[] = []
    const onRejection = (err: unknown) => escapes.push(String(err))
    process.on('unhandledRejection', onRejection)
    try {
      const { app, result } = mountRaw(() => {
        const a = useForm({ schema, key: 'dsa-a' })
        return useWizard({
          steps: [a],
          defaultStatuses: () => Promise.reject(new Error('async boom')),
          restore: false,
          persist: false,
        })
      })
      apps.push(app)
      for (let i = 0; i < 25; i++) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(escapes, 'escaped as an unhandled rejection').toEqual([])
      expect(result?.currentStep).toBe('dsa-a')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('stays where it is when restore() throws', () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'rs-a' })
      const b = useForm({ schema, key: 'rs-b' })
      return useWizard({ steps: [a, b], restore: BOOM, persist: false })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    expect(result?.currentStep).toBe('rs-a')
  })

  it('navigates anyway when persist() throws', async () => {
    const { app, result, escaped } = mountRaw(() => {
      const a = useForm({ schema, key: 'ps-a' })
      const b = useForm({ schema, key: 'ps-b' })
      return useWizard({ steps: [a, b], restore: false, persist: BOOM })
    })
    apps.push(app)
    expect(escaped, `escaped: ${String(escaped)}`).toBeNull()
    result?.next()
    await nextTick()
    expect(result?.currentStep).toBe('ps-b')
  })
})
