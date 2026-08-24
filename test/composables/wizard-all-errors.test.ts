// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `wizard.allErrors` exposes each form's validation errors under its
 * step key. Shape: `Record<FormKey, readonly WizardAggregateError[]>`.
 *
 * Each entry carries `{ formKey, path, message, code? }` so a wizard-
 * wide summary screen can render "Step Cargo > weight: weight required"
 * and link back to the offending field.
 */

const cargoSchema = z.object({
  weight: z.number().min(1, 'weight required'),
  description: z.string().min(1, 'description required'),
})
const reviewSchema = z.object({ note: z.string().min(1, 'note required') })

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

describe('useWizard — allErrors', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('starts as a record of empty lists', () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'ae-empty-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'ae-empty-review',
        defaultValues: { note: 'send it' },
      })
      return useWizard({ steps: [cargo, review], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.allErrors['ae-empty-cargo']).toEqual([])
    expect(result.allErrors['ae-empty-review']).toEqual([])
  })

  it("namespaces each form's errors under its step key", async () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({ schema: cargoSchema, key: 'ae-fill-cargo' })
      const review = useForm({ schema: reviewSchema, key: 'ae-fill-review' })
      return {
        wizard: useWizard({ steps: [cargo, review], restore: false, persist: false }),
        cargo,
        review,
      }
    })
    apps.push(app)
    await result.cargo.parse({ commit: true })
    await result.review.parse({ commit: true })
    const cargoErrors = result.wizard.allErrors['ae-fill-cargo'] ?? []
    const reviewErrors = result.wizard.allErrors['ae-fill-review'] ?? []
    expect(cargoErrors.length).toBeGreaterThan(0)
    expect(reviewErrors.length).toBeGreaterThan(0)
    const weightError = cargoErrors.find((e) => e.path.includes('weight'))
    expect(weightError).toBeDefined()
    expect(weightError!.formKey).toBe('ae-fill-cargo')
    expect(weightError!.message).toMatch(/weight/i)
  })

  it('lists noop-form step keys with empty error arrays', () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'ae-mixed-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      return useWizard({
        steps: ['ae-intro', cargo, 'ae-thanks'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(Object.keys(result.allErrors).sort()).toEqual([
      'ae-intro',
      'ae-mixed-cargo',
      'ae-thanks',
    ])
    expect(result.allErrors['ae-intro']).toEqual([])
    expect(result.allErrors['ae-thanks']).toEqual([])
  })
})
