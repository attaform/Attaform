/**
 * The `v-register` directive. Two-way binding with `v-model`-like semantics,
 * except writes go through the form's `RegisterValue` so dirty, pristine,
 * touched and errors stay coherent across the form.
 *
 * Bind to a native input, select, textarea, checkbox or radio:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * ```
 *
 * The Vite and Nuxt plugins bind each compiled template's `v-register` to this
 * directive at build time; every other setup (a webpack-family bundler, a
 * no-build page, runtime-compiled templates) calls `installVRegister(app)`
 * once. Identical under Nuxt, bare Vue CSR and bare Vue with
 * `@vue/server-renderer`: Vue skips directive lifecycle hooks during SSR, so
 * the directive is a safe server-side no-op.
 */
import { isArray, isSet, looseEqual, looseIndexOf, looseToNumber } from './vue-shared-shim'
import type { App, DirectiveBinding, DirectiveHook, ObjectDirective, VNode } from 'vue'
import { nextTick, warn } from 'vue'
import {
  isRegisterValue,
  isTransforming,
  REGISTER_OWNER_MARKER,
  SSR_COMPONENT_HOST_MODIFIER,
  V_REGISTER_COMPILED_MODIFIER,
  V_REGISTER_MARKER,
} from './register-protocol'
import { __DEV__ } from './dev'
import {
  applyAria,
  getSSRAriaProps,
  mergeAriaLocks,
  setupAria,
  setupAriaLive,
  teardownAria,
  type AriaCarrier,
} from './directive-aria'
import { vRegisterFile } from './directive-file'
import { syncElementRegistration } from './directive-lifecycle'
import { addTrackedListener, noteInteraction, removeTrackedListeners } from './directive-listeners'
import {
  setupDisabledSync,
  setupValueSync,
  teardownDisabledSync,
  teardownValueSync,
} from './directive-value-sync'
import { INTERACTIVE_TAG_NAMES } from './interactive-tags'
import type {
  InternalRegisterValue,
  RegisterCheckboxCustomDirective,
  RegisterModelDynamicCustomDirective,
  RegisterRadioCustomDirective,
  RegisterSelectCustomDirective,
  RegisterTextCustomDirective,
  RegisterValue,
} from '../types/types-api'
import {
  applyCoerce,
  assignKey,
  fireAssigner,
  isDefaultAssigner,
  setAssignFunction,
} from './assigner-pipeline'
import { armDomBinding } from './dom-binding'

// Re-exported so the public `attaform` entry keeps exporting `assignKey` from
// this module.
export { assignKey }

type ComposingTarget = (EventTarget & { composing: boolean }) | null

/**
 * Write the directive-private `lastTypedForm` ref. It lives on
 * `InternalRegisterValue` rather than the public `RegisterValue`, but every RV
 * `register-api.ts` builds carries it, so the cast captures a runtime
 * invariant the type system cannot express. The numeric-text listener uses it
 * to show `displayValue` the user's typed form (`'1e2'`) mid-typing without
 * yanking the caret on the next render.
 */
function writeLastTypedForm(rv: RegisterValue, next: string | null): void {
  ;(rv as InternalRegisterValue).lastTypedForm.value = next
}

/**
 * Listener-body bail, called at the top of every event handler the directive
 * attaches. Bails when the rendered root is a non-supported tag, where
 * `el.value` is meaningless, AND the assigner is still the default.
 *
 * That pair catches two cases with no instance-level sentinel detection:
 *  1. A `useRegister`-using child component, whose rendered root is usually a
 *     `<label>` or `<div>` while the inner `<input v-register>` handles
 *     binding. Without the bail, the parent's listener on the rendered root
 *     reads `el.value` off the wrapper and clobbers the form.
 *  2. A bare `<div v-register>` with no escape hatch, where the dev gets a
 *     deferred warn pointing at the recipe.
 *
 * A pre-installed `assignKey` and an `@update:registerValue` listener both
 * bypass the bail, their assigner having replaced the default. So does a
 * post-installed `assignKey`, set from `onMounted` or a ref callback: by the
 * time the next input event fires, the consumer's assigner is in place.
 */
function shouldBailListener(el: HTMLElement): boolean {
  if (INTERACTIVE_TAG_NAMES.has(el.tagName)) return false
  return isDefaultAssigner((el as unknown as { [k: symbol]: unknown })[assignKey])
}

/**
 * Apply the field's element-level coerce closure, built at register time by
 * `buildElementCoerceFn`, to a scalar DOM-side value that should match an
 * array or Set member. `coerceElement` is set only on container paths; on a
 * scalar path, or with coercion off, it is `undefined` and the raw value
 * passes through. Mirrors `applyCoerce` at the path level.
 */
function applyElementCoerce(value: unknown, registerValue: RegisterValue): unknown {
  return registerValue.coerceElement !== undefined ? registerValue.coerceElement(value) : value
}

function onCompositionStart(e: Event) {
  const target = e.target as ComposingTarget
  if (!target) return

  target.composing = true
}

function onCompositionEnd(e: Event) {
  const target = e.target as ComposingTarget
  if (target?.composing === true) {
    target.composing = false
    target.dispatchEvent(new Event('input'))
  }
}

// The per-tag variants are plain vnode-hook objects, so a build that never
// reaches one can tree-shake it.
const vRegisterText: RegisterTextCustomDirective = {
  created(el, { value, modifiers: { lazy, trim, number } }, vnode) {
    // Static "would this listener ever want to cast?" gate for the optional
    // blur normalizer below, read off `vnode.props` at created-time because
    // the modifier is the part that can be frozen. Listener bodies re-derive
    // `castToNumber` per fire through `liveCastToNumber`, so a dynamic
    // `:type="..."` swap is honoured against the post-patch DOM.
    const castToNumberAtCreated = number === true || vnode.props?.['type'] === 'number'
    const liveCastToNumber = (): boolean => number === true || el.getAttribute('type') === 'number'
    if (isRegisterValue(value)) {
      value.registerElement(el)
      setAssignFunction(el, vnode, value)
    }
    // Deferred async-transform repaint: paint the resolved value into the
    // input once the run commits, mirroring the post-write force-sync below. A
    // bare `<input v-register>` has no `innerRef` watcher, so the orchestrator
    // calls this directly rather than waiting on a parent re-render.
    el._syncFromStorage = (): void => {
      if (!isRegisterValue(value)) return
      const storage = value.innerRef.value
      const display = storage == null ? '' : String(storage)
      if (el.value !== display) el.value = display
      if (liveCastToNumber()) writeLastTypedForm(value, null)
    }
    addTrackedListener(el, lazy === true ? 'change' : 'input', (e) => {
      // Without this guard a descendant's `input` event reaches this handler,
      // reads `el.value` off the wrapper (`''` in jsdom, `undefined` in
      // browsers) and clobbers the form. See `shouldBailListener`.
      if (shouldBailListener(el)) return
      const target = e.target as ComposingTarget
      if (target === null || target.composing) return
      noteInteraction(value)
      // Re-read per fire, so a dynamic `:type="..."` swap routes the next
      // keystroke through the right branch.
      const castToNumber = liveCastToNumber()
      let domValue: string | number = el.value
      // Deferred-to-blur trim: trim here only when this listener is already on
      // `change`, that is `.lazy.trim`. A per-keystroke trim on `input` fights
      // Vue's `:value` patch: the trimmed write reaches the model first, the
      // patch then sees `el.value` ahead of the model and rewrites the DOM
      // back to the trimmed form, swallowing the space the user is still
      // typing. The `change`-bound normalizer below catches the canonical
      // trimmed write at blur instead.
      if (trim === true && lazy === true) {
        domValue = domValue.trim()
      }
      if (castToNumber) {
        // Empty after the deferred trim, most often a backspace-clear on
        // `<input type="number">` or a `.number` text input. Mark the path
        // blank rather than skipping silently: storage takes the slim default,
        // the UI shows blank through `displayValue`, and submit-time
        // validation raises "No value supplied" if the schema demands a
        // number. Skipping on empty instead desyncs storage from the UI.
        //
        // `<input type="number">` quirk: the browser blanks `el.value`
        // mid-typing for malformed input, since `1e` is incomplete scientific
        // notation, so the typed text is hidden from `el.value` while still
        // visible in the DOM. `validity.badInput` is `true` there and `false`
        // for a genuinely empty field, which is what tells a real user-clear
        // apart from a transient mid-edit. Without the guard, typing `1e` into
        // a `type="number"` field marks blank, `displayValue` recomputes to
        // `''`, and Vue's patch yanks the `1e` away.
        if (domValue === '') {
          // A consumer-installed assigner can land on any tag, and `validity`
          // exists only on form controls, so the cast types it optional. The
          // default-assigner case is already handled by
          // `shouldBailListener`.
          const validity = (el as { validity?: ValidityState }).validity
          if (validity?.badInput === true) {
            return
          }
          if (isRegisterValue(value)) {
            writeLastTypedForm(value, null)
            value.markBlank()
          }
          return
        }
        const typedString = domValue
        domValue = looseToNumber(domValue)
        if (typeof domValue !== 'number') {
          // Non-castable garbage such as "abc" on a `.number` text input,
          // past the beforeinput filter through a scripted paste or a
          // programmatic `el.value = 'abc'`. Treated as the empty case, so the
          // slim-primitive rejection does not dev-warn over a transient
          // mid-edit state.
          if (isRegisterValue(value)) {
            writeLastTypedForm(value, null)
            value.markBlank()
          }
          return
        }
        if (!Number.isFinite(domValue)) {
          // Overflow: `1e309` and the like parse to Infinity. Do not commit,
          // since `z.number()` rejects non-finite and `JSON.stringify` renders
          // Infinity as `null`. Snap the DOM back to the last good
          // `displayValue` so the rejection is visible immediately, the way a
          // native `<input type="number" max>` caps. Storage stays at the last
          // finite write.
          if (isRegisterValue(value)) {
            const target = value.displayValue.value
            if (el.value !== target) el.value = target
          }
          return
        }
        // Castable: record the typed string so `displayValue` surfaces it
        // mid-typing. Storage commits in real time through the assigner below,
        // and without `lastTypedForm` Vue's `:value` patch would write
        // `String(cast)` into the DOM and yank the user away from the `1e2`
        // they are typing. The blur normalizer clears it, so the post-blur DOM
        // matches storage exactly.
        if (isRegisterValue(value)) writeLastTypedForm(value, typedString)
      }
      // Schema-aware DOM clear: emptying an `.optional()` string field writes
      // `undefined` to storage rather than `''`. Otherwise the schema's
      // "absent" semantic is unreachable from the DOM once the user has typed
      // anything, and a `z.string().email().optional()` locks in a permanent
      // validation error after a clear, `''` being neither undefined nor a
      // valid email. Only the text path reaches here: the castToNumber branch
      // above returns for empty input, and `slimDefault` resolves to undefined
      // for an optional number leaf, so `markBlank` already writes the right
      // thing there.
      //
      // A path that admits neither string nor undefined, a required
      // `z.number()` rendered as a plain text input, short-circuits through
      // `markBlank` for the same reason `castToNumber` does: the empty-string
      // write would be rejected by the slim-primitive gate, and the
      // force-sync below would snap the DOM back to the stored numeric,
      // making the final character undeletable.
      if (
        domValue === '' &&
        isRegisterValue(value) &&
        !value.acceptsString &&
        !value.acceptsUndefined
      ) {
        writeLastTypedForm(value, null)
        value.markBlank()
        return
      }
      const commit =
        domValue === '' && isRegisterValue(value) && value.acceptsUndefined ? undefined : domValue
      fireAssigner(el, value, commit)
      // After the default assigner runs, force-sync the DOM when storage
      // diverges from the post-cast, post-trim `domValue`. Two cases produce
      // no Vue re-render and so strand the imperative `beforeUpdate` sync:
      //   1. A `transforms` pipeline mapped the write onto current storage (a
      //      clamp at the cap, an idempotent normalize, a coerce re-emitting
      //      the stored shape), so the write produces no patch and no render.
      //   2. The slim-primitive gate, or a transform throw, rejected the
      //      write, so storage stays put and again nothing renders.
      // Either way the DOM keeps the user's raw typed text, divorced from
      // storage. Comparing the post-cast `domValue` rather than the raw typed
      // string preserves the typed-form contract: `1e2` against a number
      // schema casts to 100, storage becomes 100, the comparison matches, no
      // force-sync fires, and the user keeps seeing `1e2` mid-typing.
      //
      // Gated on `isDefaultAssigner`, because a custom assigner
      // (`@update:registerValue`, a pre-installed `el[assignKey]`) owns its
      // own DOM / storage relationship: it may write elsewhere, defer, batch,
      // or deliberately leave `innerRef.value` alone. Only the default
      // assigner's contract, that a successful write reflects in `innerRef`
      // immediately, makes the post-write comparison meaningful.
      if (isRegisterValue(value) && isDefaultAssigner(el[assignKey]) && !isTransforming(value)) {
        const storage = value.innerRef.value
        if (storage !== domValue) {
          const display = storage == null ? '' : String(storage)
          if (el.value !== display) el.value = display
          if (castToNumber) writeLastTypedForm(value, null)
        }
      }
    })
    if (trim === true || castToNumberAtCreated) {
      addTrackedListener(el, 'change', () => {
        if (shouldBailListener(el)) return
        // Mirror Vue's `castValue(el.value, trim, castToNumber)` so the
        // visible DOM normalizes after blur under both modifiers. Without the
        // cast branch, ` 12 ` typed into a `.number` input sticks as ` 12 `.
        let normalized: string | number = el.value
        if (trim === true) normalized = normalized.trim()
        // Re-derive per fire so a `:type` swap is honoured at blur too. The
        // installation gate above is the static "could this input ever want
        // cast-on-blur" check; the branch here reads the current type.
        const castToNumber = liveCastToNumber()
        if (castToNumber) {
          const cast = looseToNumber(normalized)
          if (typeof cast === 'number' && Number.isFinite(cast)) {
            // Blur clears the typed-form override, so `displayValue` returns
            // `String(storage)` and the DOM patches to the canonical form
            // (`'1e2'` to `'100'`, `'01'` to `'1'`, `'1.'` to `'1'`). What the
            // user sees after blur is what storage holds. The model commit is
            // gated on `lazy !== true`, since the lazy listener already wrote
            // on this same change event.
            if (isRegisterValue(value)) writeLastTypedForm(value, null)
            el.value = String(cast)
            if (lazy !== true) fireAssigner(el, value, cast)
          } else {
            // Uncastable mid-edit residue (a lone '.', '-', 'abc') or an
            // overflow parsing to Infinity. Native `<input type="number">`
            // clears on blur in both cases, which this matches. The keystroke
            // listener already marked blank under non-lazy, but under
            // `.lazy.number`, or for an overflow pasted straight into the
            // change event, this is the first chance.
            if (isRegisterValue(value)) {
              writeLastTypedForm(value, null)
              value.markBlank()
            }
            el.value = ''
          }
          return
        }
        el.value = typeof normalized === 'number' ? String(normalized) : normalized
        // Catch the model up on blur for non-lazy `.trim`. The input listener
        // wrote the raw mid-typing value under the deferred trim, so `change`
        // commits the canonical trimmed form and the DOM and model agree once
        // the user leaves. Under `.lazy.trim` the input listener already wrote
        // the trimmed value, so this skips a duplicate write.
        if (trim === true && lazy !== true) {
          fireAssigner(el, value, normalized)
        }
      })
    }
    if (lazy !== true) {
      addTrackedListener(el, 'compositionstart', onCompositionStart)
      addTrackedListener(el, 'compositionend', onCompositionEnd)
      // Safari < 10.2 & UIWebView doesn't fire compositionend when
      // switching focus before confirming composition choice
      // this also fixes the issue where some browsers e.g. iOS Chrome
      // fires "change" instead of "input" on autocomplete.
      addTrackedListener(el, 'change', onCompositionEnd)
    }
    // `.number` on a text input blocks non-numeric characters at the DOM
    // layer, so `el.value` never holds garbage. Native
    // `<input type="number">` filters in the browser already, so the listener
    // is skipped there. The regex takes an optional leading `-`, a single `.`,
    // any digits and an optional scientific-notation suffix, giving parity
    // with native `type="number"` on input like `1e3`. Partial states (`-`,
    // `1.`, `1e`, `1e-`) pass while the user is still typing, and the blur
    // normalizer commits the cast value or clears non-castable residue.
    // Composition events are not blocked: IME input proceeds and the
    // `compositionend` handler catches the final value.
    if (number === true && vnode.props?.['type'] !== 'number') {
      addTrackedListener(el, 'beforeinput', (e) => {
        const ev = e as InputEvent
        if (
          ev.inputType !== 'insertText' &&
          ev.inputType !== 'insertFromPaste' &&
          ev.inputType !== 'insertFromDrop'
        ) {
          return
        }
        const data = ev.data
        if (data === null) return
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        const next = el.value.slice(0, start) + data + el.value.slice(end)
        if (!/^-?\d*\.?\d*([eE][+-]?\d*)?$/.test(next)) ev.preventDefault()
      })
    }
  },
  // set value on mounted so it's after min/max for type="range"
  mounted(el, { value }) {
    if (!isRegisterValue(value)) return

    // Read through `displayValue`, not `innerRef`: it is the string
    // projection that honours `blankPaths`, returning `''` for a numeric leaf
    // marked blank even though storage holds the slim default. Otherwise the
    // stored `0` round-trips to `'0'` here, the blur handler sees
    // `el.value === '0'`, casts, and writes back through the assigner, wiping
    // the blank flag and locking the user out of the empty display state.
    el.value = value.displayValue.value

    // Reactive value sync. `beforeUpdate` repaints only when the host
    // component re-renders, so a mutation originating elsewhere (a sibling's
    // setValue / reset / clear, any imperative write while the template reads
    // no field state) never reaches the input. This watch on `displayValue`
    // closes that gap and is torn down by `teardownValueSync` in the
    // dispatcher's `beforeUnmount`. Focus-gated, so it never disturbs an
    // in-flight edit; `beforeUpdate` writes the same target value.
    setupValueSync(
      el,
      value.displayValue,
      () => {
        const next = value.displayValue.value
        if (el.value !== next) el.value = next
      },
      { skipWhileFocused: true }
    )
  },
  beforeUpdate(el, { value, oldValue, modifiers: { lazy, trim } }, vnode) {
    setAssignFunction(el, vnode, value)
    // Skip the sync mid-IME-composition: overwriting `el.value` would clobber
    // the unresolved input.
    if ((el as { composing?: boolean }).composing === true) return
    if (!isRegisterValue(value)) return

    // `displayValue` is the canonical string view: it folds in the blank rule,
    // returning `''` for a blank-marked numeric leaf, and the typed-form
    // preference, so a sibling's re-render cannot clobber a mid-typing `'1e2'`.
    // Compare it against the live DOM as a string. Parsing `el.value` through
    // `looseToNumber` and comparing against raw storage instead paints `'0'`
    // over a blank-empty DOM on every reactive update.
    const target = value.displayValue.value
    if (el.value === target) {
      return
    }

    // ShadowRoot-aware activeElement check: for an input mounted inside a
    // shadow tree, `activeElement` lives on the rootNode. Reading
    // `document.activeElement === el` is always false there, defeating the
    // lazy and trim escape hatches below.
    const rootNode = el.getRootNode()
    const activeElement =
      rootNode instanceof Document || rootNode instanceof ShadowRoot ? rootNode.activeElement : null
    if (activeElement === el && el.type !== 'range') {
      // Lazy escape: the consumer chose `change`-only updates. While
      // the user is still editing, suppress reverse-syncs that would
      // otherwise revert their typing on every parent re-render.
      if (lazy === true && value.innerRef.value === oldValue) {
        return
      }
      // Trim escape, same rationale: the trimmed-but-otherwise-equal value is
      // where blur lands anyway, so do not fight the user's whitespace.
      if (trim === true && el.value.trim() === target) {
        return
      }
    }

    el.value = target
  },
}

const vRegisterCheckbox: RegisterCheckboxCustomDirective = {
  // #4096 array checkboxes need to be deep traversed
  deep: true,
  created(el, { value }, vnode) {
    if (!isRegisterValue(value)) return

    value.registerElement(el)
    setAssignFunction(el, vnode, value)
    // Deferred async-transform repaint: re-apply checked state from the
    // committed value once the run lands, mirroring the force-sync below.
    el._syncFromStorage = (): void => {
      if (!isRegisterValue(value)) return
      setChecked(el, value)
      el._lastAppliedModel = value.innerRef.value
    }
    addTrackedListener(el, 'change', () => {
      if (shouldBailListener(el)) return
      noteInteraction(value)
      const modelValue = value.innerRef.value ?? []

      // Side-steps the two-way binding bug where the ref updates but the input
      // cannot be tracked by value.
      const explicitValueRequired = true
      const rawElementValue = getValue(el, explicitValueRequired)

      const checked = el.checked
      if (isArray(modelValue)) {
        if (rawElementValue === undefined) {
          if (__DEV__) {
            warn(
              'Checkbox bound to an array model is missing a `value` attribute, ' +
                'so Attaform cannot determine which item to add or remove. ' +
                'Add value="..." to each <input type="checkbox">.'
            )
          }
          return
        }
        // Element-level coerce on the raw DOM value, so the `looseIndexOf`
        // lookup and the new array's element shape match the post-coerce
        // model. Without it the handler builds a mixed-type array, boolean
        // members beside a raw string, and either misses the existing entry on
        // uncheck or appends a string to a typed-element array. The assigner's
        // path-level coerce cleans up the new array either way.
        const elementValue = applyElementCoerce(rawElementValue, value)
        const index = looseIndexOf(modelValue, elementValue)
        const found = index !== -1
        if (checked && !found) {
          fireAssigner(el, value, modelValue.concat(elementValue))
        } else if (!checked && found) {
          const filtered = [...modelValue]
          filtered.splice(index, 1)
          fireAssigner(el, value, filtered)
        }
      } else if (isSet(modelValue)) {
        if (rawElementValue === undefined) {
          if (__DEV__) {
            warn(
              'Checkbox bound to a Set model is missing a `value` attribute, ' +
                'so Attaform cannot determine which item to add or remove. ' +
                'Add value="..." to each <input type="checkbox">.'
            )
          }
          return
        }
        // `Set.delete` is strict, so coerce BEFORE the Set ops or a removal
        // silently fails when the model holds post-coerce booleans or numbers
        // and the DOM hands back the raw string.
        const elementValue = applyElementCoerce(rawElementValue, value)
        const cloned = new Set(modelValue)
        if (checked) {
          cloned.add(elementValue)
        } else {
          cloned.delete(elementValue)
        }
        fireAssigner(el, value, cloned)
      } else {
        fireAssigner(el, value, getCheckboxValue(el, checked))
      }
      // Force-sync `el.checked` to storage after the default assigner runs.
      // Catches the no-op write, where a transform mapped the click onto
      // current storage (an always-false transform on an already-false
      // checkbox): no patch, no render, no `beforeUpdate`, and the DOM keeps
      // the user's click state divorced from storage. Skipped for a custom
      // assigner, which owns its own sync, and while a transform is in flight,
      // where `_syncFromStorage` repaints once the commit lands.
      if (isRegisterValue(value) && isDefaultAssigner(el[assignKey]) && !isTransforming(value)) {
        setChecked(el, value)
        el._lastAppliedModel = value.innerRef.value
      }
    })
  },
  // set initial checked on mount to wait for true-value/false-value
  mounted(el, { value }) {
    setChecked(el, value)
    if (!isRegisterValue(value)) return
    el._lastAppliedModel = value.innerRef.value
    // An external model change that triggers no host re-render (a sibling's
    // setValue / reset / clear) re-runs the `setChecked` the `beforeUpdate`
    // path uses. Not focus-gated: it must reflect even on a focused checkbox,
    // and the write is idempotent.
    setupValueSync(el, value.innerRef, () => {
      setChecked(el, value)
      el._lastAppliedModel = value.innerRef.value
    })
  },
  // Skip the DOM sync when the model is identity-unchanged since the last
  // application. Without the guard, a sibling's reactive write triggers
  // `beforeUpdate` mid-click, `setChecked` re-applies the prior model state,
  // and the in-flight toggle is clobbered before the browser fires `change`.
  // Compare `innerRef.value` by identity: every form write produces a fresh
  // value at the path, new primitives and new array or Set references along
  // the spine, so reference equality tracks "did the model move" exactly. The
  // guard must NOT compare against `oldValue`, which is the previous binding's
  // wrapper RegisterValue and never equals a model scalar.
  beforeUpdate(el, binding, vnode) {
    setAssignFunction(el, vnode, binding.value)
    if (!isRegisterValue(binding.value)) return
    const currentModel = binding.value.innerRef.value
    if (el._lastAppliedModel === currentModel) return
    setChecked(el, binding.value)
    el._lastAppliedModel = currentModel
  },
}

function setChecked(el: HTMLInputElement, value: unknown): void {
  if (!isRegisterValue(value)) return

  const originalValue = value.innerRef.value
  let checked: boolean

  // Read the option-value through `getValue(el)`, not `vnode.props`. Under SSR
  // hydration Vue skips `patchProp` for a hoisted static `value="..."`, so the
  // vnode props do not carry it and `el._value` is never set; reading props
  // unchecks the box even when the DOM `value` attribute matches the model.
  // `getValue` checks `_value` first and then the DOM property, so Vue
  // dynamic, Vue hydrated static and a manual `setAttribute` all resolve
  // identically.
  //
  // Every branch below compares the post-coerce model against the RAW DOM-side
  // value, the option's `value` attribute or the checkbox's `_trueValue`.
  // Coerce normalizes the WRITE direction (`"True"` to `true` for
  // `z.boolean()`), so without the same normalization on the READ direction
  // `looseEqual` / `looseIndexOf` / `Set.has` fight the user's click on every
  // re-render. See the setChecked-mid-coerce cases in `coerce.test.ts`.
  if (isArray(originalValue)) {
    // Element-level coerce: the DOM-side raw value is a SCALAR matching the
    // array's element type, not the path's top-level `array`, which has no
    // scalar coerce target.
    checked = looseIndexOf(originalValue, applyElementCoerce(getValue(el), value)) > -1
  } else if (isSet(originalValue)) {
    // `Set.has` is SameValueZero rather than loose, so a mismatch is fatal
    // here, not merely wrong for case-sensitive booleans.
    checked = originalValue.has(applyElementCoerce(getValue(el), value))
  } else {
    const trueValueCoerced = applyCoerce(getCheckboxValue(el, true), value)
    checked = looseEqual(originalValue, trueValueCoerced)
  }

  if (el.checked !== checked) {
    el.checked = checked
  }
}

const vRegisterRadio: RegisterRadioCustomDirective = {
  created(el, { value }, vnode) {
    if (!isRegisterValue(value)) return

    value.registerElement(el)
    setAssignFunction(el, vnode, value)
    // Deferred async-transform repaint: re-apply checked state from the
    // committed value once the run lands, mirroring the force-sync below.
    el._syncFromStorage = (): void => {
      if (!isRegisterValue(value)) return
      const currentModel = value.innerRef.value
      const target = looseEqual(currentModel, applyCoerce(getValue(el), value))
      if (el.checked !== target) el.checked = target
      el._lastAppliedModel = currentModel
    }
    addTrackedListener(el, 'change', () => {
      if (shouldBailListener(el)) return
      noteInteraction(value)
      fireAssigner(el, value, getValue(el))
      // Force-sync `el.checked` to storage after the default assigner runs,
      // catching the no-op write where a transform maps the click onto current
      // storage. Skipped for a custom assigner and while a transform is in
      // flight, where `_syncFromStorage` repaints on commit.
      if (isRegisterValue(value) && isDefaultAssigner(el[assignKey]) && !isTransforming(value)) {
        const currentModel = value.innerRef.value
        const target = looseEqual(currentModel, applyCoerce(getValue(el), value))
        if (el.checked !== target) el.checked = target
        el._lastAppliedModel = currentModel
      }
    })
  },
  // The initial checked sync runs in `mounted`, NOT `created`: Vue fires
  // `created` before the element's attributes are patched, so `type`, `value`
  // and `_value` are absent, `getValue(el)` returns undefined, and every radio
  // in a group mounts unchecked whatever the model says. Checkbox uses
  // `mounted` for the same reason.
  mounted(el, { value }) {
    if (!isRegisterValue(value)) return
    // `getValue(el)` rather than `vnode.props`, so an SSR-hydrated static
    // `value="..."` still resolves; Vue's static-attr fast path skips
    // `patchProp`, so it never reaches vnode props. Coerce the raw value as
    // the change handler will, keeping the comparison symmetric. See
    // `setChecked`.
    el.checked = looseEqual(value.innerRef.value, applyCoerce(getValue(el), value))
    el._lastAppliedModel = value.innerRef.value
    // An external model change with no host re-render re-runs the checked
    // computation the `beforeUpdate` path uses. Not focus-gated: it must
    // reflect even on a focused radio, and writing `el.checked` is atomic.
    setupValueSync(el, value.innerRef, () => {
      el.checked = looseEqual(value.innerRef.value, applyCoerce(getValue(el), value))
      el._lastAppliedModel = value.innerRef.value
    })
  },
  // Skip the DOM sync when the model is identity-unchanged since the last
  // application, tracked on `_lastAppliedModel`. Comparing against `oldValue`
  // instead compares a primitive scalar to the previous binding's wrapper
  // RegisterValue, never equal, so `el.checked` re-applies on every parent
  // re-render and a sibling's reactive write clobbers an in-flight selection
  // mid-click.
  beforeUpdate(el, { value }, vnode) {
    if (!isRegisterValue(value)) return

    setAssignFunction(el, vnode, value)
    const currentModel = value.innerRef.value
    if (el._lastAppliedModel === currentModel) return
    el.checked = looseEqual(currentModel, applyCoerce(getValue(el), value))
    el._lastAppliedModel = currentModel
  },
}

const vRegisterSelect: RegisterSelectCustomDirective = {
  // <select multiple> value need to be deep traversed
  deep: true,
  created(el, { value, modifiers: { number } }, vnode) {
    if (!isRegisterValue(value)) return

    value.registerElement(el)
    // Deferred async-transform repaint: re-apply the selection from the
    // committed value once the run lands (mirrors the post-write force-
    // sync below).
    el._syncFromStorage = (): void => {
      if (!isRegisterValue(value)) return
      setSelected(el, value)
      el._lastAppliedModel = value.innerRef.value
    }
    addTrackedListener(el, 'change', () => {
      if (shouldBailListener(el)) return
      noteInteraction(value)
      // Re-derive per fire, so an Array-to-Set swap on the bound path (a
      // `form.setValue('picks', new Set([...]))` against a union schema, or
      // any write landing a different container shape) routes the next change
      // through the matching constructor.
      const isSetModel = isSet(value.innerRef.value)
      const selectedVal = Array.prototype.filter
        .call(el.options, (o: HTMLOptionElement) => o.selected)
        .map((o: HTMLOptionElement) => (number === true ? looseToNumber(getValue(o)) : getValue(o)))
      const wrote = fireAssigner(
        el,
        value,
        el.multiple ? (isSetModel ? new Set(selectedVal) : selectedVal) : selectedVal[0]
      )
      // Set `_assigning` only when the write landed. A write the
      // slim-primitive gate rejected must NOT suppress the next `updated`
      // hook's `setSelected`, since the form state did not change and the DOM
      // should revert to `innerRef.value`. `undefined` from a
      // consumer-installed assigner counts as success: returning nothing is
      // the documented shape for a simple assigner, so it cannot mean
      // rejection.
      if (wrote !== false) {
        el._assigning = true
        void nextTick(() => {
          el._assigning = false
        })
      }
      // Force-sync the `<select>` selection to storage after the default
      // assigner runs, catching the no-op write where a transform maps the
      // pick onto current storage: no patch, no render, no `updated`, and the
      // DOM keeps the user's selection divorced from storage. Skipped for a
      // custom assigner and while a transform is in flight.
      if (isRegisterValue(value) && isDefaultAssigner(el[assignKey]) && !isTransforming(value)) {
        setSelected(el, value)
        el._lastAppliedModel = value.innerRef.value
      }
    })
    setAssignFunction(el, vnode, value)
  },
  // set value in mounted & updated because <select> relies on its children
  // <option>s.
  mounted(el, { value }) {
    setSelected(el, value)
    if (!isRegisterValue(value)) return
    el._lastAppliedModel = value.innerRef.value
    // An external model change with no host re-render re-runs the
    // `setSelected` the `updated` path uses. The `_assigning` guard
    // short-circuits the mid-click window between mousedown and change, so an
    // in-progress multi-select is not clobbered, matching `updated`.
    setupValueSync(el, value.innerRef, () => {
      if (el._assigning === true) return
      setSelected(el, value)
      el._lastAppliedModel = value.innerRef.value
    })
  },
  beforeUpdate(el, binding, vnode) {
    setAssignFunction(el, vnode, binding.value)
  },
  // Skip the DOM sync when the model is identity-unchanged since the last
  // application. A parent re-render fires `updated` whether or not the bound
  // model moved: a typed character in a sibling, an async-validation tick, any
  // reactive read elsewhere on the page. Re-applying `setSelected` against the
  // prior model on each of those clobbers an in-progress `<select multiple>`
  // selection between mousedown and the browser's change decision, after which
  // the browser sees no net change, never fires `change`, and the model never
  // updates.
  //
  // Identity comparison is sound: every form write produces a new array or Set
  // reference at the path, the replacement of `form.value` rolling fresh
  // structures forward along the spine. The `_assigning` gate stays as well,
  // short-circuiting the immediate post-write render where the DOM is already
  // in sync from the user's click.
  updated(el, { value }) {
    if (el._assigning === true) return
    if (!isRegisterValue(value)) return
    const currentModel = value.innerRef.value
    if (el._lastAppliedModel === currentModel) return
    setSelected(el, value)
    el._lastAppliedModel = currentModel
  },
}

function setSelected(el: HTMLSelectElement, value: unknown) {
  if (!isRegisterValue(value)) return

  // Use the model value directly, mirroring Vue's `vModelSelect.setSelected`.
  // Reading DOM-current selection state instead returns an empty Set for a
  // single-select numeric model, the downstream `looseEqual('1', Set{})` fails,
  // and `selectedIndex` lands at `-1` with nothing highlighted even though the
  // bound value matches an option. Single-select drives the DOM through
  // `looseEqual`, which coerces primitives via `String(...)`; multi-select uses
  // Array or Set membership.
  const externalValue = value.innerRef.value
  const isMultiple = el.multiple
  const isArrayValue = isArray(externalValue)
  // A path the form does not hold. Read the raw model rather than
  // `displayValue`, which the single-select branch below uses: `[]` and `['']`
  // both stringify to `''`, and the second is a list holding the empty member,
  // not an absent one.
  const isUnset = externalValue === null || externalValue === undefined

  if (isMultiple && isUnset) {
    // No value means no members picked. That is the multi-select's natural
    // empty state, reachable by deselecting everything, so it needs neither a
    // warning nor a `-1`. Falling through to the misuse branch below tells the
    // consumer to bind a list-typed schema they already have: the path is
    // simply unseeded, a record key that appears once a sibling field names it
    // (#569).
    for (let i = 0, l = el.options.length; i < l; i++) {
      const option = el.options[i]
      if (option !== undefined) option.selected = false
    }
    return
  }

  if (isMultiple && !isArrayValue && !isSet(externalValue)) {
    if (__DEV__) {
      warn(
        `<select multiple v-register> expected an Array or Set, got ` +
          `${Object.prototype.toString.call(externalValue).slice(8, -1)}. ` +
          `Bind to a list-typed schema (e.g. z.array(z.string()) or z.set(z.string())).`
      )
    }
    return
  }
  // Symmetric misuse: a non-multiple select bound to an Array or Set model.
  // The change handler writes a scalar `selectedVal[0]` back, which the
  // slim-primitive gate rejects against an Array path, so the clicks silently
  // fail, and mount-time `looseEqual('a', ['a', 'b'])` is false, so no option
  // is ever highlighted. Dev-warn with the fix instead.
  if (!isMultiple && (isArrayValue || isSet(externalValue))) {
    if (__DEV__) {
      warn(
        `<select v-register> (no \`multiple\` attribute) expected a scalar value for its ` +
          `binding, but got ${Object.prototype.toString.call(externalValue).slice(8, -1)}. ` +
          `Add the \`multiple\` attribute to bind to a list, or use a scalar schema (e.g. ` +
          `\`z.string()\`) for a single-select binding.`
      )
    }
    return
  }

  if (isMultiple) {
    // Stringify the model members once into a Set, then look each option up
    // in O(1). That puts `setSelected` at O(N + M) for an N-item model and an
    // M-option `<select>`, which matters at thousands of either. The Array and
    // Set primitive paths share it; object-valued option binds keep their
    // identity comparisons.
    //
    // Each option's raw `value` goes through `applyCoerce` before stringifying,
    // keeping the comparison symmetric with the change handler's write-side
    // coerce. Without it `String(true)` is `"true"` while a raw `"True"`
    // stringifies to `"True"`, and the option silently never matches.
    const stringifiedMembers = new Set<string>()
    const iter: Iterable<unknown> = isArrayValue
      ? (externalValue as ReadonlyArray<unknown>)
      : (externalValue as Set<unknown>)
    for (const v of iter) stringifiedMembers.add(String(v))

    for (let i = 0, l = el.options.length; i < l; i++) {
      const option = el.options[i]
      if (!option) continue
      // Element-level coerce: an option matches a MEMBER of the array or Set
      // model, so the comparison runs against the element type.
      const optionValue = applyElementCoerce(getValue(option), value)
      const optionType = typeof optionValue
      if (optionType === 'string' || optionType === 'number') {
        option.selected = stringifiedMembers.has(String(optionValue))
      } else if (optionType === 'boolean') {
        // Booleans take the same stringify channel, which covers
        // `<option value="True">` against `z.array(z.boolean())` once coerce
        // has normalised to `true`.
        option.selected = stringifiedMembers.has(String(optionValue))
      } else if (isArrayValue) {
        // Object option, Array model: structural equality, as Vue does.
        option.selected = looseIndexOf(externalValue, optionValue) > -1
      } else {
        // Object option, Set model: identity `.has`, since a Set cannot
        // compare structurally without iterating, and Vue uses identity here.
        option.selected = (externalValue as Set<unknown>).has(optionValue)
      }
    }
    return
  }

  // Non-multiple: select the first option matching the scalar model, clearing
  // when nothing matches. Coerce the raw option value for parity with the
  // change handler.
  //
  // A field holding no value matches against `''`, not against raw `undefined`.
  // `displayValue` is Attaform's answer to "what does this field show", folding
  // a blank mark and a null or absent model to `''`, and every other reader
  // goes through it: `vRegisterText` paints it into `el.value`, and the
  // compile-time `:value` injection on this very `<select>` reads the same ref.
  // Matching it here selects an authored `<option value="">` placeholder for an
  // unseeded path, the way an `<input>` shows empty. Comparing raw `undefined`
  // instead matches no option and falls through to `selectedIndex = -1`, a
  // state no user can reach by interacting, painted as an empty box and
  // contradicted by SSR: the server marks no option, the browser parses the
  // first as selected, and hydration erases it (#569).
  //
  // The fall-through to `-1` stays for a model that HOLDS a value no option
  // carries. Showing an arbitrary option there would lie about the form.
  const target = value.displayValue.value === '' ? '' : externalValue
  for (let i = 0, l = el.options.length; i < l; i++) {
    const option = el.options[i]
    if (!option) continue
    if (looseEqual(applyCoerce(getValue(option), value), target)) {
      if (el.selectedIndex !== i) el.selectedIndex = i
      return
    }
  }
  if (el.selectedIndex !== -1) el.selectedIndex = -1
}

// Retrieve the raw value set via `:value` bindings.
//
// `explicitRequired` is how the checkbox-array and checkbox-Set callers demand
// an option-value from either a dynamic `:value` (which sets `el._value`) or a
// static `value` attribute. With neither, the default `el.value` of `'on'`
// would silently add that literal to the array on every toggle, so undefined
// comes back and the caller warns instead.
//
// The `hasAttribute('value')` fallback is what carries the SSR static-attr
// hydration path: Vue skips `patchProp` for a hoisted static attribute, so
// `el._value` is never set even though the DOM reflects the rendered
// `value="apple"`.
function getValue(el: HTMLOptionElement | HTMLInputElement, explicitRequired = false) {
  if ('_value' in el) return el._value
  if (explicitRequired && !el.hasAttribute('value')) return undefined
  return el.value
}

// Retrieve the raw value for `:true-value` / `:false-value` bindings.
function getCheckboxValue(
  el: HTMLInputElement & { _trueValue?: unknown; _falseValue?: unknown },
  checked: boolean
) {
  const key = checked ? '_trueValue' : '_falseValue'
  return key in el ? el[key] : checked
}

// A v-register binding on a tag no variant handles natively (a `<div>`, a
// `<span>`, a Vue component whose root is a non-form element) still gets its
// listeners attached, but the bodies bail through `shouldBailListener` while
// the assigner is the default. That prevents the bubbled-write bug while
// letting a consumer-installed `assignKey` / `@update:registerValue` through.
//
// The "no escape hatch" dev-warn is deferred one tick past the directive's
// `mounted` hook, so `useRegister`'s own `onMounted` can set
// `REGISTER_OWNER_MARKER` on the rendered root first. The anchor must be
// `mounted`, NOT `created`: `mounted` always runs inside a real scheduler
// post-flush, on a fresh mount and on the Suspense / async-hydration path
// alike, so a `nextTick` chained from it resolves after the owning child's
// post-flush `onMounted`. From `created` it races during async hydration,
// where the directive hook runs inside a bare `Promise.then` with no active
// flush, making the `nextTick` a bare microtask that fires before the marker
// is set and warns falsely on every SSR'd wrapper. With no deferral at all,
// every deeply-nested `useRegister` child warns: the directive cannot reach
// the child instance through `binding.instance`, which is the parent
// component, whose `subTree` is the outer element tree.

// One-shot dedupe, so a v-for over 100 unsupported elements warns once. Keyed
// by element identity.
const warnedUnsupportedElements: WeakSet<HTMLElement> | null = __DEV__
  ? new WeakSet<HTMLElement>()
  : null

// Dev-warn dedupe for a redundant state binding beside v-register. Keyed by a
// coarse misuse SIGNATURE (`tag:type:binding`, such as
// `input:checkbox::checked`) rather than element identity, because the same
// redundant binding repeated across a v-for'd field-array row is the common
// case and an element-keyed set would print one warning per row. The signature
// space is a handful of tag / type / binding combinations, so a plain Set
// cannot grow without limit. Per-element precision is the compile layer's job,
// once per element per build; the runtime need only surface the pattern once.
const warnedRedundantBindings: Set<string> | null = __DEV__ ? new Set<string>() : null

// Per-host-root record of the component-host branch's outcome, read back at
// `beforeUnmount` to tear down symmetrically. Maps a host root to the inner
// control it latched, or `null` for the no-latch path. Absent means Case A, a
// useRegister wrapper the discriminator skipped, or not a host at all, so
// there is nothing to undo.
const componentHostLatch = new WeakMap<HTMLElement, HTMLElement | null>()

// Widget-root focus listeners for a no-latch host, kept so a later self-heal
// latch can detach them before the latched control's own focus and blur
// listeners take over. Otherwise a focus is counted on both root and control.
const hostFocusListeners = new WeakMap<
  HTMLElement,
  { focusin: EventListener; focusout: EventListener }
>()

// Self-heal MutationObservers, kept so `beforeUnmount` can disconnect a host
// still waiting for an asynchronously-rendered control.
const hostHealObservers = new WeakMap<HTMLElement, MutationObserver>()

// Upper bound on the MutationObserver batches the self-heal processes before
// giving up on a host whose subtree keeps mutating without resolving a single
// latchable control, so a no-latch host cannot carry a live observer for the
// rest of the page's life.
const SELF_HEAL_MAX_MUTATION_BATCHES = 20

// The inner form controls host discovery latches onto. The `type=hidden`
// exclusion drops the simplest mirror inputs; `isLatchableControl` drops the
// rest.
const HOST_CONTROL_SELECTOR = 'input:not([type=hidden]), select, textarea'

// Whether a control discovered under a host is a real, user-facing one rather
// than a form-submission mirror. Headless components render a second,
// visually-hidden control beside the real one so a native form submit still
// carries the value. These are not `type=hidden`: they sit at `tabindex="-1"`
// with sr-only styling and are tagged inconsistently, `aria-hidden="true"` on
// some and `data-hidden` on others. Latching one pins focus and aria onto an
// element the user can never reach, and a lone real control beside a mirror
// counts as two and declines the latch. The one to latch is the one the user
// can focus, so drop anything out of the tab order or hidden from the a11y
// tree.
function isLatchableControl(el: Element): boolean {
  return el.getAttribute('tabindex') !== '-1' && el.getAttribute('aria-hidden') !== 'true'
}

// The runtime half of v-register's third-party binding. The compile-time
// `componentBridgeTransform` stamps `SSR_COMPONENT_HOST_MODIFIER` on a
// v-register landing on a component host and injects the value channel,
// v-model for a plain component and `:value` for a select-like one. The
// directive supplies the rich FieldState: it discovers the real inner control
// and registers it, for connected, focus and blur, and the aria and
// scroll-to-error target.
//
// Two host shapes are told apart at mount.
//   - Case A, a useRegister wrapper. Its inner `<input v-register>` already
//     self-registered for this path, children mounting before parents, so a
//     registered element sits inside the host. That control owns value and
//     FieldState and the injected v-model is inert, so do nothing.
//   - Case B, a third-party component. Nothing is registered for this path.
//     Latch the single inner control when exactly one resolves, else fall back
//     to marking the host connected, value still binding through the v-model
//     channel. Either way set `REGISTER_OWNER_MARKER`, so the deferred "no-op"
//     warn skips: a value-binding host is not a no-op.

// Query the host for the single user-facing control to bind, dropping
// submission mirrors. Returns the element only when exactly one resolves; zero
// or several (a composite widget, or a control that has not rendered yet)
// returns null.
function findHostControl(el: HTMLElement): HTMLElement | null {
  const descendants = Array.from(el.querySelectorAll(HOST_CONTROL_SELECTOR)).filter(
    isLatchableControl
  )
  return descendants.length === 1 ? (descendants[0] as HTMLElement) : null
}

// Bind a discovered control: register it for the rich FieldState and manage
// its aria. `registerElement` is value-free, gating on INTERACTIVE_TAG_NAMES
// and seeding only `connected` plus focus and blur listeners, never touching
// `el.value`, so it cannot fight the v-model channel. The live-DOM aria lock
// honours aria the component authored on its own control, no vnode being
// available for a runtime-discovered element.
function latchHostControl(el: HTMLElement, rv: RegisterValue, control: HTMLElement): void {
  rv.registerElement(control)
  setupAriaLive(control as AriaCarrier, rv)
  componentHostLatch.set(el, control)
}

// No single control resolved: value still binds through the v-model channel,
// so mark the host connected and track focus at the widget root. `focusin` and
// `focusout` bubble where `focus` and `blur` do not, so a root listener sees
// focus crossing the inner controls. A move whose `relatedTarget` stays inside
// the host is an intra-widget hop, not an enter or leave of the field, so it is
// skipped. The listeners ride `addTrackedListener`, so `beforeUnmount` detaches
// them, and are stashed besides so a later self-heal latch can detach them
// itself before the control's own listeners take over.
function setupNoLatchHost(el: HTMLElement, rv: RegisterValue): void {
  rv.markHostConnected(true, el)
  const focusin: EventListener = (event) => {
    const from = (event as FocusEvent).relatedTarget
    if (from instanceof Node && el.contains(from)) return
    rv.markFocused(true)
  }
  const focusout: EventListener = (event) => {
    const to = (event as FocusEvent).relatedTarget
    if (to instanceof Node && el.contains(to)) return
    rv.markFocused(false)
  }
  addTrackedListener(el, 'focusin', focusin)
  addTrackedListener(el, 'focusout', focusout)
  hostFocusListeners.set(el, { focusin, focusout })
  componentHostLatch.set(el, null)
}

// Self-heal retry: a no-latch host re-queries for a control that arrived after
// mount. When exactly one now resolves, supersede the no-latch state by
// detaching the widget-root focus listeners, whose job `registerElement` takes
// over, and latching it. `connected` already reads true from the host mark,
// `registerElement` keeps it true, and the element Set owns it from here, so
// `beforeUnmount`'s deregister clears it. Returns true on supersede.
function trySupersedeHostLatch(el: HTMLElement, rv: RegisterValue): boolean {
  const control = findHostControl(el)
  if (control === null) return false
  const focusListeners = hostFocusListeners.get(el)
  if (focusListeners !== undefined) {
    el.removeEventListener('focusin', focusListeners.focusin)
    el.removeEventListener('focusout', focusListeners.focusout)
    hostFocusListeners.delete(el)
  }
  latchHostControl(el, rv, control)
  return true
}

// A no-latch host may simply have rendered its single control late, behind a
// Suspense boundary, an async setup or a post-fetch v-if. The directive's
// `updated` does not fire on the component's own internal re-render, only on
// the parent's, so poll: once on the next tick, which is cheap and catches a
// control a microtask late, then through a scoped, bounded MutationObserver
// for a truly async one. The first exactly-one match latches and stops the
// search.
function scheduleHostSelfHeal(el: HTMLElement, rv: RegisterValue): void {
  void nextTick(() => {
    // Bail if the host unmounted (record deleted) or already latched.
    if (componentHostLatch.get(el) !== null || !el.isConnected) return
    if (trySupersedeHostLatch(el, rv)) return
    observeForLateHostControl(el, rv)
  })
}

function observeForLateHostControl(el: HTMLElement, rv: RegisterValue): void {
  let batches = 0
  const observer = new MutationObserver(() => {
    // Short-circuits, so the latch attempt runs only while still unlatched and
    // connected and the batch counter ticks only on a batch that failed to
    // latch. Stop on a latch, on teardown, or once the budget is spent.
    const done =
      componentHostLatch.get(el) !== null ||
      !el.isConnected ||
      trySupersedeHostLatch(el, rv) ||
      ++batches >= SELF_HEAL_MAX_MUTATION_BATCHES
    if (done) {
      observer.disconnect()
      hostHealObservers.delete(el)
    }
  })
  observer.observe(el, { childList: true, subtree: true })
  hostHealObservers.set(el, observer)
}

function activateComponentHost(el: HTMLElement, rv: RegisterValue): void {
  // Case A: a useRegister wrapper already owns this path, its inner control
  // having self-registered before this host mounted. That control owns value
  // and FieldState and the injected v-model is inert.
  if (rv.hasRegisteredDescendant(el)) return

  // Case B: a third-party component. Value binds through the transform's
  // v-model desugar, so this binding is never a no-op; claim the root so the
  // deferred "no-op" warn skips. A host root that is ITSELF an interactive
  // control was registered by the per-tag variant and taken by the Case-A
  // return above.
  ;(el as unknown as { [k: symbol]: unknown })[REGISTER_OWNER_MARKER] = true

  // Strip the bridge `registerValue` attribute the transform injects on the
  // host. A useRegister wrapper consumes and strips it in setup (Case A, above)
  // and a Web Component reads it as a DOM attribute through `assignKey`, but a
  // plain third-party Vue component does neither, so with `inheritAttrs` on it
  // lands on the host root as `registervalue="[object Object]"`. This is the
  // directive's only hook on a component it does not author. Custom elements,
  // spotted by their hyphenated tag, legitimately read the attribute and are
  // skipped. Runs post-mount, so SSR output and hydration still match.
  if (!el.tagName.includes('-')) {
    el.removeAttribute('registerValue')
  }

  // Latch the single inner control when exactly one resolves now; zero or
  // several declines into the no-latch path. A control that has not rendered
  // yet looks like none, so the no-latch path also starts the self-heal.
  const control = findHostControl(el)
  if (control !== null) {
    latchHostControl(el, rv, control)
    return
  }
  setupNoLatchHost(el, rv)
  scheduleHostSelfHeal(el, rv)
}

const vRegisterDynamic: RegisterModelDynamicCustomDirective = {
  created(el, binding, vnode) {
    // Arm the store's DOM binding before any registration below, since the
    // variant `created` hooks call `value.registerElement`. This injection is
    // what keeps the DOM machinery out of the form core's eager graph; see
    // `dom-binding.ts`.
    if (isRegisterValue(binding.value)) armDomBinding(binding.value)

    // Always run the per-tag variant's `created`: the listener-body bail
    // prevents the bubbled-write bug on a non-supported root while letting
    // consumer overrides through.
    callModelHook(el, binding, vnode, null, 'created')

    // Auto-aria: lock authored attrs, paint the initial state and watch the
    // gated display state for async ticks. A no-op when the binding carries no
    // display-state accessor.
    if (isRegisterValue(binding.value)) setupAria(el as AriaCarrier, binding.value, vnode)

    // Dev diagnostic for a redundant `:value` / `:checked` / `v-model` beside
    // v-register. Stands down when the compile-time transforms own detection;
    // see `warnRedundantStateBinding`. Runs last, so the binding is fully set
    // up first: a diagnostic never affects the field's behaviour.
    if (__DEV__) warnRedundantStateBinding(el, binding, vnode)
  },
  mounted(el, binding, vnode) {
    callModelHook(el, binding, vnode, null, 'mounted')

    // Reactive `disabled` sync for a render-function native control, mirroring
    // the form's effective freeze onto `el.disabled`. Gated on the vnode
    // carrying NO `disabled` prop, so it runs only where nothing else binds the
    // attribute, a bare `withDirectives(h('input'), ...)` field. A compiled
    // field already carries the transform's `:disabled` bind, or the author's
    // own, which tracks the same source through the render function, and
    // managing `el.disabled` imperatively there would fight it. Native controls
    // only: a component host's freeze rides its `:disabled` prop through the
    // bridge transform, never the host root.
    if (
      isRegisterValue(binding.value) &&
      INTERACTIVE_TAG_NAMES.has(el.tagName) &&
      binding.modifiers[SSR_COMPONENT_HOST_MODIFIER] !== true &&
      vnode.props?.['disabled'] === undefined
    ) {
      setupDisabledSync(el, binding.value.disabled)
    }

    // Component-host element discovery; see `activateComponentHost`. Runs
    // before the warn below, so the `REGISTER_OWNER_MARKER` it sets on a Case-B
    // host suppresses the no-op warn a non-interactive host root would draw.
    if (binding.modifiers[SSR_COMPONENT_HOST_MODIFIER] === true && isRegisterValue(binding.value)) {
      activateComponentHost(el, binding.value)
    }

    // Defer the unsupported-element warn one tick past `mounted`. By then
    // `useRegister`'s `onMounted` has set `REGISTER_OWNER_MARKER` if the child
    // called it, and any post-install `assignKey` override is in place, so the
    // warn fires only when neither escape hatch was used. Anchoring on
    // `mounted` rather than `created` is what holds on the async-hydration
    // path; see the note above the dedupe set.
    if (
      __DEV__ &&
      warnedUnsupportedElements !== null &&
      !INTERACTIVE_TAG_NAMES.has(el.tagName) &&
      !warnedUnsupportedElements.has(el)
    ) {
      void nextTick(() => {
        if (warnedUnsupportedElements.has(el)) return
        const hasMarker =
          (el as unknown as { [k: symbol]: unknown })[REGISTER_OWNER_MARKER] === true
        const hasUserAssigner = !isDefaultAssigner(
          (el as unknown as { [k: symbol]: unknown })[assignKey]
        )
        if (hasMarker || hasUserAssigner) return
        warnedUnsupportedElements.add(el)
        warn(
          `[attaform] v-register on <${el.tagName.toLowerCase()}> is a no-op: ` +
            `non-input roots aren't bound to text-input semantics. For custom components: ` +
            `call \`useRegister()\` in the child's setup and re-bind v-register to an inner ` +
            `native element. Lower-level: install a custom assigner via the \`assignKey\` ` +
            `symbol on the element.`
        )
      })
    }
  },
  beforeUpdate(el, binding, vnode, prevVNode) {
    // A binding that mounted with `undefined` and received its RV on this
    // render never went through `created`'s arm, so cover it before the
    // registration sync below.
    if (isRegisterValue(binding.value)) armDomBinding(binding.value)

    // Same diff for the form's element map, catching the useRegister-driven
    // swap (mounted with `undefined`, a real RV on the next render), the
    // dynamic-path case and the cross-form swap. A same-path, same-form
    // transition short-circuits, so an identity-stable binding does not
    // thrash.
    syncElementRegistration(el, binding.value, binding.oldValue)
    callModelHook(el, binding, vnode, prevVNode, 'beforeUpdate')

    // Re-derive aria. A path change, a reused node rebound on reorder,
    // re-establishes the watch against the new path's display state; a removed
    // binding tears the attrs down; otherwise repaint and pick up any
    // newly-authored attribute lock.
    const ariaEl = el as AriaCarrier
    const value = binding.value
    if (!isRegisterValue(value) || value.ariaDisplayState === undefined) {
      teardownAria(ariaEl)
    } else {
      const old = binding.oldValue
      const pathChanged = !isRegisterValue(old) || old.path !== value.path
      if (pathChanged) {
        teardownAria(ariaEl)
        setupAria(ariaEl, value, vnode)
      } else {
        mergeAriaLocks(ariaEl, vnode)
        applyAria(ariaEl, value, vnode)
      }
    }
  },
  updated(el, binding, vnode, prevVNode) {
    callModelHook(el, binding, vnode, prevVNode, 'updated')
  },
  beforeUnmount(el, { value }) {
    // Detach every listener the variant attached in `created`, whether or not
    // the binding is still a valid RegisterValue. An element reused by
    // KeepAlive or v-show would otherwise double its listener count on the
    // next activation.
    removeTrackedListeners(el)

    // Stop the aria watch and clear the attributes it set, so a reused element
    // starts clean on its next activation.
    teardownAria(el as AriaCarrier)

    // Stop the reactive value-sync watch, a no-op for a variant that set none.
    teardownValueSync(el)

    // Stop the reactive disabled-sync watch, a no-op where none was set.
    teardownDisabledSync(el)

    if (!isRegisterValue(value)) return

    value.deregisterElement(el)

    // Component-host teardown, mirroring `activateComponentHost`. The
    // `deregisterElement` above targets the host ROOT, which a Case-B branch
    // never registered, its root usually being non-interactive, so the latched
    // descendant is uncovered. Release that control, or clear the no-latch
    // connected mark, then drop the record.
    if (componentHostLatch.has(el)) {
      // A self-heal observer may still be waiting for an async control, so stop
      // it before it latches onto a detached subtree.
      const healObserver = hostHealObservers.get(el)
      if (healObserver !== undefined) {
        healObserver.disconnect()
        hostHealObservers.delete(el)
      }
      const latchedControl = componentHostLatch.get(el)
      if (latchedControl != null) {
        // Stop the aria watch and clear the attrs set on the control before
        // releasing it; the host-root teardown above never reached this
        // descendant.
        teardownAria(latchedControl as AriaCarrier)
        value.deregisterElement(latchedControl)
      } else value.markHostConnected(false, el)
      componentHostLatch.delete(el)
    }

    // Remove the internal state the directive attaches to the element. On a
    // reused element a stale `composing: true` would swallow user input.
    delete (el as { composing?: boolean }).composing
    delete (el as { _assigning?: boolean })._assigning
    delete (el as { _syncFromStorage?: () => void })._syncFromStorage
    delete (el as unknown as { [k: symbol]: unknown })[assignKey]
  },
  // Vue skips directive lifecycle during SSR, so the hooks above never run on
  // the server and the same aria attributes are emitted here from the SSR-time
  // gated display state. Honours authored attrs through the vnode-level
  // lockout, touches no DOM, and shares `resolveAriaValue` with the client
  // path. Ids are SSR-stable, `formInstanceId` deriving from Vue's `useId`, so
  // a server-rendered describedby matches the client after hydration.
  getSSRProps(binding, vnode) {
    const rv = binding.value
    if (!isRegisterValue(rv)) return undefined
    // Vue passes `null` for the vnode in the compiled SSR directive-props
    // helper, string-based SSR having no vnode object, and the real vnode on
    // the runtime `withDirectives` path. So the vnode-level authored lockout
    // exists only client-side and on the runtime SSR path; under compiled SSR
    // an authored aria attribute cannot be seen here, and the client directive
    // reconciles it on hydration.
    const realVnode = (vnode as VNode | null) ?? null
    // Managed aria attrs belong on the bound form control, never on a component
    // host's root, where a presentational wrapper would carry an invalid
    // `aria-*`. On the runtime path Vue invokes this hook for both the
    // component vnode and the resolved root element, so emit only for an
    // interactive form-control element vnode and suppress a component vnode or
    // a wrapper root. The inner control the component re-binds through
    // `useRegister` emits its own aria. A `null` vnode is the compiled-SSR
    // path, which cannot see the element and is handled by the component-host
    // signal the transform stamps (#404).
    const isInteractiveElementVnode =
      realVnode !== null &&
      typeof realVnode.type === 'string' &&
      INTERACTIVE_TAG_NAMES.has(realVnode.type.toUpperCase())
    // `componentBridgeTransform` stamps this modifier on a component-host
    // v-register, the only signal available under compiled SSR's null vnode.
    // `modifiers` is typed as always present, but the compiled SSR helper and
    // synthetic bindings can omit it, so treat it as optional.
    const modifiers = binding.modifiers as Record<string, boolean> | undefined
    const isComponentHostModifier = modifiers?.[SSR_COMPONENT_HOST_MODIFIER] === true
    const suppressHostAria =
      isComponentHostModifier || (realVnode !== null && !isInteractiveElementVnode)
    const ariaProps = suppressHostAria ? undefined : getSSRAriaProps(rv, realVnode)

    // Form state (`value` / `checked`) is the runtime path's per-element
    // analogue of the transform's injected binding; without it a
    // render-function field paints empty for one frame before the client
    // directive fills it on mount. Compiled SSR for a directive bound DIRECTLY
    // to an element passes a `null` vnode, the transform having already emitted
    // the binding, so the guard below skips it there.
    //
    // Suppressed for a component HOST. Vue transfers a component-bound
    // directive onto the component's root element and fires this hook there, so
    // on a third-party host this would seed the stringified `displayValue` onto
    // the inner control and win the prop merge, clobbering the typed
    // `:modelValue` channel the transform set up. The host's value rides
    // v-model, and the element-level seed must stay out of its way. A scalar
    // model hides the problem, since `displayValue` equals the rendered value;
    // an array or Date model exposes the stringified clobber.
    const formStateProps =
      realVnode !== null && !isComponentHostModifier
        ? getSSRFormStateProps(rv, realVnode)
        : undefined

    if (ariaProps === undefined && formStateProps === undefined) return undefined
    // Disjoint key spaces, so merge order is immaterial and spreading
    // `undefined` is a no-op.
    return { ...ariaProps, ...formStateProps }
  },
}

function resolveDynamicModel(tagName: string, type: unknown) {
  // `tagName` is always uppercase per the DOM spec; `type` comes from
  // `vnode.props` and is usually a string, but a reactive `:type="x"` can pass
  // anything.
  if (tagName === 'SELECT') return vRegisterSelect
  if (tagName === 'TEXTAREA') return vRegisterText
  if (typeof type !== 'string') return vRegisterText
  if (type === 'file') return vRegisterFile
  if (type === 'checkbox') return vRegisterCheckbox
  if (type === 'radio') return vRegisterRadio
  return vRegisterText
}

/**
 * Dev diagnostic (#464): warn when a redundant STATE binding sits beside
 * `v-register` on a native control. `v-register` already owns value and
 * checked, so a co-located `:value` / `:checked` / `v-model` is redundant at
 * best and a dual-binding bug at worst.
 *
 * Runs ONLY when the compile-time transforms did NOT process this directive,
 * meaning `V_REGISTER_COMPILED_MODIFIER` is absent. With the bundler plugin,
 * `inputTextAreaNodeTransform` has stripped the author's value or checked and
 * injected its own, so `vnode.props` reflects the injection and reading it
 * would flag every field; there the compile layer owns detection. Without the
 * plugin nothing rewrites the props, so `vnode.props` IS what the author wrote.
 *
 * Two carve-outs. A radio's `:value` and a checkbox's `:value` are the IDENTITY
 * channel `v-register` reads, so only the state attribute warns for each. And
 * an UNBOUND `v-register` never warns: nothing is redundant beside a directive
 * that stands down (#620).
 */
function warnRedundantStateBinding(el: HTMLElement, binding: DirectiveBinding, vnode: VNode): void {
  if (warnedRedundantBindings === null) return // production
  if (!INTERACTIVE_TAG_NAMES.has(el.tagName)) return // native controls only
  // Redundant only once a field has resolved. An unbound `v-register` (a
  // dual-mode wrapper used without a form, a `useRegister()` whose parent never
  // bound) drives nothing, so the author's `:value` / `v-model` is not a second
  // writer but the only one, and telling them to drop it empties the control
  // (#620).
  if (!isRegisterValue(binding.value)) return
  // Compile layer active: it owns detection, and `vnode.props` is
  // post-injection rather than authored.
  if (binding.modifiers[V_REGISTER_COMPILED_MODIFIER] === true) return

  const props = vnode.props
  if (props == null) return

  const variant = resolveDynamicModel(el.tagName, props['type'])
  if (variant === vRegisterFile) return // out of scope: browser rejects `value`

  // Native v-model desugars to an `onUpdate:modelValue` prop, and the
  // transforms never emit that key, so its presence is an author-only signal
  // for every variant.
  const hasVModel = 'onUpdate:modelValue' in props
  // Radio and checkbox: `:value` is the option identity, so only `:checked` is
  // redundant state. Everything else is value-driven.
  const stateAttr =
    variant === vRegisterCheckbox || variant === vRegisterRadio ? 'checked' : 'value'
  const hasStateAttr = stateAttr in props

  if (!hasVModel && !hasStateAttr) return

  const tag = el.tagName.toLowerCase()
  const redundant = hasVModel ? 'v-model' : `:${stateAttr}`
  // The resolved `type` is part of the key, so a redundant `:checked` on a
  // checkbox and one on a radio count apart. Their messages read the same, but
  // they are distinct misuses.
  const signature = `${tag}:${String(props['type'] ?? '')}:${redundant}`
  if (warnedRedundantBindings.has(signature)) return
  warnedRedundantBindings.add(signature)
  warn(
    `[attaform] \`${redundant}\` is redundant beside v-register on ` +
      `<${tag}>. v-register already drives this field's value, ` +
      `so keep v-register alone and drop \`${redundant}\`. (An identity \`:value\` on a ` +
      `radio or <option> is expected and stays silent.)`
  )
}

/**
 * SSR `checked` verdict for a checkbox, mirroring `setChecked`'s ladder of
 * `looseIndexOf` for an Array, `.has` for a Set and `looseEqual` against the
 * true-value for a scalar, but reading the option-value and true-value from
 * `vnode.props`, there being no element server-side. Returns `{ checked: '' }`
 * when the box should render checked, else `undefined` so no attribute is
 * emitted.
 */
function ssrCheckboxProps(
  rv: RegisterValue,
  props: Record<string, unknown> | null
): Record<string, string> | undefined {
  const model = rv.innerRef.value
  const optionValue = props?.['value']
  let checked: boolean
  if (isArray(model)) {
    checked = looseIndexOf(model, applyElementCoerce(optionValue, rv)) > -1
  } else if (isSet(model)) {
    checked = model.has(applyElementCoerce(optionValue, rv))
  } else {
    // `getCheckboxValue(el, true)` returns the `:true-value` binding when
    // present, else `true`. On the server the prop is read directly.
    const trueValue = props !== null && 'true-value' in props ? props['true-value'] : true
    checked = looseEqual(model, applyCoerce(trueValue, rv))
  }
  return checked ? { checked: '' } : undefined
}

/**
 * The form-state props (`value` / `checked`) the directive would apply on
 * mount, for SSR emission on the RUNTIME render-function path. Mirrors each
 * variant's mount logic, `vRegisterText`'s `el.value = displayValue.value`,
 * `setChecked`, the radio's `looseEqual`, but takes the element-side
 * option-value from `vnode.props`, there being no DOM element server-side.
 *
 * Returns `undefined` for the two variants whose initial state cannot be
 * expressed at the element level here. Browsers reject `value` on a file
 * input, so `vRegisterFile` owns that DOM contract. And a `<select>`'s
 * `selected` is option-level, not expressible from the element's props: a
 * compiled template carries it through `componentBridgeTransform`, and it is a
 * documented limitation for runtime render functions.
 *
 * Only the runtime path reaches here. Compiled SSR passes a `null` vnode, where
 * the transform has already injected the binding, so the two never
 * double-emit.
 */
function getSSRFormStateProps(rv: RegisterValue, vnode: VNode): Record<string, string> | undefined {
  // A component vnode has no element-level form state; the inner native input
  // the component re-binds owns it. Only real HTML tags dispatch here.
  if (typeof vnode.type !== 'string') return undefined
  const props = (vnode.props as Record<string, unknown> | null) ?? null
  const variant = resolveDynamicModel(vnode.type.toUpperCase(), props?.['type'])

  // A frozen form renders the HTML `disabled` attribute on every control,
  // mirroring the compiled transform's `:disabled` bind. Overlaid onto whatever
  // the variant resolves, and rendered even when the variant contributes
  // nothing else (an empty text field, an unselected radio, a file or select
  // input), so the render-function SSR path matches the compiled one.
  const withDisabled = (
    base: Record<string, string> | undefined
  ): Record<string, string> | undefined =>
    rv.disabled.value === true ? { ...(base ?? {}), disabled: '' } : base

  if (variant === vRegisterFile || variant === vRegisterSelect) return withDisabled(undefined)
  if (variant === vRegisterCheckbox) return withDisabled(ssrCheckboxProps(rv, props))
  if (variant === vRegisterRadio) {
    const matches = looseEqual(rv.innerRef.value, applyCoerce(props?.['value'], rv))
    return withDisabled(matches ? { checked: '' } : undefined)
  }
  // text, textarea, number, email: mirror `el.value = displayValue`, which
  // already folds blank and unset to `''`. Omit the attribute for an empty
  // field, so SSR matches the no-value initial paint.
  const value = rv.displayValue.value
  return withDisabled(value === '' ? undefined : { value })
}

function callModelHook(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  binding: DirectiveBinding,
  vnode: VNode,
  prevVNode: VNode | null,
  hook: keyof ObjectDirective
) {
  const modelToUse = resolveDynamicModel(el.tagName, vnode.props?.['type'])
  const fn = modelToUse[hook] as DirectiveHook | undefined
  fn?.(el, binding, vnode, prevVNode)
}

export type VXCustomDirective =
  | typeof vRegisterText
  | typeof vRegisterCheckbox
  | typeof vRegisterSelect
  | typeof vRegisterRadio
  | typeof vRegisterDynamic

/**
 * The `v-register` directive. Bind a form field to a native input, select,
 * textarea, checkbox or radio:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * <select v-register="form.register('country')">
 *   <option value="us">US</option>
 *   <option value="uk">UK</option>
 * </select>
 * ```
 *
 * The binding strategy follows the element's `tagName` and `type`. Delivered by
 * the Vite and Nuxt plugins' compile-time binding, or by
 * `installVRegister(app)` everywhere else. Most consumers never import it
 * directly; it is exposed for integrations that wire directives by hand.
 */
export const vRegister = vRegisterDynamic

// Stamp the marker after definition. Reading it from
// `vnode.dirs[].dir[V_REGISTER_MARKER]` lets `useRegister` find the parent's
// binding without the compile-time bridge-prop injection, which keeps the
// wrapper pattern working in bare-Vue and playground setups.
;(vRegisterDynamic as unknown as { [k: symbol]: true })[V_REGISTER_MARKER] = true

/**
 * Register the `v-register` directive app-wide. The one-line setup for an app
 * whose templates are compiled without Attaform's Vite or Nuxt plugin: a
 * webpack-family bundler, a no-build page, or runtime-compiled templates.
 *
 * ```ts
 * import { createApp } from 'vue'
 * import { installVRegister } from 'attaform/directive'
 *
 * const app = createApp(App)
 * installVRegister(app)
 * ```
 *
 * Vite and Nuxt consumers do not call this; their build plugin binds each
 * template's `v-register` at compile time. Idempotent: a second call for the
 * same app is a no-op, and a directive the consumer registered under the same
 * name is left in place.
 */
export function installVRegister(app: App): void {
  if (app.directive('register') === undefined) {
    app.directive('register', vRegister)
  }
}
