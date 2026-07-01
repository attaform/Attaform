// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * COMP-W5 / forward-continuity: when the active step's slot becomes
 * un-resolvable mid-flight (a function or lazy slot that previously
 * returned a form now returns nullish), the wizard re-points the pin at
 * the step that took the dropped slot's place rather than snapping back
 * to the first step, and `wizard.currentStep` / `wizard.activeForm` stay
 * in lockstep. Earlier the reads fell back to the first compiled step
 * (the "W-BRITTLE-1" behavior); the pin is now re-anchored at its source
 * via a watch on the compiled list, so index-based navigation stays
 * consistent from the new position too.
 */

const schema = z.object({ email: z.string().optional() })

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

describe('useWizard — active-step forward-continuity when a slot drops', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('slides the pin forward to the step that took the dropped slot', async () => {
    const showMiddle = ref(true)
    const { app, result } = mountHarness(() => {
      const entry = useForm({ schema, key: 'w-brittle-entry' })
      const middle = useForm({ schema, key: 'w-brittle-middle' })
      const final = useForm({ schema, key: 'w-brittle-final' })
      return useWizard({
        steps: [entry, () => (showMiddle.value ? middle : undefined), final],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)

    // Baseline: all three steps compile, navigate to middle.
    expect(result.steps.map((s) => s.key)).toEqual([
      'w-brittle-entry',
      'w-brittle-middle',
      'w-brittle-final',
    ])
    await result.next()
    expect(result.currentStep).toBe('w-brittle-middle')
    expect(result.activeForm?.key).toBe('w-brittle-middle')

    // Drop the middle slot while the wizard is sitting on it.
    showMiddle.value = false
    await nextTick()

    // The compiled list contracts to [entry, final]. The active key
    // ('w-brittle-middle') is gone, so the pin slides forward to the
    // step that took its slot ('w-brittle-final') rather than snapping
    // back to the first step. currentStep and activeForm stay in lockstep.
    expect(result.steps.map((s) => s.key)).toEqual(['w-brittle-entry', 'w-brittle-final'])
    expect(result.activeForm?.key).toBe('w-brittle-final')
    expect(result.currentStep).toBe('w-brittle-final')
    expect(result.currentStep).toBe(result.activeForm?.key)
  })

  it('keeps currentStep === activeForm.key on the happy path too', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'w-brittle-happy-a' })
      const b = useForm({ schema, key: 'w-brittle-happy-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)

    expect(result.currentStep).toBe(result.activeForm?.key)
    await result.next()
    expect(result.currentStep).toBe(result.activeForm?.key)
    result.back()
    expect(result.currentStep).toBe(result.activeForm?.key)
  })
})
