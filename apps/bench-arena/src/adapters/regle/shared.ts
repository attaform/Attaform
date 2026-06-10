import { type App, type Ref, createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { resetRenderCounts, totalRenders } from '../../shared/render-count'
import { shapeFor } from '../../shared/scenarios'
import type { ArrayOp, MountHandle, MountOpts } from '../contract'
import Field from './Field.vue'
import type { RegleField, RegleRoot } from './types'

const unsupported = (op: string): never => {
  throw new Error(`bench: regle adapter does not drive "${op}" in this scenario`)
}

/**
 * Resolve a dotted leaf path to its Regle field status. Regle nests object
 * fields under `$fields` and array items under `$each`, so a deep path walks
 * `$fields[seg]` for an object segment and `$each[i]` for a numeric one
 * (`r$.$fields.rows.$each[0].$fields.v`); a flat path is the single-segment
 * case. Returns undefined if the path is absent, so a missing input surfaces as
 * the driver's "no input mounted" rather than a silent miss.
 */
function resolveField(root: RegleRoot, dotted: string): RegleField | undefined {
  let node: {
    readonly $fields?: Record<string, RegleField>
    readonly $each?: readonly RegleField[]
  } = root
  let field: RegleField | undefined
  for (const seg of dotted.split('.')) {
    field = /^\d+$/.test(seg) ? node.$each?.[Number(seg)] : node.$fields?.[seg]
    if (!field) return undefined
    node = field
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
  const arrayPath = shape.arrayPath
  const itemFields = shape.arrayItemFields ?? []
  const union = shape.union
  let root: RegleRoot | undefined
  let state: Record<string, unknown> | undefined
  let activeTag: Ref<string> | undefined

  const Host = defineComponent({
    name: 'RegleHost',
    setup() {
      // An array scenario owns a mutable array the ops splice and swap, so the
      // seed tree is cloned per mount; sharing the shape's array across mounts
      // would let one mount's op corrupt the next. Flat/nested never mutate, so
      // a shallow spread is enough there.
      const seed = arrayPath
        ? (JSON.parse(JSON.stringify(shape.defaultValues)) as Record<string, unknown>)
        : { ...shape.defaultValues }
      const s = reactive(seed) as Record<string, unknown>
      state = s
      const r$ = createRoot(s)
      root = r$
      // The active variant is tracked off a local signal the flip keeps in sync;
      // a flip reassigns the harness state's union value and advances the signal,
      // and Regle re-derives the active branch's field statuses from the state.
      const tag = ref(union?.variants[0]?.tag ?? '')
      activeTag = tag
      // Each field status is stable, so the host renders once; each Field
      // re-renders only on its own `$value`. An array scenario iterates the
      // harness-owned reactive array for length (an add/remove/reorder reflows
      // the list; a leaf edit, which never touches the array structure, does not).
      return () => {
        if (union !== undefined) {
          const variant = union.variants.find((v) => v.tag === tag.value)
          // Skip a field that has not resolved yet: in schema mode Regle derives
          // a union branch's field statuses from the schema and state, so a field
          // briefly absent right after a flip is dropped rather than crashing the
          // render (the flip lets the derivation settle before swapping).
          return h(
            'div',
            (variant?.fieldPaths ?? []).flatMap((path, index) => {
              const field = resolveField(r$, path)
              return field ? [h(Field, { key: path, field, index, trigger: opts.trigger })] : []
            })
          )
        }
        if (arrayPath !== undefined) {
          const list = (s[arrayPath] as unknown[]) ?? []
          return h(
            'div',
            list.flatMap((_row, i) =>
              itemFields.map((field, fIdx) => {
                const index = i * itemFields.length + fIdx
                return h(Field, {
                  key: index,
                  field: resolveField(r$, `${arrayPath}.${i}.${field}`) as RegleField,
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
              field: resolveField(r$, path) as RegleField,
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
      const path = shape.paths[index]
      if (path !== undefined && root) await resolveField(root, path)?.$validate()
      await flush()
    },
    // Regle is validation-only, so the harness owns the array and mutates it;
    // Regle re-derives its `$each` collection statuses from the reactive state.
    // This is the shape a Regle array form actually takes (you own the array).
    async arrayOp(op: ArrayOp, a?: number, b?: number) {
      if (arrayPath === undefined || !state) return unsupported(op)
      const list = state[arrayPath] as Array<Record<string, unknown>>
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
    // Regle is validation-only, so the harness owns the union value; reassigning
    // it lets Regle re-derive the active branch from the reactive state. The
    // clone keeps repeated flips from sharing one object across the reactive tree.
    async flipVariant(to: string) {
      const variant = union?.variants.find((v) => v.tag === to)
      if (!union || !variant || !state) return unsupported('flipVariant')
      state[union.unionPath] = { ...variant.value }
      // Let Regle re-derive the new branch's field statuses from the changed
      // state before the host swaps to them; in schema mode the branch fields do
      // not exist on `r$` until this settles. This two-phase update is the real
      // cost of a Regle discriminated-union flip.
      await nextTick()
      if (activeTag) activeTag.value = to
      await flush()
    },
    stepTransition: () => Promise.resolve(unsupported('stepTransition')),
    getRenderCount: () => totalRenders(),
    resetRenderCount: () => resetRenderCounts(),
    teardown: () => app.unmount(),
  }
}
