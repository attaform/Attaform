import {
  createSimpleExpression,
  ElementTypes,
  NodeTypes,
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type NodeTransform,
} from '@vue/compiler-core'
import { V_REGISTER_COMPILED_MODIFIER } from '../../../core/register-protocol'

/**
 * `redundantBindingWarnTransform` — the compile-time half of the
 * redundant-binding guard (#464). For every element carrying a
 * `v-register` directive it does two things:
 *
 *   1. Warns (at build time, on `console.warn`) when a `v-model` sits
 *      beside `v-register` on a native `<input>` / `<select>` /
 *      `<textarea>`. That installs Vue's own model directive next to
 *      ours, so two writers drive one element with no fallback story
 *      between them. A `:value` / `:checked` on those, and a
 *      `:selected` on an `<option>`, used to warn here too; #620 made
 *      each of them the UNBOUND leg of the injected binding instead.
 *      See `findRedundantStateBinding` below for the full reasoning.
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
 *
 * An `<option>`'s `:selected` left for the same reason once its binding
 * moved to the option's own visit, where the unbound leg became
 * expressible. Nothing walks a `<select>`'s children here any more.
 */
function findRedundantStateBinding(props: (AttributeNode | DirectiveNode)[]): string | null {
  for (const prop of props) {
    if (prop.type === NodeTypes.ATTRIBUTE) continue
    if (prop.name === 'model') return 'v-model'
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
// Warn for a native <input> / <select> / <textarea>. Component and
// custom-element hosts are skipped: there a `:value` / `v-model` is the
// legitimate prop channel, not a redundant state binding.
function warnIfRedundant(node: ElementNode): void {
  if (node.tagType !== ElementTypes.ELEMENT) return
  const tag = node.tag

  if (tag === 'select') {
    const found = findRedundantStateBinding(node.props)
    if (found !== null) emitRedundantWarning('select', found)
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
