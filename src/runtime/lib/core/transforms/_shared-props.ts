import type {
  AttributeNode,
  CompoundExpressionNode,
  DirectiveNode,
  ExpressionNode,
  RootNode,
  SimpleExpressionNode,
  TemplateChildNode,
} from '@vue/compiler-core'
import { NodeTypes } from '@vue/compiler-core'

/**
 * Shared prop-summarization toolkit for the compile-time node
 * transforms. `input-text-area-transform.ts` and
 * `component-bridge-transform.ts` both summarize their host element's
 * props into a uniform `{ key, value }` shape before deciding which
 * directive to inject, which props to strip, and how to construct the
 * synthesized binding.
 * The summarization rules are byte-identical across both transforms;
 * keeping two copies risked silent drift — particularly on key-shape
 * decisions (`isExactKey`) and quoting (`renderAsStatic`).
 *
 * Consumers in the `transforms/` directory only — not exported from
 * any package barrel. The underscore prefix mirrors the existing
 * convention for transform-internal modules.
 */

/**
 * Uniform summary of a Vue-compiler AST prop. `key` is the prop name
 * (string for attributes, the rendered text of `arg` for directive
 * binds); `value` is either a string (attribute literal, simple
 * expression, or quoted static) or the children array of a
 * `CompoundExpressionNode` (template literals, interpolated
 * expressions, etc.).
 */
export type SummarizedProp = {
  key: string
  value: string | CompoundExpressionNode['children']
}

/**
 * Summarize every prop on a Vue-compiler element node into the
 * `SummarizedProp` shape. Returns an empty array for nodes that don't
 * carry props (template / interpolation / comment).
 */
export function getSummarizedProps(node: RootNode | TemplateChildNode): SummarizedProp[] {
  if (!('props' in node)) return []
  const props = node.props

  const summarizedProps = props.reduce<SummarizedProp[]>((acc, currProp) => {
    if (currProp.type === NodeTypes.ATTRIBUTE) {
      const key = currProp.name
      const value = currProp.value?.content ?? ''
      return [...acc, { key, value: renderAsStatic(value, true) }]
    }

    if (currProp.exp === undefined) return acc
    const key = currProp.arg
      ? getSummarizedPropValue(currProp.arg)
      : renderAsStatic(currProp.name, true)
    if (typeof key !== 'string') return acc // key must always be a string
    const value = getSummarizedPropValue(currProp.exp)

    return [...acc, { key, value }]
  }, [])

  return summarizedProps
}

/**
 * Wrap a static value in double quotes so it serializes back to a
 * JS string literal. Pass `isStatic: false` to return the raw text
 * unchanged (already a dynamic-expression source string).
 */
export function renderAsStatic(val: string, isStatic: boolean): string {
  return isStatic ? `"${val}"` : val
}

/**
 * Resolve an ExpressionNode to its `SummarizedProp['value']` shape —
 * either a quoted static literal (for simple static expressions) or
 * the raw children array (for compound / interpolated expressions).
 */
export function getSummarizedPropValue(exp: ExpressionNode): SummarizedProp['value'] {
  if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
    return renderAsStatic(exp.content, exp.isStatic)
  }

  return exp.children
}

/**
 * Mutate `props` in place to drop every entry whose name (or
 * directive-arg content) matches any of `propNames`. Indices are
 * collected high-to-low so the splice loop doesn't shift remaining
 * entries mid-iteration.
 */
export function removePropsByName(
  props: (AttributeNode | DirectiveNode)[],
  propNames: string[]
): void {
  const removePropIndices: number[] = []
  for (let index = 0; index < props.length; index++) {
    const prop = props[index]
    if (!prop) continue

    if (
      propNames.includes(prop.name) ||
      ('arg' in prop && prop.arg && 'content' in prop.arg && propNames.includes(prop.arg.content))
    ) {
      removePropIndices.push(index) // store index to remove later, don't mutate variable while looping through it
    }
  }

  for (const index of removePropIndices.sort((a, z) => z - a)) {
    props.splice(index, 1) // index runs from high to low, so this works
  }
}

/**
 * Exact prop-name match. Pre-rewrite used .includes('register') /
 * .includes('value') / .includes('type') which false-positived on
 * any user prop whose name contained those substrings (e.g.
 * `data-register-id`, `valueFoo`, `prototype`, `:registerField`).
 *
 * Summarized keys come in three shapes depending on prop type:
 *   attribute       -> "name"          (from getSummarizedProps)
 *   v-bind:name="x" -> "\"name\""      (quoted via renderAsStatic)
 *   static v-prefix -> "\"name\""
 */
export function isExactKey(summarizedKey: string, name: string): boolean {
  return summarizedKey === name || summarizedKey === `"${name}"`
}

/**
 * Flatten an ExpressionNode (`SimpleExpressionNode` |
 * `CompoundExpressionNode`) back to its source-text string. Compound
 * nodes carry a list of strings interleaved with nested expression
 * nodes — concatenate the textual content to reconstruct the source.
 *
 * Single source of truth for the component-bridge transform's
 * per-`<option>` processExpression input AND the v-register preamble
 * transform's pre-wrap binding capture. Both call sites built equivalent
 * inline helpers; the consolidation prevents drift in how a future Vue
 * node-type addition gets handled.
 *
 * Children that aren't string / SIMPLE / COMPOUND (symbols from the
 * codegen helper indices; node types added in a future Vue) are
 * dropped silently — the serialized text is for downstream parsing,
 * not faithful round-trip.
 */
export function flattenExpression(exp: ExpressionNode): string {
  if (exp.type === NodeTypes.SIMPLE_EXPRESSION) return exp.content
  let out = ''
  for (const child of exp.children) {
    if (typeof child === 'string') {
      out += child
      continue
    }
    if (typeof child === 'symbol') continue
    const node = child as ExpressionNode | SimpleExpressionNode
    if (node.type === NodeTypes.SIMPLE_EXPRESSION) {
      out += node.content
      continue
    }
    if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
      out += flattenExpression(node)
    }
  }
  return out
}
