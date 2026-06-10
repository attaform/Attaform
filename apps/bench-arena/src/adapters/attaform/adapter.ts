import { createAttaform } from 'attaform'
import { useForm, useWizard } from 'attaform/zod-v3'
import { type App, type Ref, createApp, defineComponent, h, ref } from 'vue'
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

/**
 * useWizard composes a list of step forms into a multistep flow. The dynamic
 * per-step schemas erase its generics, so it is called through a loose
 * signature while the runtime call is the real one. `handleSubmit` on an
 * intermediate step validates the active step's form and advances on success
 * (the gated transition the stepTransition dimension measures); `back()` is a
 * free retreat with no validation.
 */
interface WizardLoose {
  readonly activeIndex: { readonly value: number }
  back(): void
  handleSubmit(onSuccess: (ctx: unknown) => void): (event?: Event) => Promise<void>
}
const useWizardLoose = useWizard as unknown as (config: { steps: unknown[] }) => WizardLoose

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

    const union = shape.union
    const wizardDesc = shape.wizard
    let form: AttaformForm | undefined
    let stepForms: AttaformForm[] | undefined
    let wizard: WizardLoose | undefined
    let activeTag: Ref<string> | undefined

    // The host renders the static field list and reads nothing reactive, so it
    // never re-renders; each Field subscribes only to its own value, which is
    // what keeps the render-scope measurement honest.
    const Host = defineComponent({
      name: 'AttaformHost',
      setup() {
        // The wizard is the real useWizard idiom: each step is its own useForm
        // over that step's sub-schema (sliced off the root object by key), and
        // useWizard composes them into one flow. Only the active step's fields
        // render, off `wizard.activeIndex`; an advance validates that step's
        // form through `handleSubmit` (see the handle's stepTransition).
        if (wizardDesc !== undefined) {
          const rootShape = (schema as unknown as { shape: Record<string, unknown> }).shape
          const forms = wizardDesc.stepKeys.map((stepK) =>
            useFormLoose({
              schema: rootShape[stepK],
              key: `${key}-${stepK}`,
              defaultValues: (shape.defaultValues[stepK] ?? {}) as Record<string, unknown>,
              validateOn,
              debounceMs: 0,
            })
          )
          stepForms = forms
          const wiz = useWizardLoose({ steps: forms })
          wizard = wiz
          const perStep = wizardDesc.steps[0]?.length ?? 0
          // Render every step's fields at once (eager). The wizard's per-step
          // forms all hold state regardless of which step shows, so an advance
          // never mounts or unmounts an input: the transition cost is the
          // active step's validation plus the wizard's own bookkeeping, nothing
          // more. It also keeps the cohort's aggregate validate comparable, with
          // every field mounted for every library (the hand-rolled adapters
          // render the same full set through their default branch). `activeIndex`
          // still tracks the gated position the advance walks; the render does
          // not read it, so an advance triggers no host re-render.
          return () =>
            h(
              'div',
              wizardDesc.steps.flatMap((stepPaths, s) =>
                stepPaths.map((path, j) =>
                  h(Field, {
                    key: path,
                    form: forms[s] as AttaformForm,
                    // Each step form's own field name (`f0`), not the dotted root
                    // path; the data-bench-field index stays global for the driver.
                    path: path.slice(path.indexOf('.') + 1),
                    index: s * perStep + j,
                    trigger: opts.trigger,
                  })
                )
              )
            )
        }
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
        // The active variant is tracked off a local signal the flip keeps in
        // sync (the same shape as the array's length signal): a flip writes the
        // union value through setValue, then advances the signal so the host
        // swaps to the new branch's fields. A keystroke never touches it.
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
          // An array scenario renders reactively through `form.list`: reading it
          // tracks the array length, so a row added or removed reflows the list,
          // while a leaf edit (length unchanged) re-renders only its own row. The
          // composite massive scenario appends its flat and nested leaves after
          // the rows (`objectPaths`), each registered at an index past the cells.
          if (arrayPath !== undefined) {
            const objectPaths = shape.objectPaths ?? []
            const objBase = shape.paths.length - objectPaths.length
            return h('div', [
              ...f.list(arrayPath).flatMap((row, i) =>
                itemFields.map((field, fIdx) =>
                  h(ArrayRow, {
                    key: `${row.key}.${field}`,
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

    const app: App = createApp(Host).use(createAttaform())
    app.mount(container)
    await flush()

    const driver = domDriver(container, opts.trigger)

    // The gated forward transition: validating the active step's form and
    // advancing on success is exactly what useWizard's intermediate
    // handleSubmit does. Built once after mount; the handler is stable.
    const stepAdvance = wizard?.handleSubmit(() => {})

    return {
      typeChar: driver.typeChar,
      setFieldValue: driver.setFieldValue,
      async validateAll() {
        // A wizard's cross-step aggregate is every step's form validated (the
        // same set a final-step submit runs); a single form validates itself.
        if (stepForms !== undefined) await Promise.all(stepForms.map((sf) => sf.validateAsync()))
        else await form?.validateAsync()
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
      async flipVariant(to: string) {
        const variant = union?.variants.find((v) => v.tag === to)
        if (!union || !variant) return unsupported('flipVariant')
        // Replace the whole union value, then advance the local signal so the
        // host swaps to the new branch's fields after the value has landed. A
        // fresh clone per flip keeps repeated flips from sharing one object.
        form?.setValue(union.unionPath, { ...variant.value })
        if (activeTag) activeTag.value = to
        await flush()
      },
      async stepTransition(dir: 1 | -1) {
        if (!wizard || !stepAdvance) return unsupported('stepTransition')
        // Forward is the gated advance (validate the active step, then move on);
        // backward is a free retreat, the same asymmetry a hand-composed wizard
        // carries (progress is gated, going back is not).
        if (dir === 1) await stepAdvance()
        else wizard.back()
        await flush()
      },
      getRenderCount: () => totalRenders(),
      resetRenderCount: () => resetRenderCounts(),
      teardown: () => app.unmount(),
    }
  },
}
