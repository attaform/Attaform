// @vitest-environment jsdom
/**
 * Component hosts bind with native parity through the production compile
 * pipeline. Each case compiles a real parent template with the transform
 * order `attaform/vite` installs, mounts it with `installVRegister`, types
 * into the host's control the way a browser delivers keystrokes, and reads
 * form storage while typing and after focus leaves the control. Every host
 * asserts the same expectation as the native `<input>` row, on both Zod
 * adapters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App, type Component } from 'vue'
import PrimeVue from 'primevue/config'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import type { UseFormReturn } from '../../src/zod'
import { useRegister } from '../../src/runtime/composables/use-register'
import { installVRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'
import { ADAPTERS, compileProduction, type Adapter } from '../utils/ssr-cross-path'

const schemaFor = (z: Adapter['z']) => z.object({ name: z.string(), age: z.number() })
type Api = UseFormReturn<ReturnType<typeof schemaFor>>

// A div-rooted component that renders its input straight from `modelValue`
// and keeps no state of its own, so the stored value is the only value it
// can show.
const ControlledInput = defineComponent({
  name: 'ControlledInput',
  props: { modelValue: { type: [String, Number], default: undefined } },
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h('div', { class: 'controlled' }, [
        h('input', {
          value: props.modelValue ?? '',
          onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
        }),
      ]),
})

const TextField = defineComponent({
  name: 'TextField',
  setup: () => ({ rv: useRegister() }),
  render: compileProduction(
    `<label class="field"><span>Field</span><input v-register="rv" /></label>`
  ),
})

// Two element roots, so Vue drops the runtime directive and only the
// compiled value channel reaches the component.
const FragmentInput = defineComponent({
  name: 'FragmentInput',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () => [
      h('input', {
        value: props.modelValue,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      }),
      h('span', 'hint'),
    ],
})

type Mounted = {
  app: App
  form: Api
  root: HTMLElement
  /** Bumps a counter the parent template renders, forcing a parent re-render. */
  rerender: () => Promise<void>
  /** `form.values.age` as each author `@input="observe"` call read it. */
  observed: unknown[]
}

const mounts: Mounted[] = []
afterEach(() => {
  for (const m of mounts.splice(0)) m.app.unmount()
  document.body.innerHTML = ''
})

async function mount(
  adapter: Adapter,
  template: string,
  components: Record<string, Component>,
  formOptions: { coerce?: false } = {}
): Promise<Mounted> {
  const handle: { form?: Api } = {}
  const renders = ref(0)
  const observed: unknown[] = []
  const Parent = defineComponent({
    components,
    setup() {
      const form = adapter.useForm({
        schema: schemaFor(adapter.z),
        key: `host-compiled-${Math.random().toString(36).slice(2)}`,
        ...formOptions,
      })
      handle.form = form
      const observe = (): void => {
        observed.push(form.values.age)
      }
      return { form, renders, observe }
    },
    render: compileProduction(`<div :data-renders="renders">${template}</div>`),
  })
  const app = createApp(Parent).use(createAttaform()).use(PrimeVue, { unstyled: true })
  installVRegister(app)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => root.querySelector('input'))
  await awaitSettle()
  if (handle.form === undefined) throw new Error('mount: form never set')
  const m: Mounted = {
    app,
    form: handle.form,
    root,
    rerender: async () => {
      renders.value += 1
      await awaitSettle()
    },
    observed,
  }
  mounts.push(m)
  return m
}

function control(m: Mounted): HTMLInputElement {
  const found = m.root.querySelector('input')
  if (found === null) throw new Error('no input control')
  return found
}

// A keystroke the way a browser delivers it to a plain text control: the
// value grows by one character and `input` fires.
async function typeText(el: HTMLInputElement, text: string): Promise<void> {
  el.focus()
  for (const ch of text) {
    el.value += ch
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await awaitSettle()
  }
}

// PrimeVue InputNumber formats its own value: it handles `keypress` and
// prevents the browser's insertion.
async function pressKey(el: HTMLInputElement, key: string): Promise<void> {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  el.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true, cancelable: true }))
  await awaitSettle()
}

// Leaving an edited text control fires `change`, then `blur`.
async function leave(el: HTMLInputElement): Promise<void> {
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
  await awaitSettle()
}

type Host = {
  label: string
  /** The host's markup around `attrs`, its `v-register` and any listeners. */
  markup: (attrs: string) => string
  components: Record<string, Component>
}

const TEXT_HOSTS: Host[] = [
  { label: 'native <input>', markup: (a) => `<input ${a} />`, components: {} },
  { label: 'PrimeVue InputText', markup: (a) => `<InputText ${a} />`, components: { InputText } },
  {
    label: 'PrimeVue Password',
    markup: (a) => `<Password ${a} :feedback="false" />`,
    components: { Password },
  },
  {
    label: 'controlled div-rooted component',
    markup: (a) => `<ControlledInput ${a} />`,
    components: { ControlledInput },
  },
  { label: 'useRegister wrapper', markup: (a) => `<TextField ${a} />`, components: { TextField } },
]

type Row = {
  modifiers: string
  path: 'name' | 'age'
  typed: string
  whileTyping: string | number
  afterLeave: string | number
  coerce?: false
}

// The native `<input>` contract every host matches. `.number` runs with
// coercion off, so the cast comes from the modifier alone.
const ROWS: Row[] = [
  { modifiers: '', path: 'name', typed: 'ab', whileTyping: 'ab', afterLeave: 'ab' },
  { modifiers: '.trim', path: 'name', typed: '  ab ', whileTyping: '  ab ', afterLeave: 'ab' },
  { modifiers: '.lazy', path: 'name', typed: 'ab', whileTyping: '', afterLeave: 'ab' },
  {
    modifiers: '.number',
    path: 'age',
    typed: '42',
    whileTyping: 42,
    afterLeave: 42,
    coerce: false,
  },
  { modifiers: '.lazy.trim', path: 'name', typed: '  ab ', whileTyping: '', afterLeave: 'ab' },
]

// A formatting number host's native row is `<input type="number">`. Each
// host clears its control and types the way its own input handling expects.
const NUMBER_HOSTS = [
  {
    label: 'native <input type="number">',
    markup: (a: string) => `<input type="number" ${a} />`,
    components: {},
    clear: (el: HTMLInputElement) => {
      el.value = ''
    },
    type: typeText,
  },
  {
    label: 'PrimeVue InputNumber',
    markup: (a: string) => `<InputNumber ${a} />`,
    components: { InputNumber },
    clear: (el: HTMLInputElement) => {
      el.setSelectionRange(0, el.value.length)
    },
    type: pressKey,
  },
]

describe.each(ADAPTERS)('v-register component hosts match the native input [$name]', (adapter) => {
  describe.each(TEXT_HOSTS)('$label', (host) => {
    it.each(ROWS)(
      'v-register$modifiers: $whileTyping while typing, $afterLeave after leaving',
      async (row) => {
        const m = await mount(
          adapter,
          host.markup(`v-register${row.modifiers}="form.register('${row.path}')"`),
          host.components,
          row.coerce === false ? { coerce: false } : {}
        )
        const el = control(m)
        await typeText(el, row.typed)
        expect(m.form.values[row.path]).toBe(row.whileTyping)

        await leave(el)
        expect(m.form.values[row.path]).toBe(row.afterLeave)
        expect(el.value).toBe(String(row.afterLeave))
      }
    )

    it('applies register transforms to every write', async () => {
      const m = await mount(
        adapter,
        host.markup(
          `v-register="form.register('name', { transforms: [(v) => String(v).toUpperCase()] })"`
        ),
        host.components
      )
      await typeText(control(m), 'ab')
      expect(m.form.values.name).toBe('AB')
    })

    it("coerces a typed '42' into a z.number() leaf with no modifier", async () => {
      const m = await mount(
        adapter,
        host.markup(`v-register="form.register('age')"`),
        host.components
      )
      await typeText(control(m), '42')
      expect(m.form.values.age).toBe(42)
    })

    it('.lazy keeps the typed text through a parent re-render mid-edit', async () => {
      const m = await mount(
        adapter,
        host.markup(`v-register.lazy="form.register('name')"`),
        host.components
      )
      const el = control(m)
      await typeText(el, 'ab')
      await m.rerender()
      expect(el.value).toBe('ab')

      await typeText(el, 'c')
      await leave(el)
      expect(m.form.values.name).toBe('abc')
    })
  })

  describe.each(NUMBER_HOSTS)('$label', (host) => {
    async function mountAge(attrs: string): Promise<{ m: Mounted; el: HTMLInputElement }> {
      const m = await mount(adapter, host.markup(attrs), host.components)
      const el = control(m)
      el.focus()
      host.clear(el)
      return { m, el }
    }

    it('writes each typed digit as it lands', async () => {
      const { m, el } = await mountAge(`v-register="form.register('age')"`)
      await host.type(el, '4')
      expect(m.form.values.age).toBe(4)
      await host.type(el, '2')
      expect(m.form.values.age).toBe(42)

      await leave(el)
      expect(m.form.values.age).toBe(42)
      expect(el.value).toBe('42')
    })

    it('.lazy holds the typed digits until focus leaves', async () => {
      const { m, el } = await mountAge(`v-register.lazy="form.register('age')"`)
      const before = m.form.values.age
      await host.type(el, '4')
      await host.type(el, '2')
      expect(m.form.values.age).toBe(before)

      await leave(el)
      expect(m.form.values.age).toBe(42)
    })

    it('.lazy keeps the typed digits through a parent re-render mid-edit', async () => {
      const { m, el } = await mountAge(`v-register.lazy="form.register('age')"`)
      await host.type(el, '4')
      await host.type(el, '2')
      await m.rerender()
      expect(el.value).toBe('42')

      await leave(el)
      expect(m.form.values.age).toBe(42)
    })

    it('an author @input reads the committed value', async () => {
      const { m, el } = await mountAge(`v-register="form.register('age')" @input="observe"`)
      await host.type(el, '7')
      expect(m.observed).toEqual([7])
    })
  })

  it('a fragment-rooted host still binds its value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const m = await mount(adapter, `<FragmentInput v-register="form.register('name')" />`, {
        FragmentInput,
      })
      await typeText(control(m), 'ab')
      expect(m.form.values.name).toBe('ab')
    } finally {
      warn.mockRestore()
    }
  })
})
