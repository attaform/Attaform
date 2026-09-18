/**
 * Vue compiler node transform that bridges `v-register` into the binding
 * shapes its consumers expect, on two kinds of host.
 *
 *   - `<select v-register>` gets `:value` on a single-select plus a
 *     per-`<option>` `:selected`, so the runtime directive can pre-mark
 *     selected options at SSR time.
 *   - `<MyComponent v-register>`, and a kebab-case custom-element host,
 *     gets a `:registerValue` bridge prop, so `useRegister` inside the
 *     child sees the parent's RegisterValue. Any parent-authored slotted
 *     `<option>` is marked exactly as the native path marks it, so a
 *     `<select>` wrapped in a styled component keeps its SSR-selected
 *     option (#394).
 *
 * `attaform/vite` and `attaform/nuxt` wire it for you; reach for it
 * directly only when integrating a custom bundler.
 */
import {
  createCompoundExpression,
  createSimpleExpression,
  ElementTypes,
  NodeTypes,
  processExpression,
  type AttributeNode,
  type CompoundExpressionNode,
  type DirectiveNode,
  type ExpressionNode,
  type NodeTransform,
  type PlainElementNode,
  type RootNode,
  type SourceLocation,
  type TemplateChildNode,
} from '@vue/compiler-core'
import { SSR_COMPONENT_HOST_MODIFIER } from '../../../core/register-protocol'
import {
  flattenExpression,
  getSummarizedProps,
  isExactKey,
  toExpressionArray,
  removePropsByName,
  type SummarizedProp,
} from './_shared-props'

/**
 * Build one `<option>`'s `:selected` expression.
 *
 * Every term MUST resolve in the option's OWN binding scope: the
 * register and `multiple` expressions come from the enclosing
 * `<select>`, which encloses every option, and the value expression is
 * the option's own. Nothing may reference a sibling option, which is the
 * property that makes this safe under `v-for`, and it is not a
 * theoretical one: an option inside a `v-for` cannot be referenced from
 * a sibling loop at all, so an expression that reached across emitted
 * the first loop's alias inside the second loop's render callback and
 * died at render with `ReferenceError: a is not defined` (#566).
 *
 * Two options sharing one value on a single-select need no
 * disambiguation here. They are indistinguishable to the user, the
 * browser resolves the duplicate on parse, and the directive re-syncs
 * from the model at mount.
 */
function generateEqualityExpression(
  selectValue: SummarizedProp['value'],
  optionValue: SummarizedProp['value'],
  multipleExpression: CompoundExpressionNode['children']
): CompoundExpressionNode['children'] {
  const selectValueArr = Array.isArray(selectValue) ? selectValue : [selectValue]
  const optionValueArr = Array.isArray(optionValue) ? optionValue : [optionValue]

  function getImplicitTrueMultipleExpression(expression: CompoundExpressionNode['children']) {
    // Identify user passing in `multiple` as an implied truthy prop
    if (expression.length === 1 && expression[0] === '') return [`true`]
    return expression
  }

  // The single-select branch String-coerces both sides, mirroring the
  // runtime directive's `looseEqual`-style match, so a typed-numeric
  // model (`z.number()`) matches `<option value="1">` at SSR time. The
  // `typeof !== 'object'` guard keeps an array model from matching on a
  // single-select: an array stringifies to its joined elements, which
  // would false-positive against a single-element option. The
  // multi-select branch keeps `innerRef.value`, Array and Set models
  // needing findIndex and membership iteration.
  //
  // It compares against `displayValue`, the same ref the `:value`
  // injection on the enclosing `<select>` reads and the same one the
  // runtime `setSelected` matches. For every value a form holds it
  // equals `String(innerRef.value)`; where the two part is a path
  // holding NOTHING, which displays as `''` and so marks an authored
  // `<option value="">` placeholder server-side. Raw `innerRef`
  // stringifies an absent model to `'undefined'`, matches nothing, and
  // leaves the browser to parse whichever option came first as selected
  // (#569).
  return [
    '(',
    ...getImplicitTrueMultipleExpression(multipleExpression),
    `) ? ((`,
    ...selectValueArr,
    `)?.innerRef?.value?.findIndex?.(el => el === (`,
    ...optionValueArr,
    `)) > -1) : (typeof (`,
    ...selectValueArr,
    `)?.innerRef?.value !== 'object' && (`,
    ...selectValueArr,
    `)?.displayValue?.value === String((`,
    ...optionValueArr,
    `)))`,
  ]
}

function extractMultipleFromSelectSummarizedProps(
  props: SummarizedProp[]
): SummarizedProp['value'] {
  const multipleDirectiveIndex = props.findIndex(
    (prop) => prop.key.replace(/"/g, `'`) === "'multiple'"
  )
  const multipleAttributeIndex = props.findIndex((prop) => prop.key === 'multiple')

  if (multipleDirectiveIndex === -1 && multipleAttributeIndex === -1) {
    return 'false'
  }
  const priorityIndex =
    multipleDirectiveIndex >= 0 ? multipleDirectiveIndex : multipleAttributeIndex
  const value = props[priorityIndex]?.value

  // attempt to convert expression within string into boolean
  // if undefined, make value `true` because of `<input multiple />` usage
  return typeof value === 'string' ? value.replace(/'|"/g, '') : (value ?? 'true')
}

// The node types that hold iterable children. `traverseSelectNode` reads
// it so the walk skips interpolation, comment and text nodes, which have
// no children in the traversal sense, and skips a future Vue node type
// rather than crashing on it.
const RECURSABLE_NODE_TYPES: ReadonlySet<number> = new Set<number>([
  NodeTypes.ELEMENT,
  NodeTypes.FOR,
  NodeTypes.IF,
  NodeTypes.IF_BRANCH,
])

// Native form-shell tags held back from the kebab-case extension. The
// hyphen check on `node.tag` already excludes most native HTML tags,
// which carry no hyphen, so listing these is the conservative stance: a
// future native tag like `<my-form-something>` cannot collide with the
// custom-element branch. `<input>`, `<select>` and `<textarea>` have
// their own branches through `inputTextAreaNodeTransform` and the
// `isSelect` path above; form, fieldset, label, button and option carry
// no meaningful v-register binding and must not be rewritten with
// component-style props.
const NATIVE_FORM_TAGS: ReadonlySet<string> = new Set<string>([
  'input',
  'textarea',
  'select',
  'option',
  'form',
  'fieldset',
  'label',
  'button',
])

/**
 * Synthesise a static value for an `<option>foo</option>` carrying no
 * `value=`. The text comes back as a single-quoted JS string literal, so
 * the equality check rendered into the AST treats it as a string:
 * `"'apple'"` for a single static text child, `null` for mixed, dynamic
 * or empty children, where the caller skips the binding rather than
 * guess.
 *
 * The HTML spec defaults an option's value to its descendant text, but
 * only a single static text node is handled here. Handling interpolation
 * would need a wrapped runtime expression, which cannot be emitted at
 * compile time without leaking runtime references that may not exist in
 * the template's binding scope.
 */
function inferOptionValueFromChildren(node: TemplateChildNode | RootNode): string | null {
  if (!('children' in node)) return null
  const children = node.children
  if (children.length !== 1) return null
  const only = children[0]
  if (only === undefined) return null
  if (typeof only === 'string' || typeof only === 'symbol') return null
  if (only.type !== NodeTypes.TEXT) return null
  // Vue's own option-value semantic: trim, so `<option> apple </option>`
  // matches a model value of `'apple'`.
  const text = only.content.trim()
  // A fully escaped JS string literal: `JSON.stringify` covers
  // backslashes, quotes and the line terminators (`\n`, `\r`, U+2028,
  // U+2029), so the synthesized literal stays single-line and valid.
  return JSON.stringify(text)
}

/**
 * What an `<option>` needs from its enclosing `<select>` in order to
 * build its own `:selected` binding, parked on the option node until the
 * traversal reaches it.
 */
type PendingOptionBinding = {
  readonly registerValue: SummarizedProp['value']
  readonly multiple: CompoundExpressionNode['children']
}

/**
 * The parking slot, keyed by the AST node itself. A `WeakMap` rather than
 * a property on the node, so the AST is untouched, nothing can reach
 * codegen, and entries die with the compile that made them. Node identity
 * is what makes it work, and identity survives the rewrites `v-for` and
 * `v-if` perform: both WRAP the element node rather than replacing it.
 */
const pendingOptionBindings = new WeakMap<object, PendingOptionBinding>()

/**
 * Why the option's binding is built on the OPTION's own visit rather than
 * from the `<select>` that knows the register.
 *
 * An `<option>` resolves its expressions in whatever binding scope it
 * landed in, and the enclosing `<select>` is visited BEFORE any of that
 * scope exists. Reading an option's props from there hands back raw
 * source text: `code` where the compiler would write `_ctx.code`, and
 * `o` for a `v-for` alias where `o` happens to be correct. Splicing
 * either into an injected expression makes it a plain string inside a
 * compound node, which Vue's `transformExpression` cannot descend into,
 * so whatever came out is what ships. A `v-for` alias survives that by
 * luck; a plain `<option :value="code">` does not, and its `:selected`
 * throws `ReferenceError: code is not defined` wherever identifiers are
 * prefixed rather than resolved lexically.
 *
 * By the option's own visit the compiler has processed its props in the
 * right scope, `_ctx.code` and a bare `o` inside the loop, and
 * `context.identifiers` carries the aliases. Both are simply read. This
 * is #566's rule from the other side: an expression belongs to the node
 * it was written on, and building it there is how that is respected.
 */
function applyPendingOptionBinding(node: PlainElementNode, pending: PendingOptionBinding): void {
  const optionProps = getSummarizedProps(node)
  const valueIndex = optionProps.findIndex((p) => isExactKey(p.key, 'value'))

  // HTML lets `<option>apple</option>` use its text content as the
  // value, so an option with no `value=` falls back to its children: a
  // single static TextNode becomes the static value, and anything else
  // (interpolation, mixed children, none at all) skips with a dev warn
  // rather than a guess. Without the fallback a value-less option emits
  // no `:selected` and renders unselectable through `register('fruit')`.
  let optionValueSummarizedProp: SummarizedProp | undefined
  if (valueIndex >= 0 && valueIndex < optionProps.length) {
    optionValueSummarizedProp = optionProps[valueIndex]
  } else {
    const fallback = inferOptionValueFromChildren(node)
    if (fallback === null) {
      // No static equality expression can be synthesized from dynamic
      // or mixed children. Bail without binding, leaving the option
      // non-reactive: a wrong binding is worse than none.
      return
    }
    optionValueSummarizedProp = { key: 'value', value: fallback }
  }

  const props = node.props
  const snapshot = [...props]
  try {
    removePropsByName(props, ['selected'])

    // The author's own `:selected` becomes the UNBOUND leg, the same
    // deal the `<select>`'s `:value` gets. Only possible because the
    // expression is read in the option's own scope; from the `<select>`
    // it would be raw source text (#620).
    const authorSelectedArr = toExpressionArray(
      optionProps.find((p) => isExactKey(p.key, 'selected'))?.value
    )
    const registerArr = toExpressionArray(pending.registerValue) ?? ['undefined']
    const boundExpression = generateEqualityExpression(
      pending.registerValue,
      optionValueSummarizedProp?.value ?? 'undefined',
      pending.multiple
    )

    props.push({
      arg: createSimpleExpression('selected', true),
      exp: createCompoundExpression(
        authorSelectedArr === undefined
          ? boundExpression
          : [
              '((',
              ...registerArr,
              ') == null ? (',
              ...authorSelectedArr,
              ') : (',
              ...boundExpression,
              '))',
            ]
      ),
      name: 'bind',
      modifiers: [],
      type: NodeTypes.DIRECTIVE,
      loc: node.loc,
    })
  } catch (err) {
    // Restore THIS option only, so a failure leaves one option
    // non-reactive rather than taking the template down. Each option
    // building its own binding is what keeps the blast radius there.
    props.length = 0
    props.push(...snapshot)
    console.error('[attaform] component-bridge transform: option binding failed, skipping:', err)
  }
}

export const componentBridgeTransform: NodeTransform = (node, context) => {
  // Snapshot every prop array about to be mutated, so a throw
  // mid-traversal rewinds to the pre-transform state. A PARTIAL
  // transform is worse than none: some `<option :selected>` bindings
  // rewritten and others not leaves the runtime directive computing
  // initial state against a shape it does not recognise.
  // `snapshotProps` is idempotent per target, so calling it twice
  // records one snapshot.
  type NodeProps = (AttributeNode | DirectiveNode)[]
  const snapshots: Array<{ target: NodeProps; snapshot: NodeProps }> = []
  const snapshotProps = (target: NodeProps): void => {
    if (snapshots.some((entry) => entry.target === target)) return
    snapshots.push({ target, snapshot: [...target] })
  }
  try {
    // An `<option>` the enclosing `<select>` parked a binding on. Its
    // props are processed and its scope live only at this point in the
    // traversal, which is the whole reason the work waited.
    if (node.type === NodeTypes.ELEMENT && node.tagType === ElementTypes.ELEMENT) {
      const pending = pendingOptionBindings.get(node)
      if (pending !== undefined) {
        // Consumed once. A doubly-registered pipeline parks again on
        // the second `<select>` pass and builds from whichever visit
        // arrives first, so the option ends with exactly one binding.
        pendingOptionBindings.delete(node)
        applyPendingOptionBinding(node, pending)
        return
      }
    }

    const isSelect = node.type === NodeTypes.ELEMENT && node.tag === 'select'
    const isCustomComponent =
      node.type === NodeTypes.ELEMENT && node.tagType === ElementTypes.COMPONENT
    // A kebab-case tag like `<my-input>` compiles as `tagType ===
    // ElementTypes.ELEMENT`: Vue's compiler cannot tell statically
    // whether it resolves to an `app.component` registration or to a
    // user-supplied `compilerOptions.isCustomElement` predicate, so it
    // emits an element creation the runtime disambiguates. The bridge
    // prop is injected on these too, which serves both answers: a
    // kebab-case Vue component sees `useRegister` work in its setup, and
    // a real Web Component sees `:value` and `:registerValue` as DOM
    // attributes, where the documented `assignKey` escape hatch handles
    // the interop.
    //
    // `NATIVE_FORM_TAGS` keeps this conservative, injecting only on tags
    // Vue would NEVER treat as a component.
    const isKebabCustomElement =
      node.type === NodeTypes.ELEMENT &&
      node.tagType === ElementTypes.ELEMENT &&
      node.tag.includes('-') &&
      !NATIVE_FORM_TAGS.has(node.tag)

    if (!(isSelect || isCustomComponent || isKebabCustomElement)) return

    const selectSummarizedProps = getSummarizedProps(node)

    const registerIndex = selectSummarizedProps.findIndex((p) => isExactKey(p.key, 'register'))
    if (
      selectSummarizedProps.length === 0 ||
      registerIndex < 0 ||
      registerIndex >= selectSummarizedProps.length
    )
      return

    const registerSummarizedProp = selectSummarizedProps[registerIndex]

    // The inject location matches the originating element, so a source
    // map for a runtime error in a synthesized expression points at the
    // author's `<select v-register=...>` rather than line 0.
    const selectLoc: SourceLocation = node.loc

    // Set by `traverseSelectNode` on meeting any `<option>` descendant.
    // It separates a select-like host, a native `<select>` or a component
    // projecting slotted options, from a plain input component host: the
    // first keeps the `:value` bind, the second gets the v-model pair.
    let hasSlottedOptions = false

    function traverseSelectNode(
      _node: RootNode | TemplateChildNode,
      multipleExpression: CompoundExpressionNode['children']
    ): void {
      const isOption = _node.type === NodeTypes.ELEMENT && _node.tag === 'option'
      if (!isOption) {
        // Only node types that genuinely hold iterable children. Text,
        // interpolation and comment nodes are skipped, and so is an
        // unrecognised future Vue node type.
        if (!RECURSABLE_NODE_TYPES.has(_node.type)) return
        const hasChildren = 'children' in _node
        if (!hasChildren) return
        for (const child of _node.children) {
          if (typeof child === 'symbol' || typeof child === 'string') continue
          if (child.type === NodeTypes.SIMPLE_EXPRESSION) continue
          traverseSelectNode(child, multipleExpression)
        }
        return
      }

      // At least one projected `<option>` makes this host select-like, so
      // the value channel stays `:value` below rather than v-model.
      hasSlottedOptions = true

      // Park what the option needs and leave. The rest of the binding is
      // the option's own business, in its own scope on its own visit;
      // see `applyPendingOptionBinding`.
      pendingOptionBindings.set(_node, {
        registerValue: registerSummarizedProp?.value ?? 'undefined',
        multiple: multipleExpression,
      })
    }

    const rawMultipleExpression = extractMultipleFromSelectSummarizedProps(selectSummarizedProps)

    const multipleExpression: CompoundExpressionNode['children'] =
      typeof rawMultipleExpression === 'string' ? [rawMultipleExpression] : rawMultipleExpression

    // Every `<option>` child of a v-register host derives its SSR
    // `:selected` from the host's single register. Under a native
    // `<select>` they are inline; under a component or custom-element
    // host they are parent-authored slot content, still sitting in
    // `node.children` at this enter-phase point in the parent AST,
    // BEFORE Vue's later `buildSlots` pass folds them into a slot
    // function. Walking them here marks them identically, so a `<select>`
    // wrapped in a styled component keeps its SSR selected option and
    // its first paint. `traverseSelectNode` no-ops when there are no
    // `<option>` descendants, so a host projecting none pays nothing.
    // It runs before the value-channel decision below, so
    // `hasSlottedOptions` is settled by the time `:value` and v-model
    // are weighed.
    for (const child of node.children) {
      traverseSelectNode(child, multipleExpression) // start searching for options in dfs manner
    }

    // The multi-select hydration trap. Setting `select.value = X` on a
    // `<select multiple>` runs the spec's value-setter loop, setting each
    // option's selectedness to `option.value === X`. For an array model
    // `displayValue.value` resolves to `String(arr)`, so `"red,blue"`,
    // which matches NO option's value, and the patch DESELECTS every
    // option, the SSR-selected ones the per-option `:selected` injection
    // just placed included. The directive's `setSelected` re-syncs from
    // the model at runtime, but the value patch plus the directive's
    // identity-skip path can leave the DOM stuck deselected when the
    // model has not moved since the last apply.
    //
    // Per-option `:selected` is the canonical mechanism for multi-select
    // initial state, and `setSelected` mirrors its logic exactly on the
    // client. A select-level `:value` adds nothing for multi, being
    // useful only as Vue's single-select `value` patch shorthand, which
    // is benign there: `select.value = "1"` selects the matching option,
    // a no-op when `<option selected>` already did.
    //
    // So the gate is conservative: skip `:value` unless `multiple` is
    // STATICALLY false. A static `<select>` and a static `<select
    // multiple="false">` keep the injection, both yielding the literal
    // string `'false'`. Static `multiple`, `multiple="true"`, and a
    // dynamic `:multiple` that cannot be evaluated at compile time all
    // skip. The dynamic case is rare, and trading SSR `value=` on the
    // select for hydration correctness is the right call.
    const isStaticallyNonMultiple = rawMultipleExpression === 'false'

    // The value-channel split. A select-like host, a native `<select>` or
    // a component or custom-element host projecting slotted `<option>`s,
    // keeps the `:value` bind. It never drove SSR selection, the option
    // `:selected` marks being register-driven through
    // `generateEqualityExpression`; it is kept only so the browser's
    // single-select value patch lands. A plain input component host,
    // projecting no options, gets the standard Vue v-model pair instead,
    // which is SSR-correct by construction and carries the TYPED model
    // value rather than the stringified display form.
    const isComponentHost = isCustomComponent || isKebabCustomElement
    const isSelectLikeHost = isSelect || (isComponentHost && hasSlottedOptions)
    const isPlainComponentHost = isComponentHost && !hasSlottedOptions

    const selectProps = node.props
    // Same capture-before-strip as the options above: an author-written
    // `:value` on a dual-mode `<select>` is its UNBOUND binding, not a
    // redundant one, so stripping it with nothing put back would leave a
    // nullish register with no value at all (#620).
    const authorSelectValueArr = toExpressionArray(
      selectSummarizedProps.find((p) => isExactKey(p.key, 'value'))?.value
    )
    snapshotProps(selectProps)
    removePropsByName(selectProps, ['value']) // actively prevent an attribute collision

    if (isStaticallyNonMultiple && isSelectLikeHost) {
      // construct `:value` dynamic prop based on the existing `v-register` directive
      const valuePropExpArray = Array.isArray(registerSummarizedProp?.value)
        ? registerSummarizedProp.value
        : [registerSummarizedProp?.value ?? 'undefined']
      // `displayValue.value`, not `innerRef.value`, so a select shares
      // one read surface with text inputs, the per-option `:selected`
      // above, and the runtime `setSelected`. For every value a form
      // holds it is just `String(storage)`; where it earns its keep is a
      // path holding NOTHING, which displays as `''` and so lands on an
      // authored `<option value="">` placeholder (#569).
      //
      // `displayValue` always resolves to a string for a real register,
      // `''` included, so the `??` fallback is reachable only when the
      // register EXPRESSION is nullish, never when a bound field merely
      // holds an empty value.
      const initExpression = createCompoundExpression(
        authorSelectValueArr === undefined
          ? ['(', ...valuePropExpArray, ')?.displayValue.value']
          : [
              '((',
              ...valuePropExpArray,
              ')?.displayValue.value ?? (',
              ...authorSelectValueArr,
              '))',
            ]
      )

      const simpleExpression = createSimpleExpression(flattenExpression(initExpression), false)
      // `processExpression` can throw on a malformed identifier or an
      // exotic expression shape. Isolating it here keeps a parser failure
      // on this ONE expression from reaching the outer try/catch, which
      // would run the snapshot-restore path and drop both the select's
      // `:value` and every option's `:selected`, turning a
      // single-expression problem into a whole-template fallback.
      let outputExp: ExpressionNode
      try {
        outputExp = processExpression(simpleExpression, { ...context, prefixIdentifiers: false })
      } catch (err) {
        console.error(
          '[attaform] component-bridge transform: processExpression failed; falling back to the unprocessed expression.',
          err
        )
        outputExp = simpleExpression
      }

      const valueProp: DirectiveNode = {
        rawName: ':value',
        arg: createSimpleExpression('value', true),
        exp: outputExp,
        name: 'bind',
        modifiers: [],
        type: NodeTypes.DIRECTIVE,
        loc: selectLoc,
      }

      node.props.push(valueProp)
    }

    if (isPlainComponentHost) {
      // A plain third-party or custom-element host speaks the standard
      // Vue v-model contract: strip first, then inject the pair. The
      // strip does double duty. It drops any author-written v-model, the
      // directive or an explicit `:modelValue` / `@update:modelValue`, so
      // v-register owns the binding with no duplicate-prop collision; and
      // it drops a prior injection of this transform's own pair, so a
      // doubly-registered pipeline re-injects exactly once, the same
      // strip-then-reinject idempotency the `:value` path uses.
      //
      // `:modelValue` reads `hostModelValue`, the TYPED model value (Date,
      // number, array) or `undefined` for a blank path, so a cleared
      // numeric reads empty in the component rather than as the
      // stringified `displayValue` a `<select>` takes.
      // `onUpdate:modelValue` routes through `setValueFromHost`, which
      // writes the value AND flips the sticky `interacted` bit, a v-model
      // host having no DOM input listener to do it, so blur-validation
      // and the reward-early display state arm as they do for a native
      // input.
      removePropsByName(node.props, [
        'model',
        'modelValue',
        'onUpdate:modelValue',
        'update:modelValue',
      ])

      const modelValuePropExpArray = Array.isArray(registerSummarizedProp?.value)
        ? registerSummarizedProp.value
        : [registerSummarizedProp?.value ?? 'undefined']

      const modelInitExpression = createCompoundExpression([
        '(',
        ...modelValuePropExpArray,
        ')?.hostModelValue?.value',
      ])
      const modelSimpleExpression = createSimpleExpression(
        flattenExpression(modelInitExpression),
        false
      )
      let modelOutputExp: ExpressionNode
      try {
        modelOutputExp = processExpression(modelSimpleExpression, {
          ...context,
          prefixIdentifiers: false,
        })
      } catch (err) {
        console.error(
          '[attaform] component-bridge transform: processExpression failed for :modelValue; falling back to the unprocessed expression.',
          err
        )
        modelOutputExp = modelSimpleExpression
      }

      const modelValueProp: DirectiveNode = {
        rawName: ':modelValue',
        arg: createSimpleExpression('modelValue', true),
        exp: modelOutputExp,
        name: 'bind',
        modifiers: [],
        type: NodeTypes.DIRECTIVE,
        loc: selectLoc,
      }
      node.props.push(modelValueProp)

      const updateInitExpression = createCompoundExpression([
        '$event => (',
        ...modelValuePropExpArray,
        ')?.setValueFromHost?.($event)',
      ])
      const updateSimpleExpression = createSimpleExpression(
        flattenExpression(updateInitExpression),
        false
      )
      let updateOutputExp: ExpressionNode
      try {
        updateOutputExp = processExpression(updateSimpleExpression, {
          ...context,
          prefixIdentifiers: false,
        })
      } catch (err) {
        console.error(
          '[attaform] component-bridge transform: processExpression failed for onUpdate:modelValue; falling back to the unprocessed expression.',
          err
        )
        updateOutputExp = updateSimpleExpression
      }

      const updateModelValueProp: DirectiveNode = {
        rawName: '@update:modelValue',
        arg: createSimpleExpression('onUpdate:modelValue', true),
        exp: updateOutputExp,
        name: 'bind',
        modifiers: [],
        type: NodeTypes.DIRECTIVE,
        loc: selectLoc,
      }
      node.props.push(updateModelValueProp)
    }

    // Bridge the form's effective freeze to a `:disabled` bind, on every
    // host this transform owns: a native `<select>`, a select-like
    // component host with slotted options, and a plain v-model host. A
    // `useRegister`-based component reads `registerValue.disabled` off
    // the bridge prop below instead, and the two agree.
    //
    // Skipped when the author already bound `disabled` or `:disabled`,
    // since overriding would force the control ENABLED whenever the form
    // is not frozen. The data-layer freeze rejects writes either way, so
    // only the visual affordance defers to the author. Idempotent: a
    // re-run reads its own prior injection as an author binding and
    // no-ops.
    const registerExprArray = Array.isArray(registerSummarizedProp?.value)
      ? registerSummarizedProp.value
      : [registerSummarizedProp?.value ?? 'undefined']
    const hasAuthorDisabled =
      selectSummarizedProps.findIndex((p) => isExactKey(p.key, 'disabled')) !== -1
    if (!hasAuthorDisabled) {
      const disabledInitExpression = createCompoundExpression([
        '(',
        ...registerExprArray,
        ')?.disabled?.value',
      ])
      const disabledSimpleExpression = createSimpleExpression(
        flattenExpression(disabledInitExpression),
        false
      )
      let disabledOutputExp: ExpressionNode
      try {
        disabledOutputExp = processExpression(disabledSimpleExpression, {
          ...context,
          prefixIdentifiers: false,
        })
      } catch (err) {
        console.error(
          '[attaform] component-bridge transform: processExpression failed for :disabled; falling back to the unprocessed expression.',
          err
        )
        disabledOutputExp = disabledSimpleExpression
      }
      const disabledProp: DirectiveNode = {
        rawName: ':disabled',
        arg: createSimpleExpression('disabled', true),
        exp: disabledOutputExp,
        name: 'bind',
        modifiers: [],
        type: NodeTypes.DIRECTIVE,
        loc: selectLoc,
      }
      node.props.push(disabledProp)
    }

    if (isSelect) {
      // A native `<select>` is fully handled by the option walk above plus
      // the `:value` injection; a component host falls through to the
      // bridge prop.
      return
    }

    const registerProps = node.props.filter(
      (x) => x.type === NodeTypes.DIRECTIVE && x.name === 'register'
    )
    const registerProp = registerProps[0]

    if (!registerProp) return

    // Idempotency. The hint and preamble transforms keep their own
    // per-node markers; this one looks for an already-injected
    // `:registerValue` on the props array and skips re-pushing. Without
    // it a doubly-registered pipeline, rare in production and common in
    // test combinatorics, emits two `registerValue:` keys in the
    // generated render. The last wins for prop resolution, but the output
    // is bloated and confusing to read under codegen inspection.
    const alreadyInjected = node.props.some(
      (p) =>
        p.type === NodeTypes.DIRECTIVE &&
        p.name === 'bind' &&
        p.arg !== undefined &&
        'content' in p.arg &&
        p.arg.content === 'registerValue'
    )
    if (alreadyInjected) return

    // Tells compiled SSR this v-register host is a component, so the
    // directive's `getSSRProps` suppresses the managed aria attrs on the
    // host root; the inner control the component re-binds through
    // `useRegister` carries them. The runtime path reads the component
    // vnode directly, but compiled SSR has only a null vnode, so this
    // modifier is the channel (#404).
    if (
      registerProp.type === NodeTypes.DIRECTIVE &&
      !registerProp.modifiers.some(
        (m) => m.type === NodeTypes.SIMPLE_EXPRESSION && m.content === SSR_COMPONENT_HOST_MODIFIER
      )
    ) {
      registerProp.modifiers.push(createSimpleExpression(SSR_COMPONENT_HOST_MODIFIER, true))
    }

    const customElementProp: DirectiveNode = {
      arg: createSimpleExpression('registerValue', true),
      exp: 'exp' in registerProp ? registerProp.exp : createSimpleExpression('undefined', false),
      name: 'bind',
      modifiers: [],
      type: NodeTypes.DIRECTIVE,
      loc: selectLoc,
    }

    node.props.push(customElementProp)
  } catch (err) {
    // AST shape drift or a malformed template: rewind every mutated prop
    // array so the template falls back cleanly to the runtime directive.
    // Reverse order mirrors the push order, so a later snapshot restores
    // against the state its earlier siblings saw. The directive alone
    // still handles value binding; only SSR initial-render correctness
    // is affected.
    for (const { target, snapshot } of snapshots.slice().reverse()) {
      target.splice(0, target.length, ...snapshot)
    }

    console.error('[attaform] component-bridge transform failed, skipping:', err)
  }
}
