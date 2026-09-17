import { computed, nextTick, ref, shallowReadonly, warn, type Ref } from 'vue'
import type {
  DisplayState,
  DomBindingFactory,
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
import { canonicalizePath, type Path, type PathKey } from './paths'
import { buildCoerceFn, buildElementCoerceFn, resolveCoerceEnabled } from './schema-coerce'
import { __DEV__ } from './dev'

// Dev-only dedup for the multi-root host warning: a host value update
// arriving while nothing was ever wired for the path means Vue dropped the
// directive on a multi-root component. Keyed by form-instance plus path, so
// it fires once per affected binding and never bleeds across forms.
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
  readonly coerce?: boolean
  /**
   * Resolves the gated `displayState` at a path, reusing the same
   * field-state identity as `form.fields`. Closed over the form's
   * field-state accessor by `build-form-api.ts`; absent only for
   * hand-rolled register factories (in which case bindings carry no
   * `ariaDisplayState` and the directive skips aria wiring).
   */
  readonly getDisplayStateAt?: (segments: Path) => DisplayState
}

// The transforms default for every `register()` call that does not opt in,
// shared so a field declaring no normalization costs no allocation and the
// directive's `for (const t of rv.transforms)` stays uniform, no null check.
const EMPTY_TRANSFORMS: ReadonlyArray<RegisterTransform> = Object.freeze([])

/**
 * Register API factory. Given a FormStore, returns a `register(path)` that
 * produces a RegisterValue suitable for the v-register directive.
 *
 * - Element registration and focus/blur listeners live in the DOM binding
 *   (`dom-binding.ts`, inside the directive cluster's lazy graph). The
 *   RegisterValue's element members delegate through the store's
 *   `domBinding` slot, which the directive or `useRegister` arms via
 *   `ensureDomBinding` before any element call.
 * - `innerRef` reads `form.value` through `getValueAtPath`; there is no
 *   separate raw-vs-form tracking, the synchronous diff-apply writer
 *   keeping the two in lock-step.
 * - Cross-form isolation is by construction: each `buildRegister` call
 *   closes over a FormStore<F> unique to one form.
 */
export function buildRegister<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  formInstanceId: string,
  instanceConfig?: InstanceRegisterConfig
) {
  // Per-instance coerce resolution. Sibling instances sharing one
  // FormStore (a modal and the main form) keep their own input-side
  // semantics, so one call site's `'1' → 1` does not reach the other.
  // Falls through to the store's captured switch when absent.
  const coerceEnabled =
    instanceConfig?.coerce !== undefined
      ? resolveCoerceEnabled(instanceConfig.coerce)
      : state.coerceEnabled
  const instanceMeta = instanceConfig?.instanceMeta
  const getDisplayStateAt = instanceConfig?.getDisplayStateAt
  // `meta.instance` is forwarded into every store write below so the
  // store's reads of `validateOn` / `debounceMs` / `rememberVariants`
  // honor THIS instance's config. Composed with caller-supplied
  // `meta` so the blank / array-op flags ride through unchanged.
  const withInstanceMeta = (meta?: WriteMeta): WriteMeta | undefined => {
    if (instanceMeta === undefined) return meta
    return meta === undefined ? { instance: instanceMeta } : { ...meta, instance: instanceMeta }
  }
  // Path-keyed cache of typed-form refs, outside the per-call closure so
  // every `register(path)` for one path shares a ref (two
  // `<input v-register>` bindings to `'numberText'`, or repeated calls
  // inside a render function). Unshared, the directive's keystroke
  // listener writes RegisterValue A's `lastTypedForm` while B's
  // `displayValue` reads its own always-null ref, and Vue patches B's DOM
  // to the canonical `String(storage)` mid-typing, taking the user's
  // caret off a sibling input.
  const lastTypedFormByPath = new Map<PathKey, Ref<string | null>>()

  return function register(
    pathInput: string | Path,
    options?: RegisterOptions
  ): RegisterValue<unknown> {
    const { segments, key: pathKey } = canonicalizePath(pathInput)

    const innerRef = computed(() => state.getValueAtPath(segments)) as Readonly<Ref<unknown>>

    // The user's currently-typed string form for numeric fields, written
    // by the directive on every keystroke and cleared on blur. It lets
    // `displayValue` show `'1e2'` mid-typing rather than the canonical
    // `String(storage)` of `'100'`, which Vue would patch into the DOM,
    // taking the caret with it. After blur what the user sees is the
    // canonical form again, matching storage.
    let lastTypedForm = lastTypedFormByPath.get(pathKey)
    if (lastTypedForm === undefined) {
      lastTypedForm = ref<string | null>(null)
      lastTypedFormByPath.set(pathKey, lastTypedForm)
    }

    // String-form view of the path's storage value, `''` for blank
    // membership and for null / undefined storage. The blank branch is
    // what lets a user clear a numeric field: storage holds 0, but the
    // `:value` binding reads displayValue and writes `''` to el.value, so
    // Vue's next render does not undo the clear.
    //
    // Typed-form preference, numeric only: when `lastTypedForm` is set
    // AND `parseFloat(lastTypedForm)` equals the current numeric storage,
    // return the typed form. Storage commits live (typing `1e2` writes
    // 100 immediately) while the DOM keeps showing `1e2` until blur,
    // where the directive clears `lastTypedForm` and Vue patches in
    // `String(100)`. The equality check invalidates itself on a
    // programmatic setValue, hydration or reset, a different storage
    // value falling back to `String(...)`.
    const displayValue = computed(() => {
      if (state.blankPaths.has(pathKey)) return ''
      const raw = state.getValueAtPath(segments)
      if (raw === null || raw === undefined) return ''
      const typed = lastTypedForm.value
      if (typed !== null && typeof raw === 'number' && parseFloat(typed) === raw) {
        return typed
      }
      // Container-path misuse degrades gracefully. A consumer who cast
      // past the type system to bind v-register at an object or array
      // path gets the `[object Object]` that `String({})` produces.
      // Runtime values carry `Object.prototype`, so `String(raw)` works
      // for normal container shapes, but a null-prototype value (a
      // `defaultValues` literal built with `Object.create(null)`) makes
      // it throw "Cannot convert object to primitive value". The catch
      // falls back to `Object.prototype.toString`, so the directive's
      // mounted hook never propagates that throw into the render (#608).
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
    // typed and cannot carry that `''`, so a blank path presents as
    // `undefined`, the typed-model analog of "displayed empty". A naive
    // numeric component renders `undefined ?? '' === ''`, so a cleared
    // numeric field reads empty in a v-model-bound component exactly as it
    // does in a native input. A filled path presents raw typed storage.
    const hostModelValue = computed(() =>
      state.blankPaths.has(pathKey) ? undefined : innerRef.value
    ) as Readonly<Ref<unknown>>

    // Slim default precomputed at register-time. The schema is fixed for
    // the form's lifetime, so `markBlank` reuses this instead of
    // re-walking the schema tree per call.
    const slimDefault = state.schema.getDefaultAtPath(segments)

    // `true` when the leaf's slim-primitive set includes `'undefined'`,
    // meaning the path was declared `.optional()`. The text-input
    // listener reads it on DOM clear and writes `undefined` rather than
    // `''`, keeping the schema's `.optional()` semantic reachable from
    // the DOM. A number-typed leaf needs no separate path: `slimDefault`
    // for an optional number is already `undefined`.
    const slimTypes = state.schema.getSlimPrimitiveTypesAtPath(segments)
    const acceptsUndefined = slimTypes.has('undefined')
    // `true` when the slim set admits `'string'`. The text-input listener
    // uses the negation: on a DOM clear against a leaf that does NOT
    // admit string (a required `z.number()` rendered as
    // `<input type="text">` without the `.number` modifier), the assigner
    // would reject the empty-string write and the post-write force-sync
    // would snap the DOM back to the stored numeric. Routing through
    // `markBlank` keeps the DOM empty and stages the blank meta for
    // submit-time validation.
    const acceptsString = slimTypes.has('string')

    const transforms = options?.transforms ?? EMPTY_TRANSFORMS

    // Schema-driven coerce closure, capturing the path's slim accept set
    // so the per-event hot path is one call. Identity when the form set
    // `useForm({ coerce: false })` or the path admits no coercion target.
    // Cached on the RegisterValue, so the directive never re-walks the
    // schema per keystroke.
    const coerce = buildCoerceFn(
      state.schema as Parameters<typeof buildCoerceFn>[0],
      segments,
      coerceEnabled
    )
    const coerceElement = buildElementCoerceFn(
      state.schema as Parameters<typeof buildElementCoerceFn>[0],
      segments,
      coerceEnabled
    )

    // Aria wiring baked onto the RegisterValue so the store-less
    // directive drives `aria-*` without a field-state lookup. The ids
    // match `FieldState.aria` exactly, being the same pure derivation.
    // `ariaDisplayState` reuses the form's field-state accessor, so it
    // carries the SAME gated verdict `form.fields.<path>.displayState`
    // shows. A hand-rolled register factory has no accessor to close
    // over, and a binding without `ariaDisplayState` gets no aria wiring.
    const { aria } = computeFieldIdentity(formInstanceId, state.formKey, pathKey)
    const isRequired = state.schema.isRequiredAtPath(segments)
    const ariaDisplayState =
      getDisplayStateAt !== undefined
        ? (computed(() => getDisplayStateAt(segments)) as Readonly<Ref<DisplayState>>)
        : undefined

    // Shared blank-marking op: write the schema's slim default and stage
    // the blank meta so submit-time validation surfaces "No value
    // supplied". The slim default keeps storage well-typed
    // (`getDefaultAtPath` gives 0 for `z.number()`, `''` for
    // `z.string()`, `false` for `z.boolean()`). It sits outside the object
    // literal so the `markBlank` binding (the directive's numeric-clear
    // listener) and `setValueFromHost` (the component-host analog) share
    // one path, and a cleared numeric leaf reaches the same state from a
    // native `<input>` and a v-model component alike.
    const markBlank = (): boolean =>
      state.setValueAtPath(segments, slimDefault, withInstanceMeta({ blank: true }))

    // `shallowReadonly` is what makes `rv.path`, `rv.formKey` and the
    // other top-level fields behave as reactive state inside a wrapper
    // component: property reads track in computeds and watchEffects,
    // mutation is blocked at runtime and in the types, and the inner refs
    // (`innerRef`, `displayValue`, `lastTypedForm`) keep their `Ref`
    // shape so the directive's `.value` reads and writes still work.
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

      ensureDomBinding: (factory: DomBindingFactory): void => {
        // Arm-once per store. The factory arrives from the directive
        // cluster or `useRegister`, the modules that own the DOM
        // machinery, so this eager module never imports it: that is the
        // whole point of the slot. Passing it per call also keeps
        // duplicate-package-copy apps coherent, since whichever copy's
        // cluster runs arms the store its RegisterValue is bound to.
        state.domBinding.value ??= factory(state)
      },

      registerElement: (element: HTMLElement): void => {
        const dom = state.domBinding.value
        if (dom === null) {
          // Reachable only from a custom integration calling
          // `rv.registerElement` directly with neither the directive
          // cluster nor `useRegister` loaded anywhere in the app, where
          // the machinery registration feeds (field.element, the focus
          // walk, blur listeners) is absent too.
          if (__DEV__) {
            warn(
              `[attaform] registerElement('${pathKey}'): no DOM binding is armed for this form. ` +
                `Element registration is delivered by the v-register directive or useRegister(); ` +
                `for a fully manual integration, mount the element through useRegister's ` +
                `registerElement instead.`
            )
          }
          return
        }
        dom.attach(segments, element, formInstanceId, instanceMeta)
      },

      deregisterElement: (element: HTMLElement): void => {
        state.domBinding.value?.detach(segments, element)
      },

      setValueWithInternalPath: (value: unknown, meta?: WriteMeta): boolean => {
        // The write path for custom assigners. A consumer-installed
        // assigner calls `rv.setValueWithInternalPath(value)` and lands in
        // the same funnel, with the same instance meta, as the directive's
        // default assigner. Caller-supplied `meta` passes through.
        return state.setValueAtPath(segments, value, withInstanceMeta(meta))
      },

      setValueFromHost: (value: unknown): boolean => {
        // The write path for a third-party component bound by v-register's
        // compile-time v-model desugar. The host emits its typed model value
        // through `onUpdate:modelValue`, and unlike a native control there
        // is no DOM input listener, so this bundles the value write with
        // markInteracted the way the native input listener pairs the
        // assigner write with noteInteraction. Without it, blur-validation
        // and the reward-early display state would never arm for a
        // v-model-bound component. A real value is authoritative, being the
        // component's resolved model type, so it takes the same
        // no-coercion funnel as setValueWithInternalPath. Mark interacted
        // before the write, so validation the write triggers sees the bit.
        state.markInteracted(segments)
        // Empty-signal normalization, mirroring the native input listener's
        // DOM-clear handling (directive.ts). A component clearing a
        // numeric-only leaf emits an empty signal ('' / null / undefined)
        // that the slim-primitive gate would reject, freezing form state at
        // the old value while the component's DOM shows empty. When the
        // emitted value is one of those signals AND the leaf's slim set does
        // not admit it, route to markBlank: storage lands on the slim
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
        // (fragment) component, so the value channel works while
        // activateComponentHost never ran and the rich FieldState (connected /
        // focus / aria / scroll-to-error) is silently missing. Re-check on the
        // next tick so a component that emits during its own mount, before the
        // directive's mounted runs, does not trip a false positive.
        if (__DEV__) {
          const dedupeKey = `${formInstanceId}:${pathKey}`
          const isWired = (): boolean =>
            (state.domBinding.value?.elements.get(pathKey)?.elements.size ?? 0) > 0 ||
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
        // Directive-only caller (component-host mount / unmount), so the
        // binding is armed by the time this runs. The `?.` covers a
        // hand-dispatched call in a binding-less world, where the anchor
        // it would record has no reader either.
        state.domBinding.value?.markHostConnected(segments, connected, hostEl, formInstanceId)
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
        const record = state.domBinding.value?.elements.get(pathKey)
        if (record === undefined) return false
        for (const element of record.elements) {
          if (hostElement.contains(element)) return true
        }
        return false
      },

      // --- Async transform lifecycle (internal; the directive's deferred
      // orchestrator is the only legitimate consumer). Thin path-bound
      // delegates to the store's per-path token and counter machinery,
      // the same pattern as `markBlank` and `setValueWithInternalPath`, so
      // the directive (which holds this RegisterValue and never the store)
      // can drive the busy / discard / error bookkeeping. ---
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
      // Frozen so a wrapper component can pass `rv.segments` straight to
      // `form.fields(...)` with no defensive copy, and so neither a test
      // fixture nor downstream code can mutate the canonical segment list
      // out from under the directive.
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
      ...(ariaDisplayState !== undefined ? { ariaDisplayState } : {}),
    }
    return shallowReadonly(internalRv) as RegisterValue
  }
}
