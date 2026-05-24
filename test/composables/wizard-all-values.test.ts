// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `wizard.allValues` aggregates each form's `values` proxy under
 * its step key. Drillable as `wizard.allValues['av-cargo'].weight`.
 * Useful for review screens that summarise every prior step's input
 * without prop-threading.
 */

const cargoSchema = z.object({ weight: z.number(), description: z.string() })
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

describe('useWizard — allValues', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("exposes each form's values under its step key", () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'av-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 'av-review',
        defaultValues: { note: 'send it' },
      })
      return useWizard({ steps: [cargo, review], restore: false, persist: false })
    })
    apps.push(app)
    const allValues = result.allValues as Record<string, Record<string, unknown>>
    expect(allValues['av-cargo']!['weight']).toBe(5)
    expect(allValues['av-cargo']!['description']).toBe('box')
    expect(allValues['av-review']!['note']).toBe('send it')
  })

  it('reflects live updates from each form', () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'av-live-cargo',
        defaultValues: { weight: 5, description: 'box' },
      })
      return {
        wizard: useWizard({ steps: [cargo], restore: false, persist: false }),
        cargo,
      }
    })
    apps.push(app)
    const allValues = result.wizard.allValues as Record<string, Record<string, unknown>>
    expect(allValues['av-live-cargo']!['weight']).toBe(5)
    result.cargo.setValue('weight', 12)
    expect(allValues['av-live-cargo']!['weight']).toBe(12)
  })

  it('exposes empty records for string-slot noop forms', () => {
    const { app, result } = mountHarness(() => {
      const cargo = useForm({
        schema: cargoSchema,
        key: 'av-mixed-cargo',
        defaultValues: { weight: 1, description: 'a' },
      })
      return useWizard({
        steps: ['av-intro', cargo, 'av-thanks'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    const allValues = result.allValues as Record<string, Record<string, unknown>>
    expect(Object.keys(allValues).sort()).toEqual(['av-intro', 'av-mixed-cargo', 'av-thanks'])
    expect(Object.keys(allValues['av-intro']!)).toEqual([])
    expect(Object.keys(allValues['av-thanks']!)).toEqual([])
    expect(allValues['av-mixed-cargo']!['weight']).toBe(1)
  })
})
