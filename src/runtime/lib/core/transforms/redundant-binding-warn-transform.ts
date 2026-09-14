import {
  createSimpleExpression,
  ElementTypes,
  NodeTypes,
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type NodeTransform,
  type TemplateChildNode,
} from '@vue/compiler-core'
import { V_REGISTER_COMPILED_MODIFIER } from '../../../core/register-protocol'

/**
 * `redundantBindingWarnTransform` — the compile-time half of the
 * redundant-binding guard (#464). For every element carrying a
 * `v-register` directive it does two things:
 *
 *   1. Warns (at build time, on `console.warn`) when a redundant STATE
 *      binding sits beside `v-register` — a `:value` / `v-model` on a
 *      text input or `<select>`, a `:checked` / `v-model` on a
 *      checkbox or radio, or a `:selected` on an `<option>` inside a
 *      `v-register`'d `<select>`. `v-register` already drives all of
 *      these, so the extra binding is redundant at best and a
 *      dual-binding bug at worst.
 *
 *   2. Stamps `V_REGISTER_COMPILED_MODIFIER` on the directive so the
 *      runtime diagnostic in `core/directive.ts` stands down. This
 *      transform runs BEFORE `inputTextAreaNodeTransform` /
 *      `componentBridgeTransform` strip and inject the value channel,
 *      so it sees the author's props verbatim; the runtime, which only
 *      sees the post-injection props, cannot. Exactly one layer fires
 *      per consumer.
 *
 * The carve-out: a `:value` (or static `value=`) is the legitimate
 * IDENTITY channel for a radio (`<input type="radio" :value="opt">`)
 * and an `<option>` (`<option :value="opt">`), and `v-register` READS
 * it. Those never warn. Only the STATE attrs do.
 *
 * A dynamic `:type` can't be classified at compile time, so its input
 * is skipped for the warn (best-effort, mirroring how
 * `inputTextAreaNodeTransform` and the runtime `resolveDynamicModel`
 * treat a non-static type). The marker is still stamped so the runtime
 * layer, which sees the resolved type, doesn't double-report.
 *
 * Not `__DEV__`-gated: it fires on every compile, including production
 * and CI builds, which is what lets a consumer retire a bespoke
 * SFC-lint gate. Warnings only — a redundant binding never fails the
 * build (the Vue compiler gives transforms no error channel, and a
 * library shouldn't nuke a consumer's build over a lint-level issue).
 *
 * Wired first in the `nodeTransforms` array by `attaform/vite` and
 * `attaform/nuxt`. Use directly only when integrating with a custom
 * bundler.
 */

// Node types that hold iterable children worth recursing into when
// walking a <select> for slotted <option>s. Mirrors the whitelist in
// component-bridge-transform.ts: skip text / interpolation / comment
// nodes, and don't crash on a future Vue node type we don't know.
const RECURSABLE_NODE_TYPES: ReadonlySet<number> = new Set<number>([
  NodeTypes.ELEMENT,
  NodeTypes.FOR,
  NodeTypes.IF,
  NodeTypes.IF_BRANCH,
])

/**
 * The author-facing display form of the first redundant STATE binding
 * among `props`, or `null` if none. `v-model` is the only one left, and
 * it renders as `v-model` — what the author would search their template
 * for.
 *
 * A `:value` / `:checked` (or the static form of either) used to count
 * too. It no longer does: the value injection keeps an author-written
 * one as its UNBOUND leg, so on a dual-mode wrapper it is not redundant,
 * it is the whole binding in the mode that has no field behind it. A
 * warning there would have told the author to delete the only thing
 * making that mode work (#620). Its one true-positive, a value binding
 * beside a `v-register` that is ALWAYS bound, is dead code rather than a
 * dual-binding bug, and the runtime layer still catches it wherever it
 * can tell — it warns only once a field has actually resolved.
 *
 * `v-model` stays: it installs Vue's own model directive next to ours,
 * so two writers drive one element with no fallback story between them.
 */
function findRedundantStateBinding(props: (AttributeNode | DirectiveNode)[]): string | null {
  for (const prop of props) {
    if (prop.type === NodeTypes.ATTRIBUTE) continue
    if (prop.name === 'model') return 'v-model'
  }
  return null
}

/**
 * The same question for an `<option>` under a `v-register`ed `<select>`,
 * where `selected` IS still redundant. The select's value injection
 * grew an unbound leg (#620); the option's `:selected` did not, because
 * an expression spliced in from the enclosing `<select>` cannot be
 * resolved in the option's own binding scope (#566). So an author's
 * `selected` here is still stripped with nothing put back, and saying so
 * remains the right diagnostic.
 */
function findRedundantSelectedBinding(props: (AttributeNode | DirectiveNode)[]): string | null {
  for (const prop of props) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      if (prop.name === 'selected') return 'selected'
      continue
    }
    if (prop.name === 'model') return 'v-model'
    if (
      prop.name === 'bind' &&
      prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
      prop.arg.isStatic &&
      prop.arg.content === 'selected'
    ) {
      return ':selected'
    }
  }
  return null
}

/**
 * Classify a `<input>` by its statically-known `type`, mirroring the
 * runtime `resolveDynamicModel`. Returns `'dynamic'` when `type` is a
 * non-literal binding (`:type="kind"`) that can't be read at compile
 * time, and `'file'` for file inputs (out of scope: browsers reject
 * `value` there).
 */
function classifyInput(
  props: (AttributeNode | DirectiveNode)[]
): 'text' | 'checkbox' | 'radio' | 'file' | 'dynamic' {
  let staticType: string | null = null
  for (const prop of props) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      if (prop.name === 'type') staticType = prop.value?.content ?? null
      continue
    }
    if (
      prop.name === 'bind' &&
      prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
      prop.arg.isStatic &&
      prop.arg.content === 'type'
    ) {
      // `:type="'radio'"` carries a literal simple expression we could
      // read, but the common `:type="kind"` does not. Treat any dynamic
      // `:type` as unclassifiable — conservative, matches the runtime
      // and the input/textarea transform's own `isDynamicTypeValue`.
      return 'dynamic'
    }
  }
  if (staticType === 'checkbox') return 'checkbox'
  if (staticType === 'radio') return 'radio'
  if (staticType === 'file') return 'file'
  // text / number / email / no explicit type / anything else scalar.
  return 'text'
}

function emitRedundantWarning(tag: string, binding: string): void {
  console.warn(
    `[attaform] \`${binding}\` is redundant beside v-register on <${tag}>. ` +
      `v-register already drives this field's value, so keep v-register alone and ` +
      `drop \`${binding}\`. (An identity \`:value\` on a radio or <option> is expected ` +
      `and stays silent.)`
  )
}

// Walk a <select v-register>'s children for a redundant <option :selected>.
// The option's own `:value` / `value=` is its identity (silent); only a
// `:selected` / `selected` is redundant, since the component-bridge transform
// drives option selection from the select's single register. Options can be
// nested under v-for / v-if, so recurse the same node types the bridge does.
function walkOptionsForSelected(selectNode: ElementNode): void {
  const visit = (candidate: TemplateChildNode): void => {
    if (candidate.type === NodeTypes.ELEMENT && candidate.tag === 'option') {
      const found = findRedundantSelectedBinding(candidate.props)
      if (found !== null) emitRedundantWarning('option', found)
      return // an <option>'s own children never hold another <option>
    }
    if (!RECURSABLE_NODE_TYPES.has(candidate.type)) return
    if (!('children' in candidate)) return
    for (const child of candidate.children) {
      if (typeof child === 'string' || typeof child === 'symbol') continue
      if (child.type === NodeTypes.SIMPLE_EXPRESSION) continue
      visit(child)
    }
  }
  for (const child of selectNode.children) visit(child)
}

// Warn for a native <input> / <select> / <textarea>. Component and
// custom-element hosts are skipped: there a `:value` / `v-model` is the
// legitimate prop channel, not a redundant state binding.
function warnIfRedundant(node: ElementNode): void {
  if (node.tagType !== ElementTypes.ELEMENT) return
  const tag = node.tag

  if (tag === 'select') {
    const found = findRedundantStateBinding(node.props)
    if (found !== null) emitRedundantWarning('select', found)
    walkOptionsForSelected(node)
    return
  }

  if (tag === 'textarea') {
    const found = findRedundantStateBinding(node.props)
    if (found !== null) emitRedundantWarning('textarea', found)
    return
  }

  if (tag !== 'input') return

  const kind = classifyInput(node.props)
  // Dynamic type: can't classify at compile time. File: out of scope.
  if (kind === 'dynamic' || kind === 'file') return
  const found = findRedundantStateBinding(node.props)
  if (found !== null) emitRedundantWarning('input', found)
}

/**
 * Vue compiler node transform that warns about a redundant state
 * binding co-located with `v-register`, and stamps the
 * compile-active marker so the runtime diagnostic stands down.
 *
 * Must run BEFORE `inputTextAreaNodeTransform` and
 * `componentBridgeTransform` so it reads the author's props before they
 * are stripped / injected. Wired first by `attaform/vite` and
 * `attaform/nuxt`.
 */
export const redundantBindingWarnTransform: NodeTransform = (node) => {
  try {
    if (node.type !== NodeTypes.ELEMENT) return
    const registerProp = node.props.find(
      (prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE && prop.name === 'register'
    )
    if (registerProp === undefined) return

    // Idempotency: a doubly-applied pipeline (test combinatorics, some
    // bundler configs) would otherwise warn twice and stamp twice. The
    // marker is our own record that we've processed this directive.
    const alreadyProcessed = registerProp.modifiers.some(
      (modifier) =>
        modifier.type === NodeTypes.SIMPLE_EXPRESSION &&
        modifier.content === V_REGISTER_COMPILED_MODIFIER
    )
    if (alreadyProcessed) return

    // Warn selectively (native, statically-classifiable controls); stamp
    // unconditionally (every v-register, so the runtime always stands down).
    warnIfRedundant(node)
    registerProp.modifiers.push(createSimpleExpression(V_REGISTER_COMPILED_MODIFIER, true))
  } catch (err) {
    // AST shape drift across @vue/compiler-core versions, or a malformed
    // directive: skip. The guard is a diagnostic; skipping it never
    // affects a correct template's output. Matches every sibling
    // transform's fail-safe posture.
    console.error('[attaform] redundant-binding warn transform failed, skipping:', err)
  }
}
