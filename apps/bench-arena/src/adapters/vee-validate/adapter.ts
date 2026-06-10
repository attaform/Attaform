import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { type App, createApp, defineComponent, h } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { BenchAdapter, MountHandle } from '../contract'
import Field from './Field.vue'

/** The slice of vee-validate's form context the adapter drives. */
interface VeeForm {
  validate: () => Promise<unknown>
  validateField: (path: string) => Promise<unknown>
}

let mountSeq = 0

const unsupported = (op: string): never => {
  throw new Error(`bench: vee-validate adapter does not drive "${op}" in this scenario`)
}

export const veeValidateAdapter: BenchAdapter = {
  meta: {
    id: 'vee-validate',
    displayName: 'vee-validate',
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
    mountSeq += 1

    let form: VeeForm | undefined

    const Host = defineComponent({
      name: 'VeeValidateHost',
      setup() {
        // useForm provides the field context useField injects in each child.
        const f = useForm({
          validationSchema: toTypedSchema(schema),
          initialValues: shape.defaultValues as Record<string, unknown>,
        })
        form = f as unknown as VeeForm
        return () =>
          h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, { key: index, name: path, index, trigger: opts.trigger })
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
        await form?.validate()
        await flush()
      },
      async validateField(index) {
        await form?.validateField(shape.paths[index] ?? '')
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
