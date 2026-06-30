// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { computed, createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Introspection surfaces that survived the v2 cutover:
 *   - `wizard.steps` — ordered list of compiled `{ key, form }` slots.
 *   - `wizard.forms` — keyed record indexable by step key.
 *   - `wizard.visited` — append-only audit log of navigated step keys.
 *
 * Static graph machinery (`flow.tree`, `flow.allForms`, `flow.diagnose`)
 * is retired with v1; only the data that maps cleanly to a positional
 * step list survives here.
 */

const schema = z.object({ email: z.string().optional() })

function mountWizardHarness<R>(setup: () => R): { app: App; result: R } {
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

describe('wizard.steps + wizard.forms — positional introspection', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('steps[0].form is identity-equal to the first form in the steps list', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'f-1-a' })
      const b = useForm({ schema, key: 'f-1-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { wizard, a }
    })
    apps.push(app)
    expect(result.wizard.steps[0]?.form).toBe(result.a)
  })

  it('forms[key] resolves each step by its key', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'f-2-a' })
      const b = useForm({ schema, key: 'f-2-b' })
      const c = useForm({ schema, key: 'f-2-c' })
      const wizard = useWizard({ steps: [a, b, c], restore: false, persist: false })
      return { wizard, a, b, c }
    })
    apps.push(app)
    expect(result.wizard.forms['f-2-a']).toBe(result.a)
    expect(result.wizard.forms['f-2-b']).toBe(result.b)
    expect(result.wizard.forms['f-2-c']).toBe(result.c)
  })

  it('drops duplicate forms from the compiled list (first occurrence wins)', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'f-3-a' })
      const b = useForm({ schema, key: 'f-3-b' })
      return useWizard({ steps: [a, b, a], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['f-3-a', 'f-3-b'])
  })

  it('renders single-step wizards as a one-element steps list', () => {
    const { app, result } = mountWizardHarness(() => {
      const only = useForm({ schema, key: 'f-4-only' })
      return useWizard({ steps: [only], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['f-4-only'])
    // `activeForm` is a live facade keyed to the active step; the raw
    // per-step handle stays reachable via `forms[key]`.
    expect(result.activeForm?.key).toBe('f-4-only')
    expect(result.forms['f-4-only']).toBe(result.steps[0]?.form)
  })
})

describe('wizard.visited — runtime audit log', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('seeds with the initial step on construction', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-1-a' })
      const b = useForm({ schema, key: 'v-1-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.visited).toEqual(['v-1-a'])
  })

  it('appends on next()', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-2-a' })
      const b = useForm({ schema, key: 'v-2-b' })
      const c = useForm({ schema, key: 'v-2-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    await result.next()
    expect(result.visited).toEqual(['v-2-a', 'v-2-b'])
    await result.next()
    expect(result.visited).toEqual(['v-2-a', 'v-2-b', 'v-2-c'])
  })

  it('does NOT re-append a key already in the trail', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-3-a' })
      const b = useForm({ schema, key: 'v-3-b' })
      const c = useForm({ schema, key: 'v-3-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    await result.next()
    await result.next()
    expect(result.visited).toEqual(['v-3-a', 'v-3-b', 'v-3-c'])
    result.back()
    expect(result.visited).toEqual(['v-3-a', 'v-3-b', 'v-3-c'])
  })

  it('appends on a forward goTo()', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-4-a' })
      const b = useForm({ schema, key: 'v-4-b' })
      const c = useForm({ schema, key: 'v-4-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    result.goTo('v-4-c')
    expect(result.visited).toEqual(['v-4-a', 'v-4-c'])
  })

  it('does not append on a no-op navigation (target equals current)', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-5-a' })
      const b = useForm({ schema, key: 'v-5-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.visited).toEqual(['v-5-a'])
    result.goTo('v-5-a')
    expect(result.visited).toEqual(['v-5-a'])
  })

  it('reset() rewinds visited to the first step', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-6-a' })
      const b = useForm({ schema, key: 'v-6-b' })
      const c = useForm({ schema, key: 'v-6-c' })
      return useWizard({ steps: [a, b, c], restore: false, persist: false })
    })
    apps.push(app)
    await result.next()
    await result.next()
    expect(result.visited).toEqual(['v-6-a', 'v-6-b', 'v-6-c'])
    result.reset()
    expect(result.visited).toEqual(['v-6-a'])
  })

  it('is reactive — a computed reading visited.length recomputes on navigation', async () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({ schema, key: 'v-7-a' })
      const b = useForm({ schema, key: 'v-7-b' })
      const c = useForm({ schema, key: 'v-7-c' })
      const wizard = useWizard({ steps: [a, b, c], restore: false, persist: false })
      const trailLength = computed(() => wizard.visited.length)
      return { wizard, trailLength }
    })
    apps.push(app)
    expect(result.trailLength.value).toBe(1)
    await result.wizard.next()
    expect(result.trailLength.value).toBe(2)
    await result.wizard.next()
    expect(result.trailLength.value).toBe(3)
  })
})
