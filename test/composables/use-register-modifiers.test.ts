// @vitest-environment jsdom
/**
 * The parent's `v-register` modifiers reach a `useRegister` wrapper's inner
 * control. `<TextField v-register.trim="form.register('name')" />` lands the
 * parent's binding on the wrapper's root `<label>`, which owns no value; the
 * inner `<input v-register="rv">` carries only the modifiers written inside
 * the wrapper. `useRegister` records the parent's `.lazy` / `.trim` /
 * `.number` against the RegisterValue it hands the inner control, and the
 * directive and the host write channel apply them under their own.
 *
 * Templates compile through the production transform stack, so each case
 * runs the same codegen an SFC gets. Every assertion runs on both Zod
 * adapters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App, type Component } from 'vue'
import type { UseFormReturn } from '../../src/zod'
import { useRegister } from '../../src/runtime/composables/use-register'
import { installVRegister, vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'
import { ADAPTERS, compileToRender, type Adapter } from '../utils/ssr-cross-path'

const schemaFor = (z: Adapter['z']) => z.object({ name: z.string(), age: z.number() })
type Api = UseFormReturn<ReturnType<typeof schemaFor>>

type Mounted = { app: App; form: Api; root: HTMLElement }

function compiledWrapper(
  name: string,
  template: string,
  components: Record<string, Component> = {}
) {
  return defineComponent({
    name,
    components,
    setup: () => ({ rv: useRegister() }),
    render: compileToRender(template),
  })
}

const TextField = compiledWrapper(
  'TextField',
  `<label class="field"><span>Name</span><input class="inner" v-register="rv" /></label>`
)

// The inner input is the wrapper's root, so the parent's binding and the
// inner one both land on it.
const InputRootedField = compiledWrapper(
  'InputRootedField',
  `<input class="inner" v-register="rv" />`
)

// The wrapper writes its own `.lazy`; the parent adds the rest.
const LazyTextField = compiledWrapper(
  'LazyTextField',
  `<label class="field"><span>Name</span><input class="inner" v-register.lazy="rv" /></label>`
)

const SelectField = compiledWrapper(
  'SelectField',
  `<label class="field"><span>Age</span><select class="inner" v-register="rv">` +
    `<option value="0">0</option><option value="18">18</option><option value="21">21</option>` +
    `</select></label>`
)

// A wrapper around another wrapper, writing its own `.lazy` on the way down.
const OuterField = compiledWrapper(
  'OuterField',
  `<div class="outer"><TextField v-register.lazy="rv" /></div>`,
  { TextField }
)

// A div-rooted component that commits its model on every keystroke, the
// shape most third-party inputs take.
const KeystrokeInput = defineComponent({
  name: 'KeystrokeInput',
  inheritAttrs: false,
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h('div', { class: 'host' }, [
        h('input', {
          class: 'inner',
          value: props.modelValue,
          onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
        }),
      ]),
})

const HostField = compiledWrapper(
  'HostField',
  `<label class="field"><span>Name</span><KeystrokeInput v-register="rv" /></label>`,
  { KeystrokeInput }
)

// A render-function wrapper closing over `rv`: the inner binding receives
// the useRegister proxy itself rather than the unwrapped RegisterValue.
const ProxyField = defineComponent({
  name: 'ProxyField',
  setup() {
    const rv = useRegister()
    return () =>
      h('label', { class: 'field' }, [
        withDirectives(h('input', { class: 'inner' }), [[vRegister, rv]]),
      ])
  },
})

async function mountParent(
  adapter: Adapter,
  view:
    { template: string; components: Record<string, Component> } | ((form: Api) => () => unknown),
  formOptions: { coerce?: false } = {}
): Promise<Mounted> {
  const handle: { form?: Api } = {}
  const Parent = defineComponent({
    components: typeof view === 'function' ? {} : view.components,
    setup() {
      const form = adapter.useForm({
        schema: schemaFor(adapter.z),
        key: `wrapper-modifiers-${Math.random().toString(36).slice(2)}`,
        ...formOptions,
      })
      handle.form = form
      return typeof view === 'function' ? view(form) : { form }
    },
    ...(typeof view === 'function' ? {} : { render: compileToRender(view.template) }),
  })
  const app = createApp(Parent).use(createAttaform())
  installVRegister(app)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (root.querySelector('.inner') !== null ? true : null))
  await awaitSettle()
  if (handle.form === undefined) throw new Error('mountParent: form never set')
  return { app, form: handle.form, root }
}

function inner<T extends HTMLElement>(m: Mounted): T {
  const found = m.root.querySelector<T>('.inner')
  if (found === null) throw new Error('no .inner control')
  return found
}

function typeInto(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function commitChange(el: HTMLElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe.each(ADAPTERS)(
  'useRegister wrapper: the parent binding modifiers reach the inner control [$name]',
  (adapter) => {
    let m: Mounted | undefined
    afterEach(() => {
      m?.app.unmount()
      m = undefined
      document.body.innerHTML = ''
    })

    it('without parent modifiers the inner input writes the raw value', async () => {
      m = await mountParent(adapter, {
        template: `<TextField v-register="form.register('name')" />`,
        components: { TextField },
      })
      typeInto(inner(m), '  ada  ')
      commitChange(inner(m))
      expect(m.form.values.name).toBe('  ada  ')
    })

    it('.trim writes the raw keystroke and commits the trimmed value on change', async () => {
      m = await mountParent(adapter, {
        template: `<TextField v-register.trim="form.register('name')" />`,
        components: { TextField },
      })
      typeInto(inner(m), '  ada  ')
      expect(m.form.values.name).toBe('  ada  ')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })

    it('.lazy holds the keystrokes until the inner input commits', async () => {
      m = await mountParent(adapter, {
        template: `<TextField v-register.lazy="form.register('name')" />`,
        components: { TextField },
      })
      typeInto(inner(m), 'ada')
      expect(m.form.values.name).toBe('')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })

    it('.lazy holds the keystrokes when the inner input is the wrapper root', async () => {
      m = await mountParent(adapter, {
        template: `<InputRootedField v-register.lazy="form.register('name')" />`,
        components: { InputRootedField },
      })
      typeInto(inner(m), 'ada')
      expect(m.form.values.name).toBe('')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })

    it('.lazy.trim commits the trimmed value on change', async () => {
      m = await mountParent(adapter, {
        template: `<TextField v-register.lazy.trim="form.register('name')" />`,
        components: { TextField },
      })
      typeInto(inner(m), '  ada  ')
      expect(m.form.values.name).toBe('')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })

    it('.number casts the inner text input, with coercion off', async () => {
      m = await mountParent(
        adapter,
        {
          template: `<TextField v-register.number="form.register('age')" />`,
          components: { TextField },
        },
        { coerce: false }
      )
      typeInto(inner(m), '42')
      expect(m.form.values.age).toBe(42)
    })

    it('.number reaches a select wrapper, with coercion off', async () => {
      m = await mountParent(
        adapter,
        {
          template: `<SelectField v-register.number="form.register('age')" />`,
          components: { SelectField },
        },
        { coerce: false }
      )
      const select = inner<HTMLSelectElement>(m)
      select.value = '21'
      commitChange(select)
      expect(m.form.values.age).toBe(21)
    })

    it("combines the parent's modifiers with the inner binding's own", async () => {
      m = await mountParent(adapter, {
        template: `<LazyTextField v-register.trim="form.register('name')" />`,
        components: { LazyTextField },
      })
      typeInto(inner(m), '  ada  ')
      expect(m.form.values.name).toBe('')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })

    it("combines the outer parent's modifiers with a nested wrapper's own", async () => {
      m = await mountParent(adapter, {
        template: `<OuterField v-register.trim="form.register('name')" />`,
        components: { OuterField },
      })
      typeInto(inner(m), '  ada  ')
      expect(m.form.values.name).toBe('')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })

    it("buffers a component host's emits inside a wrapper on the parent's .lazy", async () => {
      m = await mountParent(adapter, {
        template: `<HostField v-register.lazy="form.register('name')" />`,
        components: { HostField },
      })
      const control = inner<HTMLInputElement>(m)
      control.dispatchEvent(new FocusEvent('focus'))
      typeInto(control, 'ada')
      expect(m.form.values.name).toBe('')

      control.dispatchEvent(new FocusEvent('blur', { relatedTarget: document.body }))
      expect(m.form.values.name).toBe('ada')
    })

    it('forwards the modifiers on the bare withDirectives path to a proxy-bound inner input', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        m = await mountParent(adapter, (form) => () => {
          const rv = form.register('name')
          return withDirectives(h(ProxyField), [[vRegister, rv, '', { trim: true }]])
        })
      } finally {
        warn.mockRestore()
      }
      typeInto(inner(m), '  ada  ')
      expect(m.form.values.name).toBe('  ada  ')

      commitChange(inner(m))
      expect(m.form.values.name).toBe('ada')
    })
  }
)
