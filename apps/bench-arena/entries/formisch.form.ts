import { useField, useForm } from '@formisch/vue'
import { type App, createApp, defineComponent, h } from 'vue'
import { email, minLength, object, pipe, string } from 'valibot'

/**
 * The minimal real @formisch/vue form: `useForm` over a valibot schema (the
 * validator formisch is built on) and two fields through the `useField`
 * composable. formisch's functional generics collapse under introspection, so
 * the store and field handles are cast through; the runtime calls are the real
 * ones a consumer ships.
 */
const schema = object({
  name: pipe(string(), minLength(2)),
  email: pipe(string(), email()),
})

type FormStore = object
type FieldHandle = { input: string; props: { onBlur: (event?: FocusEvent) => void } }

const Field = defineComponent({
  name: 'FormischBundleField',
  props: {
    form: { type: Object, required: true },
    name: { type: String, required: true },
  },
  setup(props) {
    const field = useField(
      props.form as never,
      { path: [props.name] } as never
    ) as unknown as FieldHandle
    return () =>
      h('input', {
        value: field.input,
        onInput: (e: Event) => {
          field.input = (e.target as HTMLInputElement).value
        },
        onBlur: () => field.props.onBlur(),
      })
  },
})

const Form = defineComponent({
  name: 'FormischBundleForm',
  setup() {
    const form = useForm({ schema, initialInput: { name: '', email: '' } } as never) as FormStore
    return () => h('form', [h(Field, { form, name: 'name' }), h(Field, { form, name: 'email' })])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form)
  app.mount(el)
  return app
}
