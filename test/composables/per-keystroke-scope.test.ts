// @vitest-environment jsdom
/**
 * CORE-P1a — every per-keystroke `scheduleFieldValidation` ran
 * `validateAtPath(form, undefined)` (whole-form), re-parsing every
 * leaf on every character. For a 200-field flat schema, typing one
 * character did 200 leaf parses; for any schema that only carries
 * leaf-level refines, the ancestor verdicts the whole-form pass
 * was guarding for didn't exist.
 *
 * Fix: route the per-keystroke run through the new adapter
 * predicate `hasContainerOrRootRefine`. When it returns `false`
 * (no ancestor or root effect), validate only the edited subtree.
 * When it returns `true` (or is missing), fall back to whole-form
 * — ancestor refines stay correct under cross-field writes.
 *
 * Red-green: leaf refine on `refined`, an unrefined sibling
 * `sibling`. Type into `sibling`. Old whole-form pass invokes
 * `refined`'s refine on every keystroke; new subtree pass at
 * `['sibling']` doesn't. Counter pinned at the pre-edit value.
 * A control test mounts a schema WITH a container refine so the
 * predicate returns `true` and the whole-form behaviour is
 * preserved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

const drainMicrotasks = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function buildFlatV4() {
  let runs = 0
  const schema = zV4.object({
    refined: zV4.string().refine(
      (v) => {
        runs += 1
        return v.length > 0
      },
      { message: 'refined-invalid' }
    ),
    sibling: zV4.string(),
  })
  return { schema, runs: () => runs }
}

function buildFlatV3() {
  let runs = 0
  const schema = zV3.object({
    refined: zV3.string().refine(
      (v) => {
        runs += 1
        return v.length > 0
      },
      { message: 'refined-invalid' }
    ),
    sibling: zV3.string(),
  })
  return { schema, runs: () => runs }
}

function buildContainerRefineV4() {
  let runs = 0
  const inner = zV4.object({
    refined: zV4.string().refine(
      (v) => {
        runs += 1
        return v.length > 0
      },
      { message: 'refined-invalid' }
    ),
    sibling: zV4.string(),
  })
  // Container refine on the root: predicate returns `true` and the
  // runtime keeps the whole-form scope so cross-field constraints
  // re-evaluate.
  const schema = inner.refine(() => true, { message: 'object-invariant' })
  return { schema, runs: () => runs }
}

function buildContainerRefineV3() {
  let runs = 0
  const inner = zV3.object({
    refined: zV3.string().refine(
      (v) => {
        runs += 1
        return v.length > 0
      },
      { message: 'refined-invalid' }
    ),
    sibling: zV3.string(),
  })
  const schema = inner.refine(() => true, { message: 'object-invariant' })
  return { schema, runs: () => runs }
}

const flatAdapters = [
  { name: 'v4', useForm: useFormV4, build: buildFlatV4 },
  { name: 'v3', useForm: useFormV3, build: buildFlatV3 },
] as const

const refineAdapters = [
  { name: 'v4', useForm: useFormV4, build: buildContainerRefineV4 },
  { name: 'v3', useForm: useFormV3, build: buildContainerRefineV3 },
] as const

describe.each(flatAdapters)(
  'per-keystroke scope — flat schema (leaf-only refine) — $name',
  ({ useForm, build }) => {
    const apps: App[] = []
    afterEach(() => {
      while (apps.length > 0) apps.pop()?.unmount()
      document.body.innerHTML = ''
    })

    it('typing into a sibling does NOT re-invoke the leaf refine on a different path', async () => {
      const { schema, runs } = build()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let api: any
      const App = defineComponent({
        setup() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          api = (useForm as any)({
            schema,
            key: 'per-keystroke-flat',
            strict: false,
            validateOn: 'change',
            debounceMs: 0,
            defaultValues: { refined: 'r', sibling: '' },
          })
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      const root = document.createElement('div')
      document.body.appendChild(root)
      app.mount(root)
      apps.push(app)
      await drainMicrotasks()
      const runsAtMount = runs()

      // Type into the sibling field. Under whole-form scope the
      // refined field's refine fires once per write; under subtree
      // scope only the sibling subtree is parsed.
      api.setValue('sibling', 's1')
      await drainMicrotasks()
      api.setValue('sibling', 's12')
      await drainMicrotasks()
      api.setValue('sibling', 's123')
      await drainMicrotasks()

      expect(runs()).toBe(runsAtMount)
    })

    it('typing into the refined field DOES re-invoke its own refine', async () => {
      const { schema, runs } = build()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let api: any
      const App = defineComponent({
        setup() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          api = (useForm as any)({
            schema,
            key: 'per-keystroke-flat-self',
            strict: false,
            validateOn: 'change',
            debounceMs: 0,
            defaultValues: { refined: 'r', sibling: '' },
          })
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      const root = document.createElement('div')
      document.body.appendChild(root)
      app.mount(root)
      apps.push(app)
      await drainMicrotasks()
      const runsAtMount = runs()

      api.setValue('refined', 'rr')
      await drainMicrotasks()

      expect(runs()).toBeGreaterThan(runsAtMount)
    })
  }
)

describe.each(refineAdapters)(
  'per-keystroke scope — container refine forces whole-form — $name',
  ({ useForm, build }) => {
    const apps: App[] = []
    afterEach(() => {
      while (apps.length > 0) apps.pop()?.unmount()
      document.body.innerHTML = ''
    })

    it('typing into a sibling DOES still re-invoke the leaf refine when a container refine is present', async () => {
      const { schema, runs } = build()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let api: any
      const App = defineComponent({
        setup() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          api = (useForm as any)({
            schema,
            key: 'per-keystroke-container',
            strict: false,
            validateOn: 'change',
            debounceMs: 0,
            defaultValues: { refined: 'r', sibling: '' },
          })
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      const root = document.createElement('div')
      document.body.appendChild(root)
      app.mount(root)
      apps.push(app)
      await drainMicrotasks()
      const runsAtMount = runs()

      // Container refine present → predicate returns `true` →
      // whole-form pass → leaf refine re-fires.
      api.setValue('sibling', 's1')
      await drainMicrotasks()

      expect(runs()).toBeGreaterThan(runsAtMount)
    })
  }
)
