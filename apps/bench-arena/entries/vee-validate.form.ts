import { toTypedSchema } from '@vee-validate/zod'
import { useField, useForm } from 'vee-validate'
import { type App, createApp, defineComponent, h } from 'vue'
import { z } from 'zod'

/**
 * The minimal real vee-validate form: `useForm` over a typed Zod schema, two
 * fields through the `useField` composition API, and `handleSubmit`. This is
 * the headless composition-API shape (no `<Form>`/`<Field>` components), the
 * fastest-correct setup the keystroke dimension also drives.
 */
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
})

const Field = defineComponent({
  name: 'VeeBundleField',
  props: { name: { type: String, required: true } },
  setup(props) {
    const { value, handleChange } = useField<string>(() => props.name)
    return () =>
      h('input', {
        value: value.value,
        onInput: (e: Event) => handleChange((e.target as HTMLInputElement).value),
      })
  },
})

const Form = defineComponent({
  name: 'VeeBundleForm',
  setup() {
    const form = useForm({ validationSchema: toTypedSchema(schema) })
    const onSubmit = form.handleSubmit(() => {})
    return () => h('form', { onSubmit }, [h(Field, { name: 'name' }), h(Field, { name: 'email' })])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form)
  app.mount(el)
  return app
}
