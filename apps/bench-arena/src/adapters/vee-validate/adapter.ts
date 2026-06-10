import { toTypedSchema } from '@vee-validate/zod'
import { useFieldArray, useForm } from 'vee-validate'
import { type App, type Ref, createApp, defineComponent, h, ref } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { ArrayOp, BenchAdapter, MountHandle } from '../contract'
import Field from './Field.vue'

/** The slice of vee-validate's form context the adapter drives. */
interface VeeForm {
  validate: () => Promise<unknown>
  validateField: (path: string) => Promise<unknown>
  /** Set a path's value, including a whole object at the union path (the flip). */
  setFieldValue: (path: string, value: unknown) => void
}

/**
 * The slice of vee-validate's `useFieldArray` the adapter drives: the reactive
 * `fields` (each entry carrying a stable `key` that follows its row across a
 * reorder) plus the idiomatic mutators. This is vee-validate's first-class
 * dynamic-array primitive.
 */
interface VeeFieldArray {
  fields: { readonly value: ReadonlyArray<{ readonly key: string | number }> }
  push(value: unknown): void
  remove(index: number): void
  swap(a: number, b: number): void
}

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

    const arrayPath = shape.arrayPath
    const itemFields = shape.arrayItemFields ?? []
    const union = shape.union
    const wizardDesc = shape.wizard
    let form: VeeForm | undefined
    let rows: VeeFieldArray | undefined
    let activeTag: Ref<string> | undefined
    // The hand-composed wizard's active step. vee-validate has no wizard
    // primitive, so the harness tracks the position and the gated advance
    // validates the leaving step's fields through the per-field API; every step
    // renders through the default branch, so navigation never remounts a field.
    let wizardStep = 0

    const Host = defineComponent({
      name: 'VeeValidateHost',
      setup() {
        // useForm provides the field context useField injects in each child.
        const f = useForm({
          validationSchema: toTypedSchema(schema),
          initialValues: shape.defaultValues as Record<string, unknown>,
        })
        form = f as unknown as VeeForm
        // useFieldArray is vee-validate's array primitive; its reactive `fields`
        // drive the rendered rows so an add/remove/reorder reflows the list.
        const fieldArray = arrayPath
          ? (useFieldArray(arrayPath) as unknown as VeeFieldArray)
          : undefined
        rows = fieldArray
        // The active variant is tracked off a local signal the flip keeps in
        // sync; a flip writes the union value through setFieldValue, then
        // advances the signal so the host swaps to the new branch's fields.
        const tag = ref(union?.variants[0]?.tag ?? '')
        activeTag = tag
        return () => {
          if (union !== undefined) {
            const variant = union.variants.find((v) => v.tag === tag.value)
            return h(
              'div',
              (variant?.fieldPaths ?? []).map((path, index) =>
                h(Field, { key: path, name: path, index, trigger: opts.trigger })
              )
            )
          }
          if (fieldArray) {
            const objectPaths = shape.objectPaths ?? []
            const objBase = shape.paths.length - objectPaths.length
            return h('div', [
              ...fieldArray.fields.value.flatMap((entry, i) =>
                itemFields.map((field, fIdx) =>
                  h(Field, {
                    key: `${entry.key}.${field}`,
                    name: `${arrayPath}.${i}.${field}`,
                    index: i * itemFields.length + fIdx,
                    trigger: opts.trigger,
                  })
                )
              ),
              ...objectPaths.map((path, j) =>
                h(Field, {
                  key: `obj-${path}`,
                  name: path,
                  index: objBase + j,
                  trigger: opts.trigger,
                })
              ),
            ])
          }
          return h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, { key: index, name: path, index, trigger: opts.trigger })
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
        await form?.validate()
        await flush()
      },
      async validateField(index) {
        await form?.validateField(shape.paths[index] ?? '')
        await flush()
      },
      async arrayOp(op: ArrayOp, a?: number, b?: number) {
        if (!rows) return unsupported(op)
        if (op === 'append') rows.push(shape.newRow?.() ?? {})
        else if (op === 'remove') rows.remove(a ?? rows.fields.value.length - 1)
        else if (op === 'swap') rows.swap(a ?? 0, b ?? 0)
        else unsupported(op)
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
      async stepTransition(dir: 1 | -1) {
        if (!wizardDesc || !form) return unsupported('stepTransition')
        if (dir === 1) {
          if (wizardStep < wizardDesc.steps.length - 1) {
            // Gate the advance on the leaving step's fields, validated through
            // vee-validate's per-field API (the granular path a hand-composed
            // wizard reaches for; only this step's fields are checked).
            await Promise.all(
              (wizardDesc.steps[wizardStep] ?? []).map((p) => form?.validateField(p))
            )
            wizardStep += 1
          }
        } else if (wizardStep > 0) wizardStep -= 1
        await flush()
      },
      getRenderCount: () => totalRenders(),
      resetRenderCount: () => resetRenderCounts(),
      teardown: () => app.unmount(),
    }
  },
}
