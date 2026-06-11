import { useVuelidate } from '@vuelidate/core'
import { email, minLength, required } from '@vuelidate/validators'
import { type App, createApp, defineComponent, h, reactive } from 'vue'

/**
 * The minimal real Vuelidate form: model-based native validators (`required`,
 * `minLength`, `email`) over a reactive state object, with `useVuelidate`
 * deriving the validation tree and a submit that runs `$validate`. Vuelidate
 * ships no schema mode, so this weighs its core plus the native validators, the
 * honest cost of its idiomatic form. The validation tree is cast to the slice
 * this form reads.
 */
const Form = defineComponent({
  name: 'VuelidateBundleForm',
  setup() {
    const state = reactive({ name: '', email: '' })
    const rules = {
      name: { required, minLength: minLength(2) },
      email: { required, email },
    }
    const v$ = useVuelidate(rules, state) as unknown as {
      value: { $validate: () => Promise<boolean> } & Record<string, { $touch: () => void }>
    }
    const field = (key: 'name' | 'email') =>
      h('input', {
        value: state[key],
        onInput: (e: Event) => {
          state[key] = (e.target as HTMLInputElement).value
        },
        onBlur: () => v$.value[key]?.$touch(),
      })
    const onSubmit = (event: Event): void => {
      event.preventDefault()
      void v$.value.$validate()
    }
    return () => h('form', { onSubmit }, [field('name'), field('email')])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form)
  app.mount(el)
  return app
}
