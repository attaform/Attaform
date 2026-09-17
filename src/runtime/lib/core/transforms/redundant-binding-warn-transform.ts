/**
 * The compile-time half of the redundant-binding guard (#464). On every
 * element carrying `v-register` it does two things.
 *
 *   1. Warns at build time when a `v-model` sits beside `v-register` on
 *      a native `<input>`, `<select>` or `<textarea>`, which installs
 *      Vue's own model directive next to Attaform's: two writers driving
 *      one element with no fallback story between them.
 *      `findRedundantStateBinding` below carries the full reasoning for
 *      what does and does not count.
 *
 *   2. Stamps `V_REGISTER_COMPILED_MODIFIER` on the directive so the
 *      runtime diagnostic in `core/directive.ts` stands down. This
 *      transform runs BEFORE `inputTextAreaNodeTransform` and
 *      `componentBridgeTransform` strip and inject the value channel, so
 *      it sees the author's props verbatim where the runtime, seeing
 *      only the post-injection props, cannot. Exactly one layer fires
 *      per consumer.
 *
 * The carve-out: a `:value`, or a static `value=`, is the legitimate
 * IDENTITY channel for a radio and an `<option>`, and `v-register` READS
 * it. Those never warn; only the STATE attrs do.
 *
 * A dynamic `:type` cannot be classified at compile time, so that input
 * is skipped for the warn, best-effort as in `inputTextAreaNodeTransform`
 * and the runtime `resolveDynamicModel`. The marker is still stamped, so
 * the runtime layer, which sees the resolved type, does not double-report.
 *
 * It is deliberately NOT `__DEV__`-gated: firing on every compile,
 * production and CI included, is what lets a consumer retire a bespoke
 * SFC-lint gate. Warnings only. A redundant binding never fails the
 * build, the Vue compiler giving transforms no error channel and a
 * library having no business nuking a consumer's build over a
 * lint-level issue.
 *
 * `attaform/vite` and `attaform/nuxt` wire it first in `nodeTransforms`;
 * reach for it directly only when integrating a custom bundler.
 */
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
 * The author-facing display form of the first redundant STATE binding
 * among `props`, or `null`. `v-model` is the only one that counts, and
 * it renders as `v-model`, which is what an author would search their
 * template for. It earns the warn by installing Vue's own model
 * directive next to Attaform's: two writers on one element with no
 * fallback story between them.
 *
 * A `:value` or `:checked`, static or bound, does NOT count, and neither
 * does an `<option>`'s `:selected`. The value injection keeps an
 * author-written one as its UNBOUND leg, so on a dual-mode wrapper it is
 * not redundant at all: it is the whole binding in the mode with no
 * field behind it, and warning there would tell the author to delete the
 * only thing making that mode work (#620). The one true positive, a
 * value binding beside a v-register that is ALWAYS bound, is dead code
 * rather than a dual-binding bug, and the runtime layer catches it
 * wherever it can tell, warning only once a field has resolved.
 */
function findRedundantStateBinding(props: (AttributeNode | DirectiveNode)[]): string | null {
  for (const prop of props) {
    if (prop.type === NodeTypes.ATTRIBUTE) continue
    if (prop.name === 'model') return 'v-model'
  }
  return null
}

/**
 * Classify an `<input>` by its statically-known `type`, as the runtime
 * `resolveDynamicModel` does. `'dynamic'` for a non-literal binding like
 * `:type="kind"` that cannot be read at compile time, and `'file'` for a
 * file input, which is out of scope since browsers reject `value`
 * there.
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
      // `:type="'radio'"` carries a readable literal, but the common
      // `:type="kind"` does not, so every dynamic `:type` counts as
      // unclassifiable. Conservative, and it matches both the runtime and
      // `isDynamicTypeValue` in the input/textarea transform.
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
// Native `<input>`, `<select>` and `<textarea>` only. On a component or
// custom-element host a `:value` or `v-model` is the legitimate prop
// channel, not a redundant state binding.
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
  // A dynamic type cannot be classified here; a file input is out of
  // scope.
  if (kind === 'dynamic' || kind === 'file') return
  const found = findRedundantStateBinding(node.props)
  if (found !== null) emitRedundantWarning('input', found)
}

/**
 * Vue compiler node transform that warns about a redundant state binding
 * sitting beside `v-register`, and stamps the compile-active marker so
 * the runtime diagnostic stands down.
 *
 * It MUST run before `inputTextAreaNodeTransform` and
 * `componentBridgeTransform`, so it reads the author's props before they
 * are stripped and injected. `attaform/vite` and `attaform/nuxt` wire it
 * first.
 */
export const redundantBindingWarnTransform: NodeTransform = (node) => {
  try {
    if (node.type !== NodeTypes.ELEMENT) return
    const registerProp = node.props.find(
      (prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE && prop.name === 'register'
    )
    if (registerProp === undefined) return

    // A doubly-applied pipeline, from test combinatorics or some bundler
    // configs, would otherwise warn twice and stamp twice. The marker is
    // this transform's own record of having processed the directive.
    const alreadyProcessed = registerProp.modifiers.some(
      (modifier) =>
        modifier.type === NodeTypes.SIMPLE_EXPRESSION &&
        modifier.content === V_REGISTER_COMPILED_MODIFIER
    )
    if (alreadyProcessed) return

    // Warn selectively, on native statically-classifiable controls;
    // stamp unconditionally, so the runtime always stands down.
    warnIfRedundant(node)
    registerProp.modifiers.push(createSimpleExpression(V_REGISTER_COMPILED_MODIFIER, true))
  } catch (err) {
    // AST shape drift across `@vue/compiler-core` versions, or a
    // malformed directive, skips the transform. The guard is a
    // diagnostic, so skipping it never changes a correct template's
    // output. Same fail-safe posture as every sibling transform.
    console.error('[attaform] redundant-binding warn transform failed, skipping:', err)
  }
}
