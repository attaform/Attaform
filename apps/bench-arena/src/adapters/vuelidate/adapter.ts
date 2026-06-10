import { useVuelidate } from '@vuelidate/core'
import { minLength } from '@vuelidate/validators'
import { type App, createApp, defineComponent, h, reactive } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { nativeRulesFor, nestRules, shapeFor } from '../../shared/scenarios'
import type { BenchAdapter, MountHandle } from '../contract'
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
    mountSeq += 1

    let root: VuelidateRoot | undefined
    let tree: Record<string, unknown> | undefined

    const Host = defineComponent({
      name: 'VuelidateHost',
      setup() {
        const state = reactive({ ...shape.defaultValues })
        const v$ = useVuelidateLoose(rules, state)
        root = v$.value
        tree = v$.value
        return () =>
          h(
            'div',
            shape.paths.map((path, index) =>
              h(Field, {
                key: index,
                field: resolveField(v$.value, path) as VuelidateField,
                index,
                trigger: opts.trigger,
              })
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
        await root?.$validate()
        await flush()
      },
      async validateField(index) {
        const path = shape.paths[index]
        if (path !== undefined && tree) await resolveField(tree, path)?.$validate()
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
