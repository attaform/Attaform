// @vitest-environment jsdom
/**
 * A parent re-render leaves an in-progress `.lazy` edit on screen. Under
 * `.lazy` storage holds the last committed value while the user types, so
 * a render that paints storage into the control (the compiled `:value`
 * patch on a native input, or a component rendering its input from its
 * model) would put the old value back over the typing and move the caret.
 * The directive holds the focused control's text and caret through the
 * render, as Vue's `v-model.lazy` leaves a focused input alone, until the
 * model itself moves: a programmatic write still lands.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, ref, type App, type Component } from 'vue'
import type { UseFormReturn } from '../../src/zod'
import { useRegister } from '../../src/runtime/composables/use-register'
import { installVRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'
import { ADAPTERS, compileProduction, type Adapter } from '../utils/ssr-cross-path'

const schemaFor = (z: Adapter['z']) => z.object({ name: z.string() })
type Api = UseFormReturn<ReturnType<typeof schemaFor>>

// Renders its input straight from `modelValue`, with no state of its own.
const ControlledInput = defineComponent({
  name: 'ControlledInput',
  props: { modelValue: { type: String, default: undefined } },
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
  render: compileProduction(`<label><span>Name</span><input v-register="rv" /></label>`),
})

type Mounted = { app: App; form: Api; input: HTMLInputElement; rerender: () => Promise<void> }

const mounts: Mounted[] = []
afterEach(() => {
  for (const m of mounts.splice(0)) m.app.unmount()
  document.body.innerHTML = ''
})

// The parent shows the field's `interacted` flag, as error display gating
// does, plus a counter a test bumps to force an unrelated re-render.
async function mount(
  adapter: Adapter,
  control: string,
  components: Record<string, Component> = {}
): Promise<Mounted> {
  const handle: { form?: Api } = {}
  const tick = ref(0)
  const Parent = defineComponent({
    components,
    setup() {
      const form = adapter.useForm({
        schema: schemaFor(adapter.z),
        key: `lazy-rerender-${Math.random().toString(36).slice(2)}`,
      })
      handle.form = form
      return { form, tick }
    },
    render: compileProduction(
      `<div :data-tick="tick">${control}<span>{{ form.fields.name.interacted }}</span></div>`
    ),
  })
  const app = createApp(Parent).use(createAttaform())
  installVRegister(app)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  const input = await waitUntil(() => root.querySelector('input'))
  await awaitSettle()
  if (handle.form === undefined) throw new Error('mount: form never set')
  input.focus()
  await awaitSettle()
  const m: Mounted = {
    app,
    form: handle.form,
    input,
    rerender: async () => {
      tick.value += 1
      await awaitSettle()
    },
  }
  mounts.push(m)
  return m
}

async function typeText(el: HTMLInputElement, text: string): Promise<void> {
  for (const ch of text) {
    el.value += ch
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await awaitSettle()
  }
}

async function leave(el: HTMLInputElement): Promise<void> {
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
  await awaitSettle()
}

const CONTROLS = [
  { label: 'a native input', control: `<input v-register.lazy="form.register('name')" />` },
  {
    label: 'a useRegister wrapper',
    control: `<TextField v-register.lazy="form.register('name')" />`,
    components: { TextField },
  },
  {
    label: 'a controlled component host',
    control: `<ControlledInput v-register.lazy="form.register('name')" />`,
    components: { ControlledInput },
  },
]

describe.each(ADAPTERS)(
  '.lazy keeps an in-progress edit through a re-render [$name]',
  (adapter) => {
    describe.each(CONTROLS)('$label', ({ control, components }) => {
      it('keeps the typed text and caret through a parent re-render', async () => {
        const m = await mount(adapter, control, components)
        await typeText(m.input, 'abc')
        m.input.setSelectionRange(1, 1)
        await m.rerender()
        expect(m.input.value).toBe('abc')
        expect([m.input.selectionStart, m.input.selectionEnd]).toEqual([1, 1])
        expect(m.form.values.name).toBe('')

        await leave(m.input)
        expect(m.form.values.name).toBe('abc')
      })

      it('lets a write that moves storage replace the edit', async () => {
        const m = await mount(adapter, control, components)
        await typeText(m.input, 'abc')
        m.form.setValue('name', 'set')
        await awaitSettle()
        expect(m.input.value).toBe('set')

        await leave(m.input)
        expect(m.form.values.name).toBe('set')
      })
    })

    it("keeps a controlled host's first keystroke when it flips interacted", async () => {
      const m = await mount(
        adapter,
        `<ControlledInput v-register.lazy="form.register('name')" />`,
        { ControlledInput }
      )
      await typeText(m.input, 'a')
      expect(m.form.fields.name.interacted).toBe(true)
      expect(m.input.value).toBe('a')
    })
  }
)
