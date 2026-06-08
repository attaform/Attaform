import type {
  CompoundExpressionNode,
  DirectiveNode,
  NodeTransform,
  PlainElementNode,
  SourceLocation,
} from '@vue/compiler-core'
import { createCompoundExpression, NodeTypes } from '@vue/compiler-core'
import {
  getSummarizedProps,
  isExactKey,
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
  // The scalar branch routes both sides through `String(...)` to mirror
  // the runtime `setChecked` path, which uses Vue's `looseEqual` —
  // looseEqual coerces primitives via `String(...)` before comparing.
  // Without the coerce, SSR on `<input type="radio" value="2">` bound
  // to a `z.number()` model of `2` evaluated `2 === "2"` → `false` and
  // emitted unchecked HTML, then the runtime's `looseEqual(2, applyCoerce("2"))`
  // returned `true` on hydration and flipped to checked — a one-tick
  // visible flicker (DIR-F4). The `typeof !== 'object'` guard preserves
  // current behaviour for non-array / non-Set object models, which both
  // ladders fall through this scalar branch with no realistic match.
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
 * Parse a one-line JS string literal from `text`. Returns `null` for
 * any non-literal source (dynamic expression, compound, mismatched
 * quotes); on a match returns the quote character and the inner
 * payload separately so callers can disambiguate template literals
 * with interpolations from literal-static strings.
 *
 * Doesn't attempt to handle escaped quotes inside the literal — a
 * value containing escaped quotes is vanishingly rare in the prop
 * shapes the transforms inspect (HTML attribute values, type names).
 * Callers that can't prove safety on `null` should bail conservatively.
 */
function parseStaticStringLiteral(text: string): { quote: string; inner: string } | null {
  const literalMatch = /^(["'`])(.*)\1$/.exec(text.trim())
  if (literalMatch === null) return null
  return { quote: literalMatch[1] as string, inner: literalMatch[2] as string }
}

/**
 * Returns true iff the type prop's value is the static-attribute literal
 * matching one of `names` (case-insensitive). Used to detect static
 * `type="checkbox"` / `type="radio"` shapes where the `value` attribute
 * is the option-value (a discriminator within the group), not display
 * state — so the transform must NOT strip it.
 *
 * Conservative on dynamic shapes — `:type="x"` returns false, falling
 * through to the text-input branch which strips `value`. Authors using
 * dynamic types between checkbox/radio and text are rare; if they hit
 * this they can add a static `type=` to lock the shape.
 */
function isStaticTypeOneOf(value: SummarizedProp['value'], names: readonly string[]): boolean {
  if (Array.isArray(value)) return false
  const parsed = parseStaticStringLiteral(value)
  if (parsed === null) return false
  return names.includes(parsed.inner.toLowerCase())
}

/**
 * True when the `type` prop is a DYNAMIC binding whose value can't be
 * read as a static string literal at compile time. A static attribute
 * (`type="text"`) or a literal bound expression (`:type="'text'"`) is
 * NOT dynamic — its type is settled at compile time, so the transform
 * classifies it directly (and can skip the runtime file guard).
 *
 *   - `type="text"`      → value is `'"text"'`      → false (static attr literal)
 *   - `:type="'text'"`   → value is `"'text'"`      → false (literal expression)
 *   - `:type="kind"`     → value is `'kind'`        → true  (dynamic identifier)
 *   - `:type="`a-${x}`"` → array (compound exp)     → true  (interpolated)
 *
 * Dynamic-typed inputs keep their static `value=` attribute (it may be a
 * checkbox/radio option discriminator at runtime) AND get the runtime
 * file-exclusion guard on the injected binding.
 */
function isDynamicTypeValue(value: SummarizedProp['value']): boolean {
  if (Array.isArray(value)) return true // compound / interpolated expression
  return parseStaticStringLiteral(value) === null // dynamic identifier / expression
}

/**
 * Vue compiler node transform for `<input v-register>` and
 * `<textarea v-register>`. Injects the `:value` / `:checked`
 * bindings required for SSR-correct initial render.
 *
 * Wired automatically by `attaform/vite` and
 * `attaform/nuxt`. Use directly only when integrating with
 * a custom bundler.
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

    // A provably-static `type="file"` (or `:type="'file'"`) bypasses the
    // value-binding injection entirely — the runtime `vRegisterFile`
    // variant owns the DOM contract for file inputs (read `el.files` on
    // change; clear via `el.value = ''` only), and browsers reject a
    // `value=` attribute on a file input. A DYNAMIC `:type` that could
    // only SOMETIMES resolve to "file" does NOT bail here: it proceeds to
    // inject, and the synthesized expression below excludes the file case
    // at runtime (`type === 'file' ? undefined : …`) so a wrapper input
    // that resolves to "text" still gets its SSR value. This is what fixes
    // the first-paint flash on every dynamically-typed wrapper field.
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
    // The HTML spec matches `type` ASCII case-insensitively, so
    // `<input type="CHECKBOX">` and `<input type="Radio">` produce the
    // same runtime element as their lowercase counterparts. The
    // injected expression normalizes via `String(t).toLowerCase()`
    // before comparing — the compile-time `isStaticTypeOneOf` already
    // uses case-insensitive matching, so without the runtime
    // normalization a `type="CHECKBOX"` input would have its static
    // `value` preserved (per `keepStaticValue`) but still emit
    // `:value="..."` instead of `:checked="..."`, breaking SSR initial
    // checked state.
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

    // Narrowed from `PlainElementNode | ComponentNode | SlotOutletNode |
    // TemplateNode` — `<input>` / `<textarea>` are always PlainElementNode
    // in Vue's AST. The previous wide union let a TemplateNode slip
    // through and crash on `_node.props`.
    function computeProps(
      _node: PlainElementNode,
      registerSummarizedProp: SummarizedProp,
      elementValueSummarizedProp: SummarizedProp
    ): void {
      // Reuse the originating element's source location for the
      // injected directive — runtime errors in the synthesized expression
      // get reported at the v-register binding site rather than line 0.
      const injectedLoc: SourceLocation = _node.loc

      const props = _node.props
      // For statically-typed checkbox / radio inputs, the `value=`
      // attribute is the OPTION-value (the discriminator the directive
      // matches against the model), not display state. The synthesized
      // binding below resolves to `:checked="..."` for those types, a
      // different attribute key — so the static `value` survives
      // alongside it without conflict. Stripping it (as we still do
      // for text/textarea, where the synthesized binding resolves to
      // `:value`) leaves the SSR HTML without the attribute, and on
      // hydration the directive can't tell which option this checkbox
      // represents.
      const isStaticCheckbox =
        typeProp !== undefined && isStaticTypeOneOf(typeProp.value, ['checkbox'])
      const isStaticRadio = typeProp !== undefined && isStaticTypeOneOf(typeProp.value, ['radio'])
      // A dynamic `:type` could resolve to checkbox/radio at runtime,
      // where the static `value=` is the option discriminator the runtime
      // directive matches against the model — so it must survive the
      // strip. If the runtime type turns out to be text instead, the
      // injected `:value` binding harmlessly overrides the static
      // attribute (dynamic binds win over static attrs in mergeProps).
      const isDynamicType = typeProp !== undefined && isDynamicTypeValue(typeProp.value)
      const keepStaticValue = isStaticCheckbox || isStaticRadio || isDynamicType
      removePropsByName(props, keepStaticValue ? ['checked'] : ['checked', 'value'])
      const registerValueArr = Array.isArray(registerSummarizedProp.value)
        ? registerSummarizedProp.value
        : [registerSummarizedProp.value]
      // Read `displayValue.value` rather than `innerRef.value` so the
      // `:value` binding renders the blank `''` when the
      // user clears a numeric field. `displayValue` returns
      // `String(storage)` for non-empty storage and `''` for both
      // null/undefined storage and paths in the form's
      // `blankPaths` set — a single read surface for the
      // injected expression. For checkbox / radio (the ternary's
      // truthy branch above), this leg is unreached, so behaviour
      // there is unchanged.
      const valueExpression = createCompoundExpression([
        '(',
        ...registerValueArr,
        ')?.displayValue?.value',
      ])

      // Scalar-equality target. Three cases (see the long-form comment
      // on `generateEqualityExpression`):
      //   - static checkbox + `:true-value="X"` → X (the explicit
      //     mapped string the model takes when checked)
      //   - static checkbox without `:true-value` → boolean `true`
      //     (matches the runtime's `getCheckboxValue(el, true)` default)
      //   - static radio → the option-value (since radio model is
      //     always scalar and the `value=` IS the discriminator)
      //   - dynamic type → fall back to the option-value (current
      //     behaviour); a dynamic-type element can't be statically
      //     classified into checkbox vs radio vs text.
      const trueValueIndex = elementProps.findIndex((p) => isExactKey(p.key, 'true-value'))
      const trueValueProp = elementProps[trueValueIndex]
      const scalarTarget: SummarizedProp['value'] = isStaticCheckbox
        ? trueValueProp !== undefined
          ? trueValueProp.value
          : 'true'
        : elementValueSummarizedProp.value

      // The core binding: a boolean for the `checked` branch (checkbox /
      // radio), the register's `displayValue` for the `value` branch
      // (text / textarea). The arg (`elementSelectionLabelExpression`)
      // picks which attribute key this binds to at runtime.
      const coreExpression = [
        '(',
        ...elementSelectionLabelExpression.children,
        ") === 'checked' ? (",
        // resolves to a boolean
        ...generateEqualityExpression(
          registerSummarizedProp.value,
          elementValueSummarizedProp.value,
          scalarTarget
        ),
        ') : (',
        // resolves to the provided register value
        ...valueExpression.children,
        ')',
      ]

      // Runtime file-exclusion guard, dynamic `:type` only: when the type
      // resolves to "file" at runtime the binding yields `undefined`, so
      // Vue omits the attribute (browsers reject `value` on a file input,
      // and the runtime `vRegisterFile` variant owns that DOM contract).
      // A provably-static non-file type skips the guard — its file-ness is
      // already settled at compile time, so the runtime check would be
      // dead weight on the SSR-correct common path (static `type="file"`
      // bailed out far above and never reaches here).
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
    }

    // The outer guards (`node.type === NodeTypes.ELEMENT` + `node.tag
    // === 'input' | 'textarea'`) narrow `node` to a PlainElementNode
    // at runtime; the cast records that for the type system.
    computeProps(node as PlainElementNode, registerSummarizedProp, elementValueSummarizedProp)
  } catch (err) {
    // AST shapes can shift with minor Vue compiler updates. If we hit
    // anything unexpected, skip this transform — the runtime directive
    // alone handles value binding (via mounted/beforeUpdate), so the only
    // cost is a one-frame flash on SSR initial render.

    console.error('[attaform] input/textarea transform failed, skipping:', err)
  }
}
