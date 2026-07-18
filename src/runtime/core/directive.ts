/**
 * The `v-register` directive. Two-way binding with `v-model`-like
 * semantics, but writes go through the form's `RegisterValue` so
 * dirty / pristine / touched / errors stay coherent across the form.
 *
 * Bind to a native input, select, textarea, checkbox, or radio:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * ```
 *
 * Installed automatically by `createAttaform()`; the export is
 * for advanced consumers who install directives manually. Works
 * identically under Nuxt, bare Vue CSR, and bare Vue +
 * `@vue/server-renderer` — Vue skips directive lifecycle hooks during
 * SSR, so the directive is a safe no-op server-side.
 */
import { isArray, isSet, looseEqual, looseIndexOf, looseToNumber } from './vue-shared-shim'
import type { DirectiveBinding, DirectiveHook, ObjectDirective, VNode } from 'vue'
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

// `assignKey` now lives in `assigner-pipeline.ts`; re-export it here so
// the public `attaform` entry keeps exporting it from this module.
export { assignKey }

type ComposingTarget = (EventTarget & { composing: boolean }) | null

/**
 * Write the directive-private `lastTypedForm` ref. Lives on the
 * `InternalRegisterValue` extension of `RegisterValue` (it's not part
 * of the public type), but every RV constructed by `register-api.ts`
 * carries it — so the cast captures a runtime invariant the type
 * system can't otherwise express. Used by the numeric-text listener
 * to surface the user's typed form (`'1e2'`) to `displayValue`
 * mid-typing without yanking the caret on the next render.
 */
function writeLastTypedForm(rv: RegisterValue, next: string | null): void {
  ;(rv as InternalRegisterValue).lastTypedForm.value = next
}

/**
 * Listener-body bail. Called at the top of every event handler the
 * directive attaches. Bails when:
 *  - the rendered root is a non-supported tag (where `el.value` is
 *    meaningless), AND
 *  - the assigner is the default (no consumer override).
 *
 * Catches two cases without needing instance-level sentinel detection:
 *  1. A `useRegister`-using child component — its rendered root is
 *     usually a `<label>` / `<div>` / etc., and the inner
 *     `<input v-register>` handles binding. The parent's directive's
 *     listener on the rendered root would otherwise read `el.value`
 *     off the wrapper and clobber the form.
 *  2. A bare `<div v-register>` with no escape hatch — same story,
 *     the dev gets a deferred warn pointing at the recipe.
 *
 * Pre-installed `assignKey` AND `@update:registerValue` listener
 * shapes both bypass this bail (their assigner replaces the default,
 * stripping the tag). Post-installed `assignKey` (set via
 * `onMounted` or a ref callback) ALSO bypasses, because by the time
 * the next input event fires, the user's assigner is in place.
 */
function shouldBailListener(el: HTMLElement): boolean {
  if (INTERACTIVE_TAG_NAMES.has(el.tagName)) return false
  return isDefaultAssigner((el as unknown as { [k: symbol]: unknown })[assignKey])
}

/**
 * Apply the field's element-level coerce closure (built at
 * register-time by `buildElementCoerceFn`) to a scalar DOM-side
 * value that should match an array/Set member. `coerceElement` is
 * only set on container paths; for scalar paths or when coercion
 * is disabled it's `undefined` and the raw value passes through.
 * Mirrors `applyCoerce` for the path-level case.
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

// We are exporting the v-model runtime directly as vnode hooks so that it can
// be tree-shaken in case v-model is never used.
const vRegisterText: RegisterTextCustomDirective = {
  created(el, { value, modifiers: { lazy, trim, number } }, vnode) {
    // Static "would this listener ever want to cast?" gate for the
    // optional blur normalizer below. Read straight off vnode.props
    // at created-time because the modifier is what we're allowed to
    // freeze. Listener bodies re-derive `castToNumber` each fire
    // (see `liveCastToNumber`) so a dynamic `:type="..."` swap is
    // honored against the post-patch DOM.
    const castToNumberAtCreated = number === true || vnode.props?.['type'] === 'number'
    const liveCastToNumber = (): boolean => number === true || el.getAttribute('type') === 'number'
    if (isRegisterValue(value)) {
      value.registerElement(el)
      setAssignFunction(el, vnode, value)
    }
    // Deferred async-transform repaint: paint the resolved/normalized
    // value into the input once the run commits (mirrors the post-write
    // force-sync below). Bare `<input v-register>` has no `innerRef`
    // watcher, so the orchestrator calls this directly rather than
    // relying on a parent re-render.
    el._syncFromStorage = (): void => {
      if (!isRegisterValue(value)) return
      const storage = value.innerRef.value
      const display = storage == null ? '' : String(storage)
      if (el.value !== display) el.value = display
      if (liveCastToNumber()) writeLastTypedForm(value, null)
    }
    addTrackedListener(el, lazy === true ? 'change' : 'input', (e) => {
      // Bail if this listener was attached on a non-supported root
      // (a `<label>` / `<div>` etc.) AND the assigner is the default.
      // The bubbled-write bug fires here without this guard: a
      // descendant's `input` event reaches this handler, reads
      // `el.value` off the wrapper (`''` in jsdom, `undefined` in
      // browsers), and clobbers the form. See `shouldBailListener`.
      if (shouldBailListener(el)) return
      const target = e.target as ComposingTarget
      if (target === null || target.composing) return
      noteInteraction(value)
      // Re-read per fire so a dynamic `:type="..."` swap (text → number
      // or back) routes the next keystroke through the right branch.
      const castToNumber = liveCastToNumber()
      let domValue: string | number = el.value
      // Deferred-to-blur trim: only trim here when this listener is
      // already on `change` (i.e. `.lazy.trim`). Per-keystroke trim
      // on the `input` event fights Vue's `:value` patch — when the
      // user types a trailing space the trimmed write reaches the
      // model first, Vue's patch then sees `el.value` ahead of the
      // model and rewrites the DOM back to the trimmed form,
      // swallowing the space the user is still typing. The `change`-
      // bound normalization listener below catches the canonical
      // trimmed write at blur instead.
      if (trim === true && lazy === true) {
        domValue = domValue.trim()
      }
      if (castToNumber) {
        // Empty after the (deferred) trim — most commonly a backspace-
        // clear on `<input type="number">` or a `.number` text input.
        // Mark the path blank rather than skipping silently:
        // storage gets the slim default (0), the UI shows blank via
        // `displayValue.value === ''`, and submit-time validation
        // raises "No value supplied" if the schema demands a number (the
        // public-housing footgun fix). Without this, the directive's
        // pre-fix skip-on-empty silently desynced storage from UI.
        //
        // `<input type="number">` quirk: the browser blanks `el.value`
        // mid-typing for malformed input (`1e` is incomplete scientific
        // notation, so the browser hides the typed text from
        // `el.value` even though it's still visually in the DOM).
        // `validity.badInput` is `true` in that case and `false` for
        // a genuine empty field — we use it to distinguish a real
        // user-clear (mark) from a transient mid-edit (skip). Without
        // this guard, typing `1e` into a `type="number"` field fires
        // `markBlank`, `displayValue` recomputes to `''`,
        // Vue patches the DOM and yanks the user's `1e` away.
        if (domValue === '') {
          // Guard against non-input elements with custom assigners
          // (the directive bails on default-assigner non-inputs via
          // `shouldBailListener`, but a consumer-installed assigner
          // can land on any tag — `validity` only exists on form
          // controls). The cast types `validity` as optional to
          // capture that shape.
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
          // Non-castable garbage like "abc" — text input with `.number`,
          // not protected by the beforeinput filter (e.g. consumer
          // pasted via JS or programmatic `el.value = 'abc'`). Treat
          // as the empty case so the gate's slim-primitive rejection
          // doesn't surface a dev warning for a transient mid-edit
          // state.
          if (isRegisterValue(value)) {
            writeLastTypedForm(value, null)
            value.markBlank()
          }
          return
        }
        if (!Number.isFinite(domValue)) {
          // Overflow: parseFloat returned Infinity / -Infinity for
          // values past Number.MAX_VALUE (e.g. `1e309`). Don't commit
          // — Zod's z.number() rejects non-finite, and
          // JSON.stringify() renders Infinity as `null`, both confusing
          // for devs and downstream consumers. Snap the DOM back to
          // the last good displayValue so the user gets immediate
          // visual feedback that their input was rejected (analogous
          // to a native `<input type="number" max>` cap). Storage
          // stays at whatever the last finite write committed.
          if (isRegisterValue(value)) {
            const target = value.displayValue.value
            if (el.value !== target) el.value = target
          }
          return
        }
        // Castable: record the user's typed string so `displayValue`
        // surfaces it mid-typing. Storage commits real-time via the
        // assigner below; without `lastTypedForm`, Vue's `:value`
        // patch would write `String(cast)` (e.g. `'100'`) into the
        // DOM and yank the user away from the `1e2` they're typing.
        // The blur normalizer clears `lastTypedForm` so the post-blur
        // DOM matches storage exactly.
        if (isRegisterValue(value)) writeLastTypedForm(value, typedString)
      }
      // Schema-aware DOM clear: when the user empties an `.optional()`
      // string field, write `undefined` to storage rather than `''`.
      // Otherwise an `.optional()` schema's "absent" semantic would be
      // unreachable from the DOM once the user has typed anything, and
      // schemas like `z.string().email().optional()` would lock in a
      // permanent validation error after a clear (storage `''` is
      // neither undefined nor a valid email). Only the text path
      // reaches here — the castToNumber branch above already returns
      // for empty input, and `slimDefault` resolves to undefined for
      // an optional number leaf, so `markBlank` writes the right thing
      // there already.
      //
      // When the path doesn't admit string AND doesn't admit
      // undefined (e.g. required `z.number()` rendered as a plain
      // text input), short-circuit through `markBlank` for the same
      // reason `castToNumber` does: the empty-string write would be
      // rejected by the slim-primitive gate, and the post-write
      // force-sync below would then snap the DOM back to the stored
      // numeric — making the final character undeletable.
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
      // After the default assigner runs, force-sync the DOM when
      // storage diverges from the post-cast/post-trim `domValue`.
      // Two cases produce no Vue re-render and so leave the
      // imperative `beforeUpdate` DOM-from-storage sync stranded:
      //   1. A `transforms` pipeline mutated the write to a value
      //      identical to current storage (a clamp at the cap, an
      //      idempotent normalize, a coerce that re-emits the prior
      //      stored shape) — `setValueWithInternalPath` produces no
      //      patch, no reactive trigger, no render.
      //   2. The slim-primitive gate (or a transform-throw) silently
      //      rejected the write — storage stays at the prior value,
      //      again no render.
      // Either way the DOM keeps the user's raw typed text divorced
      // from storage. Comparing post-cast `domValue` (not the raw
      // typed string) preserves the typed-form contract: typing
      // `1e2` against a number schema casts to 100, storage updates
      // to 100, post-cast `domValue === storage`, no force-sync —
      // the user keeps seeing `1e2` mid-typing.
      //
      // Gated on `isDefaultAssigner` because custom assigners
      // (`@update:registerValue`, pre-installed `el[assignKey]`)
      // own their own DOM/storage relationship — they may write to
      // a different store, defer / batch / debounce, or intentionally
      // not update `innerRef.value`. The default assigner's contract
      // ("a successful write reflects in `innerRef.value` immediately")
      // is what makes the post-write storage comparison meaningful.
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
        // visible DOM normalizes after blur for both modifiers — without
        // the cast branch, a user typing ` 12 ` into a `.number` input
        // sees ` 12 ` stick after blur instead of `12`.
        let normalized: string | number = el.value
        if (trim === true) normalized = normalized.trim()
        // Re-derive each fire so a `:type` swap is honored at blur too.
        // The installation gate above is the static "could this input
        // ever want cast-on-blur" check, but the body's branch picks
        // up the current type per fire.
        const castToNumber = liveCastToNumber()
        if (castToNumber) {
          const cast = looseToNumber(normalized)
          if (typeof cast === 'number' && Number.isFinite(cast)) {
            // Blur: clear the typed-form override so `displayValue`
            // returns `String(storage)`. The DOM then patches to the
            // canonical form (`'1e2'` → `'100'`, `'01'` → `'1'`,
            // `'1.'` → `'1'`). Honest by design — what the user sees
            // after blur matches what's in storage. The model commit
            // is gated on `lazy !== true` because the lazy listener
            // already wrote on the same change event ahead of this
            // handler.
            if (isRegisterValue(value)) writeLastTypedForm(value, null)
            el.value = String(cast)
            if (lazy !== true) fireAssigner(el, value, cast)
          } else {
            // Uncastable mid-edit residue (lone '.', '-', 'abc') OR
            // overflow (`1e309` parses to Infinity). Native
            // `<input type="number">` blur behaviour clears in both
            // cases; we match that. The keystroke listener has
            // already markBlank'd uncastable input under
            // non-lazy, but under `.lazy.number` (or for an overflow
            // pasted directly via the change event) this is the first
            // chance, so re-mark defensively.
            if (isRegisterValue(value)) {
              writeLastTypedForm(value, null)
              value.markBlank()
            }
            el.value = ''
          }
          return
        }
        el.value = typeof normalized === 'number' ? String(normalized) : normalized
        // Catch up the model on blur for non-lazy `.trim`. The input
        // listener wrote the raw mid-typing value (deferred trim);
        // here on `change` we commit the canonical trimmed form so
        // the DOM and the model agree once the user leaves the
        // field. Under `.lazy.trim`, the input listener (on
        // `change`) already wrote the trimmed value, so this branch
        // skips to avoid a redundant duplicate write.
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
    // `.number` × text input — block non-numeric characters at the
    // DOM layer so `el.value` never holds garbage. Native
    // `<input type="number">` already filters at the browser layer,
    // so we skip the listener there to avoid double-filtering. The
    // regex allows an optional leading `-`, a single `.`, any number
    // of digits, and an optional scientific-notation suffix
    // (`[eE][+-]?\d*`) so devs get parity with native `type="number"`
    // for inputs like `1e3`. Partial states (just `-`, `1.`, `1e`,
    // `1e-`) are accepted as the user is still typing; the blur
    // normalizer commits the cast value (or clears the DOM if the
    // residue is non-castable). Composition events
    // (`insertCompositionText`) aren't blocked — IME input proceeds
    // normally and the directive's `compositionend` handler catches
    // the final value.
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

    // Read through `displayValue` rather than `innerRef`: it's the
    // string projection that already honours `blankPaths` (returns
    // `''` for a numeric leaf marked blank, even though storage
    // holds the slim default `0`). Without this, the storage `0`
    // round-trips to `'0'` here and the change handler at blur
    // sees `el.value === '0'`, casts to 0, and writes-back through
    // the assigner — wiping the blank flag and locking the user
    // out of the empty display state.
    el.value = value.displayValue.value

    // Reactive value sync: `beforeUpdate` only repaints the DOM when the
    // host component re-renders, so a form mutation that originates
    // outside this component (cross-tab sync, a sibling's setValue /
    // reset / clear, any imperative write while the template reads no
    // field state) wouldn't reach the input. Watch `displayValue` in its
    // own scope to close that gap — torn down via `teardownValueSync` in
    // the dispatcher's `beforeUnmount`. Focus-gated so it never disturbs
    // an in-flight edit; `beforeUpdate` writes the same target value.
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
    // Skip the el.value sync while the user is mid-IME-composition;
    // overwriting `el.value` would clobber the unresolved input.
    if ((el as { composing?: boolean }).composing === true) return
    if (!isRegisterValue(value)) return

    // `displayValue` is the canonical string view: it folds in the
    // blank/unset rule (returns `''` for blank-marked numeric
    // leaves) AND the typed-form preference (`lastTypedForm` so
    // mid-typing `'1e2'` doesn't get clobbered by a sibling
    // re-render). String comparison against the live DOM is honest:
    // pre-fix this branch parsed `el.value` through `looseToNumber`
    // and compared against raw storage, which paints `'0'` over a
    // blank-empty DOM on every reactive update.
    const target = value.displayValue.value
    if (el.value === target) {
      return
    }

    // ShadowRoot-aware activeElement check: a v-register'd input mounted
    // inside a shadow tree's `activeElement` lives on the rootNode, not
    // on `document`. Falling back to `document.activeElement === el` for
    // shadow-mounted inputs would always be `false`, defeating the
    // lazy/trim escape-hatches below.
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
      // Trim escape: same rationale — the trimmed-but-otherwise-equal
      // value is what we'd land on at blur anyway, so don't fight the
      // user's whitespace mid-typing.
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
    // Deferred async-transform repaint: re-apply checked-state from the
    // committed value once the run lands (mirrors the post-write force-
    // sync below).
    el._syncFromStorage = (): void => {
      if (!isRegisterValue(value)) return
      setChecked(el, value)
      el._lastAppliedModel = value.innerRef.value
    }
    addTrackedListener(el, 'change', () => {
      if (shouldBailListener(el)) return
      noteInteraction(value)
      const modelValue = value.innerRef.value ?? []

      // this side-steps subtle 2-way binding bugs where ref updates but input cannot be tracked by value
      const explicitValueRequired = true
      const rawElementValue = getValue(el, explicitValueRequired)

      const checked = el.checked
      if (isArray(modelValue)) {
        if (rawElementValue === undefined) {
          warn(
            'Checkbox bound to an array model is missing a `value` attribute — ' +
              'cannot determine which item to add or remove. ' +
              'Add value="..." to each <input type="checkbox">.'
          )
          return
        }
        // Element-level coerce on the raw DOM value so the
        // looseIndexOf lookup and the new array's element shape
        // match the post-coerce model. Without this, the change
        // handler builds a mixed-type array (e.g. boolean members
        // plus a raw string) and either fails to find the existing
        // entry on uncheck (case-sensitive looseEqual on booleans)
        // or appends a string to a typed-element array. The path-
        // level coerce in the assigner cleans up the new array
        // afterwards either way.
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
          warn(
            'Checkbox bound to a Set model is missing a `value` attribute — ' +
              'cannot determine which item to add or remove. ' +
              'Add value="..." to each <input type="checkbox">.'
          )
          return
        }
        // Set's `.delete` uses strict ===, so coerce the element
        // BEFORE the Set ops or removals silently fail when the
        // model holds post-coerce booleans/numbers and the DOM
        // gives back the raw string.
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
      // After the default assigner runs, force-sync `el.checked` to
      // current storage. Catches the no-op-write case: a transform
      // mapped the click's value to current storage (e.g. an always-
      // false transform on an already-false checkbox) — no patch, no
      // render, no `beforeUpdate` setChecked. Without this the DOM
      // stays at the user's click state, divorced from storage.
      // Skipped for custom assigners (they own DOM/storage sync) and
      // while a transform is in flight (the deferred commit hasn't
      // landed yet — `_syncFromStorage` repaints once it does).
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
    // External model changes that don't trigger a host re-render
    // (cross-tab sync, a sibling's setValue / reset / clear) re-run the
    // same `setChecked` the `beforeUpdate` path uses. Not focus-gated:
    // an external change must reflect even on a focused checkbox, and the
    // write is idempotent (`setChecked` skips when `el.checked` matches).
    setupValueSync(el, value.innerRef, () => {
      setChecked(el, value)
      el._lastAppliedModel = value.innerRef.value
    })
  },
  // Skip the DOM sync when the model is identity-unchanged from the
  // last application. Pre-fix the scalar branch in `setChecked`
  // gated on `originalValue === oldValue`, comparing a primitive
  // scalar against the wrapper RegisterValue object — always !==,
  // so the guard was a silent no-op. Array / Set branches lacked
  // any guard. The per-render re-apply mirrors the just-fixed
  // `vRegisterSelect` shape: a sibling's reactive write triggers
  // `beforeUpdate` mid-click, `setChecked` re-applies the prior
  // model state, and the in-flight user toggle is clobbered before
  // the browser fires `change`. Identity comparison on
  // `innerRef.value` is sound for the same reason as multi-select —
  // every form write produces a fresh value at the path (new
  // primitives; new array/Set references along the spine), so
  // reference equality tracks "did the model move" exactly.
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

  // Read the option-value via `getValue(el)` rather than
  // `vnode.props?.['value']`. On SSR + hydration, Vue skips
  // `patchProp` for hoisted static `value="..."` attributes — vnode
  // props don't carry the value AND `el._value` is never set, so the
  // old code returned undefined and unchecked the box even when the
  // DOM `value` attribute matched the model. `getValue` (post the
  // static-attr fix) checks `_value` first, then the DOM property,
  // so all three paths (Vue dynamic, Vue hydrated static, manual
  // setAttribute) resolve identically.
  // All three branches compare the post-coerce model against the
  // RAW DOM-side value (the option's `value` attribute, or the
  // checkbox's `_trueValue`). Coerce normalizes the WRITE direction
  // (e.g. `"True"` → `true` for `z.boolean()`); without symmetric
  // normalization on the READ direction, `looseEqual` /
  // `looseIndexOf` / `Set.has` fight the user's click on every
  // re-render. Route the raw value through the same `applyCoerce`
  // closure to restore parity. See setChecked-mid-coerce regression
  // tests in coerce.test.ts.
  if (isArray(originalValue)) {
    // Element-level coerce: the DOM-side raw value is a SCALAR
    // matching against the array's element type, not the path's
    // top-level type (which would be `array`, with no scalar
    // coerce target).
    checked = looseIndexOf(originalValue, applyElementCoerce(getValue(el), value)) > -1
  } else if (isSet(originalValue)) {
    // Set.has uses SameValueZero (===), not loose comparison —
    // mismatch is fatal here, not just for case-sensitive booleans.
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
    // Deferred async-transform repaint: re-apply checked-state from the
    // committed value once the run lands (mirrors the post-write force-
    // sync below).
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
      // After the default assigner runs, force-sync `el.checked` to
      // current storage. Catches the no-op-write case where a
      // transform maps the click's value to current storage — no
      // patch, no render, no `beforeUpdate` sync. Skipped for custom
      // assigners (they own DOM/storage sync) and while a transform is
      // in flight (the deferred commit repaints via `_syncFromStorage`).
      if (isRegisterValue(value) && isDefaultAssigner(el[assignKey]) && !isTransforming(value)) {
        const currentModel = value.innerRef.value
        const target = looseEqual(currentModel, applyCoerce(getValue(el), value))
        if (el.checked !== target) el.checked = target
        el._lastAppliedModel = currentModel
      }
    })
  },
  // Initial checked-state sync runs in `mounted`, NOT `created` —
  // Vue's directive lifecycle fires `created` BEFORE the element's
  // attributes are patched (`type`, `value`, `_value` etc. aren't on
  // the element yet), so `getValue(el)` would return `undefined` and
  // every radio in a group would mount unchecked regardless of the
  // model. Checkbox already uses `mounted: setChecked` for the same
  // reason.
  mounted(el, { value }) {
    if (!isRegisterValue(value)) return
    // Read the option-value via `getValue(el)` rather than
    // `vnode.props?.['value']` so SSR-hydrated static `value="..."`
    // attributes (which don't surface in vnode.props because Vue's
    // static-attr fast path skips patchProp) still resolve correctly.
    // Coerce the raw value the same way the change handler will so
    // the comparison stays symmetric — see setChecked's note.
    el.checked = looseEqual(value.innerRef.value, applyCoerce(getValue(el), value))
    el._lastAppliedModel = value.innerRef.value
    // External model changes that don't trigger a host re-render re-run
    // the same checked computation the `beforeUpdate` path uses. Not
    // focus-gated: an external change must reflect even on a focused
    // radio, and writing `el.checked` is atomic.
    setupValueSync(el, value.innerRef, () => {
      el.checked = looseEqual(value.innerRef.value, applyCoerce(getValue(el), value))
      el._lastAppliedModel = value.innerRef.value
    })
  },
  // Skip the DOM sync when the model is identity-unchanged from the
  // last application. Pre-fix the guard read `value.innerRef.value
  // !== oldValue`, comparing a primitive scalar against the previous
  // binding's wrapper RegisterValue object — always !==, so the
  // guard was a silent no-op and `el.checked = …` re-applied on
  // every parent re-render. Same shape as the just-fixed
  // `vRegisterSelect` and `setChecked` bugs: a sibling's reactive
  // write triggers `beforeUpdate` mid-click and writes back the
  // prior model state, clobbering the in-flight selection.
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
      // Re-derive each fire so an Array ↔ Set swap on the bound path
      // (a `form.setValue('picks', new Set([...]))` against a union
      // schema, or any other write that lands a different container
      // shape) routes the next change through the matching constructor.
      const isSetModel = isSet(value.innerRef.value)
      const selectedVal = Array.prototype.filter
        .call(el.options, (o: HTMLOptionElement) => o.selected)
        .map((o: HTMLOptionElement) => (number === true ? looseToNumber(getValue(o)) : getValue(o)))
      const wrote = fireAssigner(
        el,
        value,
        el.multiple ? (isSetModel ? new Set(selectedVal) : selectedVal) : selectedVal[0]
      )
      // Only set `_assigning` when the write actually landed. A
      // rejected write (slim-primitive gate said no) should NOT
      // suppress the next `updated` hook's `setSelected` — we want
      // the DOM to revert to `innerRef.value` since the form state
      // didn't change. `undefined` from a consumer-installed assigner
      // counts as "succeeded" for back-compat (their assigner has no
      // way to signal otherwise).
      if (wrote !== false) {
        el._assigning = true
        void nextTick(() => {
          el._assigning = false
        })
      }
      // After the default assigner runs, force-sync the `<select>`
      // selection to current storage. Catches the no-op-write case:
      // a transform mapped the user's pick to current storage (e.g.
      // always-fixed transform) — no patch, no render, no `updated`
      // setSelected. Without this the DOM stays at the user's
      // selection, divorced from storage. Skipped for custom
      // assigners (they own DOM/storage sync) and while a transform is
      // in flight (the deferred commit repaints via `_syncFromStorage`).
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
    // External model changes that don't trigger a host re-render re-run
    // the same `setSelected` the `updated` path uses. The `_assigning`
    // guard short-circuits the mid-click window (mousedown → change) so
    // an in-progress multi-select isn't clobbered, matching `updated`.
    setupValueSync(el, value.innerRef, () => {
      if (el._assigning === true) return
      setSelected(el, value)
      el._lastAppliedModel = value.innerRef.value
    })
  },
  beforeUpdate(el, binding, vnode) {
    setAssignFunction(el, vnode, binding.value)
  },
  // Skip the DOM sync when the model is identity-unchanged from the
  // last application. Parent re-renders fire `updated` whether or not
  // the bound model actually moved (a typed character in a sibling,
  // an async-validation tick, any reactive read elsewhere on the
  // page). Without this guard, every such render unconditionally re-
  // applies `setSelected` against the prior model, which on a
  // `<select multiple>` clobbers any in-progress user selection
  // between mousedown and the browser's change-event decision — the
  // browser then sees no net change, never fires `change`, and the
  // model never updates. Identity comparison is sound: every form
  // write produces a new array/Set reference at the path (the diff-
  // apply replacement of `form.value` rolls forward fresh structures
  // along the spine), so reference equality on `innerRef.value`
  // tracks "did the model move" exactly. The `_assigning` gate stays
  // — it short-circuits the immediate post-write render where the
  // DOM is already in sync from the user's click.
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

  // Use the model value directly — mirrors Vue's reference
  // `vModelSelect.setSelected`. Pre-fix this went through a
  // `getBaseValue` indirection that read DOM-current selection state
  // instead of the model, returning an empty Set for single-select
  // numeric models. The downstream `looseEqual('1', Set{})` always
  // failed, so `selectedIndex` ended at `-1` (no option highlighted)
  // even though the bound value matched an option. Single-select with
  // number / string / boolean now correctly drives the DOM via
  // `looseEqual` (which coerces primitives through `String(...)`),
  // and multi-select uses the Array / Set membership it always did.
  const externalValue = value.innerRef.value
  const isMultiple = el.multiple
  const isArrayValue = isArray(externalValue)

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
  // Symmetric misuse: non-multiple select bound to an Array / Set
  // model. The change handler would write `selectedVal[0]` (scalar)
  // back, which the slim-primitive gate rejects against an Array
  // path — so the user's clicks silently fail. Mount-time
  // `looseEqual('a', ['a', 'b'])` also returns false, so no option
  // ever appears highlighted. Bail with a dev-warn pointing at the
  // fix (`add multiple` for list bindings, or use a scalar model).
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
    // Precompute a `Set<string>` of stringified model members once,
    // then do O(1) lookups per option. Drops the per-option work
    // from O(N) to O(1), so total `setSelected` cost is O(N + M)
    // for an N-item model and an M-option <select> — matters for
    // long forms (thousands of options or selected items). Both
    // Array and Set primitive paths share this; only object-valued
    // option binds (rare) keep their original identity comparisons.
    //
    // Each option's raw `value` is routed through `applyCoerce`
    // before stringifying so the comparison stays symmetric with
    // the change handler's WRITE-side coerce — without it,
    // `String(true) === "true"` but the option's raw `"True"`
    // stringifies to `"True"` and the option silently never matches.
    const stringifiedMembers = new Set<string>()
    const iter: Iterable<unknown> = isArrayValue
      ? (externalValue as ReadonlyArray<unknown>)
      : (externalValue as Set<unknown>)
    for (const v of iter) stringifiedMembers.add(String(v))

    for (let i = 0, l = el.options.length; i < l; i++) {
      const option = el.options[i]
      if (!option) continue
      // Element-level coerce: a multi-select's option matches a
      // member of an array/Set model, so the comparison must run
      // against the element type, not the path's top-level type.
      const optionValue = applyElementCoerce(getValue(option), value)
      const optionType = typeof optionValue
      if (optionType === 'string' || optionType === 'number') {
        option.selected = stringifiedMembers.has(String(optionValue))
      } else if (optionType === 'boolean') {
        // Booleans go through the same stringify channel — covers
        // `<option value="True">` × `z.array(z.boolean())` after
        // coerce normalises to `true`.
        option.selected = stringifiedMembers.has(String(optionValue))
      } else if (isArrayValue) {
        // Object option, Array model: structural equality via
        // `looseIndexOf` (mirrors Vue's reference).
        option.selected = looseIndexOf(externalValue, optionValue) > -1
      } else {
        // Object option, Set model: identity-based `.has` (Sets
        // can't structurally compare without iterating, and Vue's
        // reference uses identity here).
        option.selected = (externalValue as Set<unknown>).has(optionValue)
      }
    }
    return
  }

  // Non-multiple: find the first option matching the scalar model
  // and set selectedIndex; clear if nothing matches. Coerce the
  // raw option value to keep parity with the change handler.
  for (let i = 0, l = el.options.length; i < l; i++) {
    const option = el.options[i]
    if (!option) continue
    if (looseEqual(applyCoerce(getValue(option), value), externalValue)) {
      if (el.selectedIndex !== i) el.selectedIndex = i
      return
    }
  }
  if (el.selectedIndex !== -1) el.selectedIndex = -1
}

// retrieve raw value set via :value bindings
//
// `explicitRequired` is the checkbox-array / checkbox-Set caller's way
// of saying "the user must have provided an option-value via either a
// dynamic `:value` binding (Vue sets `el._value`) OR a static `value`
// attribute (DOM has `value` attribute set). If neither is present,
// the default `el.value` of 'on' would silently add the bogus literal
// 'on' to the array on every toggle — surface as undefined so the
// caller can warn instead."
//
// Without the `hasAttribute('value')` fallback, the SSR + static-attr
// hydration path fails: Vue's hydration skips patchProp for hoisted
// static attributes, `el._value` is never set, but the DOM still
// reflects the rendered `value="apple"` attribute. We need to honor
// either signal.
function getValue(el: HTMLOptionElement | HTMLInputElement, explicitRequired = false) {
  if ('_value' in el) return el._value
  if (explicitRequired && !el.hasAttribute('value')) return undefined
  return el.value
}

// retrieve raw value for true-value and false-value set via :true-value or :false-value bindings
function getCheckboxValue(
  el: HTMLInputElement & { _trueValue?: unknown; _falseValue?: unknown },
  checked: boolean
) {
  const key = checked ? '_trueValue' : '_falseValue'
  return key in el ? el[key] : checked
}

// Tags the directive's text/checkbox/radio/select variants handle
// natively. A v-register binding on anything else (a `<div>`, a
// `<span>`, a Vue component whose root is a non-form element) gets
// listeners attached normally — but the listener bodies bail (via
// `shouldBailListener`) when the assigner is still the default. This
// prevents the bubbled-write bug while letting consumer-installed
// `assignKey` / `@update:registerValue` shapes flow through.
//
// The dev-warn for the "no escape hatch" case is deferred to the
// next tick after the directive's `mounted` hook, so `useRegister`'s
// `onMounted` marker has a chance to set `REGISTER_OWNER_MARKER` on
// the rendered root before the warn check runs. The anchor is
// `mounted`, NOT `created`, on purpose: `mounted` always runs inside
// a real scheduler post-flush (fresh mount AND the Suspense/async-
// hydration path), so the `nextTick` chained from it reliably
// resolves after the owning child's post-flush `onMounted`. Anchoring
// from `created` races during async hydration — the directive hook
// then runs inside a bare `Promise.then` (registerDep / Suspense)
// with no active flush, so a `created`-scheduled `nextTick` is a bare
// microtask that fires before the marker is set, warning falsely on
// every SSR'd wrapper. Without any deferral, deeply-nested
// `useRegister` children would always warn (the directive can't
// reach the child instance via `binding.instance` — that's the
// page/parent component, whose `subTree` is the outer element tree,
// not the child component vnode directly).

// One-shot dev-warn dedupe so a v-for over 100 unsupported elements
// produces one warning, not 100. Keyed by element identity (WeakSet
// for GC-friendliness).
const warnedUnsupportedElements: WeakSet<HTMLElement> | null = __DEV__
  ? new WeakSet<HTMLElement>()
  : null

// Dev-warn dedupe for a redundant state binding (:value / :checked /
// v-model) co-located with v-register. Keyed by a coarse misuse
// SIGNATURE (`tag:type:binding`, e.g. `input:checkbox::checked`) rather
// than element identity, on purpose: the same redundant binding
// repeated across a v-for'd field-array row is the common case, and an
// element-keyed set would print one warning per row. The signature
// space is tiny and bounded (a handful of tag / type / binding
// combinations), so a plain Set never grows without limit. The precise,
// per-element coverage is the compile layer's job (it runs once per
// element per build); the runtime only needs to surface the pattern once.
const warnedRedundantBindings: Set<string> | null = __DEV__ ? new Set<string>() : null

// Per-host-root record of the component-host branch's outcome, read back at
// `beforeUnmount` to tear down symmetrically. Maps a host root element to the
// inner control it latched, or `null` when it took the no-latch (markHost
// connected) path. Absent means Case A (a useRegister wrapper the discriminator
// skipped) or not a host at all -- nothing to undo. WeakMap so a host that
// unmounts without GC interaction (KeepAlive churn) leaves no residue.
const componentHostLatch = new WeakMap<HTMLElement, HTMLElement | null>()

// Widget-root focus listeners attached for a no-latch host, kept so a later
// self-heal latch can detach them before the latched control's own focus / blur
// listeners take over -- otherwise a focus would be counted on both the root
// and the control.
const hostFocusListeners = new WeakMap<
  HTMLElement,
  { focusin: EventListener; focusout: EventListener }
>()

// Self-heal MutationObservers, kept so `beforeUnmount` can disconnect a host
// still waiting for an asynchronously-rendered control.
const hostHealObservers = new WeakMap<HTMLElement, MutationObserver>()

// Upper bound on MutationObserver callback batches the self-heal processes
// before giving up on a host whose subtree keeps mutating without ever
// resolving a single latchable control. Stops a no-latch host from carrying a
// live observer for the rest of the page's life.
const SELF_HEAL_MAX_MUTATION_BATCHES = 20

// The inner form controls the host element-discovery latches onto. The
// `type=hidden` exclusion drops the simplest mirror inputs; isLatchableControl
// drops the visually-hidden, out-of-tab-order mirrors real headless components
// render for native form submission.
const HOST_CONTROL_SELECTOR = 'input:not([type=hidden]), select, textarea'

// Whether a control discovered under a host is a real, user-facing one rather
// than a form-submission mirror. Headless components (reka-ui's BubbleInput /
// BubbleSelect and the like) render a second, visually-hidden control beside
// the real one so a native form submit still carries the value. These are not
// `type=hidden`: they sit at `tabindex="-1"` with sr-only styling, tagged
// inconsistently (`aria-hidden="true"` on some, `data-hidden` on others).
// Latching one would pin focus / aria onto an element the user can never reach,
// and a lone real control beside a mirror would otherwise count as two and
// decline the latch. The control to latch is the one the user can focus, so
// drop anything pulled out of the tab order or hidden from the a11y tree.
function isLatchableControl(el: Element): boolean {
  return el.getAttribute('tabindex') !== '-1' && el.getAttribute('aria-hidden') !== 'true'
}

// The runtime half of v-register's third-party binding. The compile-time
// componentBridgeTransform stamps SSR_COMPONENT_HOST_MODIFIER on a v-register
// that lands on a component host and injects the value channel (v-model for a
// plain component, :value for a select-like one). Here the directive supplies
// the rich FieldState: it discovers the real inner control and registers it
// (connected + focus/blur + the aria / scroll-to-error target).
//
// Two host shapes are told apart at mount:
//   - Case A (a useRegister wrapper): its inner `<input v-register>` already
//     self-registered for this path (children mount before parents), so a
//     registered element is contained in the host. That inner control owns
//     value + FieldState and the injected v-model is inert; do nothing.
//   - Case B (a third-party component): nothing is registered for this path.
//     Latch the single inner control when exactly one resolves, else fall back
//     to marking the host connected -- value still binds via the v-model
//     channel. Either way set REGISTER_OWNER_MARKER so the deferred "no-op"
//     warn skips: a value-binding host is not a no-op.
// Query the host for the single user-facing control to bind, dropping
// submission mirrors (isLatchableControl). Returns the element only when
// exactly one resolves; zero or several (a composite widget, or a control that
// has not rendered yet) returns null.
function findHostControl(el: HTMLElement): HTMLElement | null {
  const descendants = Array.from(el.querySelectorAll(HOST_CONTROL_SELECTOR)).filter(
    isLatchableControl
  )
  return descendants.length === 1 ? (descendants[0] as HTMLElement) : null
}

// Bind a discovered control: register it for the rich FieldState and manage its
// aria. `registerElement` is value-free (it gates on INTERACTIVE_TAG_NAMES and
// seeds only `connected` + focus/blur listeners, never reading or writing
// `el.value`), so it cannot fight the v-model value channel. The live-DOM aria
// lock honours aria the component authored on its own control (no vnode is
// available for a runtime-discovered element); a no-op when autoAria is off.
function latchHostControl(el: HTMLElement, rv: RegisterValue, control: HTMLElement): void {
  rv.registerElement(control)
  setupAriaLive(control as AriaCarrier, rv)
  componentHostLatch.set(el, control)
}

// No single control resolved: value still binds via the v-model channel, so
// mark the host connected and track focus at the widget root. focusin /
// focusout bubble (focus / blur do not), so a root listener sees focus crossing
// the inner controls. A move whose relatedTarget stays inside the host is an
// intra-widget hop (segment to segment), not an enter / leave of the field, so
// it is skipped. The listeners ride addTrackedListener (auto-detached by
// removeTrackedListeners at beforeUnmount); they are also stashed so a later
// self-heal latch can detach them itself before the control's own focus / blur
// listeners take over.
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
// mount. When exactly one now resolves, supersede the no-latch state -- detach
// the widget-root focus listeners (the control's own focus / blur listeners
// take over via registerElement) and latch it. `connected` already reads true
// from the host mark; registerElement keeps it true and the element Set owns it
// from here, so beforeUnmount's deregister clears it. Returns true on supersede.
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

// A no-latch host may simply have rendered its single control late -- behind a
// Suspense boundary, an async setup, or a post-fetch v-if. The directive's
// `updated` does not fire on the component's own internal re-render (only on the
// parent's), so poll for the control: once on the next tick (cheap, catches a
// control a microtask late), then via a scoped, bounded MutationObserver for a
// truly-async one. The first exactly-one match supersedes into a latch and
// stops the search.
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
    // Short-circuits so the latch attempt runs only while still unlatched and
    // connected, and the batch counter only ticks on a batch that failed to
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
  // Case A: a useRegister wrapper owns this path already (its inner control
  // self-registered before this host mounted, so a registered element is
  // contained in the host). That control owns value + FieldState and the
  // injected v-model is inert; leave it be.
  if (rv.hasRegisteredDescendant(el))
    return // Case B: a third-party component. Value binds via the transform's v-model
    // desugar, so this binding is never a no-op -- claim ownership of the root so
    // the deferred "no-op" warn skips. A host root that is ITSELF an interactive
    // control was registered by the per-tag variant (callModelHook) and taken by
    // the Case-A return above.
  ;(el as unknown as { [k: symbol]: unknown })[REGISTER_OWNER_MARKER] = true

  // Strip the bridge `registerValue` attribute the transform injects on the
  // host. A useRegister wrapper consumes it and strips it from its own attrs in
  // setup (Case A, returned above); a Web Component reads it as a DOM attribute
  // via assignKey. A plain third-party Vue component does neither, so with
  // inheritAttrs on it falls through to the host root as
  // `registervalue="[object Object]"`. This is the directive's only hook on a
  // component it does not author, so clean it here. Skip custom elements (their
  // hyphenated tag), which legitimately read the attribute. Runs post-mount, so
  // SSR output and client hydration still match before the removal.
  if (!el.tagName.includes('-')) {
    el.removeAttribute('registerValue')
  }

  // Latch the single inner control when exactly one resolves now; zero or
  // several declines into the no-latch path. A control that has not rendered
  // yet looks the same as none, so the no-latch path also starts the self-heal
  // in case it is arriving asynchronously.
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
    // Always run the per-tag variant's `created` — listener-body bail
    // (`shouldBailListener`) prevents the bubbled-write bug on
    // non-supported roots while letting consumer overrides through.
    callModelHook(el, binding, vnode, null, 'created')

    // Auto-aria: lock authored attrs, paint the initial state, and watch
    // the gated display state for async ticks. No-op when the binding
    // disabled aria or carries no display-state accessor.
    if (isRegisterValue(binding.value)) setupAria(el as AriaCarrier, binding.value, vnode)

    // Dev diagnostic: flag a redundant `:value` / `:checked` / `v-model`
    // co-located with v-register. No-op in production, and stands down
    // when the compile-time transforms already own detection (see
    // warnRedundantStateBinding). Runs last so the binding is fully set
    // up first — a diagnostic never affects the field's behaviour.
    if (__DEV__) warnRedundantStateBinding(el, binding, vnode)
  },
  mounted(el, binding, vnode) {
    callModelHook(el, binding, vnode, null, 'mounted')

    // Reactive `disabled` sync for a render-function native control: mirror
    // the form's effective freeze onto `el.disabled` and its client-only
    // first paint. Gated on the vnode carrying NO `disabled` prop, so it
    // runs only where nothing else binds the attribute — a bare
    // `withDirectives(h('input'), ...)` field. A compiled field already
    // carries the transform's `:disabled` bind (or the author's own), which
    // tracks the same source through the render function; managing
    // `el.disabled` imperatively there would fight that bind. Native
    // controls only — a component host's freeze rides its `:disabled` prop
    // through the bridge transform, never the host root element.
    if (
      isRegisterValue(binding.value) &&
      INTERACTIVE_TAG_NAMES.has(el.tagName) &&
      binding.modifiers[SSR_COMPONENT_HOST_MODIFIER] !== true &&
      vnode.props?.['disabled'] === undefined
    ) {
      setupDisabledSync(el, binding.value.disabled)
    }

    // Component-host element discovery. The transform stamps
    // SSR_COMPONENT_HOST_MODIFIER on a v-register that lands on a component
    // host; here the directive discovers the inner control and registers it
    // for the rich FieldState (the value channel is the transform's job). The
    // discriminator inside skips a useRegister wrapper. Runs before the warn
    // below sets REGISTER_OWNER_MARKER on a Case-B host, suppressing the
    // no-op warn that would otherwise fire on a non-interactive host root.
    if (binding.modifiers[SSR_COMPONENT_HOST_MODIFIER] === true && isRegisterValue(binding.value)) {
      activateComponentHost(el, binding.value)
    }

    // Defer the unsupported-element warn one tick past `mounted`. By the
    // time this resolves:
    //  - useRegister's onMounted has run, setting REGISTER_OWNER_MARKER
    //    on the el if the child component called useRegister()
    //  - any post-install assignKey override (via onMounted /
    //    ref-callback) is in place, so the assigner isn't default
    // anymore. The warn fires only when neither escape hatch was used.
    // Anchoring on `mounted` rather than `created` is what makes this
    // hold on the async-hydration path (see the directive-level note
    // above the dedupe set): `mounted` always runs inside a real
    // post-flush, so this `nextTick` resolves after the owning child's
    // `onMounted`, never before it.
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
          `[attaform] v-register on <${el.tagName.toLowerCase()}> is a no-op — ` +
            `non-input roots aren't bound to text-input semantics. For custom components: ` +
            `call \`useRegister()\` in the child's setup and re-bind v-register to an inner ` +
            `native element. Lower-level: install a custom assigner via the \`assignKey\` ` +
            `symbol on the element.`
        )
      })
    }
  },
  beforeUpdate(el, binding, vnode, prevVNode) {
    // Same diff for the form's element map. Catches the
    // `useRegister`-driven swap (binding mounted with `undefined`,
    // a real RV arrives on the next render), the dynamic-path case,
    // and the cross-form swap. Same-path + same-form transitions
    // short-circuit so identity-stable bindings don't thrash.
    syncElementRegistration(el, binding.value, binding.oldValue)
    callModelHook(el, binding, vnode, prevVNode, 'beforeUpdate')

    // Re-derive aria. A path change (a reused node rebound on reorder)
    // re-establishes the watch against the new path's display state; a
    // disabled / removed binding tears down the attrs we set; otherwise
    // we re-paint and pick up any newly-authored attribute lock.
    const ariaEl = el as AriaCarrier
    const value = binding.value
    if (
      !isRegisterValue(value) ||
      value.ariaEnabled !== true ||
      value.ariaDisplayState === undefined
    ) {
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
    // Detach every listener the variant attached in `created`, regardless
    // of whether the binding is still a valid RegisterValue. An element
    // re-used by KeepAlive / v-show would otherwise double its listener
    // count on the next activation cycle.
    removeTrackedListeners(el)

    // Stop the aria watch and clear the attributes we set. A reused
    // element (KeepAlive / v-show) starts clean on its next activation.
    teardownAria(el as AriaCarrier)

    // Stop the reactive value-sync watch (text / textarea bindings). A
    // no-op for variants that never set one up.
    teardownValueSync(el)

    // Stop the reactive disabled-sync watch. A no-op for a host root or
    // any element that never set one up.
    teardownDisabledSync(el)

    if (!isRegisterValue(value)) return

    value.deregisterElement(el)

    // Component-host teardown (mirrors activateComponentHost). The
    // deregisterElement above targets the host ROOT, which a Case-B branch
    // never registered (its root is typically non-interactive), so it doesn't
    // cover the latched descendant. Release that control, or clear the
    // no-latch connected mark, then drop the record.
    if (componentHostLatch.has(el)) {
      // A self-heal observer may still be waiting for an async control; stop it
      // so it can't latch onto a detached subtree after unmount.
      const healObserver = hostHealObservers.get(el)
      if (healObserver !== undefined) {
        healObserver.disconnect()
        hostHealObservers.delete(el)
      }
      const latchedControl = componentHostLatch.get(el)
      if (latchedControl != null) {
        // Mirror activateComponentHost in reverse: stop the aria watch and
        // clear the attrs we set on the control before releasing it. The
        // host-root teardownAria above never reached this descendant.
        teardownAria(latchedControl as AriaCarrier)
        value.deregisterElement(latchedControl)
      } else value.markHostConnected(false, el)
      componentHostLatch.delete(el)
    }

    // Remove internal state that the directive attaches directly to the
    // element. If the element is reused (<KeepAlive>, v-show), stale flags
    // like `composing: true` (IME in progress) would swallow user input.
    delete (el as { composing?: boolean }).composing
    delete (el as { _assigning?: boolean })._assigning
    delete (el as { _syncFromStorage?: () => void })._syncFromStorage
    delete (el as unknown as { [k: symbol]: unknown })[assignKey]
  },
  // The lifecycle hooks above don't run on the server (Vue skips
  // directive lifecycle during SSR), so emit the same aria attributes
  // here from the SSR-time gated display state. Honors authored attrs
  // (vnode-level lockout) and the ariaEnabled gate, touches no DOM, and
  // shares `resolveAriaValue` with the client path. Ids are SSR-stable
  // (formInstanceId derives from Vue's useId), so a server-rendered
  // describedby matches the client after hydration.
  getSSRProps(binding, vnode) {
    const rv = binding.value
    if (!isRegisterValue(rv)) return undefined
    // Vue passes `null` for the vnode in the compiled SSR directive-props
    // helper (string-based SSR has no vnode object), and the real vnode
    // in the runtime `withDirectives` path. The vnode-level authored
    // lockout is therefore only available client-side and on the runtime
    // SSR path; under compiled SSR an authored aria attribute can't be
    // detected here, and the client directive reconciles it on hydration.
    const realVnode = (vnode as VNode | null) ?? null
    // autoAria attrs belong on the bound form control, never on a
    // component host's root element (a presentational wrapper would carry
    // an invalid aria-* attribute). On the runtime path Vue invokes this
    // hook for both the component vnode and the resolved root element, so
    // emit only for an interactive form-control element vnode; a component
    // vnode or a non-control root (e.g. a wrapper <div>) is suppressed.
    // The inner control the component re-binds via useRegister emits its
    // own aria. A `null` vnode is the compiled-SSR path, which cannot see
    // the element here and is handled by the component-host signal the
    // transform stamps. (#404)
    const isInteractiveElementVnode =
      realVnode !== null &&
      typeof realVnode.type === 'string' &&
      INTERACTIVE_TAG_NAMES.has(realVnode.type.toUpperCase())
    // The compile-time componentBridgeTransform stamps this modifier on a
    // component-host v-register, the only signal available under compiled
    // SSR's null vnode. `modifiers` is typed as always-present, but the
    // compiled SSR helper (and synthetic bindings) can omit it, so treat it
    // as optional the same way the vnode above is.
    const modifiers = binding.modifiers as Record<string, boolean> | undefined
    const isComponentHostModifier = modifiers?.[SSR_COMPONENT_HOST_MODIFIER] === true
    const suppressHostAria =
      isComponentHostModifier || (realVnode !== null && !isInteractiveElementVnode)
    const ariaProps = suppressHostAria ? undefined : getSSRAriaProps(rv, realVnode)

    // Form-state (`value` / `checked`) is the runtime path's per-element
    // analogue of the transform's injected binding: without it a
    // render-function field paints empty for one frame before the client
    // directive fills it on mount. Compiled SSR for a directive bound DIRECTLY
    // to an element passes a `null` vnode (the transform already emitted the
    // binding), so the guard below skips it there.
    //
    // Suppressed for a component HOST (the modifier the transform stamps). Vue
    // transfers a component-bound directive onto the component's root element
    // and fires this hook there, so for a third-party host this would seed
    // `value = displayValue` (the stringified model) onto the inner control
    // and win the prop merge, clobbering the typed `:modelValue` channel the
    // transform set up. The host's value rides v-model instead; the
    // element-level seed must stay out of its way. A scalar model hid this
    // (displayValue equals the rendered value); a typed model (array / Date)
    // exposed the stringified clobber.
    const formStateProps =
      realVnode !== null && !isComponentHostModifier
        ? getSSRFormStateProps(rv, realVnode)
        : undefined

    if (ariaProps === undefined && formStateProps === undefined) return undefined
    // Disjoint key spaces (`aria-*` vs `value` / `checked`), so the merge
    // order is immaterial; spreading `undefined` is a no-op.
    return { ...ariaProps, ...formStateProps }
  },
}

function resolveDynamicModel(tagName: string, type: unknown) {
  // tagName is always uppercase per DOM spec (el.tagName); type comes from
  // vnode.props and is usually a string, but reactive bindings (`:type="x"`)
  // can pass other values — guard defensively.
  if (tagName === 'SELECT') return vRegisterSelect
  if (tagName === 'TEXTAREA') return vRegisterText
  if (typeof type !== 'string') return vRegisterText
  if (type === 'file') return vRegisterFile
  if (type === 'checkbox') return vRegisterCheckbox
  if (type === 'radio') return vRegisterRadio
  return vRegisterText
}

/**
 * Dev diagnostic (#464): warn when a redundant STATE binding sits
 * beside `v-register` on a native control. `v-register` already owns
 * value / checked, so a co-located `:value` / `:checked` / `v-model`
 * is redundant at best and a dual-binding bug at worst.
 *
 * Runs ONLY when Attaform's compile-time transforms did NOT process
 * this directive (`V_REGISTER_COMPILED_MODIFIER` absent). With the
 * bundler plugin, `inputTextAreaNodeTransform` has stripped the
 * author's value / checked and injected its own, so `vnode.props`
 * reflects the injection, not what the author wrote — reading it would
 * flag every field. There the compile layer owns detection. Without the
 * plugin (CSR-only, the common case) nothing rewrites the props, so
 * `vnode.props` IS what the author wrote and is authoritative.
 *
 * Carve-out: a radio's `:value` (`<input type="radio" :value="opt">`)
 * and a checkbox's `:value` (array / Set member) are the IDENTITY
 * channel `v-register` reads, never flagged — only the state attr for
 * each kind warns. `<option :selected>` is a child of the `<select>`,
 * not the bound element, so it's left to the compile layer.
 */
function warnRedundantStateBinding(el: HTMLElement, binding: DirectiveBinding, vnode: VNode): void {
  if (warnedRedundantBindings === null) return // production
  if (!INTERACTIVE_TAG_NAMES.has(el.tagName)) return // native controls only
  // Compile layer active: it owns detection, and vnode.props is
  // post-injection (not what the author wrote), so stand down.
  if (binding.modifiers[V_REGISTER_COMPILED_MODIFIER] === true) return

  const props = vnode.props
  if (props == null) return

  const variant = resolveDynamicModel(el.tagName, props['type'])
  if (variant === vRegisterFile) return // out of scope: browser rejects `value`

  // Native v-model desugars to an `onUpdate:modelValue` prop. The
  // transforms never emit that key, so its presence is an author-only
  // signal for every variant (text / select / checkbox / radio).
  const hasVModel = 'onUpdate:modelValue' in props
  // Radio / checkbox: `:value` is the option identity; only `:checked`
  // is redundant state. Everything else is value-driven.
  const stateAttr =
    variant === vRegisterCheckbox || variant === vRegisterRadio ? 'checked' : 'value'
  const hasStateAttr = stateAttr in props

  if (!hasVModel && !hasStateAttr) return

  const tag = el.tagName.toLowerCase()
  const redundant = hasVModel ? 'v-model' : `:${stateAttr}`
  // The resolved `type` is part of the key so a redundant `:checked` on
  // a checkbox and on a radio are counted apart (their messages read the
  // same, but they're distinct misuses).
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
 * SSR `checked` verdict for a checkbox, mirroring `setChecked`'s
 * Array→`looseIndexOf` / Set→`.has` / scalar→`looseEqual(trueValue)`
 * ladder — but reading the option-value and true-value from `vnode.props`
 * rather than the DOM element (there's no element server-side). Returns
 * the props bag (`{ checked: '' }`) when the box should render checked,
 * else `undefined` so no attribute is emitted.
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
    // `getCheckboxValue(el, true)` returns `_trueValue` (the `:true-value`
    // binding) when present, else `true`. On the server we read the
    // `true-value` prop directly.
    const trueValue = props !== null && 'true-value' in props ? props['true-value'] : true
    checked = looseEqual(model, applyCoerce(trueValue, rv))
  }
  return checked ? { checked: '' } : undefined
}

/**
 * Compute the form-state props (`value` / `checked`) the directive would
 * apply on mount, for SSR emission on the RUNTIME render-function path.
 * Mirrors each variant's mount logic — `vRegisterText`'s
 * `el.value = displayValue.value`, `setChecked`, the radio `looseEqual` —
 * but sources the element-side option-value from `vnode.props` since
 * there's no DOM element server-side.
 *
 * Returns `undefined` for the variants whose initial state can't be
 * expressed at the element level here:
 *  - file: browsers reject `value` on file inputs; `vRegisterFile` owns
 *    the DOM contract.
 *  - select: option `selected` is option-level, not expressible from the
 *    `<select>` element's props (compiled templates carry it via
 *    `componentBridgeTransform`; documented limitation for runtime
 *    render functions).
 *
 * Only reached on the runtime path — compiled SSR passes a `null` vnode,
 * where the compile-time transform already injected the binding — so the
 * two mechanisms never double-emit.
 */
function getSSRFormStateProps(rv: RegisterValue, vnode: VNode): Record<string, string> | undefined {
  // Component vnodes (`h(MyComp, ...)` with a v-register binding) have no
  // element-level form state — the inner native input the component
  // re-binds owns it. Only real HTML tags dispatch here.
  if (typeof vnode.type !== 'string') return undefined
  const props = (vnode.props as Record<string, unknown> | null) ?? null
  const variant = resolveDynamicModel(vnode.type.toUpperCase(), props?.['type'])

  // A frozen form (`useForm({ disabled })`) renders the HTML `disabled`
  // attribute on every control, mirroring the compiled transform's
  // `:disabled` bind. Overlaid onto whatever value / checked state the
  // variant resolves, and rendered even when the variant contributes no
  // other attribute (an empty text field, an unselected radio, a file or
  // select input) so the render-function SSR path matches the compiled one.
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
  // text / textarea / number / email — mirror `el.value = displayValue`.
  // `displayValue` already folds blank/unset to `''`; omit the attribute
  // for an empty field so SSR matches the no-value initial paint.
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
 * The `v-register` directive. Bind a form field to a native input,
 * select, textarea, checkbox, or radio:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * <select v-register="form.register('country')">
 *   <option value="us">US</option>
 *   <option value="uk">UK</option>
 * </select>
 * ```
 *
 * The directive picks the right binding strategy automatically based
 * on the element's `tagName` and `type`. Registered globally by
 * `createAttaform()`. Most consumers never import it directly, but
 * it's exposed for advanced integrations that wire directives
 * manually.
 */
export const vRegister = vRegisterDynamic

// Stamp the marker on the directive object after definition. Reading
// it from `vnode.dirs[].dir[V_REGISTER_MARKER]` lets `useRegister`
// find the parent's binding even without the compile-time bridge-
// prop injection — keeps the wrapper pattern working in bare-Vue and
// playground setups.
;(vRegisterDynamic as unknown as { [k: symbol]: true })[V_REGISTER_MARKER] = true
