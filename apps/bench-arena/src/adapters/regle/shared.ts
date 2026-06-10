import { type App, createApp, defineComponent, h, reactive } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor } from '../../shared/scenarios'
import type { MountHandle, MountOpts } from '../contract'
import Field from './Field.vue'
import type { RegleField, RegleRoot } from './types'

const unsupported = (op: string): never => {
  throw new Error(`bench: regle adapter does not drive "${op}" in this scenario`)
}

/**
 * Resolve a dotted leaf path to its Regle field status. Regle nests object
 * fields under `$fields`, so a deep path walks `$fields[seg]` at each level
 * (`r$.$fields.l0.$fields.l1.$fields.leaf`); a flat path is the single-segment
 * case. Returns undefined if the path is absent, so a missing input surfaces as
 * the driver's "no input mounted" rather than a silent miss.
 */
function resolveField(root: RegleRoot, dotted: string): RegleField | undefined {
  let fields: Record<string, RegleField> | undefined = root.$fields
  let field: RegleField | undefined
  for (const seg of dotted.split('.')) {
    field = fields?.[seg]
    if (!field) return undefined
    fields = field.$fields
  }
  return field
}

/**
 * Shared Regle mount. Both modes own identical wiring (a reactive state object,
 * an `r$` root, and granular per-field bindings); only how `r$` is produced
 * differs, so each mode passes a `createRoot` that calls `useRegleSchema` (zod)
 * or `useRegle` (native rules) on the harness-owned reactive state.
 */
export async function mountRegle(
  container: HTMLElement,
  opts: MountOpts,
  createRoot: (state: Record<string, unknown>) => RegleRoot
): Promise<MountHandle> {
  const shape = shapeFor(opts.scenario, opts.params)
  let root: RegleRoot | undefined

  const Host = defineComponent({
    name: 'RegleHost',
    setup() {
      const state = reactive({ ...shape.defaultValues })
      const r$ = createRoot(state)
      root = r$
      // Each field status is stable, so the host renders once; each Field
      // re-renders only on its own `$value`.
      return () =>
        h(
          'div',
          shape.paths.map((path, index) =>
            h(Field, {
              key: index,
              field: resolveField(r$, path) as RegleField,
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
      if (path !== undefined && root) await resolveField(root, path)?.$validate()
      await flush()
    },
    arrayOp: () => Promise.resolve(unsupported('arrayOp')),
    flipVariant: () => Promise.resolve(unsupported('flipVariant')),
    stepTransition: () => Promise.resolve(unsupported('stepTransition')),
    getRenderCount: () => totalRenders(),
    resetRenderCount: () => resetRenderCounts(),
    teardown: () => app.unmount(),
  }
}
