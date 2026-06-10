import { useVuelidate } from '@vuelidate/core'
import { helpers, minLength } from '@vuelidate/validators'
import { type App, createApp, defineComponent, h, reactive } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { nativeRulesFor, nestRules, shapeFor } from '../../shared/scenarios'
import type { ArrayOp, BenchAdapter, MountHandle } from '../contract'
import Field from './Field.vue'
import type { VuelidateField, VuelidateRoot } from './types'

/**
 * Resolve a dotted leaf path to its Vuelidate field validation. Vuelidate's
 * validation tree mirrors the nested rules/state by key, so a deep path walks
 * `v$.value.l0.l1.leaf`; a flat path is the single-segment case.
 */
function resolveField(root: Record<string, unknown>, dotted: string): VuelidateField | undefined {
  let node: unknown = root
  for (const seg of dotted.split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return node as VuelidateField | undefined
}

/**
 * A per-row field façade for an array scenario. Vuelidate's `forEach` validates
 * the collection as a whole and exposes no per-item `$model`, so the row binds
 * its value to the raw reactive state cell (granular: only this row re-renders on
 * its own edit) and routes validation through the collection status. That is the
 * honest hand-rolled shape a Vuelidate array form takes; reading the collection
 * `$error` on render forces the whole-collection revalidation per keystroke.
 */
function arrayFacade(
  state: Record<string, unknown>,
  coll: VuelidateField,
  arrayPath: string,
  index: number,
  fieldSegs: readonly string[]
): VuelidateField {
  const row = (): Record<string, unknown> =>
    (state[arrayPath] as Array<Record<string, unknown>>)[index] ?? {}
  const last = fieldSegs[fieldSegs.length - 1] ?? ''
  return {
    get $model(): string {
      let node: unknown = row()
      for (const seg of fieldSegs) node = (node as Record<string, unknown> | undefined)?.[seg]
      return node as string
    },
    set $model(val: string) {
      let node = row()
      for (let k = 0; k < fieldSegs.length - 1; k++) {
        node = node[fieldSegs[k] ?? ''] as Record<string, unknown>
      }
      node[last] = val
    },
    get $error(): boolean {
      return coll.$error
    },
    $touch: () => coll.$touch(),
    $validate: () => coll.$validate(),
  }
}

/**
 * The dynamic rules object erases Vuelidate's `Validation` generics, so the call
 * is made through a loose signature; the runtime call is the real one. `v$.value`
 * is the validation tree, indexable by field path.
 */
type VuelidateTree = VuelidateRoot & Record<string, VuelidateField>
type UseVuelidateLoose = (rules: Record<string, unknown>, state: object) => { value: VuelidateTree }
const useVuelidateLoose = useVuelidate as unknown as UseVuelidateLoose

let mountSeq = 0

const unsupported = (op: string): never => {
  throw new Error(`bench: vuelidate adapter does not drive "${op}" in this scenario`)
}

/**
 * Vuelidate is the model-based old-guard baseline (clearly labeled
 * unmaintained / LTS on the page). Native validators ride on a rules object
 * mirroring the cohort's constraint, and the reactive state is the model the
 * fields bind to through `$model`.
 */
export const vuelidateAdapter: BenchAdapter = {
  meta: {
    id: 'vuelidate',
    displayName: 'Vuelidate',
    layer: 'headless-validation-only',
    schemaLib: 'native',
    ownsInputs: false,
    capabilities: {
      flat: 'native',
      nested: 'native',
      arrays: 'hand-rolled',
      grid: 'hand-rolled',
      'discriminated-union': 'hand-rolled',
      massive: 'native',
      wizard: 'hand-rolled',
    },
  },

  async mount(container, opts): Promise<MountHandle> {
    const shape = shapeFor(opts.scenario, opts.params)
    // Rules nest to mirror the value tree (Vuelidate keys validations by
    // structure), built from the scenario's flat rule description.
    const rules = nestRules(nativeRulesFor(opts.scenario, opts.params), (rule) =>
      rule.minLength !== undefined ? { minLength: minLength(rule.minLength) } : {}
    )
    if (shape.arrayPath && shape.arrayItemRules) {
      const itemRules: Record<string, unknown> = {}
      for (const [field, rule] of Object.entries(shape.arrayItemRules)) {
        itemRules[field] =
          rule.minLength !== undefined ? { minLength: minLength(rule.minLength) } : {}
      }
      rules[shape.arrayPath] = { $each: helpers.forEach(itemRules) }
    }
    mountSeq += 1

    const arrayPath = shape.arrayPath
    const itemFields = shape.arrayItemFields ?? []
    let root: VuelidateRoot | undefined
    let resolve: ((index: number) => VuelidateField | undefined) | undefined
    let stateRef: Record<string, unknown> | undefined

    const Host = defineComponent({
      name: 'VuelidateHost',
      setup() {
        // An array scenario owns a mutable array the ops splice and swap, so the
        // seed tree is cloned per mount; sharing the shape's array would let one
        // mount's op corrupt the next. Flat/nested never mutate.
        const seed = arrayPath
          ? (JSON.parse(JSON.stringify(shape.defaultValues)) as Record<string, unknown>)
          : { ...shape.defaultValues }
        const state = reactive(seed) as Record<string, unknown>
        stateRef = state
        const v$ = useVuelidateLoose(rules, state)
        root = v$.value
        // An array path resolves to a per-row façade; an object path walks the
        // nested validation tree by key.
        const fieldFor = (path: string): VuelidateField | undefined => {
          if (arrayPath && path.startsWith(`${arrayPath}.`)) {
            const rest = path.slice(arrayPath.length + 1).split('.')
            const coll = (v$.value as Record<string, unknown>)[arrayPath] as VuelidateField
            return arrayFacade(state, coll, arrayPath, Number(rest[0]), rest.slice(1))
          }
          return resolveField(v$.value, path)
        }
        resolve = (index) => {
          const path = shape.paths[index]
          return path === undefined ? undefined : fieldFor(path)
        }
        return () => {
          if (arrayPath !== undefined) {
            const list = (state[arrayPath] as unknown[]) ?? []
            return h(
              'div',
              list.flatMap((_row, i) =>
                itemFields.map((field, fIdx) => {
                  const index = i * itemFields.length + fIdx
                  return h(Field, {
                    key: index,
                    field: fieldFor(`${arrayPath}.${i}.${field}`) as VuelidateField,
                    index,
                    trigger: opts.trigger,
                  })
                })
              )
            )
          }
          return h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, {
                key: index,
                field: fieldFor(path) as VuelidateField,
                index,
                trigger: opts.trigger,
              })
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
        await root?.$validate()
        await flush()
      },
      async validateField(index) {
        await resolve?.(index)?.$validate()
        await flush()
      },
      // Vuelidate is validation-only, so the harness owns the array and mutates
      // it; Vuelidate's `forEach` collection rule re-validates the rows from the
      // reactive state. This is the shape a Vuelidate array form actually takes.
      async arrayOp(op: ArrayOp, a?: number, b?: number) {
        if (arrayPath === undefined || !stateRef) return unsupported(op)
        const list = stateRef[arrayPath] as Array<Record<string, unknown>>
        if (op === 'append') list.push(shape.newRow?.() ?? {})
        else if (op === 'remove') {
          const index = a ?? list.length - 1
          if (index >= 0) list.splice(index, 1)
        } else if (op === 'swap') {
          const i = a ?? 0
          const j = b ?? 0
          const tmp = list[i] as Record<string, unknown>
          list[i] = list[j] as Record<string, unknown>
          list[j] = tmp
        } else unsupported(op)
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
