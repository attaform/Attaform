import { useForm } from '@tanstack/vue-form'
import { type App, createApp, defineComponent, h } from 'vue'
import { z } from 'zod'

/**
 * The minimal real @tanstack/vue-form form: `useForm` with the schema attached
 * as a Standard Schema `onChange` validator (its recommended setup), two fields
 * through the `form.Field` render-prop component, and `handleSubmit`. The
 * dynamic-free static schema still leaves TanStack's field generics heavy, so
 * the `Field` props and slot are cast through; the runtime calls are the real
 * ones a consumer ships.
 */
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
})

type FieldSlot = { field: { state: { value: string }; handleChange: (value: string) => void } }

const Form = defineComponent({
  name: 'TanstackBundleForm',
  setup() {
    const form = useForm({
      defaultValues: { name: '', email: '' },
      validators: { onChange: schema },
    })
    const field = (name: 'name' | 'email') =>
      h(form.Field, { name } as never, {
        default: (slot: FieldSlot) =>
          h('input', {
            value: slot.field.state.value,
            onInput: (e: Event) => slot.field.handleChange((e.target as HTMLInputElement).value),
          }),
      })
    const onSubmit = (event: Event): void => {
      event.preventDefault()
      void form.handleSubmit()
    }
    return () => h('form', { onSubmit }, [field('name'), field('email')])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form)
  app.mount(el)
  return app
}
