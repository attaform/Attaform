// @vitest-environment jsdom
/**
 * `injectForm` calls that resolve the same store under the same ancestor
 * `useForm` share one form API.
 *
 * Each such call inherits the ancestor's `formInstanceId` and passes no
 * per-call options, so each would build an identical API: its own field
 * caches, and its own registrations on the store. A page of fields that
 * each call `injectForm` built one API per field, about 16 KB each while
 * mounted. They now share one, built in a scope of its own and counted
 * by the effect scopes holding it, and its registrations go when the
 * last of those scopes disposes (#690).
 *
 * Registrations are counted exactly, by wrapping the store's
 * `onFormChange` and `pathSweep.onEvict`, as in
 * `consumer-registration-release.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  effectScope,
  h,
  nextTick,
  ref,
  type App,
  type Component,
  type EffectScope,
  type VNodeChild,
} from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { injectForm } from '../../src/runtime/composables/use-form-context'
import type { FormStore } from '../../src/runtime/core/create-form-store'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegistry } from '../../src/runtime/core/registry'
import type { GenericForm } from '../../src/runtime/types/types-core'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'

const KEY = 'application'
type Shape = { name: string; email: string }
type Api = NonNullable<ReturnType<typeof injectForm<Shape>>>

const schemaV3 = zV3.object({ name: zV3.string(), email: zV3.string() })
const schemaV4 = zV4.object({ name: zV4.string(), email: zV4.string() })

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

function mountApp(root: Component): void {
  const app = createApp(root)
  app.use(createAttaform())
  app.mount(document.body.appendChild(document.createElement('div')))
  apps.push(app)
}

/**
 * Mount a root that owns the form under `KEY` and renders `child` beneath
 * it, so every consumer below inherits the root's instance id. Returns
 * the store.
 */
function mount(provideForm: () => unknown, child: () => VNodeChild): FormStore<GenericForm> {
  let store: FormStore<GenericForm> | undefined
  mountApp(
    defineComponent({
      setup() {
        provideForm()
        store = useRegistry().forms.get(KEY)
        return () => h('main', [child()])
      },
    })
  )
  return defined(store)
}

/** Live registrations on `store` from here on: each subscribe adds one, each release removes it. */
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

/** A field component that reaches the form through `injectForm`, records the API, and renders its value. */
function fieldInto(apis: Api[], className = 'field'): Component {
  return defineComponent({
    setup() {
      const form = injectForm<Shape>(KEY)
      if (form !== null) apis.push(form)
      return () => h('p', { class: className }, form?.fields.name.value)
    },
  })
}

describe.each(adapters)(
  '$name: injectForm under one ancestor',
  ({ provideForm, provideOtherForm }) => {
    it('every consumer gets the same form object, and the store holds one set of registrations', async () => {
      const one: Api[] = []
      const three: Api[] = []
      const showOne = ref(false)
      const showThree = ref(false)
      const OneField = fieldInto(one)
      const ThreeFields = [fieldInto(three), fieldInto(three), fieldInto(three)]
      const store = mount(provideForm, () => [
        showOne.value ? h(OneField) : null,
        ...(showThree.value ? ThreeFields.map((field) => h(field)) : []),
      ])
      const live = countRegistrations(store)

      showOne.value = true
      await nextTick()
      const oneConsumer = live()
      expect(oneConsumer).toBeGreaterThan(0)
      showOne.value = false
      await nextTick()
      expect(live()).toBe(0)

      showThree.value = true
      await nextTick()
      expect(three).toHaveLength(3)
      expect(new Set(three).size).toBe(1)
      expect(live()).toBe(oneConsumer)
    })

    it('the shared form stays subscribed until its last consumer unmounts', async () => {
      const apis: Api[] = []
      const showFirst = ref(false)
      const showSecond = ref(false)
      const First = fieldInto(apis, 'first')
      const Second = fieldInto(apis, 'second')
      const store = mount(provideForm, () => [
        showFirst.value ? h(First) : null,
        showSecond.value ? h(Second) : null,
      ])
      const live = countRegistrations(store)
      showFirst.value = true
      showSecond.value = true
      await nextTick()
      const form = defined(apis[0])
      expect(apis[1]).toBe(form)
      const shared = live()
      expect(shared).toBeGreaterThan(0)

      showFirst.value = false
      await nextTick()
      expect(live()).toBe(shared)
      form.setValue('name', 'Ada')
      await nextTick()
      expect(form.fields.name.value).toBe('Ada')
      expect(document.querySelector('.second')?.textContent).toBe('Ada')

      showSecond.value = false
      await nextTick()
      expect(live()).toBe(0)
    })

    it('consumers under different ancestors get their own form objects', async () => {
      const apis: Api[] = []
      const Direct = fieldInto(apis)
      const UnderOther = defineComponent({
        setup() {
          provideOtherForm()
          return () => h(fieldInto(apis))
        },
      })
      mount(provideForm, () => [h(Direct), h(UnderOther)])
      await nextTick()

      expect(apis).toHaveLength(2)
      expect(apis[0]).not.toBe(apis[1])
    })

    it('a consumer with no ancestor useForm gets a form object of its own', async () => {
      const apis: Api[] = []
      // The owner registers the form before its later siblings run setup,
      // and none of them sits below it, so none inherits an instance id.
      const Owner = defineComponent({
        setup() {
          provideForm()
          return () => null
        },
      })
      const First = fieldInto(apis)
      const Second = fieldInto(apis)
      mountApp(defineComponent({ setup: () => () => [h(Owner), h(First), h(Second)] }))
      await nextTick()

      expect(apis).toHaveLength(2)
      expect(apis[0]).not.toBe(apis[1])
    })

    it('mounting again after every consumer unmounted builds a new form object', async () => {
      const apis: Api[] = []
      const show = ref(true)
      const Field = fieldInto(apis)
      const store = mount(provideForm, () => (show.value ? h(Field) : null))
      const live = countRegistrations(store)

      show.value = false
      await nextTick()
      show.value = true
      await nextTick()
      expect(apis).toHaveLength(2)
      expect(apis[1]).not.toBe(apis[0])
      expect(live()).toBeGreaterThan(0)

      show.value = false
      await nextTick()
      expect(live()).toBe(0)
    })

    it("a consumer's own effect scope holds its share", async () => {
      let scope: EffectScope | undefined
      const scoped: Api[] = []
      const apis: Api[] = []
      const Panel = defineComponent({
        setup() {
          scope = effectScope()
          scope.run(() => {
            const form = injectForm<Shape>(KEY)
            if (form !== null) scoped.push(form)
          })
          return () => h('section')
        },
      })
      const showPanel = ref(false)
      const showField = ref(false)
      const Field = fieldInto(apis)
      const store = mount(provideForm, () => [
        showPanel.value ? h(Panel) : null,
        showField.value ? h(Field) : null,
      ])
      const live = countRegistrations(store)
      showPanel.value = true
      showField.value = true
      await nextTick()
      const form = defined(apis[0])
      expect(scoped[0]).toBe(form)
      const shared = live()
      expect(shared).toBeGreaterThan(0)

      defined(scope).stop()
      expect(live()).toBe(shared)

      showField.value = false
      await nextTick()
      expect(live()).toBe(0)
    })
  }
)
