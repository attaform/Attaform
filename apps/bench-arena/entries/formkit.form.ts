import { FormKit, defaultConfig, plugin } from '@formkit/vue'
import { createZodPlugin } from '@formkit/zod'
import { type App, type Component, createApp, defineComponent, h } from 'vue'
import { z } from 'zod'

/**
 * The minimal real FormKit form, the batteries-included entry: FormKit renders
 * its own inputs, so this weighs its component runtime plus the default config
 * and the Zod plugin, the cost a consumer pays to ship a FormKit form. FormKit
 * accepts attributes its typed surface does not enumerate, so it is bound
 * through a loose Component, exactly as the adapter does.
 */
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
})

const FormKitC = FormKit as unknown as Component

const Form = defineComponent({
  name: 'FormKitBundleForm',
  setup() {
    const [zodPlugin, submitHandler] = createZodPlugin(schema as never, () => {})
    return () =>
      h(FormKitC, { type: 'form', plugins: [zodPlugin], onSubmit: submitHandler }, () => [
        h(FormKitC, { type: 'text', name: 'name' }),
        h(FormKitC, { type: 'email', name: 'email' }),
      ])
  },
})

export function mount(el: HTMLElement): App {
  const app = createApp(Form).use(plugin, defaultConfig())
  app.mount(el)
  return app
}
