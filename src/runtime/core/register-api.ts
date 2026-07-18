import { computed, nextTick, ref, shallowReadonly, warn, type Ref } from 'vue'
import type {
  CoercionRegistry,
  DisplayState,
  InternalRegisterValue,
  RegisterOptions,
  RegisterTransform,
  RegisterValue,
  TransformAbortHolder,
  WriteMeta,
} from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { computeFieldIdentity } from './field-ids'
import { INTERACTIVE_TAG_NAMES } from './interactive-tags'
import { canonicalizePath, type Path, type PathKey } from './paths'
import { buildCoerceFn, buildElementCoerceFn, resolveCoercionIndex } from './schema-coerce'
import { __DEV__ } from './dev'

// Dev-only dedup for the multi-root host warning: a host value update flowing
// in while nothing was ever wired for the path means Vue dropped the directive
// on a multi-root component. Keyed by form-instance + path so it fires once per
// affected binding, and never bleeds the warning across separate forms.
const warnedMultiRootHosts = new Set<string>()

/**
 * Per-`useForm()`-instance config that the API layer threads through
 * register so each instance honors its own `validateOn` / `debounceMs`
 * / `coerce` / `rememberVariants` even when sharing a FormStore with
 * sibling instances. Anything omitted falls back to the store's
 * construction-time captured values.
 */
export type InstanceRegisterConfig = {
  readonly instanceMeta?: WriteMeta['instance']
  readonly coerce?: boolean | CoercionRegistry
  /**
   * Form-level `autoAria` resolution (form config merged over app
   * defaults). The per-register `autoAria` option overrides this per
   * binding to produce each binding's `ariaEnabled`. Omitted (undefined)
   * is treated as the library default, `true`.
   */
  readonly autoAria?: boolean
  /**
   * Resolves the gated `displayState` at a path, reusing the same
   * field-state identity as `form.fields`. Closed over the form's
   * field-state accessor by `build-form-api.ts`; absent only for
   * hand-rolled register factories (in which case bindings carry no
   * `ariaDisplayState` and the directive skips aria wiring).
   */
  readonly getDisplayStateAt?: (segments: Path) => DisplayState
}

// Module-level frozen empty array — re-used as the transforms default
// across every register() call that doesn't opt in. Avoids a per-call
// allocation on the 99% of fields that don't declare normalization,
// while keeping the directive's `for (const t of rv.transforms)`
// iteration uniform (no null-check needed).
const EMPTY_TRANSFORMS: ReadonlyArray<RegisterTransform> = Object.freeze([])

/**
 * Register API factory. Given a FormStore, returns a `register(path)` that
 * produces a RegisterValue suitable for the v-register directive.
 *
 * Design points:
 *
 * - Focus/blur listeners are attached per-element-registration and stored
 *   on the element itself via a symbol, then removed on deregistration.
 *   No registration-time helper cache.
 * - `innerRef` reads `form.value` directly via `getValueAtPath`; there's
 *   no separate raw-vs-form tracking. The synchronous diff-apply writer
 *   keeps the two values in lock-step.
 * - Cross-form isolation is by construction: every call to `buildRegister`
 *   closes over a FormStore<F> unique to one form.
 */

// `Symbol.for(...)` so duplicate copies of attaform agree on the
// element-property key for stashed focus/blur handlers — see
// `assignKey` in core/directive.ts for the same reasoning.
const attaformListenersSymbol: unique symbol = Symbol.for('attaform:focus-listeners')

type ElementWithListeners = HTMLElement & {
  [attaformListenersSymbol]?: {
    handleFocus: (event: FocusEvent) => void
    handleBlur: (event: FocusEvent) => void
  }
}

function attachFocusListeners<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  segments: Path,
  element: HTMLElement,
  instanceMeta: WriteMeta['instance'] | undefined
): void {
  const target = element as ElementWithListeners
  if (target[attaformListenersSymbol] !== undefined) return
  const focusMeta = instanceMeta !== undefined ? { instance: instanceMeta } : undefined
  const handleFocus = (): void => state.markFocused(segments, true, focusMeta)
  const handleBlur = (): void => state.markFocused(segments, false, focusMeta)
  element.addEventListener('focus', handleFocus)
  element.addEventListener('blur', handleBlur)
  target[attaformListenersSymbol] = { handleFocus, handleBlur }
  // Catch-up probe: the browser applies `autofocus` and dispatches the
  // resulting `focus` event during HTML parse, BEFORE Vue's directive
  // lifecycle runs and we attach the listeners above. Programmatic
  // `.focus()` from a parent component's `onMounted` has the same race.
  // In both cases, by the time we wire up, the focus event has come and
  // gone and our handler never runs. Probe `document.activeElement`
  // (ShadowRoot-aware, mirroring the lookup at directive.ts:881) once
  // immediately after attaching, so the freshly-rendered field's
  // FieldState reflects DOM truth instead of the optimistic
  // `focused: false` seeded at registration.
  const rootNode = element.getRootNode()
  const activeElement =
    rootNode instanceof Document || rootNode instanceof ShadowRoot ? rootNode.activeElement : null
  if (activeElement === element) {
    state.markFocused(segments, true, focusMeta)
  }
}

function detachFocusListeners(element: HTMLElement): void {
  const target = element as ElementWithListeners
  const listeners = target[attaformListenersSymbol]
  if (listeners === undefined) return
  element.removeEventListener('focus', listeners.handleFocus)
  element.removeEventListener('blur', listeners.handleBlur)
  delete target[attaformListenersSymbol]
}

export function buildRegister<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  formInstanceId: string,
  instanceConfig?: InstanceRegisterConfig
) {
  // Per-instance coerce resolution: when a `useForm()` callsite passes
  // its own `coerce` config, resolve to a fresh CoercionIndex local to
  // this register factory. Sibling instances sharing the FormStore
  // (modal + main) keep their own input-side coerce semantics — one's
  // `'1' → 1` doesn't infect the other's. Falls through to the store's
  // captured index when the per-call config is absent.
  const coerceIndex =
    instanceConfig?.coerce !== undefined
      ? resolveCoercionIndex(instanceConfig.coerce)
      : state.coerceIndex
  const instanceMeta = instanceConfig?.instanceMeta
  // Form-level aria resolution captured once for this register factory.
  // `autoAria` omitted is the library default (`true`); the per-register
  // `autoAria` option overrides this per call below.
  const formAutoAria = instanceConfig?.autoAria ?? true
  const getDisplayStateAt = instanceConfig?.getDisplayStateAt
  // `meta.instance` is forwarded into every store write below so the
  // store's reads of `validateOn` / `debounceMs` / `rememberVariants`
  // honor THIS instance's config. Composed with caller-supplied
  // `meta` so the blank / array-op flags ride through unchanged.
  const withInstanceMeta = (meta?: WriteMeta): WriteMeta | undefined => {
    if (instanceMeta === undefined) return meta
    return meta === undefined ? { instance: instanceMeta } : { ...meta, instance: instanceMeta }
  }
  // Path-keyed cache of typed-form refs. Lifted out of the per-call
  // closure so multiple `register(path)` invocations for the same
  // path — e.g. two `<input v-register>` bindings to `'numberText'`,
  // or repeated calls inside a render function — share the same ref.
  // Without sharing, the directive's keystroke listener writes to
  // RegisterValue A's `lastTypedForm` while RegisterValue B's
  // `displayValue` reads its own (always-null) ref, and Vue patches
  // B's DOM to the canonical `String(storage)` mid-typing — yanking
  // the user's caret on a sibling input.
  const lastTypedFormByPath = new Map<PathKey, Ref<string | null>>()

  return function register(
    pathInput: string | Path,
    options?: RegisterOptions
  ): RegisterValue<unknown> {
    const { segments, key: pathKey } = canonicalizePath(pathInput)

    const innerRef = computed(() => state.getValueAtPath(segments)) as Readonly<Ref<unknown>>

    // The user's currently-typed string form for numeric fields,
    // populated by the directive on every keystroke and cleared on
    // blur. Lets `displayValue` surface the typed form (e.g. `'1e2'`)
    // mid-typing instead of the canonical `String(storage)` (`'100'`),
    // which Vue would otherwise patch into the DOM and yank the
    // cursor away from the user's caret. After blur the typed form
    // is cleared so `displayValue` falls back to the honest canonical
    // form — what the user sees matches what's in storage. Shared
    // across all RegisterValues for the same path so paired inputs
    // stay in sync mid-typing.
    let lastTypedForm = lastTypedFormByPath.get(pathKey)
    if (lastTypedForm === undefined) {
      lastTypedForm = ref<string | null>(null)
      lastTypedFormByPath.set(pathKey, lastTypedForm)
    }

    // String-form view of the path's storage value, with `''` returned
    // for blank membership and for null/undefined storage.
    // The blank branch is what lets a user clear a numeric
    // field: even though storage holds 0, the `:value` binding reads
    // displayValue and writes `''` to el.value, so Vue's next render
    // doesn't undo the user's clear.
    //
    // Typed-form preference (numeric only): when `lastTypedForm` is
    // set AND `parseFloat(lastTypedForm)` equals the current numeric
    // storage, return the typed form. Storage commits live (typing
    // `1e2` writes 100 to storage immediately), but the DOM keeps
    // showing `1e2` until blur — at which point the directive clears
    // `lastTypedForm` and Vue patches the DOM to `String(100)` =
    // `'100'`. The check naturally invalidates on programmatic
    // setValue / hydration / reset (different storage value → fall
    // back to `String(...)`).
    const displayValue = computed(() => {
      if (state.blankPaths.has(pathKey)) return ''
      const raw = state.getValueAtPath(segments)
      if (raw === null || raw === undefined) return ''
      const typed = lastTypedForm.value
      if (typed !== null && typeof raw === 'number' && parseFloat(typed) === raw) {
        return typed
      }
      // Container-path misuse degrades gracefully: a consumer who
      // bound v-register at an object/array path (e.g.
      // `api.register('payment' as 'payment.last4', …)` to bypass the
      // type system) gets the `[object Object]` placeholder
      // `String({})` produces. Runtime values now carry
      // `Object.prototype` so `String(raw)` succeeds for normal
      // container shapes, but a consumer can still hand us a
      // null-prototype value (e.g. a `defaultValues` literal made via
      // `Object.create(null)`); for those, `String(raw)` throws
      // "Cannot convert object to primitive value". The catch falls
      // back to the canonical `Object.prototype.toString` output so
      // the directive's mounted hook never propagates the throw into
      // the consumer's render.
      try {
        return String(raw)
      } catch {
        return Object.prototype.toString.call(raw)
      }
    }) as Readonly<Ref<string>>

    // Blank-aware model presentation for a `v-register` component host's
    // `:modelValue`. The native `:value` path reads `displayValue`, which
    // returns `''` for a blank path so a cleared numeric input renders
    // empty while storage still holds the slim `0`. A component's model is
    // typed, so it can't carry that `''`; instead a blank path presents as
    // `undefined` -- the typed-model analog of "displayed empty." A naive
    // numeric component renders `undefined ?? '' === ''`, so a cleared
    // numeric field reads empty in a v-model-bound component exactly as it
    // does in a native input. Filled paths present the raw typed storage.
    const hostModelValue = computed(() =>
      state.blankPaths.has(pathKey) ? undefined : innerRef.value
    ) as Readonly<Ref<unknown>>

    // Slim default precomputed at register-time. The schema is fixed
    // for the form's lifetime, so this is safe to cache; downstream
    // `markBlank` calls reuse it without re-walking the
    // schema tree.
    const slimDefault = state.schema.getDefaultAtPath(segments)

    // `true` when the leaf's slim-primitive set includes `'undefined'`
    // (i.e. the path was declared `.optional()`). The text-input
    // listener consults this on DOM clear: when the user empties an
    // optional field, the directive writes `undefined` rather than
    // `''`, so the schema's `.optional()` semantic remains reachable
    // from the DOM after any interaction. Number-typed leaves don't
    // need a separate path — `slimDefault` for an optional number
    // resolves to `undefined`, so `markBlank` writes the right thing
    // already.
    const slimTypes = state.schema.getSlimPrimitiveTypesAtPath(segments)
    const acceptsUndefined = slimTypes.has('undefined')
    // `true` when the slim set admits `'string'`. The text-input
    // listener uses the negation: when a DOM clear lands on a leaf
    // that does NOT admit string (e.g. a required `z.number()`
    // rendered as `<input type="text">` without the `.number`
    // modifier), the assigner would reject the empty-string write and
    // the post-write force-sync would snap the DOM back to the stored
    // numeric. Routing through `markBlank` instead keeps the DOM
    // empty and stages the blank meta for submit-time validation.
    const acceptsString = slimTypes.has('string')

    const transforms = options?.transforms ?? EMPTY_TRANSFORMS

    // Schema-driven coerce closure. Captures the path's slim accept set
    // and the form's resolved coercion index so the per-event hot path
    // is a single function call. Identity when the form has coercion
    // disabled (`useForm({ coerce: false })`) or the path admits no
    // coercion target. Cached on RegisterValue so the directive doesn't
    // re-walk the schema per keystroke.
    const coerce = buildCoerceFn(
      state.schema as Parameters<typeof buildCoerceFn>[0],
      segments,
      coerceIndex
    )
    const coerceElement = buildElementCoerceFn(
      state.schema as Parameters<typeof buildElementCoerceFn>[0],
      segments,
      coerceIndex
    )

    // Aria wiring baked onto the RegisterValue so the (store-less)
    // directive can drive `aria-*` without a field-state lookup. The
    // ids match `FieldState.aria` exactly (same pure derivation).
    // `ariaEnabled` resolves this binding's per-register `autoAria`
    // override against the form-level value, so a binding can re-enable
    // aria even when the form opted out. `ariaDisplayState` reuses the
    // form's field-state accessor, so it carries the SAME gated verdict
    // the visible `form.fields.<path>.displayState` shows.
    const { aria } = computeFieldIdentity(formInstanceId, state.formKey, pathKey)
    const isRequired = state.schema.isRequiredAtPath(segments)
    const ariaEnabled = options?.autoAria ?? formAutoAria
    const ariaDisplayState =
      getDisplayStateAt !== undefined
        ? (computed(() => getDisplayStateAt(segments)) as Readonly<Ref<DisplayState>>)
        : undefined

    // Shared blank-marking op: write the schema's slim default and stage
    // the blank meta so submit-time validation surfaces "No value
    // supplied". The slim default keeps storage well-typed
    // (getDefaultAtPath returns 0 for z.number(), '' for z.string(),
    // false for z.boolean()). Hoisted out of the object literal so both
    // the `markBlank` binding (the directive's numeric-clear listener)
    // and `setValueFromHost` (the component-host analog) route through
    // one place, and a cleared numeric leaf lands on the same state
    // whether it came from a native `<input>` or a v-model component.
    const markBlank = (): boolean =>
      state.setValueAtPath(segments, slimDefault, withInstanceMeta({ blank: true }))

    // `shallowReadonly` is what makes `rv.path`, `rv.formKey`, and the
    // other top-level string fields feel like reactive state in
    // wrapper components: property reads track in computeds /
    // watchEffects, mutations are blocked at runtime + type level, and
    // inner refs (`innerRef`, `displayValue`, `lastTypedForm`) keep
    // their `Ref` shape so the directive's `.value` reads/writes
    // continue to work unchanged.
    const internalRv: InternalRegisterValue = {
      innerRef,
      displayValue,
      hostModelValue,
      // Live form-freeze flag for the compile-time transforms' `:disabled`
      // bind (native attribute + component-host prop) and custom
      // `useRegister` integrations. Reads the form-level effective freeze,
      // so every binding on a disabled form reports `true`.
      disabled: computed(() => state.effectiveDisabled.value),
      lastTypedForm,

      markBlank,

      markInteracted: (): void => {
        state.markInteracted(segments)
      },

      registerElement: (element: HTMLElement): void => {
        // Form-element semantics (state-side registration + focus
        // listeners) are gated behind the interactive tag set —
        // prevents accidental registration of component wrapper divs
        // when fallthrough attributes carry the directive past the
        // intended `<input>` / `<select>` / `<textarea>`.
        if (!INTERACTIVE_TAG_NAMES.has(element.tagName)) return
        const added = state.registerElement(segments, element, formInstanceId)
        if (added) attachFocusListeners(state, segments, element, instanceMeta)
      },

      deregisterElement: (element: HTMLElement): void => {
        detachFocusListeners(element)
        state.deregisterElement(segments, element)
      },

      setValueWithInternalPath: (value: unknown, meta?: WriteMeta): boolean => {
        // The write path for custom assigners: a consumer-installed
        // assigner calls `rv.setValueWithInternalPath(value)` and the
        // write routes through the same funnel (and instance meta) as
        // the directive's default assigner. Caller-supplied `meta`
        // passes through unchanged.
        return state.setValueAtPath(segments, value, withInstanceMeta(meta))
      },

      setValueFromHost: (value: unknown): boolean => {
        // The write path for a third-party component bound by v-register's
        // compile-time v-model desugar. The host emits its typed model value
        // through `onUpdate:modelValue`; unlike a native control there is no
        // DOM input listener, so this bundles the value write with
        // markInteracted -- exactly as the native input listener pairs the
        // assigner write with noteInteraction. Without the markInteracted,
        // blur-validation and the reward-early display state would never arm
        // for a v-model-bound component. A real value is authoritative (the
        // component's resolved model type), so it routes through the same
        // no-coercion funnel as setValueWithInternalPath. Mark interacted
        // before the write so any validation the write triggers sees the bit.
        state.markInteracted(segments)
        // Empty-signal normalization, mirroring the native input listener's
        // DOM-clear handling (directive.ts). A component clearing a
        // numeric-only leaf emits an empty signal ('' / null / undefined)
        // that the slim-primitive gate would reject, freezing form state at
        // the old value while the component's DOM shows empty. When the
        // emitted value is one of those signals AND the leaf's slim set does
        // not admit it, route to markBlank -- storage lands on the slim
        // default with the blank flag, the same state a native
        // `<input v-register>` reaches on clear. The slim-set gate keeps a
        // `.nullable()` / `.optional()` (or `z.file()`) leaf accepting null /
        // undefined as a genuine value rather than reading it as blank.
        const isBlankSignal =
          (value === '' && !acceptsString) ||
          (value === null && !slimTypes.has('null')) ||
          (value === undefined && !acceptsUndefined)
        const accepted = isBlankSignal
          ? markBlank()
          : state.setValueAtPath(segments, value, withInstanceMeta(undefined))
        // Dev diagnostic: a host value update flowed in, but nothing was ever
        // wired for this path (no registered element, connected never set). The
        // transform's v-model props ride a component's props / emits, which Vue
        // keeps even when it drops a runtime directive on a multi-root
        // (fragment) component -- so the value channel works while
        // activateComponentHost never ran and the rich FieldState (connected /
        // focus / aria / scroll-to-error) is silently missing. Re-check on the
        // next tick so a component that emits during its own mount, before the
        // directive's mounted runs, does not trip a false positive.
        if (__DEV__) {
          const dedupeKey = `${formInstanceId}:${pathKey}`
          const isWired = (): boolean =>
            (state.elements.get(pathKey)?.elements.size ?? 0) > 0 ||
            state.getFieldRecord(segments)?.connected === true
          if (!warnedMultiRootHosts.has(dedupeKey) && !isWired()) {
            warnedMultiRootHosts.add(dedupeKey)
            void nextTick(() => {
              if (isWired()) return
              warn(
                `[attaform] v-register received a value update from a component it never ` +
                  `attached to. Vue drops a runtime directive on a component with more than one ` +
                  `root node (a fragment / multi-root template), so v-register's value binding ` +
                  `works but its field state (connected, focus, aria, scroll-to-error) does not. ` +
                  `Give the component a single element root, or wrap it so v-register lands on ` +
                  `one element.`
              )
            })
          }
        }
        return accepted
      },

      // Called by the `vRegisterHint` compile-time transform's wrapping
      // IIFE on every server-side render of `<element v-register="…">`.
      // Without it, every SSR'd FieldState serialises `connected: false`
      // (because Vue skips directive lifecycle during SSR) and the client
      // briefly shows that stale flag until hydration runs the directive's
      // `created` hook. The mark only takes effect when `state.ssr` is
      // true; on the client this is a no-op so the directive lifecycle
      // remains the source of truth.
      markConnectedOptimistically: (): void => {
        state.markConnectedOptimistically(segments)
      },

      markHostConnected: (connected: boolean, hostEl: HTMLElement): void => {
        state.markHostConnected(segments, connected, hostEl, formInstanceId)
      },

      markFocused: (focused: boolean): void => {
        // The no-latch host focus path. A composite widget (PinInput's
        // segments) or a control-less one (Slider) exposes no single element
        // for attachFocusListeners to bind focus / blur to, so the directive
        // tracks focusin / focusout on the widget root and forwards here. Pass
        // the same instance meta the latched-control focus listeners use, so a
        // blur still drives this binding's validateOn blur-validation.
        state.markFocused(
          segments,
          focused,
          instanceMeta !== undefined ? { instance: instanceMeta } : undefined
        )
      },

      hasRegisteredDescendant: (hostElement: HTMLElement): boolean => {
        // Discriminator for the directive's component-host branch: is any
        // element already registered for this path contained within (or
        // equal to) the host? True for a `useRegister` wrapper whose inner
        // control self-registered before the host mounted (children mount
        // first); false for a third-party component that registered nothing.
        const record = state.elements.get(pathKey)
        if (record === undefined) return false
        for (const element of record.elements) {
          if (hostElement.contains(element)) return true
        }
        return false
      },

      // --- Async transform lifecycle (internal; the directive's
      // deferred orchestrator is the only legitimate consumer). Thin
      // path-bound delegates to the store's per-path token / counter
      // machinery — same pattern as `markBlank` / `setValueWithInternalPath`,
      // so the directive (which holds only this RegisterValue, never the
      // store) can drive the busy/discard/error bookkeeping. ---
      beginTransform: (holder: TransformAbortHolder): number =>
        state.beginTransform(pathKey, holder),
      isCurrentTransform: (token: number): boolean => state.isCurrentTransform(pathKey, token),
      endTransform: (token: number): void => state.endTransform(pathKey, token),
      setTransformError: (err: Error): void => state.setTransformError(pathKey, err),
      // Synchronous read of "is a transform in flight at this path". The
      // orchestrator's `beginTransform` bumps the count before the
      // listener's force-sync block runs, so the directive reads this to
      // skip reverting the DOM to stale storage mid-flight.
      get transforming(): boolean {
        return (state.fieldTransformCounts.get(pathKey) ?? 0) > 0
      },

      path: pathKey,
      // Frozen so a wrapper component can pass `rv.segments` directly
      // to `form.fields(...)` without defensive copying — and so test
      // fixtures or downstream code can't mutate the canonical
      // segment list out from under the directive.
      segments: Object.freeze(segments.slice()),
      formKey: state.formKey,
      formInstanceId,

      transforms,
      coerce,
      ...(coerceElement !== undefined ? { coerceElement } : {}),
      acceptsUndefined,
      acceptsString,

      // --- Aria (internal; consumed by the directive) ---
      aria,
      isRequired,
      ariaEnabled,
      ...(ariaDisplayState !== undefined ? { ariaDisplayState } : {}),
    }
    return shallowReadonly(internalRv) as RegisterValue
  }
}
