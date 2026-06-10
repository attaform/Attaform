import { FormKit, defaultConfig, plugin } from '@formkit/vue'
import { createZodPlugin } from '@formkit/zod'
import {
  type App,
  type Component,
  type Ref,
  type VNode,
  createApp,
  defineComponent,
  h,
  ref,
} from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { leafSeed, shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { ArrayOp, BenchAdapter, MountHandle } from '../contract'

// FormKit accepts arbitrary attributes (type, name, delay, data-*), which its
// typed component surface does not enumerate; bind through a loose Component.
const FormKitC = FormKit as unknown as Component

let mountSeq = 0

const unsupported = (op: string): never => {
  throw new Error(`bench: formkit adapter does not drive "${op}" in this scenario`)
}

interface FormNode {
  submit(): void
  settled: Promise<unknown>
}

/** The FormKit `list` node the array scenario reorders through. Its value is the
 *  array of row values; `input` commits a new array (used for the swap). */
interface ListNode {
  readonly value: readonly unknown[]
  input(value: unknown): Promise<unknown>
}

/** A segment node in the FormKit field tree: a `group` if it has children, a
 *  `text` input if it is a leaf (carrying its rendered index + full path). */
interface TrieNode {
  readonly children: Map<string, TrieNode>
  leaf?: { index: number; path: string }
}

/**
 * FormKit builds its data tree from the nesting of `group` nodes, so the flat
 * dotted paths are folded into a segment trie the render mirrors: shared
 * prefixes become nested groups, leaves become text inputs. Flat scenarios
 * (single-segment paths) fold to a flat list of inputs, exactly the prior
 * shape; nested scenarios produce the real group chain a FormKit author writes.
 */
function buildTrie(paths: readonly string[]): TrieNode {
  const root: TrieNode = { children: new Map() }
  paths.forEach((path, index) => {
    const segs = path.split('.')
    let node = root
    segs.forEach((seg, i) => {
      let child = node.children.get(seg)
      if (!child) {
        child = { children: new Map() }
        node.children.set(seg, child)
      }
      node = child
      if (i === segs.length - 1) node.leaf = { index, path }
    })
  })
  return root
}

/** A trie node whose every child key is numeric is an array: FormKit models it
 *  as a `list` whose items are positional, not a `group` keyed by name. */
function isArrayNode(node: TrieNode): boolean {
  if (node.children.size === 0) return false
  for (const key of node.children.keys()) if (!/^\d+$/.test(key)) return false
  return true
}

function leafInput(
  leaf: { index: number; path: string },
  defaultValues: Record<string, unknown>,
  name?: string
): VNode {
  return h(FormKitC, {
    key: name ?? leaf.index,
    type: 'text',
    name,
    value: leafSeed(defaultValues, leaf.path),
    delay: 0,
    'data-bench-field': leaf.index,
  })
}

function renderNodes(node: TrieNode, defaultValues: Record<string, unknown>): VNode[] {
  const out: VNode[] = []
  for (const [seg, child] of node.children) {
    if (child.leaf) {
      out.push(leafInput(child.leaf, defaultValues, seg))
    } else if (isArrayNode(child)) {
      // A `list`: render its items in index order, each positional (no name).
      const items = [...child.children.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([idx, item]) =>
          item.leaf
            ? leafInput(item.leaf, defaultValues)
            : h(FormKitC, { key: idx, type: 'group' }, () => renderNodes(item, defaultValues))
        )
      out.push(h(FormKitC, { key: seg, type: 'list', name: seg }, () => items))
    } else {
      out.push(
        h(FormKitC, { key: seg, type: 'group', name: seg }, () => renderNodes(child, defaultValues))
      )
    }
  }
  return out
}

/**
 * FormKit is the batteries-included entry: it renders its own inputs, so it
 * cannot drive the shared bare input and is always categorized separately. It is
 * measured in its idiomatic mode (the zod plugin, `:delay="0"` to neutralize the
 * input debounce). Validation is debounced inside the zod plugin, so a keystroke
 * measures FormKit's commit + re-render, and the full-form validate pass forces
 * an immediate validation via `node.submit()`. Render scope reports `null`
 * (FormKit owns the components); the DOM-mutation proxy lands with the grid
 * scenario, where render scope is the headline.
 */
export const formkitAdapter: BenchAdapter = {
  meta: {
    id: 'formkit',
    displayName: 'FormKit',
    layer: 'batteries-included',
    schemaLib: 'zod3',
    ownsInputs: true,
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
    const [zodPlugin, submitHandler] = createZodPlugin(schema as never, () => {})
    mountSeq += 1
    const formId = `bench-formkit-${opts.scenario}-${opts.seed}-${mountSeq}`

    // FormKit emits its root node on creation; capture it for the validate pass
    // rather than reaching for a getNode import from @formkit/core.
    let rootNode: FormNode | undefined

    const trie = buildTrie(shape.paths)
    const arrayPath = shape.arrayPath
    const itemFields = shape.arrayItemFields ?? []
    const initialSeeds = arrayPath
      ? ((shape.defaultValues[arrayPath] as Array<Record<string, unknown>>) ?? [])
      : []
    // The append row is the SAME row every adapter pushes (the shape's newRow),
    // so an appended FormKit row seeds to identical content as the cohort's.
    const appendSeed = shape.newRow?.() ?? {}
    const union = shape.union
    // FormKit addresses fields by name within a group, so the union renders as
    // a `group` whose children are the discriminant input plus the active
    // variant's inputs; the leaf segment is the FormKit `name`.
    const discriminantSeg = union
      ? union.discriminantPath.slice(union.discriminantPath.lastIndexOf('.') + 1)
      : ''
    let listNode: ListNode | undefined
    let rowCount: Ref<number> | undefined
    let activeTag: Ref<string> | undefined

    const Host = defineComponent({
      name: 'FormKitHost',
      setup() {
        // A discriminated union renders as a `group` whose children are rebuilt
        // when the discriminant flips. Keying the group by the active tag remounts
        // it, so FormKit rebuilds the union value (the discriminant carried by its
        // own input plus the new branch's fields) from the freshly mounted inputs:
        // the idiomatic conditional-fields shape a FormKit union form takes.
        if (union !== undefined) {
          const tag = ref(union.variants[0]?.tag ?? '')
          activeTag = tag
          return () => {
            const variant = union.variants.find((v) => v.tag === tag.value)
            const fields = Object.entries(variant?.value ?? {}).filter(
              ([key]) => key !== discriminantSeg
            )
            return h(
              FormKitC,
              {
                type: 'form',
                id: formId,
                plugins: [zodPlugin],
                actions: false,
                onSubmit: submitHandler,
                onNode: (node: unknown) => {
                  rootNode = node as FormNode
                },
              },
              () =>
                h(FormKitC, { type: 'group', name: union.unionPath, key: tag.value }, () => [
                  h(FormKitC, {
                    key: '__discriminant',
                    type: 'text',
                    name: discriminantSeg,
                    value: tag.value,
                    delay: 0,
                  }),
                  ...fields.map(([seg, val], i) =>
                    h(FormKitC, {
                      key: seg,
                      type: 'text',
                      name: seg,
                      value: val,
                      delay: 0,
                      'data-bench-field': i,
                    })
                  ),
                ])
            )
          }
        }
        // An array scenario renders the `list` node's rows off a reactive count:
        // appending or removing a row mounts/unmounts a group child, which FormKit
        // grows/shrinks the list from. A keystroke (count unchanged) never reflows
        // the list, so this is the performant idiomatic dynamic list (the repeater
        // add-on, an extra package, is the only lighter authoring path).
        if (arrayPath !== undefined) {
          const count = ref(initialSeeds.length)
          rowCount = count
          return () =>
            h(
              FormKitC,
              {
                type: 'form',
                id: formId,
                plugins: [zodPlugin],
                actions: false,
                onSubmit: submitHandler,
                onNode: (node: unknown) => {
                  rootNode = node as FormNode
                },
              },
              () =>
                h(
                  FormKitC,
                  {
                    type: 'list',
                    name: arrayPath,
                    onNode: (node: unknown) => {
                      listNode = node as ListNode
                    },
                  },
                  () =>
                    Array.from({ length: count.value }, (_unused, i) =>
                      h(FormKitC, { key: i, type: 'group' }, () =>
                        itemFields.map((field, fIdx) =>
                          h(FormKitC, {
                            type: 'text',
                            name: field,
                            delay: 0,
                            value: (initialSeeds[i] ?? appendSeed)[field],
                            'data-bench-field': i * itemFields.length + fIdx,
                          })
                        )
                      )
                    )
                )
            )
        }
        return () =>
          h(
            FormKitC,
            {
              type: 'form',
              id: formId,
              plugins: [zodPlugin],
              actions: false,
              onSubmit: submitHandler,
              onNode: (node: unknown) => {
                rootNode = node as FormNode
              },
            },
            () => renderNodes(trie, shape.defaultValues)
          )
      },
    })

    const app: App = createApp(Host).use(plugin, defaultConfig())
    app.mount(container)
    await flush()

    const driver = domDriver(container, opts.trigger)

    const validate = async (): Promise<void> => {
      rootNode?.submit()
      await rootNode?.settled
      await flush()
    }

    return {
      typeChar: driver.typeChar,
      setFieldValue: driver.setFieldValue,
      validateAll: validate,
      validateField: validate,
      async arrayOp(op: ArrayOp, a?: number, b?: number) {
        if (arrayPath === undefined || !rowCount) return unsupported(op)
        // Add/remove a row by mounting/unmounting a group child (FormKit grows or
        // shrinks the list to match). A reorder commits a reordered array to the
        // list node, since the rendered groups carry no Vue-side array to swap.
        if (op === 'append') rowCount.value += 1
        else if (op === 'remove') {
          if (rowCount.value > 0) rowCount.value -= 1
        } else if (op === 'swap') {
          if (!listNode) return unsupported(op)
          const arr = [...listNode.value]
          const i = a ?? 0
          const j = b ?? 0
          const tmp = arr[i]
          arr[i] = arr[j]
          arr[j] = tmp
          await listNode.input(arr)
        } else unsupported(op)
        await flush()
      },
      async flipVariant(to: string) {
        if (!union || !activeTag || !union.variants.some((v) => v.tag === to)) {
          return unsupported('flipVariant')
        }
        // Advancing the tag remounts the keyed group, so FormKit rebuilds the
        // union value from the new branch's inputs (no explicit value write).
        activeTag.value = to
        await flush()
      },
      stepTransition: () => Promise.resolve(unsupported('stepTransition')),
      // FormKit owns its components; component render count is not applicable.
      // The grid scenario adds a DOM-mutation proxy, explicitly caveated.
      getRenderCount: () => null,
      resetRenderCount: () => {},
      teardown: () => app.unmount(),
    }
  },
}
