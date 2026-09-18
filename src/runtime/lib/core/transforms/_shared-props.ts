/**
 * Shared prop-summarization toolkit for the compile-time node
 * transforms. `input-text-area-transform.ts` and
 * `component-bridge-transform.ts` both summarize their host element's
 * props into a uniform `{ key, value }` shape before deciding which
 * directive to inject, which props to strip, and how to build the
 * synthesized binding, and the rules are identical on both sides. Two
 * copies would drift, particularly on the key-shape decision in
 * `isExactKey` and the quoting in `renderAsStatic`.
 *
 * For the `transforms/` directory only; no package barrel exports it,
 * and the underscore prefix marks it transform-internal.
 */
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
 * Uniform summary of a Vue-compiler AST prop. `key` is the prop name: a
 * string for an attribute, the rendered text of `arg` for a directive
 * bind. `value` is either a string, meaning an attribute literal, a
 * simple expression or a quoted static, or the children array of a
 * `CompoundExpressionNode`, meaning a template literal or an
 * interpolated expression.
 */
export type SummarizedProp = {
  key: string
  value: string | CompoundExpressionNode['children']
}

/**
 * Summarize every prop on a Vue-compiler element node. An empty array for
 * a node that carries none: template, interpolation, comment.
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
function renderAsStatic(val: string, isStatic: boolean): string {
  return isStatic ? `"${val}"` : val
}

/**
 * Resolve an ExpressionNode to its `SummarizedProp['value']` shape:
 * a quoted static literal for a simple static expression, the raw
 * children array for a compound or interpolated one.
 */
function getSummarizedPropValue(exp: ExpressionNode): SummarizedProp['value'] {
  if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
    return renderAsStatic(exp.content, exp.isStatic)
  }

  return exp.children
}

/**
 * Drop every entry from `props`, in place, whose name or directive-arg
 * content matches one of `propNames`. Indices are collected high to low
 * so the splice loop cannot shift a remaining entry mid-iteration.
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
 * A summarized prop's value as compound-expression children, ready to
 * splice into an injected expression. `undefined` in, `undefined` out, so
 * one call answers "did the author bind this?" and builds the fallback
 * leg at once.
 */
export function toExpressionArray(
  value: SummarizedProp['value'] | undefined
): CompoundExpressionNode['children'] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

/**
 * Exact prop-name match, and it MUST stay exact. A substring test
 * (`.includes('register')`, `.includes('value')`, `.includes('type')`)
 * false-positives on any author prop whose name merely contains one:
 * `data-register-id`, `valueFoo`, `prototype`, `:registerField`.
 *
 * A summarized key comes in three shapes depending on prop type:
 *   attribute       -> "name"          (from getSummarizedProps)
 *   v-bind:name="x" -> "\"name\""      (quoted via renderAsStatic)
 *   static v-prefix -> "\"name\""
 */
export function isExactKey(summarizedKey: string, name: string): boolean {
  return summarizedKey === name || summarizedKey === `"${name}"`
}

/**
 * Flatten a `SimpleExpressionNode` or `CompoundExpressionNode` back to
 * its source text. A compound node holds strings interleaved with nested
 * expression nodes, so the textual content concatenates to reconstruct
 * the source.
 *
 * It is the single source of truth for two call sites: the
 * component-bridge transform's per-`<option>` `processExpression` input
 * and the preamble transform's pre-wrap binding capture. One helper is
 * what keeps them agreeing about a future Vue node-type addition.
 *
 * A child that is neither a string nor SIMPLE nor COMPOUND, a symbol
 * from the codegen helper indices or a node type a future Vue adds, is
 * dropped silently: the serialized text feeds downstream parsing, not a
 * faithful round-trip.
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
