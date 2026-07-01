// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { lazy } from '../../src/runtime/core/wizard-lazy'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Issue #467: `useWizard({ steps })` accepts `null`, `undefined`, and
 * function / lazy slots that resolve to them, all treated as "no step
 * here" and filtered out of the compiled list. Conditional steps read
 * inline as `cond ? form : null` without pre-filtering the array. When a
 * function slot flips its active step to nullish mid-flight, the pin
 * slides forward to the step that took its place.
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

describe('useWizard — nullish step slots (#467)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('filters literal null and undefined array elements', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'nz-a' })
      const b = useForm({ schema, key: 'nz-b' })
      return useWizard({
        steps: [a, null, 'affordance', undefined, b],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['nz-a', 'affordance', 'nz-b'])
    expect(result.count).toBe(3)
    expect(result.currentStep).toBe('nz-a')
  })

  it('filters a function slot that returns null, at parity with undefined', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'nz-fn-a' })
      const b = useForm({ schema, key: 'nz-fn-b' })
      return useWizard({
        steps: [a, () => null, () => undefined, b],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['nz-fn-a', 'nz-fn-b'])
  })

  it('filters a lazy slot that resolves to null', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'nz-lazy-a' })
      const b = useForm({ schema, key: 'nz-lazy-b' })
      return useWizard({
        steps: [a, lazy(() => null), b],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['nz-lazy-a', 'nz-lazy-b'])
  })

  it('compiles an all-nullish steps list to a degenerate empty wizard without throwing', () => {
    const { app, result } = mountHarness(() =>
      useWizard({ steps: [null, undefined, () => null], restore: false, persist: false })
    )
    apps.push(app)
    expect(result.steps).toEqual([])
    expect(result.count).toBe(0)
    expect(result.currentStep).toBeUndefined()
    expect(result.activeForm).toBeUndefined()
  })

  it('reactively adds and drops a step as a function slot flips between form and null', async () => {
    const show = ref(false)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'nz-react-a' })
      const opt = useForm({ schema, key: 'nz-react-opt' })
      const b = useForm({ schema, key: 'nz-react-b' })
      return useWizard({
        steps: [a, () => (show.value ? opt : null), b],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['nz-react-a', 'nz-react-b'])
    show.value = true
    await nextTick()
    expect(result.steps.map((s) => s.key)).toEqual(['nz-react-a', 'nz-react-opt', 'nz-react-b'])
    show.value = false
    await nextTick()
    expect(result.steps.map((s) => s.key)).toEqual(['nz-react-a', 'nz-react-b'])
  })

  it('slides the pin forward when the active step flips to null', async () => {
    const showMiddle = ref(true)
    const { app, result } = mountHarness(() => {
      const entry = useForm({ schema, key: 'nz-slide-entry' })
      const middle = useForm({ schema, key: 'nz-slide-middle' })
      const final = useForm({ schema, key: 'nz-slide-final' })
      return useWizard({
        steps: [entry, () => (showMiddle.value ? middle : null), final],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    await result.next()
    expect(result.currentStep).toBe('nz-slide-middle')

    showMiddle.value = false
    await nextTick()

    // The dropped 'middle' slot's place is taken by 'final'; the pin
    // slides there rather than snapping to the first step.
    expect(result.steps.map((s) => s.key)).toEqual(['nz-slide-entry', 'nz-slide-final'])
    expect(result.currentStep).toBe('nz-slide-final')
    expect(result.activeForm?.key).toBe('nz-slide-final')

    // Navigation stays consistent from the re-pinned position.
    result.back()
    expect(result.currentStep).toBe('nz-slide-entry')
  })

  it('clamps to the new last step when the dropped active step was last', async () => {
    const showLast = ref(true)
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema, key: 'nz-last-a' })
      const b = useForm({ schema, key: 'nz-last-b' })
      const last = useForm({ schema, key: 'nz-last-c' })
      return useWizard({
        steps: [a, b, () => (showLast.value ? last : null)],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    await result.next()
    await result.next()
    expect(result.currentStep).toBe('nz-last-c')

    showLast.value = false
    await nextTick()

    expect(result.steps.map((s) => s.key)).toEqual(['nz-last-a', 'nz-last-b'])
    expect(result.currentStep).toBe('nz-last-b')
  })
})
