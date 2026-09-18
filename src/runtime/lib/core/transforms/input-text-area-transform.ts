import type {
  CompoundExpressionNode,
  DirectiveNode,
  NodeTransform,
  PlainElementNode,
  SourceLocation,
} from '@vue/compiler-core'
import { createCompoundExpression, createSimpleExpression, NodeTypes } from '@vue/compiler-core'
import {
  getSummarizedProps,
  isExactKey,
  toExpressionArray,
  removePropsByName,
  type SummarizedProp,
} from './_shared-props'

function generateEqualityExpression(
  registerValue: SummarizedProp['value'],
  optionValue: SummarizedProp['value'],
  scalarTarget: SummarizedProp['value']
): CompoundExpressionNode['children'] {
  const registerValueArr = Array.isArray(registerValue) ? registerValue : [registerValue]
  const optionValueArr = Array.isArray(optionValue) ? optionValue : [optionValue]
  const scalarTargetArr = Array.isArray(scalarTarget) ? scalarTarget : [scalarTarget]

  // Discriminator selection:
  //   - Array model     → membership of the option-value (e.g. value="apple")
  //   - Set model       → membership of the option-value
  //   - Scalar model    → coerced String() equality with the scalar target
  //
  // The scalar target differs from the option-value for two checkbox
  // shapes that the directive's runtime `setChecked` already handles
  // via `getCheckboxValue(el, true)`:
  //
  //   - boolean model + no `value=` → target is `true`
  //   - string model + `:true-value="'X'"` → target is `'X'`
  //
  // For radio inputs the model is always scalar and the discriminator
  // IS the option-value, so `optionValue === scalarTarget` there.
  //
  // The scalar branch routes both sides through `String(...)` to match
  // the runtime `setChecked` path, which uses Vue's `looseEqual`, and
  // `looseEqual` coerces primitives through `String(...)` before
  // comparing. Without the coerce, `<input type="radio" value="2">`
  // bound to a `z.number()` model of `2` evaluates `2 === "2"` at SSR,
  // emits unchecked HTML, and then flips to checked on hydration when
  // `looseEqual(2, applyCoerce("2"))` returns true: a one-tick visible
  // flicker. The `typeof !== 'object'` guard covers a non-array,
  // non-Set object model, which falls through this scalar branch with
  // no realistic match either way.
  return [
    'Array.isArray((',
    ...registerValueArr,
    ')?.innerRef?.value) ? ',
    '(',
    ...registerValueArr,
    ')?.innerRef?.value?.includes(',
    ...optionValueArr,
    ') : ',
    '(',
    ...registerValueArr,
    ')?.innerRef?.value instanceof Set ? (',
    ...registerValueArr,
    ')?.innerRef?.value?.has(',
    ...optionValueArr,
    ') : ',
    '(typeof (',
    ...registerValueArr,
    ")?.innerRef?.value !== 'object' && String((",
    ...registerValueArr,
    ')?.innerRef?.value) === String((',
    ...scalarTargetArr,
    ')))',
  ]
}

/**
 * Parse a one-line JS string literal out of `text`. `null` for any
 * non-literal source: a dynamic expression, a compound, mismatched
 * quotes. A match returns the quote character and the inner payload
 * separately, so a caller can tell an interpolated template literal from
 * a literal-static string.
 *
 * Escaped quotes inside the literal are not handled. They are
 * vanishingly rare in the prop shapes these transforms inspect, HTML
 * attribute values and type names, and a caller that cannot prove safety
 * on `null` should bail.
 */
function parseStaticStringLiteral(text: string): { quote: string; inner: string } | null {
  const literalMatch = /^(["'`])(.*)\1$/.exec(text.trim())
  if (literalMatch === null) return null
  return { quote: literalMatch[1] as string, inner: literalMatch[2] as string }
}

/**
 * True when the type prop's value is a static-attribute literal matching
 * one of `names`, case-insensitively. It detects the static
 * `type="checkbox"` and `type="radio"` shapes, where the `value`
 * attribute is the OPTION-value, a discriminator within the group,
 * rather than display state, so the transform must not strip it.
 *
 * Conservative on a dynamic shape: `:type="x"` is false and falls
 * through to the text-input branch, which strips `value`. Switching a
 * dynamic type between checkbox, radio and text is rare, and an author
 * who does can add a static `type=` to lock the shape.
 */
function isStaticTypeOneOf(value: SummarizedProp['value'], names: readonly string[]): boolean {
  if (Array.isArray(value)) return false
  const parsed = parseStaticStringLiteral(value)
  if (parsed === null) return false
  return names.includes(parsed.inner.toLowerCase())
}

/**
 * True when the `type` prop is a DYNAMIC binding whose value cannot be
 * read as a static string literal at compile time. A static attribute or
 * a literal bound expression is not dynamic: its type is settled, so the
 * transform classifies it directly and skips the runtime file guard.
 *
 *   - `type="text"`      value `'"text"'`     false (static attr literal)
 *   - `:type="'text'"`   value `"'text'"`     false (literal expression)
 *   - `:type="kind"`     value `'kind'`       true  (dynamic identifier)
 *   - `:type="`a-${x}`"` array (compound exp) true  (interpolated)
 *
 * A dynamic-typed input keeps its static `value=`, which may turn out to
 * be a checkbox or radio option discriminator at runtime, AND gets the
 * runtime file-exclusion guard on the injected binding.
 */
function isDynamicTypeValue(value: SummarizedProp['value']): boolean {
  if (Array.isArray(value)) return true // compound / interpolated expression
  return parseStaticStringLiteral(value) === null // dynamic identifier / expression
}

/**
 * Vue compiler node transform for `<input v-register>` and `<textarea
 * v-register>`, injecting the `:value` and `:checked` bindings an
 * SSR-correct initial render needs.
 *
 * `attaform/vite` and `attaform/nuxt` wire it for you; reach for it
 * directly only when integrating a custom bundler.
 */
export const inputTextAreaNodeTransform: NodeTransform = (node) => {
  try {
    if (node.type !== NodeTypes.ELEMENT) return

    const isInput = node.tag === 'input'
    const isTextArea = node.tag === 'textarea'

    if (!isInput && !isTextArea) return

    const elementProps = getSummarizedProps(node)

    const registerIndex = elementProps.findIndex((p) => isExactKey(p.key, 'register'))
    const registerSummarizedProp = elementProps[registerIndex]
    if (!registerSummarizedProp) return // no v-register directive; nothing to transform

    // A provably-static `type="file"`, or `:type="'file'"`, skips the
    // value-binding injection outright: the runtime `vRegisterFile`
    // variant owns a file input's DOM contract, reading `el.files` on
    // change and clearing only through `el.value = ''`, and a browser
    // rejects a `value=` attribute there anyway.
    //
    // A DYNAMIC `:type` that might only SOMETIMES resolve to file does
    // NOT bail. It injects, and the synthesized expression below excludes
    // the file case at runtime, so a wrapper input resolving to "text"
    // still gets its SSR value and no dynamically-typed wrapper field
    // flashes on first paint.
    const typeIndex = elementProps.findIndex((p) => isExactKey(p.key, 'type'))
    const typeProp = elementProps[typeIndex]
    if (typeProp !== undefined && isStaticTypeOneOf(typeProp.value, ['file'])) return

    const valueIndex = elementProps.findIndex((p) => isExactKey(p.key, 'value'))
    const elementValueSummarizedProp = elementProps?.[valueIndex] ?? {
      key: 'value',
      value: "''",
    }

    const inputTypeIndex = typeIndex

    const defaultSummarizedTextProp = { key: 'type', value: "'text'" }
    const inputTypeSummarizedProp: SummarizedProp =
      inputTypeIndex === -1
        ? defaultSummarizedTextProp
        : (elementProps[inputTypeIndex] ?? defaultSummarizedTextProp)
    const inputTypeExpressionArray =
      typeof inputTypeSummarizedProp.value === 'string'
        ? [inputTypeSummarizedProp.value]
        : inputTypeSummarizedProp.value

    // this gets paired with `value` to get the [selectionLabel]=[label] prop for the given input
    // checkbox and radio are marked as selected via `checked`, others typically use `value`
    //
    // The HTML spec matches `type` ASCII case-insensitively, so `<input
    // type="CHECKBOX">` and `<input type="Radio">` produce the same
    // runtime element as their lowercase spellings. The injected
    // expression normalizes through `String(t).toLowerCase()` before
    // comparing, and it MUST: `isStaticTypeOneOf` is already
    // case-insensitive at compile time, so without the runtime half a
    // `type="CHECKBOX"` input would keep its static `value` under
    // `keepStaticValue` and still emit `:value="..."` instead of
    // `:checked="..."`, losing its SSR initial checked state.
    const elementSelectionLabelExpression = createCompoundExpression([
      '(',
      'String((',
      ...inputTypeExpressionArray,
      ')).toLowerCase()',
      " === 'checkbox' || ",
      'String((',
      ...inputTypeExpressionArray,
      ")).toLowerCase() === 'radio'",
      ") ? 'checked' : 'value'",
    ])

    // `<input>` and `<textarea>` are always `PlainElementNode` in Vue's
    // AST. The wider union the signature could take lets a `TemplateNode`
    // through, which crashes on `_node.props`.
    function computeProps(
      _node: PlainElementNode,
      registerSummarizedProp: SummarizedProp,
      elementValueSummarizedProp: SummarizedProp
    ): void {
      // The originating element's source location, so a runtime error in
      // the synthesized expression reports at the v-register binding site
      // rather than line 0.
      const injectedLoc: SourceLocation = _node.loc

      const props = _node.props
      // On a statically-typed checkbox or radio the `value=` attribute is
      // the OPTION-value, the discriminator the directive matches against
      // the model, not display state. The synthesized binding resolves to
      // `:checked="..."` there, a different attribute key, so the static
      // `value` survives beside it without conflict. Stripping it, as
      // still happens for text and textarea where the binding resolves to
      // `:value`, leaves the SSR HTML without the attribute and the
      // directive unable to tell which option this checkbox is.
      const isStaticCheckbox =
        typeProp !== undefined && isStaticTypeOneOf(typeProp.value, ['checkbox'])
      const isStaticRadio = typeProp !== undefined && isStaticTypeOneOf(typeProp.value, ['radio'])
      // A dynamic `:type` could resolve to checkbox or radio at runtime,
      // where the static `value=` is the option discriminator, so it has
      // to survive the strip. If the type turns out to be text instead,
      // the injected `:value` harmlessly overrides it, a dynamic bind
      // winning over a static attr in `mergeProps`.
      const isDynamicType = typeProp !== undefined && isDynamicTypeValue(typeProp.value)
      const keepStaticValue = isStaticCheckbox || isStaticRadio || isDynamicType
      // What the author bound on this element, captured BEFORE the strip
      // below discards it, and kept as the UNBOUND leg of the injected
      // expression. A dual-mode wrapper is one component used both
      // `v-register`-bound and plain-bound, and its plain mode is what
      // this protects: strip the author's `:value` and the injected
      // expression resolves to `undefined` for a nullish register, so the
      // control renders with no value and the caller's binding is
      // silently gone (#620). One element now serves both modes, and the
      // wrapper needs no `v-if` / `v-else` duplicate of itself.
      //
      // `checked` is always taken. `value` only when it is being
      // stripped: under `keepStaticValue` it stays on the element as a
      // checkbox or radio's option discriminator, not as display state,
      // so it is a fallback for nothing.
      const authorCheckedProp = elementProps.find((p) => isExactKey(p.key, 'checked'))
      const authorValueProp = keepStaticValue
        ? undefined
        : elementProps.find((p) => isExactKey(p.key, 'value'))
      removePropsByName(props, keepStaticValue ? ['checked'] : ['checked', 'value'])
      const registerValueArr = Array.isArray(registerSummarizedProp.value)
        ? registerSummarizedProp.value
        : [registerSummarizedProp.value]
      // `displayValue.value`, not `innerRef.value`, so `:value` renders
      // the blank `''` when the user clears a numeric field.
      // `displayValue` gives `String(storage)` for non-empty storage and
      // `''` for both nullish storage and a path in the form's
      // `blankPaths`, which is one read surface for the whole injected
      // expression. The checkbox and radio branch above never reaches
      // this leg.
      //
      // The author's own binding rides in as the `??` right-hand side.
      // `displayValue` is a `Ref<string>` and always resolves to a
      // string for a real register, `''` included, so the fallback is
      // reachable only when the register EXPRESSION is nullish, never
      // when a bound field merely holds an empty value.
      const authorValueArr = toExpressionArray(authorValueProp?.value)
      const valueExpression = createCompoundExpression(
        authorValueArr === undefined
          ? ['(', ...registerValueArr, ')?.displayValue?.value']
          : ['((', ...registerValueArr, ')?.displayValue?.value ?? (', ...authorValueArr, '))']
      )

      // The scalar-equality target, four cases; `generateEqualityExpression`
      // carries the long form.
      //   - static checkbox with `:true-value="X"`: X, the explicit
      //     mapped string the model takes when checked
      //   - static checkbox without one: boolean `true`, matching the
      //     runtime's `getCheckboxValue(el, true)` default
      //   - static radio: the option-value, a radio model always being
      //     scalar and the `value=` being the discriminator
      //   - dynamic type: the option-value, since a dynamic-type element
      //     cannot be statically sorted into checkbox, radio or text
      const trueValueIndex = elementProps.findIndex((p) => isExactKey(p.key, 'true-value'))
      const trueValueProp = elementProps[trueValueIndex]
      const scalarTarget: SummarizedProp['value'] = isStaticCheckbox
        ? trueValueProp !== undefined
          ? trueValueProp.value
          : 'true'
        : elementValueSummarizedProp.value

      // The core binding: a boolean on the `checked` branch for checkbox
      // and radio, the register's `displayValue` on the `value` branch
      // for text and textarea. `elementSelectionLabelExpression` picks
      // which attribute key it binds to at runtime.
      //
      // The checked leg CANNOT use `??`: the equality expression resolves
      // to `false` for a nullish register rather than to `undefined`, so
      // its fallback needs an explicit nullish test on the register.
      const authorCheckedArr = toExpressionArray(authorCheckedProp?.value)
      const checkedExpression =
        authorCheckedArr === undefined
          ? generateEqualityExpression(
              registerSummarizedProp.value,
              elementValueSummarizedProp.value,
              scalarTarget
            )
          : [
              '((',
              ...registerValueArr,
              ') == null ? (',
              ...authorCheckedArr,
              ') : (',
              ...generateEqualityExpression(
                registerSummarizedProp.value,
                elementValueSummarizedProp.value,
                scalarTarget
              ),
              '))',
            ]

      const coreExpression = [
        '(',
        ...elementSelectionLabelExpression.children,
        ") === 'checked' ? (",
        // resolves to a boolean
        ...checkedExpression,
        ') : (',
        // resolves to the provided register value
        ...valueExpression.children,
        ')',
      ]

      // The runtime file-exclusion guard, on a dynamic `:type` only: a
      // type resolving to "file" yields `undefined`, so Vue omits the
      // attribute, browsers rejecting `value` on a file input and the
      // runtime `vRegisterFile` variant owning that DOM contract. A
      // provably-static non-file type skips it, its file-ness being
      // settled at compile time, and a static `type="file"` bailed out
      // far above and never reaches here.
      const exp = isDynamicType
        ? createCompoundExpression([
            'String((',
            ...inputTypeExpressionArray,
            ")).toLowerCase() === 'file' ? undefined : (",
            ...coreExpression,
            ')',
          ])
        : createCompoundExpression(coreExpression)

      const valueOrCheckedProp: DirectiveNode = {
        // reconstruct the `value` attribute based on the provided v-registerer, now that the computation is complete
        arg: elementSelectionLabelExpression,
        exp,
        name: 'bind',
        modifiers: [],
        type: NodeTypes.DIRECTIVE,
        loc: injectedLoc,
      }

      props.push(valueOrCheckedProp)

      // A sibling `:disabled` bind, rendering the HTML `disabled`
      // attribute on the SSR initial paint and patching it on the client,
      // tracking the form's effective freeze from `useForm({ disabled
      // })`. It needs no file-exclusion guard: unlike `value`, `disabled`
      // is legal on a file input, so a dynamic `:type` resolving to file
      // still disables correctly.
      //
      // Skipped when the author already wrote `disabled` or `:disabled`,
      // since overriding would force the field ENABLED whenever the form
      // is not frozen, clobbering a legitimate author condition. The
      // data-layer freeze rejects writes either way, so only the visual
      // affordance defers to the author.
      const hasAuthorDisabled = elementProps.findIndex((p) => isExactKey(p.key, 'disabled')) !== -1
      if (!hasAuthorDisabled) {
        const disabledProp: DirectiveNode = {
          arg: createSimpleExpression('disabled', true, injectedLoc),
          exp: createCompoundExpression(['(', ...registerValueArr, ')?.disabled?.value']),
          name: 'bind',
          modifiers: [],
          type: NodeTypes.DIRECTIVE,
          loc: injectedLoc,
        }
        props.push(disabledProp)
      }
    }

    // The outer guards on `node.type` and `node.tag` narrow to a
    // `PlainElementNode` at runtime; the cast records that for the type
    // system.
    computeProps(node as PlainElementNode, registerSummarizedProp, elementValueSummarizedProp)
  } catch (err) {
    // AST shapes shift with minor Vue compiler updates, so anything
    // unexpected skips the transform. The runtime directive still handles
    // value binding through `mounted` and `beforeUpdate`, leaving a
    // one-frame flash on SSR initial render as the only cost.

    console.error('[attaform] input/textarea transform failed, skipping:', err)
  }
}
