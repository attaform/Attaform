/**
 * Closes the render-order edge `vRegisterHintTransform` alone leaves
 * open.
 *
 * The hint transform wraps each `v-register` expression in an IIFE that
 * calls `markConnectedOptimistically()` when the element's vnode is
 * created, which covers any expression evaluated AT or AFTER the input
 * in render order. Vue's SSR is single-pass top to bottom, though, so in
 *
 *   <pre>{{ form.fields.password.connected }}</pre>
 *   <input v-register="form.register('password')" />
 *
 * the `<pre>` evaluates BEFORE the wrapper has fired. The serialized
 * HTML carries `connected: false`, the post-hydration steady state says
 * `true`, and the user sees a one-tick flicker.
 *
 * So the marks hoist one level up. The walk collects every static
 * `v-register` binding, skipping `v-for` descendants, whose expressions
 * reference loop locals unavailable at root scope, and prepends a
 * synthetic `:data-atta-pre-mark` directive to the first root element.
 * Vue evaluates an element's prop bindings before recursing into its
 * children, so that IIFE fires every collected mark before any
 * descendant expression runs. Its own expression resolves to
 * `undefined`, which the SSR renderer drops, so no attribute appears and
 * the marks are the only output.
 *
 * Register it BEFORE `vRegisterHintTransform`. The pre-order pass here
 * captures each expression's original, un-wrapped text into a
 * per-template state map, the hint transform then wraps the in-place
 * directive expression, and the exit hook on the first root element
 * builds the preamble from the captured originals. An element's exit
 * hooks fire before `transformElement`'s codegen exit, so the injected
 * prop lands in the rendered output.
 *
 * For a `v-for` descendant the hint transform's per-element wrapper
 * stays load-bearing: those bindings cannot hoist, their path
 * expressions referencing loop-scoped identifiers.
 */
import {
  createSimpleExpression,
  NodeTypes,
  type DirectiveNode,
  type ElementNode,
  type ExpressionNode,
  type NodeTransform,
  type RootNode,
  type SimpleExpressionNode,
} from '@vue/compiler-core'
import { flattenExpression } from './_shared-props'

/**
 * Per-root traversal state, keyed by the RootNode object, which is stable
 * for one compile pass and collectable across pipelines.
 *   - `captured`: the pre-wrap expression strings, in visit order.
 *   - `vForDepth`: `v-for` ancestry, bumped on FOR entry and dropped on
 *     FOR exit, so an element visit in between skips captures cheaply.
 *   - `firstRootElementVisited`: keeps the injection exit-hook on the
 *     very first root element. A multi-root template still has one
 *     first: Vue wraps it in a fragment, and that element's props
 *     evaluate before any sibling's.
 */
type TraversalState = {
  readonly captured: string[]
  /**
   * Elements whose v-register binding this root traversal has already
   * captured. It guards double-capture when the same transform is
   * registered twice in `nodeTransforms`, which some bundler chains do;
   * without it every binding's mark call appears twice in the injected
   * expression.
   */
  readonly capturedElements: WeakSet<ElementNode>
  vForDepth: number
  firstRootElementVisited: boolean
}
const stateByRoot: WeakMap<RootNode, TraversalState> = new WeakMap()

const PREAMBLE_ATTR = 'data-atta-pre-mark'

/**
 * Vue compiler node transform that hoists `v-register`'s SSR connection
 * marks to the root of the template. With `vRegisterHintTransform`, it
 * is what lets an expression EARLIER in the template read
 * `getFieldState(path).connected` correctly during the server's
 * single-pass render.
 *
 * It must run before `vRegisterHintTransform`. `attaform/vite` and
 * `attaform/nuxt` wire both.
 */
export const vRegisterPreambleTransform: NodeTransform = (node, context) => {
  try {
    if (node.type === NodeTypes.ROOT) {
      // Existing state means a duplicate registration of this transform.
      // Keep the first run's state; re-initialising would wipe its
      // captures.
      if (stateByRoot.has(node)) return
      stateByRoot.set(node, {
        captured: [],
        capturedElements: new WeakSet<ElementNode>(),
        vForDepth: 0,
        firstRootElementVisited: false,
      })
      return () => {
        // Cleanup on root exit. The injection happened on the first root
        // element's exit, registered below, and by now that element's
        // `transformElement` codegen has absorbed the injected prop.
        stateByRoot.delete(node)
      }
    }

    const state = stateByRoot.get(context.root)
    if (state === undefined) return

    if (node.type === NodeTypes.FOR) {
      // compiler-core's own `transformFor` runs first and wraps any
      // element carrying v-for in a `NodeTypes.FOR` node. Bumping the
      // depth on entry and dropping it on exit makes "am I inside a
      // v-for?" O(1) for the element visits below.
      state.vForDepth += 1
      return () => {
        state.vForDepth -= 1
      }
    }

    if (node.type !== NodeTypes.ELEMENT) return

    // Capture this element's v-register binding BEFORE deciding about
    // exit-hook registration, so the very first root element, which may
    // carry one itself, contributes to the preamble it hosts.
    captureVRegisterIfStatic(node, state)

    // The first root element registers the exit hook that injects the
    // preamble from the FINAL collected state. Exit hooks fire after the
    // children are traversed, so every descendant capture has landed in
    // `state.captured` by then.
    if (!state.firstRootElementVisited && context.parent?.type === NodeTypes.ROOT) {
      state.firstRootElementVisited = true
      return () => {
        const finalState = stateByRoot.get(context.root)
        if (finalState === undefined || finalState.captured.length === 0) return
        injectPreamble(node, finalState.captured)
      }
    }
    return
  } catch (err) {
    // AST shape drift or a malformed directive skips the transform.
    // `vRegisterHintTransform` still covers the common case, a read at or
    // after the input, so only the read-before-input edge is lost.
    console.error('[attaform] v-register preamble transform failed, skipping:', err)
    return
  }
}

function captureVRegisterIfStatic(node: ElementNode, state: TraversalState): void {
  if (state.vForDepth > 0) return
  // An element carrying v-for has not been wrapped by `transformFor`
  // yet when a user transform sees it, ordering varying by bundler, so
  // check the directive itself.
  if (hasVForDirective(node)) return
  // One capture per element per root traversal. Registering the
  // transform twice in `nodeTransforms` would otherwise double every
  // binding's mark call inside the injected expression.
  if (state.capturedElements.has(node)) return

  const exp = findVRegisterExpression(node)
  if (exp === null) return
  state.capturedElements.add(node)
  // Pre-wrap capture. This transform is registered BEFORE
  // `vRegisterHintTransform`, so `prop.exp` is still the original
  // expression; the hint's wrap happens after this pre-order pass
  // returns from the same node.
  state.captured.push(flattenExpression(exp))
}

function findVRegisterExpression(node: ElementNode): ExpressionNode | null {
  for (const prop of node.props) {
    if (prop.type !== NodeTypes.DIRECTIVE) continue
    if (prop.name !== 'register') continue
    if (prop.exp === undefined) continue
    return prop.exp
  }
  return null
}

function hasVForDirective(node: ElementNode): boolean {
  for (const prop of node.props) {
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'for') return true
  }
  return false
}

/**
 * Build and prepend the `:data-atta-pre-mark` directive to the element's
 * props. The expression is a comma-chain of
 * `(<expr>)?.markConnectedOptimistically?.()` calls ending in
 * `undefined`, so the attribute resolves to `undefined` and the SSR
 * renderer omits it: the marks fire during evaluation and no HTML
 * attribute appears.
 *
 * The exp is a `SimpleExpressionNode` with `isStatic: false`, so
 * `transformElement`'s exit codegen prefixes `form` to `_ctx.form` just
 * as it does for every other dynamic binding. That works because this
 * exit hook runs BEFORE `transformElement`'s: being registered later in
 * `nodeTransforms` means firing earlier in the reverse pass.
 */
function injectPreamble(element: ElementNode, captured: readonly string[]): void {
  if (hasPreamble(element)) return

  // Each entry is a try/catch IIFE. The preamble is best-effort, and
  // only for the read-before-input edge (see the file header), so a
  // throw inside one entry must not stop the rest firing or break SSR.
  // The usual throw is a v-register against a null `ctx`, where
  // `injectForm` returned null and a v-if the AST walker cannot see
  // gates the input: that check fires later, so the preamble would
  // dereference null here.
  const callList = captured
    .map((source) => `(()=>{try{(${source})?.markConnectedOptimistically?.()}catch{}})()`)
    .join(', ')
  const expressionText = `(${callList}, undefined)`
  const exp: SimpleExpressionNode = createSimpleExpression(expressionText, false /* not static */)

  const directive: DirectiveNode = {
    type: NodeTypes.DIRECTIVE,
    name: 'bind',
    arg: createSimpleExpression(PREAMBLE_ATTR, true /* static arg */),
    exp,
    modifiers: [],
    // The host element's source location, so a runtime error in the
    // synthesized expression points at the consumer's template line
    // rather than at line 0.
    loc: element.loc,
  }
  element.props.unshift(directive)
}

function hasPreamble(element: ElementNode): boolean {
  for (const prop of element.props) {
    if (prop.type !== NodeTypes.DIRECTIVE) continue
    if (prop.name !== 'bind') continue
    if (prop.arg === undefined) continue
    if (prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION) continue
    if (prop.arg.content === PREAMBLE_ATTR) return true
  }
  return false
}
