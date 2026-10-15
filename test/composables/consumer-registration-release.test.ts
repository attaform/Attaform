// @vitest-environment jsdom
/**
 * A form API built over a shared store releases what it registered on
 * that store when the effect scope it was built in disposes (#690).
 *
 * Every API registers its per-path caches with the store's liveness
 * sweep, and its values surface with the store's `onFormChange`. The
 * store outlives the API whenever another consumer shares the form,
 * which is every `injectForm()` and every remount of a keyed `useForm`,
 * and nothing released those registrations. Each one pinned its API's
 * caches for the life of the form: every field state it built, and
 * through `element`, the input it bound. A page of 38 fields, each
 * reaching the form through `injectForm()` and binding an input with
 * `v-register`, visited 60 times on the unfixed tree:
 *
 * |                                | unfixed  | fixed |
 * | ------------------------------ | -------- | ----- |
 * | heap retained per visit        | 1,703 KB | noise |
 * | APIs still reachable           | 2,318    | 0     |
 * | inputs still reachable         | 2,318    | 0     |
 * | store `onFormChange` listeners | 2,320    | 2     |
 *
 * The count pins are exact and need no collector. The retention pins
 * prove the consequence the issue reported, behind a control run. The
 * sibling pin holds the other side of the line: releasing one consumer
 * leaves every other consumer of the store subscribed, and an API that
 * something still holds after its release keeps reading and writing
 * correctly. Consumers under the same ancestor `useForm` share one API
 * (`inject-form-shared-api.test.ts`), so that pin puts its two consumers
 * under different ancestors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  effectScope,
  h,
  nextTick,
  ref,
  withDirectives,
  type App,
  type Component,
  type EffectScope,
  type Ref,
  type VNodeChild,
} from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { injectForm } from '../../src/runtime/composables/use-form-context'
import type { FormStore } from '../../src/runtime/core/create-form-store'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegistry } from '../../src/runtime/core/registry'
import type { GenericForm } from '../../src/runtime/types/types-core'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'

const hasGc = typeof globalThis.gc === 'function'

const KEY = 'application'
const PATHS = ['name', 'email', 'city'] as const
type FieldPath = (typeof PATHS)[number]
type Shape = Record<FieldPath, string>
type Api = NonNullable<ReturnType<typeof injectForm<Shape>>>

const schemaV3 = zV3.object({ name: zV3.string(), email: zV3.string(), city: zV3.string() })
const schemaV4 = zV4.object({ name: zV4.string(), email: zV4.string(), city: zV4.string() })

const adapters = [
  {
    name: 'zod v3',
    provideForm: () => useFormV3({ schema: schemaV3, key: KEY }),
    provideOtherForm: () => useFormV3({ schema: schemaV3, key: 'other' }),
  },
  {
    name: 'zod v4',
    provideForm: () => useFormV4({ schema: schemaV4, key: KEY }),
    provideOtherForm: () => useFormV4({ schema: schemaV4, key: 'other' }),
  },
] as const

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

/**
 * Mount a root that owns the form under `KEY` for the whole test and
 * renders `child` beneath it. Returns the store, which every consumer
 * below the root shares.
 */
function mount(provideForm: () => unknown, child: () => VNodeChild): FormStore<GenericForm> {
  let store: FormStore<GenericForm> | undefined
  const Root = defineComponent({
    setup() {
      provideForm()
      store = useRegistry().forms.get(KEY)
      return () => h('main', [child()])
    },
  })
  const app = createApp(Root)
  app.use(createAttaform())
  app.mount(document.body.appendChild(document.createElement('div')))
  apps.push(app)
  return defined(store)
}

/**
 * Count the registrations consumers hold on `store` from here on. Each
 * `onFormChange` listener and each sweep evictor adds one, and running
 * the release it returned removes it. The root's own `useForm` built
 * its API before this was installed, so it is not counted.
 */
function countRegistrations(store: FormStore<GenericForm>): () => number {
  let live = 0
  const counted =
    <A>(subscribe: (arg: A) => () => void) =>
    (arg: A): (() => void) => {
      live += 1
      const release = subscribe(arg)
      let released = false
      return () => {
        if (!released) live -= 1
        released = true
        release()
      }
    }
  const onFormChange = store.onFormChange.bind(store)
  const onEvict = store.pathSweep.onEvict
  vi.spyOn(store, 'onFormChange').mockImplementation(counted(onFormChange))
  vi.spyOn(store.pathSweep, 'onEvict').mockImplementation(counted(onEvict))
  return () => live
}

/** What the field components built, held weakly so the test itself retains none of it. */
type Built = { apis: WeakRef<Api>[]; inputs: WeakRef<HTMLInputElement>[] }

/**
 * A template ref that records the input it lands on, once. Vue calls a
 * function ref again on every patch of its element, so one built per
 * component would otherwise record the same input per render.
 */
function inputRef(built: Built | undefined) {
  let recorded = false
  return (el: unknown): void => {
    if (recorded || !(el instanceof HTMLInputElement)) return
    recorded = true
    built?.inputs.push(new WeakRef(el))
  }
}

/**
 * A field component written the way a form page writes one: it reaches
 * the form through `injectForm`, reads its own state and errors, and
 * binds an input with `v-register`.
 */
function fieldFor(path: FieldPath, built?: Built): Component {
  return defineComponent({
    setup() {
      const form = injectForm<Shape>(KEY)
      if (form === null) return () => null
      built?.apis.push(new WeakRef(form))
      const binding = form.register(path)
      const onInput = inputRef(built)
      return () =>
        h('label', [
          `${form.fields[path].value} ${form.errors[path].length} ${form.values()[path]}`,
          withDirectives(h('input', { ref: onInput }), [[vRegister, binding]]),
        ])
    },
  })
}

/** The control for `fieldFor`: the same markup, never reaching the form. */
function plainFieldFor(path: FieldPath, built: Built): Component {
  return defineComponent({
    setup() {
      const onInput = inputRef(built)
      return () => h('label', [path, h('input', { ref: onInput })])
    },
  })
}

function pageOf(fields: Component[]): Component {
  return defineComponent({
    setup: () => () =>
      h(
        'div',
        fields.map((field) => h(field))
      ),
  })
}

/** Mount and unmount whatever `show` gates, `times` over. */
async function visit(show: Ref<boolean>, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    show.value = true
    await nextTick()
    show.value = false
    await nextTick()
  }
}

/** Force collection hard enough for a WeakRef to clear. */
async function collect(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    globalThis.gc?.()
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

const reachable = (refs: WeakRef<object>[]): number =>
  refs.filter((entry) => entry.deref() !== undefined).length

describe.each(adapters)(
  '$name: consumers of a shared store',
  ({ provideForm, provideOtherForm }) => {
    it('an injectForm consumer releases every registration when it unmounts', async () => {
      const show = ref(false)
      const Page = pageOf(PATHS.map((path) => fieldFor(path)))
      const store = mount(provideForm, () => (show.value ? h(Page) : null))
      const live = countRegistrations(store)

      show.value = true
      await nextTick()
      expect(live()).toBeGreaterThan(0)
      show.value = false
      await nextTick()
      expect(live()).toBe(0)

      await visit(show, 5)
      expect(live()).toBe(0)
    })

    it("a keyed useForm's remount releases the previous mount's registrations", async () => {
      const show = ref(false)
      const Sidebar = defineComponent({
        setup() {
          provideForm()
          return () => h('aside')
        },
      })
      const store = mount(provideForm, () => (show.value ? h(Sidebar) : null))
      const live = countRegistrations(store)

      show.value = true
      await nextTick()
      expect(live()).toBeGreaterThan(0)
      show.value = false
      await nextTick()
      expect(live()).toBe(0)

      await visit(show, 5)
      expect(live()).toBe(0)
    })

    it('releases with the effect scope the API was built in, ahead of its component', async () => {
      let scope: EffectScope | undefined
      const Panel = defineComponent({
        setup() {
          scope = effectScope()
          scope.run(() => injectForm<Shape>(KEY))
          return () => h('section')
        },
      })
      const show = ref(false)
      const store = mount(provideForm, () => (show.value ? h(Panel) : null))
      const live = countRegistrations(store)

      show.value = true
      await nextTick()
      expect(live()).toBeGreaterThan(0)
      defined(scope).stop()
      expect(live()).toBe(0)
      expect(document.querySelector('section')).not.toBeNull()
    })

    it('releasing one consumer leaves a sibling subscribed, and a held API correct', async () => {
      const consumers: { held?: Api | null; sibling?: Api | null } = {}
      const HeldForm = defineComponent({
        setup() {
          consumers.held = injectForm<Shape>(KEY)
          return () => h('p', consumers.held?.fields.name.value)
        },
      })
      // A `useForm` of its own above the held consumer gives it a different
      // instance id from the sibling's, so the two hold separate APIs.
      const Held = defineComponent({
        setup() {
          provideOtherForm()
          return () => h(HeldForm)
        },
      })
      const Sibling = defineComponent({
        setup() {
          consumers.sibling = injectForm<Shape>(KEY)
          return () => h('p', { class: 'sibling' }, consumers.sibling?.fields.name.value)
        },
      })
      const showHeld = ref(false)
      const showSibling = ref(false)
      const store = mount(provideForm, () => [
        showSibling.value ? h(Sibling) : null,
        showHeld.value ? h(Held) : null,
      ])
      const live = countRegistrations(store)

      showSibling.value = true
      await nextTick()
      const siblingOnly = live()
      showHeld.value = true
      await nextTick()
      expect(live()).toBeGreaterThan(siblingOnly)
      showHeld.value = false
      await nextTick()
      expect(live()).toBe(siblingOnly)

      const held = defined(consumers.held)
      const sibling = defined(consumers.sibling)
      expect(held).not.toBe(sibling)

      // The sibling still reacts to a write, whichever API makes it.
      held.setValue('name', 'Ada')
      await nextTick()
      expect(sibling.fields.name.value).toBe('Ada')
      expect(document.querySelector('.sibling')?.textContent).toBe('Ada')

      // The released API still reads the live form, through every surface.
      sibling.setValue('email', 'ada@example.com')
      expect(held.values().email).toBe('ada@example.com')
      expect(held.fields.email.value).toBe('ada@example.com')
      expect(held.errors.email).toEqual([])
    })

    describe.skipIf(!hasGc)('retention', () => {
      const VISITS = 10

      async function visitPage(fields: (built: Built) => Component[]): Promise<Built> {
        const built: Built = { apis: [], inputs: [] }
        const show = ref(false)
        const Page = pageOf(fields(built))
        mount(provideForm, () => (show.value ? h(Page) : null))
        await visit(show, VISITS)
        await collect()
        return built
      }

      it('leaves no input of a page that never reaches the form reachable (control)', async () => {
        // Proves the harness reports zero for the right reason before the
        // run below reports zero for the fixed one.
        const built = await visitPage((b) => PATHS.map((path) => plainFieldFor(path, b)))
        expect(built.inputs.length).toBe(PATHS.length * VISITS)
        expect(reachable(built.inputs)).toBe(0)
      })

      it('leaves no API or bound input of an injectForm page reachable after it unmounts', async () => {
        const built = await visitPage((b) => PATHS.map((path) => fieldFor(path, b)))
        expect(built.apis.length).toBe(PATHS.length * VISITS)
        expect(built.inputs.length).toBe(PATHS.length * VISITS)
        expect(reachable(built.apis)).toBe(0)
        expect(reachable(built.inputs)).toBe(0)
      })
    })
  }
)
