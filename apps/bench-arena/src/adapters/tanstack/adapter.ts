import { useForm } from '@tanstack/vue-form'
import { type App, type Ref, createApp, defineComponent, h, ref } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { ArrayOp, BenchAdapter, MountHandle } from '../contract'
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

    const arrayPath = shape.arrayPath
    const itemFields = shape.arrayItemFields ?? []
    const seedRows = arrayPath ? ((shape.defaultValues[arrayPath] as unknown[]) ?? []) : []
    const union = shape.union
    let form: TanstackForm | undefined
    let rowCount: Ref<number> | undefined
    let activeTag: Ref<string> | undefined

    const Host = defineComponent({
      name: 'TanstackHost',
      setup() {
        const f = useFormLoose({ defaultValues: { ...shape.defaultValues }, validators })
        form = f
        // TanStack exposes no per-row key, so rows are positional. Rendering off
        // a length signal the array ops keep in sync (rather than deep-reading
        // the array value) is the most performant idiomatic shape: a keystroke
        // into a row never reflows the list, only an add/remove/reorder does.
        const count = ref(seedRows.length)
        rowCount = count
        // The active variant is tracked off a local signal the flip keeps in
        // sync (the same shape as the row-count signal); a flip writes the union
        // value through setFieldValue, then advances the signal so the host
        // swaps to the new branch's fields.
        const tag = ref(union?.variants[0]?.tag ?? '')
        activeTag = tag
        return () => {
          if (union !== undefined) {
            const variant = union.variants.find((v) => v.tag === tag.value)
            return h(
              'div',
              (variant?.fieldPaths ?? []).map((path, index) =>
                h(Field, { key: path, form: f, name: path, index, trigger: opts.trigger })
              )
            )
          }
          if (arrayPath !== undefined) {
            return h(
              'div',
              Array.from({ length: count.value }, (_unused, i) =>
                itemFields.map((field, fIdx) => {
                  const index = i * itemFields.length + fIdx
                  return h(Field, {
                    key: index,
                    form: f,
                    name: `${arrayPath}.${i}.${field}`,
                    index,
                    trigger: opts.trigger,
                  })
                })
              ).flat()
            )
          }
          return h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, { key: index, form: f, name: path, index, trigger: opts.trigger })
            )
          )
        }
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
      async arrayOp(op: ArrayOp, a?: number, b?: number) {
        if (arrayPath === undefined || !rowCount) return unsupported(op)
        if (op === 'append') {
          form?.pushFieldValue(arrayPath, shape.newRow?.() ?? {})
          rowCount.value += 1
        } else if (op === 'remove') {
          const index = a ?? rowCount.value - 1
          if (index >= 0) {
            await form?.removeFieldValue(arrayPath, index)
            rowCount.value -= 1
          }
        } else if (op === 'swap') {
          form?.swapFieldValues(arrayPath, a ?? 0, b ?? 0)
        } else unsupported(op)
        await flush()
      },
      async flipVariant(to: string) {
        const variant = union?.variants.find((v) => v.tag === to)
        if (!union || !variant) return unsupported('flipVariant')
        // Write the whole union value, then advance the local signal so the host
        // swaps to the new branch's fields after the value has landed.
        form?.setFieldValue(union.unionPath, { ...variant.value })
        if (activeTag) activeTag.value = to
        await flush()
      },
      stepTransition: () => Promise.resolve(unsupported('stepTransition')),
      getRenderCount: () => totalRenders(),
      resetRenderCount: () => resetRenderCounts(),
      teardown: () => app.unmount(),
    }
  },
}
