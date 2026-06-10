import { useForm } from '@tanstack/vue-form'
import { type App, createApp, defineComponent, h } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { BenchAdapter, MountHandle } from '../contract'
import Field from './Field.vue'
import type { TanstackForm } from './types'

/**
 * The dynamic schema erases TanStack's form generics, so the call is made
 * through a loose signature; the runtime config is exactly what the typed API
 * resolves to. The schema rides along as a Standard Schema validator (zod v3
 * implements the spec), which is TanStack's recommended whole-form setup.
 */
type UseFormLoose = (opts: {
  defaultValues: Record<string, unknown>
  validators: Record<string, unknown>
}) => TanstackForm
const useFormLoose = useForm as unknown as UseFormLoose

let mountSeq = 0

const unsupported = (op: string): never => {
  throw new Error(`bench: tanstack adapter does not drive "${op}" in this scenario`)
}

export const tanstackAdapter: BenchAdapter = {
  meta: {
    id: 'tanstack',
    displayName: '@tanstack/vue-form',
    layer: 'headless-form-state',
    schemaLib: 'zod3',
    ownsInputs: false,
    capabilities: {
      flat: 'native',
      nested: 'native',
      arrays: 'native',
      grid: 'native',
      'discriminated-union': 'hand-rolled',
      massive: 'native',
      wizard: 'hand-rolled',
    },
  },

  async mount(container, opts): Promise<MountHandle> {
    const shape = shapeFor(opts.scenario, opts.params)
    const schema = zodSchemaFor(opts.scenario, opts.params)
    // Validate on the trigger under test: onChange for the input pass (a
    // keystroke does validation work), onBlur for the blur pass.
    const validators = opts.trigger === 'blur' ? { onBlur: schema } : { onChange: schema }
    mountSeq += 1

    let form: TanstackForm | undefined

    const Host = defineComponent({
      name: 'TanstackHost',
      setup() {
        const f = useFormLoose({ defaultValues: { ...shape.defaultValues }, validators })
        form = f
        return () =>
          h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, { key: index, form: f, name: path, index, trigger: opts.trigger })
            )
          )
      },
    })

    const app: App = createApp(Host)
    app.mount(container)
    await flush()

    const driver = domDriver(container, opts.trigger)

    return {
      typeChar: driver.typeChar,
      setFieldValue: driver.setFieldValue,
      async validateAll() {
        await form?.validateAllFields('change')
        await flush()
      },
      async validateField(index) {
        await form?.validateField(shape.paths[index] ?? '', 'change')
        await flush()
      },
      arrayOp: () => Promise.resolve(unsupported('arrayOp')),
      flipVariant: () => Promise.resolve(unsupported('flipVariant')),
      stepTransition: () => Promise.resolve(unsupported('stepTransition')),
      getRenderCount: () => totalRenders(),
      resetRenderCount: () => resetRenderCounts(),
      teardown: () => app.unmount(),
    }
  },
}
