/**
 * Rewrites every `<element v-register="<expr>">` so the binding
 * expression wraps `<expr>` in an IIFE that calls
 * `markConnectedOptimistically()` on the resulting `RegisterValue` and
 * hands back the same object:
 *
 *   ((__attaRv) => (__attaRv?.markConnectedOptimistically?.(), __attaRv))(<expr>)
 *
 * Vue deliberately skips directive lifecycle hooks during SSR (see the
 * header of `core/directive.ts`), so the `v-register` directive's
 * `created` hook, the one that flips `connected: true`, never fires on
 * the server. Every SSR'd FieldState therefore serialises `connected:
 * false`, then flickers to `true` when the directive runs on hydration,
 * and anything reading `getFieldState(path).connected` in a
 * server-rendered template sees the stale value baked into the HTML.
 *
 * The IIFE captures the `RegisterValue` `<expr>` produced, fires the
 * optimistic mark, itself guarded by `state.ssr` so it is a free no-op
 * on the client, and returns the same object, so the directive receives
 * exactly what the author wrote.
 *
 * It is agnostic to the shape of `<expr>`, inline, hoisted into a
 * variable, or dynamically built: all three produce a `RegisterValue` at
 * runtime and the wrapper never needs the path string. A setup-time
 * `register()` call NEVER bound to `v-register` gets no wrapper, no
 * mark, and stays `connected: false` after hydration, which is correct:
 * it represents no rendered DOM element.
 *
 * Idempotent. Running twice on one AST, as some bundler configurations
 * do, detects the marker on the second pass and skips re-wrapping.
 */
import {
  createCompoundExpression,
  NodeTypes,
  type CompoundExpressionNode,
  type ExpressionNode,
  type NodeTransform,
} from '@vue/compiler-core'

const HINT_MARKER = '__attaRv'
const HINT_PREFIX = `((${HINT_MARKER}) => (${HINT_MARKER}?.markConnectedOptimistically?.(), ${HINT_MARKER}))(`
const HINT_SUFFIX = `)`

/**
 * Vue compiler node transform that wraps every `v-register` expression
 * in a small IIFE, so the directive can flag a field connected during
 * SSR and `getFieldState(path).connected` does not flicker after
 * hydration.
 *
 * It must run after `vRegisterPreambleTransform`. `attaform/vite` and
 * `attaform/nuxt` wire both.
 */
export const vRegisterHintTransform: NodeTransform = (node) => {
  try {
    if (node.type !== NodeTypes.ELEMENT) return
    for (const prop of node.props) {
      if (prop.type !== NodeTypes.DIRECTIVE) continue
      if (prop.name !== 'register') continue
      if (prop.exp === undefined) continue
      if (isAlreadyWrapped(prop.exp)) continue
      prop.exp = wrapWithOptimisticHint(prop.exp)
    }
  } catch (err) {
    // AST shape drift across `@vue/compiler-core` versions, or a
    // malformed directive, skips the transform. Without the wrapper the
    // only cost is the flicker on first paint, never an incorrect
    // render.
    console.error('[attaform] v-register hint transform failed, skipping:', err)
  }
}

function isAlreadyWrapped(exp: ExpressionNode): boolean {
  if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
    return exp.content.includes(HINT_MARKER)
  }
  // On a compound expression, scan only the string children. A nested
  // `SimpleExpressionNode` was copied verbatim from the author's
  // expression and cannot hold the marker, which appears only in the
  // literal prefix and suffix strings this transform adds.
  for (const child of exp.children) {
    if (typeof child === 'string' && child.includes(HINT_MARKER)) return true
  }
  return false
}

function wrapWithOptimisticHint(exp: ExpressionNode): CompoundExpressionNode {
  // A SimpleExpression keeps its node intact as a child, so a later
  // `processExpression` pass, prefixing identifiers for setup refs, still
  // walks it. A CompoundExpression has its children spliced in instead:
  // prefix string prepended, suffix appended, which preserves the
  // post-prefix shape downstream transforms expect.
  const innerChildren: CompoundExpressionNode['children'] =
    exp.type === NodeTypes.SIMPLE_EXPRESSION ? [exp] : [...exp.children]
  // The wrapped expression's source location, so a runtime error in the
  // IIFE points at the v-register binding site rather than line 0.
  return createCompoundExpression([HINT_PREFIX, ...innerChildren, HINT_SUFFIX], exp.loc)
}
