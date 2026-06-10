import { createAttaform } from 'attaform'
import { useForm } from 'attaform/zod-v3'
import { type App, createApp, defineComponent, h } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { ArrayOp, BenchAdapter, MountHandle } from '../contract'
import ArrayRow from './ArrayRow.vue'
import Field from './Field.vue'
import type { AttaformForm } from './types'

/**
 * The benchmark builds the schema dynamically, so `useForm`'s generics cannot
 * derive the static `FlatPath` set and the inference blows the instantiation
 * depth. Calling through a loose signature erases that derivation while leaving
 * the runtime call identical (the same path the typed API resolves to).
 */
type UseFormLoose = (config: {
  schema: unknown
  key: string
  defaultValues: Record<string, unknown>
  validateOn: 'change' | 'blur'
  debounceMs: number
}) => AttaformForm
const useFormLoose = useForm as unknown as UseFormLoose

let mountSeq = 0

const unsupported = (op: string): never => {
  throw new Error(`bench: attaform adapter does not drive "${op}" in this scenario`)
}

export const attaformAdapter: BenchAdapter = {
  meta: {
    id: 'attaform',
    displayName: 'Attaform',
    layer: 'headless-form-state',
    schemaLib: 'zod3',
    ownsInputs: false,
    capabilities: {
      flat: 'native',
      nested: 'native',
      arrays: 'native',
      grid: 'native',
      'discriminated-union': 'native',
      massive: 'native',
      wizard: 'native',
    },
  },

  async mount(container, opts): Promise<MountHandle> {
    const shape = shapeFor(opts.scenario, opts.params)
    const schema = zodSchemaFor(opts.scenario, opts.params)
    const validateOn: 'change' | 'blur' = opts.trigger === 'blur' ? 'blur' : 'change'
    mountSeq += 1
    const key = `bench-attaform-${opts.scenario}-${opts.seed}-${mountSeq}`

    let form: AttaformForm | undefined

    // The host renders the static field list and reads nothing reactive, so it
    // never re-renders; each Field subscribes only to its own value, which is
    // what keeps the render-scope measurement honest.
    const Host = defineComponent({
      name: 'AttaformHost',
      setup() {
        const f = useFormLoose({
          schema,
          key,
          defaultValues: shape.defaultValues,
          validateOn,
          debounceMs: 0,
        })
        form = f
        const arrayPath = shape.arrayPath
        const itemFields = shape.arrayItemFields ?? []
        return () => {
          // An array scenario renders reactively through `form.list`: reading it
          // tracks the array length, so a row added or removed reflows the list,
          // while a leaf edit (length unchanged) re-renders only its own row.
          if (arrayPath !== undefined) {
            return h(
              'div',
              f.list(arrayPath).flatMap((row, i) =>
                itemFields.map((field, fIdx) =>
                  h(ArrayRow, {
                    key: `${row.key}.${field}`,
                    form: f,
                    path: `${arrayPath}.${i}.${field}`,
                    index: i * itemFields.length + fIdx,
                    trigger: opts.trigger,
                  })
                )
              )
            )
          }
          return h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, { key: index, form: f, path, index, trigger: opts.trigger })
            )
          )
        }
      },
    })

    const app: App = createApp(Host).use(createAttaform())
    app.mount(container)
    await flush()

    const driver = domDriver(container, opts.trigger)

    return {
      typeChar: driver.typeChar,
      setFieldValue: driver.setFieldValue,
      async validateAll() {
        await form?.validateAsync()
        await flush()
      },
      async validateField(index) {
        await form?.validateAsync(shape.paths[index])
        await flush()
      },
      async arrayOp(op: ArrayOp, a?: number, b?: number) {
        const path = shape.arrayPath ?? 'rows'
        if (op === 'append') form?.append(path, shape.newRow?.() ?? {})
        else if (op === 'remove') {
          const len = form?.list(path).length ?? 0
          const index = a ?? len - 1
          if (index >= 0) form?.remove(path, index)
        } else if (op === 'swap') form?.swap(path, a ?? 0, b ?? 0)
        else unsupported(op)
        await flush()
      },
      flipVariant: () => Promise.resolve(unsupported('flipVariant')),
      stepTransition: () => Promise.resolve(unsupported('stepTransition')),
      getRenderCount: () => totalRenders(),
      resetRenderCount: () => resetRenderCounts(),
      teardown: () => app.unmount(),
    }
  },
}
