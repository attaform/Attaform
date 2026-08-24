import { useForm } from 'attaform/zod-v3'
import { type App, createApp, defineComponent, h } from 'vue'
import { z } from 'zod'

/**
 * The minimal real Attaform form weighed by the bundle dimension: a Zod schema,
 * `useForm`, two registered fields, and a submit handler. No plugin install:
 * `useForm` lazy-installs the registry on first use, which is the shipping
 * default setup (installing the package and calling `useForm` is the whole
 * story; `createAttaform()` exists for app-wide options). The opt-in layers
 * (`v-register`, `attaform/history`, `useWizard`) are separate entries this
 * form never imports, so they are not in the weighed graph. Every cohort entry
 * is this same two-field form in its own idiomatic API, so esbuild (Vue
 * external) weighs like against like.
 */
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
})

/**
 * `useForm`'s schema generic derives the static `FlatPath` set; calling it
 * through a loose signature erases that derivation while leaving the runtime
 * call identical (the path the typed API resolves to). It also side-steps the
 * monorepo-only type skew where Attaform's published `.d.ts` resolves the repo
 * root's zod (v4) while this entry imports the arena's zod (v3); a real
 * single-zod consumer never sees it. The adapters take the same loose route.
 */
type RegisterBinding = { displayValue: { value: string } }
type BundleForm = {
  register: (path: string) => RegisterBinding
  setValue: (path: string, value: string) => void
  handleSubmit: (onValid: (values: unknown) => void) => (event?: Event) => Promise<void>
}
const useFormLoose = useForm as unknown as (config: { schema: unknown }) => BundleForm

const Form = defineComponent({
  name: 'AttaformBundleForm',
  setup() {
    const form = useFormLoose({ schema })
    const onSubmit = form.handleSubmit(() => {})
    const name = form.register('name')
    const email = form.register('email')
    const write = (path: 'name' | 'email', event: Event): void => {
      form.setValue(path, (event.target as HTMLInputElement).value)
    }
    return () =>
      h('form', { onSubmit }, [
        h('input', { value: name.displayValue.value, onInput: (e: Event) => write('name', e) }),
        h('input', { value: email.displayValue.value, onInput: (e: Event) => write('email', e) }),
      ])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form)
  app.mount(el)
  return app
}
