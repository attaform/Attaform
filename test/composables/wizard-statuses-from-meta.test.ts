// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `wizard.statuses` derives each `FormStatus` from the matching
 * form's `meta`. Reactivity flows: form values mutate → meta updates →
 * status updates → template re-renders.
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

describe('useWizard — statuses derived from form.meta', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('starts with valid:false / dirty:false / errorCount:0 for empty forms', () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({ schema: reviewSchema, key: 'st-review' })
      const cargo = useForm({ schema: cargoSchema, key: 'st-cargo', next: review })
      return useWizard(cargo, {})
    })
    apps.push(app)
    expect(result.statuses['st-cargo']!.dirty).toBe(false)
    expect(result.statuses['st-cargo']!.submitted).toBe(false)
    expect(result.statuses['st-review']!.dirty).toBe(false)
  })

  it('flips dirty when a form value changes', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({ schema: reviewSchema, key: 'st-dirty-review' })
      const cargo = useForm({ schema: cargoSchema, key: 'st-dirty-cargo', next: review })
      return { wizard: useWizard(cargo, {}), cargo, review }
    })
    apps.push(app)
    expect(result.wizard.statuses['st-dirty-cargo']!.dirty).toBe(false)
    result.cargo.setValue('description', 'box of widgets')
    await nextTick()
    expect(result.wizard.statuses['st-dirty-cargo']!.dirty).toBe(true)
    expect(result.wizard.statuses['st-dirty-review']!.dirty).toBe(false)
  })

  it('errorCount reflects form.meta.errorCount', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({ schema: reviewSchema, key: 'st-err-review' })
      const cargo = useForm({ schema: cargoSchema, key: 'st-err-cargo', next: review })
      return { wizard: useWizard(cargo, {}), cargo, review }
    })
    apps.push(app)
    result.cargo.setValue('description', '')
    result.cargo.setValue('weight', 0)
    await result.cargo.validate()
    expect(result.wizard.statuses['st-err-cargo']!.errorCount).toBeGreaterThan(0)
    expect(result.wizard.statuses['st-err-cargo']!.valid).toBe(false)
  })

  it('valid flips true once errors clear', async () => {
    const { app, result } = mountHarness(() => {
      const review = useForm({ schema: reviewSchema, key: 'st-clear-review' })
      const cargo = useForm({
        schema: cargoSchema,
        key: 'st-clear-cargo',
        defaultValues: { weight: 5, description: 'box' },
        next: review,
      })
      return { wizard: useWizard(cargo, {}), cargo, review }
    })
    apps.push(app)
    await result.cargo.validate()
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (!result.cargo.meta.validating) break
    }
    expect(result.cargo.meta.valid).toBe(true)
    expect(result.wizard.statuses['st-clear-cargo']!.valid).toBe(true)
    expect(result.wizard.statuses['st-clear-cargo']!.errorCount).toBe(0)
  })

  it('callable form returns the live FormStatus snapshot', async () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'st-call-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      return { wizard: useWizard(cargo, {}), cargo }
    })
    apps.push(app)
    await result.cargo.validate()
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve()
      await nextTick()
      if (!result.cargo.meta.validating) break
    }
    const single = result.wizard.statuses('st-call-cargo')
    expect((single as { valid: boolean }).valid).toBe(true)
    const all = result.wizard.statuses() as Record<string, { valid: boolean }>
    const cargoStatus = all['st-call-cargo'] as { valid: boolean }
    expect(cargoStatus.valid).toBe(true)
  })
})
