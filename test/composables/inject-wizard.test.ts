// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { injectWizard } from '../../src/runtime/composables/inject-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { AttaformRegistry } from '../../src/runtime/core/registry'
import type { UseWizardReturnType } from '../../src/runtime/types/types-wizard'

/**
 * `injectWizard` — cross-component access for wizard handles. Two
 * resolution modes:
 *   - keyed: `injectWizard('key')` looks up the registry directly
 *   - ambient: `injectWizard()` reaches the nearest ancestor wizard
 *     via Vue provide/inject
 *
 * Returns `null` (NOT throws) on any miss, matching `injectForm`.
 *
 * The wizard test harness mounts an SFC tree (Parent → Child) so the
 * provide/inject + registry interplay is exercised end-to-end, just
 * as the production usage will run.
 */

const schema = z.object({ email: z.string().optional() })

const WARN_MARKER = '[attaform] injectWizard'

function registryOf(app: App): AttaformRegistry {
  return (app as unknown as { _attaform: AttaformRegistry })._attaform
}

describe('injectWizard — keyed resolution', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('returns the same handle as the parent useWizard call (identity)', () => {
    const shared: {
      parent?: UseWizardReturnType
      child?: UseWizardReturnType | null
    } = {}

    const Child = defineComponent({
      setup() {
        shared.child = injectWizard('inj-1-wiz')
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'inj-1-only' })
        shared.parent = useWizard({
          steps: [only],
          key: 'inj-1-wiz',
          restore: false,
          persist: false,
        })
        return () => h(Child)
      },
    })

    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)

    expect(shared.parent).toBeDefined()
    expect(shared.child).toBeDefined()
    expect(shared.child).toBe(shared.parent)
  })

  it('shares reactive state — child observes parent navigation', async () => {
    const shared: {
      parent?: UseWizardReturnType
      child?: UseWizardReturnType | null
    } = {}

    const Child = defineComponent({
      setup() {
        shared.child = injectWizard('inj-2-wiz')
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const a = useForm({ schema, key: 'inj-2-a' })
        const b = useForm({ schema, key: 'inj-2-b' })
        const c = useForm({ schema, key: 'inj-2-c' })
        shared.parent = useWizard({
          steps: [a, b, c],
          key: 'inj-2-wiz',
          restore: false,
          persist: false,
        })
        return () => h(Child)
      },
    })

    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)

    expect(shared.child?.currentStep).toBe('inj-2-a')
    await shared.parent?.next()
    expect(shared.child?.currentStep).toBe('inj-2-b')
  })

  it('accepts an object form: injectWizard({ key })', () => {
    const shared: { child?: UseWizardReturnType | null } = {}

    const Child = defineComponent({
      setup() {
        shared.child = injectWizard({ key: 'inj-3-wiz' })
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'inj-3-only' })
        useWizard({ steps: [only], key: 'inj-3-wiz', restore: false, persist: false })
        return () => h(Child)
      },
    })

    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBeDefined()
    expect(shared.child?.key).toBe('inj-3-wiz')
  })
})

describe('injectWizard — ambient resolution', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('reaches the nearest ancestor wizard via provide/inject (anonymous parent)', () => {
    const shared: {
      parent?: UseWizardReturnType
      child?: UseWizardReturnType | null
    } = {}

    const Child = defineComponent({
      setup() {
        shared.child = injectWizard()
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'amb-1-only' })
        shared.parent = useWizard({ steps: [only], restore: false, persist: false })
        return () => h(Child)
      },
    })

    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBe(shared.parent)
  })

  it('reaches the nearest ancestor wizard via ambient even when the parent is keyed', () => {
    const shared: {
      parent?: UseWizardReturnType
      child?: UseWizardReturnType | null
    } = {}

    const Child = defineComponent({
      setup() {
        shared.child = injectWizard()
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'amb-2-only' })
        shared.parent = useWizard({
          steps: [only],
          key: 'amb-2-wiz',
          restore: false,
          persist: false,
        })
        return () => h(Child)
      },
    })

    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBe(shared.parent)
  })

  it('object form with undefined key falls through to ambient lookup', () => {
    const shared: {
      parent?: UseWizardReturnType
      child?: UseWizardReturnType | null
    } = {}

    const Child = defineComponent({
      setup() {
        shared.child = injectWizard({ key: undefined })
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'amb-3-only' })
        shared.parent = useWizard({ steps: [only], restore: false, persist: false })
        return () => h(Child)
      },
    })

    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBe(shared.parent)
  })
})

describe('injectWizard — miss modes (null + dev warn)', () => {
  const apps: App[] = []
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    warnSpy.mockRestore()
  })

  const matchingWarns = (): readonly unknown[][] =>
    warnSpy.mock.calls.filter((args: readonly unknown[]) =>
      String(args[0] ?? '').includes(WARN_MARKER)
    )

  it('returns null and warns when the key is not registered', () => {
    const shared: { child?: UseWizardReturnType | null } = {}
    const Child = defineComponent({
      setup() {
        shared.child = injectWizard('missing-wiz-key')
        return () => h('div')
      },
    })
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'miss-1-only' })
        useWizard({ steps: [only], key: 'miss-1-wiz', restore: false, persist: false })
        return () => h(Child)
      },
    })
    const app = createApp(Parent).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBeNull()
    const warns = matchingWarns()
    expect(warns.length).toBeGreaterThan(0)
    expect(String(warns[0]?.[0] ?? '')).toMatch(/no wizard registered/)
    expect(String(warns[0]?.[0] ?? '')).toMatch(/miss-1-wiz/)
  })

  it('returns null and warns when called with no ancestor wizard', () => {
    const shared: { child?: UseWizardReturnType | null } = {}
    const Orphan = defineComponent({
      setup() {
        shared.child = injectWizard()
        return () => h('div')
      },
    })
    const app = createApp(Orphan).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBeNull()
    const warns = matchingWarns()
    expect(warns.length).toBeGreaterThan(0)
    expect(String(warns[0]?.[0] ?? '')).toMatch(/no ambient wizard context/)
  })

  it('omits the registered-keys hint when the registry is empty', () => {
    const shared: { child?: UseWizardReturnType | null } = {}
    const Orphan = defineComponent({
      setup() {
        shared.child = injectWizard('anything')
        return () => h('div')
      },
    })
    const app = createApp(Orphan).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    expect(shared.child).toBeNull()
    const warns = matchingWarns()
    expect(String(warns[0]?.[0] ?? '')).not.toMatch(/Registered keys:/)
  })
})

describe('injectWizard — sibling isolation', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('two unrelated subtrees resolve their own ancestor wizard via ambient', () => {
    const shared: {
      parentA?: UseWizardReturnType
      childA?: UseWizardReturnType | null
      parentB?: UseWizardReturnType
      childB?: UseWizardReturnType | null
    } = {}

    const ChildA = defineComponent({
      setup() {
        shared.childA = injectWizard()
        return () => h('span')
      },
    })
    const ChildB = defineComponent({
      setup() {
        shared.childB = injectWizard()
        return () => h('span')
      },
    })
    const BranchA = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'sib-a-only' })
        shared.parentA = useWizard({ steps: [only], restore: false, persist: false })
        return () => h(ChildA)
      },
    })
    const BranchB = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'sib-b-only' })
        shared.parentB = useWizard({ steps: [only], restore: false, persist: false })
        return () => h(ChildB)
      },
    })
    const Root = defineComponent({
      setup() {
        return () => h('div', [h(BranchA), h(BranchB)])
      },
    })

    const app = createApp(Root).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)

    expect(shared.childA).toBe(shared.parentA)
    expect(shared.childB).toBe(shared.parentB)
    expect(shared.childA).not.toBe(shared.childB)
  })
})

describe('injectWizard — consumer ref-counting (keyed)', () => {
  it('keeps the handle in the registry while a keyed child consumer is mounted', async () => {
    const Parent = defineComponent({
      setup() {
        const only = useForm({ schema, key: 'lt-2-only' })
        useWizard({ steps: [only], key: 'lt-2-wiz', restore: false, persist: false })
        return () => h('div')
      },
    })
    const Child = defineComponent({
      setup() {
        injectWizard('lt-2-wiz')
        return () => h('span')
      },
    })
    const Root = defineComponent({
      setup() {
        return () => h('div', [h(Parent), h(Child)])
      },
    })

    const app = createApp(Root).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))

    const registry = registryOf(app)
    expect(registry.wizards.has('lt-2-wiz')).toBe(true)

    app.unmount()
    await Promise.resolve()
    expect(registry.wizards.has('lt-2-wiz')).toBe(false)
  })
})
