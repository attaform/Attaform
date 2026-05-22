// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { FormStatus } from '../../src/runtime/types/types-wizard'

/**
 * `onStatusChange` fires on each material change to a form's status —
 * a change to `valid`, `dirty`, `submitted`, or `errorCount`.
 * It's immediate (no debounce). Async return is fire-and-forget (the
 * wizard does NOT await it).
 */

const cargoSchema = z.object({
  weight: z.number().min(1, 'weight required'),
  description: z.string().min(1, 'description required'),
})
const reviewSchema = z.object({ note: z.string() })

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

describe('useWizard — onStatusChange material-change firing', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('fires when dirty flips', async () => {
    const calls: Array<{ formKey: string; status: FormStatus }> = []
    const { app, result } = mountHarness(() => {
      const cargo = useForm({ schema: cargoSchema, key: 'osc-dirty-cargo' })
      return {
        wizard: useWizard(cargo, {
          onStatusChange: (status, form) => {
            calls.push({ formKey: form.key, status })
          },
        }),
        cargo,
      }
    })
    apps.push(app)
    expect(calls.length).toBe(0)
    result.cargo.setValue('description', 'box')
    await nextTick()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[calls.length - 1]!.formKey).toBe('osc-dirty-cargo')
    expect(calls[calls.length - 1]!.status.dirty).toBe(true)
  })

  it('fires when errorCount changes', async () => {
    const calls: FormStatus[] = []
    const { app, result } = mountHarness(() => {
      const cargo = useForm({ schema: cargoSchema, key: 'osc-err-cargo' })
      return {
        wizard: useWizard(cargo, {
          onStatusChange: (status) => {
            calls.push(status)
          },
        }),
        cargo,
      }
    })
    apps.push(app)
    result.cargo.setValue('description', '')
    result.cargo.setValue('weight', 0)
    await result.cargo.validate()
    await nextTick()
    expect(calls.some((status) => status.errorCount > 0)).toBe(true)
  })

  it('does not fire when a non-picked field changes', async () => {
    const calls: FormStatus[] = []
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'osc-no-fire-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      return {
        wizard: useWizard(cargo, {
          onStatusChange: (status) => {
            calls.push(status)
          },
        }),
        cargo,
      }
    })
    apps.push(app)
    await nextTick()
    const baseline = calls.length
    // Reading a non-status field (submitting) does not trigger a meta
    // change that would fire onStatusChange.
    void result.cargo.meta.submitting
    await nextTick()
    expect(calls.length).toBe(baseline)
  })

  it('does not block nav on an async return', async () => {
    let pending = false
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: reviewSchema, key: 'osc-block-b' })
      const a = useForm({
        schema: cargoSchema,
        key: 'osc-block-a',
        defaultValues: { weight: 5, description: 'box' },
        next: b,
      })
      return {
        wizard: useWizard(a, {
          onStatusChange: () =>
            new Promise<void>((resolve) => {
              pending = true
              setTimeout(() => {
                pending = false
                resolve()
              }, 50)
            }),
        }),
        a,
        b,
      }
    })
    apps.push(app)
    result.a.setValue('description', 'box-mutated')
    await nextTick()
    expect(pending).toBe(true)
    // Even with onStatusChange's promise still in-flight, nav is unblocked.
    await result.wizard.next()
    expect(result.wizard.current).toBe('osc-block-b')
  })

  it('fires only once per material change (no chatter on identical writes)', async () => {
    let calls = 0
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'osc-dedup-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      return {
        wizard: useWizard(cargo, {
          onStatusChange: () => {
            calls += 1
          },
        }),
        cargo,
      }
    })
    apps.push(app)
    await nextTick()
    const baseline = calls
    result.cargo.setValue('description', 'box')
    await nextTick()
    result.cargo.setValue('description', 'box')
    await nextTick()
    expect(calls).toBe(baseline)
  })
})
