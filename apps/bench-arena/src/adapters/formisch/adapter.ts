import { useForm, validate } from '@formisch/vue'
import { type App, createApp, defineComponent, h } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, valibotSchemaFor } from '../../shared/scenarios'
import type { BenchAdapter, MountHandle } from '../contract'
import Field from './Field.vue'

/**
 * formisch is a functional, valibot-native form store. The dynamic valibot
 * schema collapses its generics, so `useForm` / `validate` are called through
 * loose signatures; the runtime calls are the real ones. `validate(form)` runs
 * the whole-schema parse, which is formisch's only public validation entry, so
 * single-field validation maps to the same full-form pass (noted as such).
 */
type FormStoreLoose = object
type UseFormLoose = (config: {
  schema: unknown
  initialInput: Record<string, unknown>
  validate: string
  revalidate: string
}) => FormStoreLoose
const useFormLoose = useForm as unknown as UseFormLoose
const validateForm = validate as unknown as (form: FormStoreLoose) => Promise<unknown>

let mountSeq = 0

const unsupported = (op: string): never => {
  throw new Error(`bench: formisch adapter does not drive "${op}" in this scenario`)
}

export const formischAdapter: BenchAdapter = {
  meta: {
    id: 'formisch',
    displayName: '@formisch/vue',
    layer: 'headless-form-state',
    schemaLib: 'valibot',
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
    const schema = valibotSchemaFor(opts.scenario, opts.params)
    // Validate on the trigger under test; revalidate on the same event so a
    // dirtied field keeps re-checking as the cohort does.
    const mode = opts.trigger === 'blur' ? 'blur' : 'input'
    mountSeq += 1

    let form: FormStoreLoose | undefined

    const Host = defineComponent({
      name: 'FormischHost',
      setup() {
        const f = useFormLoose({
          schema,
          initialInput: { ...shape.defaultValues },
          validate: mode,
          revalidate: mode,
        })
        form = f
        return () =>
          h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, { key: index, form: f, path, index, trigger: opts.trigger })
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
        if (form) await validateForm(form)
        await flush()
      },
      // formisch exposes only whole-form validation; single-field maps to it.
      async validateField() {
        if (form) await validateForm(form)
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
