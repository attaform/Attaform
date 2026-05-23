// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { computed, createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `wizard.flow` — Phase 5 introspection surface. Composes the static
 * graph (`entryForm`, `tree`, `allForms`) with the runtime navigation
 * log (`visited`) and the diagnostic warnings channel (`diagnose()`).
 *
 * Static-graph coverage (tree shape for linear / branching / convergent
 * graphs, BFS ordering, dedupe) lives in `wizard-graph.test.ts` against
 * the pure framework-free module. The tests here exercise the same data
 * via the wizard surface (so `useForm`-backed forms — not plain object
 * fixtures — round-trip through the introspection namespace) and add
 * coverage for the two pieces that DON'T exist at the graph layer:
 * `visited` tracking across navigation and `diagnose()`'s passthrough.
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

describe('wizard.flow — static graph view', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('exposes the entry form identity-equal to the useWizard argument', () => {
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'f-1-b' })
      const a = useForm({ schema, key: 'f-1-a', next: b })
      const wizard = useWizard(a)
      return { wizard, a }
    })
    apps.push(app)
    expect(result.wizard.flow.entryForm).toBe(result.a)
  })

  it('exposes allForms BFS-ordered, deduped across convergent paths', () => {
    const { app, result } = mountWizardHarness(() => {
      const review = useForm({ schema, key: 'f-2-review' })
      const admin = useForm({ schema, key: 'f-2-admin', next: review })
      const user = useForm({ schema, key: 'f-2-user', next: review })
      const account = useForm({
        schema: z.object({ role: z.enum(['admin', 'user']) }),
        defaultValues: { role: 'admin' },
        key: 'f-2-account',
        next: {
          forms: [admin, user] as const,
          pick: (parsed) => (parsed.role === 'admin' ? admin : user),
        },
      })
      return useWizard(account)
    })
    apps.push(app)
    expect(result.flow.allForms.map((f) => f.key)).toEqual([
      'f-2-account',
      'f-2-admin',
      'f-2-user',
      'f-2-review',
    ])
  })

  it('exposes tree as a recursive WizardTreeNode for branching graphs', () => {
    const { app, result } = mountWizardHarness(() => {
      const review = useForm({ schema, key: 'f-3-review' })
      const admin = useForm({ schema, key: 'f-3-admin', next: review })
      const user = useForm({ schema, key: 'f-3-user', next: review })
      const account = useForm({
        schema: z.object({ role: z.enum(['admin', 'user']) }),
        defaultValues: { role: 'admin' },
        key: 'f-3-account',
        next: {
          forms: [admin, user] as const,
          pick: (parsed) => (parsed.role === 'admin' ? admin : user),
        },
      })
      return useWizard(account)
    })
    apps.push(app)
    expect(result.flow.tree).toEqual({
      key: 'f-3-account',
      next: [
        { key: 'f-3-admin', next: [{ key: 'f-3-review', next: [] }] },
        { key: 'f-3-user', next: [{ key: 'f-3-review', next: [] }] },
      ],
    })
  })

  it('exposes a flat single-node tree for a single-step entry', () => {
    const { app, result } = mountWizardHarness(() => {
      const only = useForm({ schema, key: 'f-4-only' })
      return useWizard(only)
    })
    apps.push(app)
    expect(result.flow.tree).toEqual({ key: 'f-4-only', next: [] })
  })

  it('flow.allForms and top-level allForms refer to the same array', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'f-5-c' })
      const b = useForm({ schema, key: 'f-5-b', next: c })
      const a = useForm({ schema, key: 'f-5-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.flow.allForms).toBe(result.allForms)
  })
})

describe('wizard.flow.visited — runtime audit log', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('seeds with the initial step on construction', () => {
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'v-1-b' })
      const a = useForm({ schema, key: 'v-1-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.flow.visited).toEqual(['v-1-a'])
  })

  it('appends on next()', async () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'v-2-c' })
      const b = useForm({ schema, key: 'v-2-b', next: c })
      const a = useForm({ schema, key: 'v-2-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    await result.next()
    expect(result.flow.visited).toEqual(['v-2-a', 'v-2-b'])
    await result.next()
    expect(result.flow.visited).toEqual(['v-2-a', 'v-2-b', 'v-2-c'])
  })

  it('appends on back() too — the trail is an audit log, not a back-stack', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'v-3-c' })
      const b = useForm({ schema, key: 'v-3-b', next: c })
      const a = useForm({ schema, key: 'v-3-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    return (async () => {
      await result.next()
      await result.next()
      expect(result.flow.visited).toEqual(['v-3-a', 'v-3-b', 'v-3-c'])
      result.back()
      expect(result.flow.visited).toEqual(['v-3-a', 'v-3-b', 'v-3-c', 'v-3-b'])
    })()
  })

  it('appends on goTo()', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'v-4-c' })
      const b = useForm({ schema, key: 'v-4-b', next: c })
      const a = useForm({ schema, key: 'v-4-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    result.goTo('v-4-c')
    expect(result.flow.visited).toEqual(['v-4-a', 'v-4-c'])
    result.goTo('v-4-b')
    expect(result.flow.visited).toEqual(['v-4-a', 'v-4-c', 'v-4-b'])
  })

  it('does not append on a no-op navigation (target equals current)', () => {
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'v-5-b' })
      const a = useForm({ schema, key: 'v-5-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.flow.visited).toEqual(['v-5-a'])
    result.goTo('v-5-a')
    expect(result.flow.visited).toEqual(['v-5-a'])
  })

  it('reset() rewinds visited to the current step only', async () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'v-6-c' })
      const b = useForm({ schema, key: 'v-6-b', next: c })
      const a = useForm({ schema, key: 'v-6-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    await result.next()
    await result.next()
    expect(result.flow.visited).toEqual(['v-6-a', 'v-6-b', 'v-6-c'])
    result.reset()
    expect(result.flow.visited).toEqual([result.current])
  })

  it('is reactive — a computed reading visited.length recomputes on navigation', async () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'v-7-c' })
      const b = useForm({ schema, key: 'v-7-b', next: c })
      const a = useForm({ schema, key: 'v-7-a', next: b })
      const wizard = useWizard(a)
      const trailLength = computed(() => wizard.flow.visited.length)
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

describe('wizard.flow.diagnose — construction warnings passthrough', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('returns an empty array for a clean multi-step graph', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'd-1-c' })
      const b = useForm({ schema, key: 'd-1-b', next: c })
      const a = useForm({ schema, key: 'd-1-a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.flow.diagnose()).toEqual([])
  })

  it('reports a single-step warning when the entry has no next', () => {
    const { app, result } = mountWizardHarness(() => {
      const only = useForm({ schema, key: 'd-2-only' })
      return useWizard(only)
    })
    apps.push(app)
    const warnings = result.flow.diagnose()
    const single = warnings.find((w) => w.kind === 'single-step')
    expect(single).toBeDefined()
    expect(single?.key).toBe('d-2-only')
    expect(single?.severity).toBe('warn')
  })

  it('reports an empty-forms warning when a branching next declares forms: []', () => {
    const { app, result } = mountWizardHarness(() => {
      const a = useForm({
        schema,
        key: 'd-3-a',
        next: {
          forms: [] as const,
          pick: () => undefined,
        },
      })
      return useWizard(a)
    })
    apps.push(app)
    const warnings = result.flow.diagnose()
    const empty = warnings.find((w) => w.kind === 'empty-forms')
    expect(empty).toBeDefined()
    expect(empty?.key).toBe('d-3-a')
  })

  it('returns the same array identity on repeat calls (cheap, memoizable)', () => {
    const { app, result } = mountWizardHarness(() => {
      const only = useForm({ schema, key: 'd-4-only' })
      return useWizard(only)
    })
    apps.push(app)
    expect(result.flow.diagnose()).toBe(result.flow.diagnose())
  })
})
