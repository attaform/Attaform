import { insert, remove, setInput, swap, useFieldArray, useForm, validate } from '@formisch/vue'
import { type App, type Ref, createApp, defineComponent, h, ref } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor, valibotSchemaFor } from '../../shared/scenarios'
import type { ArrayOp, BenchAdapter, MountHandle } from '../contract'
import ArrayRow from './ArrayRow.vue'
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

// formisch addresses a field array by its array path (`['rows']`); the dynamic
// schema collapses the path generics, so the helpers are called through loose
// signatures while the runtime calls are the real ones.
type ArrayPath = ReadonlyArray<string | number>
const useFieldArrayLoose = useFieldArray as unknown as (
  form: FormStoreLoose,
  config: { path: ArrayPath }
) => { readonly items: readonly string[] }
const insertRow = insert as unknown as (
  form: FormStoreLoose,
  config: { path: ArrayPath; initialInput?: unknown }
) => void
const removeRow = remove as unknown as (
  form: FormStoreLoose,
  config: { path: ArrayPath; at: number }
) => void
const swapRows = swap as unknown as (
  form: FormStoreLoose,
  config: { path: ArrayPath; at: number; and: number }
) => void
// setInput writes a value at a path; the flip writes the whole union object at
// `['event']`. The dynamic schema collapses the path/input generics.
const setInputAt = setInput as unknown as (
  form: FormStoreLoose,
  config: { path: ArrayPath; input: unknown }
) => void

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

    const arrayPath = shape.arrayPath
    const itemFields = shape.arrayItemFields ?? []
    const union = shape.union
    const wizardDesc = shape.wizard
    let form: FormStoreLoose | undefined
    let rows: { readonly items: readonly string[] } | undefined
    let activeTag: Ref<string> | undefined
    // The hand-composed wizard's active step. formisch has no wizard primitive
    // and exposes only whole-form validation, so a gated advance re-parses the
    // whole schema; every step renders through the default branch.
    let wizardStep = 0

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
        // useFieldArray is formisch's array primitive; its reactive `items` are
        // the stable per-row keys, so iterating them reflows the list on an
        // add/remove and a leaf edit (keys unchanged) touches only its own row.
        const fieldArray = arrayPath ? useFieldArrayLoose(f, { path: [arrayPath] }) : undefined
        rows = fieldArray
        // The active variant is tracked off a local signal the flip keeps in
        // sync; a flip writes the union value through setInput, then advances the
        // signal so the host swaps to the new branch's fields.
        const tag = ref(union?.variants[0]?.tag ?? '')
        activeTag = tag
        return () => {
          if (union !== undefined) {
            const variant = union.variants.find((v) => v.tag === tag.value)
            return h(
              'div',
              (variant?.fieldPaths ?? []).map((path, index) =>
                h(Field, { key: path, form: f, path, index, trigger: opts.trigger })
              )
            )
          }
          if (fieldArray && arrayPath !== undefined) {
            const objectPaths = shape.objectPaths ?? []
            const objBase = shape.paths.length - objectPaths.length
            return h('div', [
              ...fieldArray.items.flatMap((key, i) =>
                itemFields.map((field, fIdx) =>
                  h(ArrayRow, {
                    key: `${key}.${field}`,
                    form: f,
                    path: `${arrayPath}.${i}.${field}`,
                    index: i * itemFields.length + fIdx,
                    trigger: opts.trigger,
                  })
                )
              ),
              ...objectPaths.map((path, j) =>
                h(Field, {
                  key: `obj-${path}`,
                  form: f,
                  path,
                  index: objBase + j,
                  trigger: opts.trigger,
                })
              ),
            ])
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
      async arrayOp(op: ArrayOp, a?: number, b?: number) {
        if (arrayPath === undefined || !form) return unsupported(op)
        const path = [arrayPath]
        if (op === 'append') insertRow(form, { path, initialInput: shape.newRow?.() ?? {} })
        else if (op === 'remove') {
          const at = a ?? (rows?.items.length ?? 0) - 1
          if (at >= 0) removeRow(form, { path, at })
        } else if (op === 'swap') swapRows(form, { path, at: a ?? 0, and: b ?? 0 })
        else unsupported(op)
        await flush()
      },
      async flipVariant(to: string) {
        const variant = union?.variants.find((v) => v.tag === to)
        if (!union || !variant || !form) return unsupported('flipVariant')
        // Write the whole union value, then advance the local signal so the host
        // swaps to the new branch's fields after the value has landed.
        setInputAt(form, { path: [union.unionPath], input: { ...variant.value } })
        if (activeTag) activeTag.value = to
        await flush()
      },
      async stepTransition(dir: 1 | -1) {
        if (!wizardDesc || !form) return unsupported('stepTransition')
        if (dir === 1) {
          if (wizardStep < wizardDesc.steps.length - 1) {
            // formisch validates the whole form (no per-field entry), so a gated
            // step re-runs the full schema parse; that whole-form cost is the
            // honest price of hand-composing a wizard without a step primitive.
            await validateForm(form)
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
