import { computed, ref, shallowReadonly, type Ref } from 'vue'
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
import { captureUserCallSite } from './dev-stack-trace'
import { AnonPersistError } from './errors'
import { extractSchemaFields } from './extract-schema-fields'
import { computeFieldIdentity } from './field-ids'
import { INTERACTIVE_TAG_NAMES } from './interactive-tags'
import { canonicalizePath, type Path, type PathKey } from './paths'
import { PERSISTENCE_MODULE_KEY } from './persistence'
import { getOrAssignElementId } from './persistence/opt-in-registry'
import { buildCoerceFn, buildElementCoerceFn, resolveCoercionIndex } from './schema-coerce'

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
  // `meta` so the persist / blank flags ride through unchanged.
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

    const persist = options?.persist === true
    const acknowledgeSensitive = options?.acknowledgeSensitive === true
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

    // Eager throw: opt-in declared but the form has no persistence wired.
    // Without the throw the directive silently records the opt-in, no
    // writes ever land, and the dev concludes "persistence is broken"
    // when the actual issue is a missing `persist:` option on useForm().
    // Throws in dev and prod — contradictions are bugs, not rate-limited
    // drift. The error body carries the schema's top-level fields and a
    // captured call-site frame so the offending form is identifiable
    // from the message alone (script-setup stacks collapse misleadingly).
    //
    // Skipped during SSR: `wirePersistence` is intentionally not run on
    // the server (persistence is a client-only concern), so
    // `state.modules.has(PERSISTENCE_MODULE_KEY)` is always false during
    // SSR — even for forms that DID configure `persist:`. Without this
    // gate the throw would falsely fire on every server-rendered
    // `register({ persist: true })`. The client-side hydration pass
    // re-checks against a freshly-wired module and throws correctly if
    // the misuse is real.
    if (persist && !state.ssr && !state.modules.has(PERSISTENCE_MODULE_KEY)) {
      throw new AnonPersistError({
        cause: 'register-without-config',
        schemaFields: extractSchemaFields(state.schema),
        callSite: captureUserCallSite(),
      })
    }

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

    // Per-RV bound-element reference. Set by `registerElement` (called
    // by the directive's `created` hook and by `syncElementRegistration`
    // on every parent re-render to keep the freshly closed-over RV in
    // step with the underlying DOM node). Cleared by
    // `deregisterElement`. Consulted by `setValueWithInternalPath` to
    // auto-derive persistence meta from the per-element opt-in
    // registry, so a consumer-installed assigner that simply calls
    // `rv.setValueWithInternalPath(value)` participates in the same
    // per-element persistence contract the directive's default assigner
    // honors.
    let boundElement: HTMLElement | null = null

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
      lastTypedForm,

      markBlank: (): boolean => {
        // Mirror the binding's persist meta so the blank
        // mark rides the same persistence channel as user-typed
        // writes — without this, refresh after a clear silently loses
        // the empty state. The slim default keeps storage well-typed
        // (the schema's getDefaultAtPath returns 0 for z.number(), ''
        // for z.string(), false for z.boolean(), etc.).
        return state.setValueAtPath(
          segments,
          slimDefault,
          withInstanceMeta({
            blank: true,
            persist,
          })
        )
      },

      markInteracted: (): void => {
        state.markInteracted(segments)
      },

      registerElement: (element: HTMLElement): void => {
        // Track the bound element on the RV regardless of tag name.
        // The custom-assigner shape (`<div v-register>` + an
        // `el[assignKey]` install) targets a non-form element on
        // purpose; the rv still needs to know which element it was
        // bound to so `setValueWithInternalPath` can auto-derive the
        // per-element persistence meta. Single element per RV: each
        // `form.register('path')` call returns a fresh handle, so the
        // directive's lifecycle never asks one RV to track two
        // elements; last-wins covers the corner case of a consumer who
        // manually re-binds. Closure-private so a consumer can't read
        // it off the public `RegisterValue` surface.
        boundElement = element
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
        // Drop the bound-element reference if it matches the element
        // being torn down. A post-teardown write (e.g. a captured RV
        // ref held by a parent's `onBeforeUnmount` cleanup callback)
        // therefore falls back to the "no auto-meta" path — safe,
        // since the element id has gone out of scope on the WeakMap
        // and the persist gate would drop the write either way.
        if (boundElement === element) boundElement = null
      },

      setValueWithInternalPath: (value: unknown, meta?: WriteMeta): boolean => {
        // Auto-attach persistence meta when the consumer didn't supply
        // their own AND this RV has a bound element. Lets a custom
        // assigner call `rv.setValueWithInternalPath(value)` and have
        // the per-element opt-in registry consulted automatically —
        // the directive's default assigner takes this same path. An
        // explicit `meta` (including `{}` or `{ persist: false }`)
        // opts out of the derivation and passes through unchanged, so
        // the documented "imperative writes via `form.setValue` don't
        // auto-persist" contract is preserved (`form.setValue` calls
        // `state.setValueAtPath` directly, not through RV).
        const resolvedMeta =
          meta === undefined && boundElement !== null
            ? { persist: state.persistOptIns.hasOptIn(getOrAssignElementId(boundElement), pathKey) }
            : meta
        return state.setValueAtPath(segments, value, withInstanceMeta(resolvedMeta))
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

      // --- Persistence opt-in (internal; the directive is the only
      // legitimate consumer) ---
      persist,
      acknowledgeSensitive,
      persistOptIns: state.persistOptIns,
      isSensitivePath: state.isSensitivePath,
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
