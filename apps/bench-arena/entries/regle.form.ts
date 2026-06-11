import { useRegleSchema } from '@regle/schemas'
import { type App, createApp, defineComponent, h, reactive } from 'vue'
import { z } from 'zod'

/**
 * The minimal real Regle form (schema mode, the Zod comparison): `useRegleSchema`
 * validating a reactive state object against a Zod schema, with two fields bound
 * to their granular `$value` and a submit that runs the root validation. Regle
 * is validation-only, so the form owns its own reactive state; its deep generic
 * tree is cast to the slice this form reads.
 */
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
})

type RegleField = { $value: string; $validate: () => Promise<unknown> }
type RegleRoot = { $validate: () => Promise<unknown>; $fields: Record<string, RegleField> }

const Form = defineComponent({
  name: 'RegleBundleForm',
  setup() {
    const state = reactive({ name: '', email: '' })
    const { r$ } = useRegleSchema(state as never, schema as never) as unknown as { r$: RegleRoot }
    const field = (key: 'name' | 'email') =>
      h('input', {
        value: r$.$fields[key]?.$value,
        onInput: (e: Event) => {
          const f = r$.$fields[key]
          if (f) f.$value = (e.target as HTMLInputElement).value
        },
        onBlur: () => void r$.$fields[key]?.$validate(),
      })
    const onSubmit = (event: Event): void => {
      event.preventDefault()
      void r$.$validate()
    }
    return () => h('form', { onSubmit }, [field('name'), field('email')])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form)
  app.mount(el)
  return app
}
