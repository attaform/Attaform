import { FormKit, defaultConfig, plugin } from '@formkit/vue'
import { createZodPlugin } from '@formkit/zod'
import { type App, type Component, type VNode, createApp, defineComponent, h } from 'vue'
import { flush } from '../../shared/clock'
import { domDriver } from '../../shared/dom-driver'
import { leafSeed, shapeFor, zodSchemaFor } from '../../shared/scenarios'
import type { BenchAdapter, MountHandle } from '../contract'

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

function renderNodes(node: TrieNode, defaultValues: Record<string, unknown>): VNode[] {
  const out: VNode[] = []
  for (const [seg, child] of node.children) {
    if (child.leaf) {
      out.push(
        h(FormKitC, {
          key: seg,
          type: 'text',
          name: seg,
          value: leafSeed(defaultValues, child.leaf.path),
          delay: 0,
          'data-bench-field': child.leaf.index,
        })
      )
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

    const Host = defineComponent({
      name: 'FormKitHost',
      setup() {
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
      arrayOp: () => Promise.resolve(unsupported('arrayOp')),
      flipVariant: () => Promise.resolve(unsupported('flipVariant')),
      stepTransition: () => Promise.resolve(unsupported('stepTransition')),
      // FormKit owns its components; component render count is not applicable.
      // The grid scenario adds a DOM-mutation proxy, explicitly caveated.
      getRenderCount: () => null,
      resetRenderCount: () => {},
      teardown: () => app.unmount(),
    }
  },
}
