/**
 * Public types for `useWizard` — the multistep-form orchestrator.
 *
 * The wizard is built around an ordered list of step slots. Each slot
 * resolves to a participating form: an existing `useForm` reference, a
 * bare string key (desugared to a noop form so affordance steps
 * participate uniformly), an eagerly-evaluated function slot for
 * runtime branching, or a `lazy()`-wrapped function slot that caches
 * its resolution and re-fires only on its own tracked deps.
 *
 * The wizard surface is loosely keyed (`Record<FormKey, …>`).
 * Cross-component flows threaded through `injectWizard` lose lexical
 * key knowledge anyway, so the public read surface is a string-keyed
 * record. Typed per-form access flows back through the original form
 * refs and through `wizard.handleSubmit`'s `ctx.get(formRef)` accessor.
 */

import type { FormKey, UseFormReturnType } from './types-api'
import type { GenericForm } from './types-core'

/**
 * Minimum structural shape the wizard requires from a participating
 * form. Constraining to the full `UseFormReturnType` would force
 * contravariant unification of the storage / read shapes across all
 * steps; the wizard does not care about those — it routes by `key` at
 * runtime and exposes the original form objects untouched.
 */
export type AnyForm = {
  readonly key: FormKey
}

/**
 * Per-form summary surface — what `wizard.statuses[key]` exposes (and
 * what `defaultStatuses` seeds). Distinct from `form.meta`: `FormStatus`
 * is the cross-step rollup optimized for template ergonomics
 * (`{{ wizard.statuses.cargo.valid }}`), while `form.meta` carries the
 * full per-form lifecycle surface.
 *
 * Field semantics:
 *  - `valid` — `form.meta.valid`. `false` while errors exist or while
 *    the first-validation-done gate has not flipped.
 *  - `dirty` — `form.meta.dirty`. `true` once any value differs from
 *    the original defaults.
 *  - `submitted` — `form.meta.submitted`. `true` once a `handleSubmit`
 *    callback has resolved without throwing. A failed submit
 *    (validation or callback rejection) leaves this `false`;
 *    `submissionAttempts > 0` is the "user has tried" signal.
 *  - `errorCount` — `form.meta.errorCount`. Count of active validation
 *    errors (zero when valid).
 *
 * Noop forms generated for string slots surface as default-valid
 * (`{ valid: true, dirty: false, submitted: false, errorCount: 0 }`).
 */
export type FormStatus = {
  readonly valid: boolean
  readonly dirty: boolean
  readonly submitted: boolean
  readonly errorCount: number
}

/**
 * Flat error shape returned per form by `wizard.allErrors[key]`. Each
 * entry carries the formKey + path tuple so consumers can route to the
 * offending field from a wizard-wide error summary.
 */
export type WizardAggregateError = {
  readonly formKey: FormKey
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  readonly code?: string
}

/**
 * Mirror of `form.values`' call-or-read pattern, one level deep.
 * Drillable as `wizard.statuses.cargo.valid` (readable), as
 * `wizard.statuses('cargo')` (callable single-key), or as
 * `wizard.statuses()` (callable no-arg returns the whole record).
 */
export type WizardStatusesProxy<S extends Record<string, FormStatus>> = ((
  key?: keyof S
) => FormStatus | S) &
  Readonly<S>

/**
 * One compiled position in the wizard's flow. The wizard surface
 * exposes an ordered array of these as `wizard.steps`, plus a
 * `wizard.forms` record keyed by `step.key` for direct lookup.
 *
 * String slots in the source `steps` array desugar to noop forms
 * before compilation, so every compiled step carries a `form`
 * regardless of source kind.
 */
export type CompiledStep = {
  readonly key: FormKey
  readonly form: AnyForm
}

/**
 * Shape of a participating form as seen from inside a function slot's
 * `ctx.forms[key]` lookup. Adds `values` to the structural `AnyForm`
 * minimum so routing decisions can read live form state.
 *
 * Values are typed loose because the wizard does not generically thread
 * each step's schema through `ctx.forms`. For typed access inside slot
 * bodies, close over the original form ref instead of routing through
 * `ctx.forms`.
 */
export type WizardCtxForm = AnyForm & {
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Context object passed to function slots in the `steps` array. The
 * `forms` record exposes the wizard's statically-known forms (every
 * top-level `AnyForm` slot plus every noop form synthesized for a
 * top-level string slot). `currentKey` mirrors the live wizard step.
 *
 * Function slots re-evaluate reactively when the values they read
 * mutate (typically `ctx.forms.<key>.values.<path>`). The `forms`
 * accumulator itself is stable across re-evaluations so the slot's
 * lookup identity stays referentially equal. Effectful slot bodies
 * should be avoided; routing decisions live here.
 */
export type WizardCtx = {
  readonly forms: Readonly<Record<FormKey, WizardCtxForm>>
  readonly currentKey: FormKey | undefined
}

/**
 * Internal phantom brand for `LazyMarker`. The runtime brand symbol
 * lives in `core/wizard-lazy.ts`; this declaration keeps the marker
 * type unforgeable without circular module imports.
 */
declare const _lazyBrand: unique symbol

/**
 * Brand-typed marker returned by `lazy((ctx) => …)`. Wrapping a
 * function slot in `lazy()` gives that slot its own memoization cache:
 * the resolver fires once on the first compile pass, and the result
 * stays cached until one of the resolver's own tracked reactive reads
 * changes (or `wizard.reset()` invalidates the cache). Heavy or
 * one-shot lookups (network-backed factories, expensive derivations)
 * do not re-fire because an unrelated slot's deps changed.
 *
 * Construct via the `lazy()` helper exported from the same entry as
 * `useWizard`. The marker is opaque at the type level; consumers do
 * not assemble it directly.
 */
export type LazyMarker<Ctx = WizardCtx> = {
  readonly [_lazyBrand]: true
  readonly resolve: (ctx: Ctx) => AnyForm | string | null | undefined
}

/**
 * One position in the source `useWizard({ steps })` array. Each slot
 * resolves to a compiled `{ key, form }` step, or drops out:
 *
 *  - `AnyForm`         — a form declared via `useForm`. Surfaced as-is.
 *  - `string`          — bare key. The wizard generates a noop form
 *                        under the hood so the external surface stays
 *                        uniform across affordance positions (intro,
 *                        terms, congratulations, review surfaces).
 *  - `null` / `undefined` — a literal absence, dropped from the compiled
 *                        list. Lets a conditional step read inline as
 *                        `cond ? form : null` without pre-filtering the
 *                        array.
 *  - function          — eager slot, re-evaluates reactively. Returns
 *                        one of the above, or `null` / `undefined` to
 *                        drop the slot from the compiled list.
 *  - `LazyMarker`      — memoized function slot (see `lazy`).
 */
export type StepSlot<Ctx = WizardCtx> =
  | AnyForm
  | string
  | null
  | undefined
  | ((ctx: Ctx) => AnyForm | string | null | undefined)
  | LazyMarker<Ctx>

/**
 * Shape returned by the `restore` callback. Carries the active step's
 * key; intentionally open-ended (object form) so future additions land
 * without a callback-signature break.
 */
export type WizardRestoreState = {
  readonly step?: FormKey
}

/**
 * `restore` callback signature. Invoked at construction and watched
 * reactively via `watchEffect` so external state changes (browser
 * back/forward, cross-tab events, route changes) re-apply through the
 * wizard. Returning `undefined` falls through to the first step.
 */
export type WizardRestoreFn = () => WizardRestoreState | undefined

/**
 * `persist` callback signature. Invoked whenever `wizard.currentStep`
 * changes; the wizard diffs against the last persisted value to break
 * the restore-persist loop, so the callback only fires when the active
 * step actually moves.
 */
export type WizardPersistFn = (state: WizardRestoreState) => void

/**
 * Submit context passed to the `onSubmit` callback registered via
 * `wizard.handleSubmit(onSubmit, onError?)`. `handleSubmit` always
 * processes the whole step list, so `values` carries every form's
 * parsed output regardless of which step fired the submit.
 *
 *  - `values` — namespaced aggregate keyed by form key, mirroring
 *               `wizard.allValues`. Reflects parsed output for every
 *               form whose validation has settled; noops contribute an
 *               empty record.
 *  - `get(form)` — typed accessor that reads the parsed output for a
 *               specific form ref. Works across cross-component graphs
 *               because the form ref carries its schema info.
 *  - `currentKey` — key of the step that fired this submission.
 *  - `isFinal`   — `true` when `currentKey` is the last position in
 *               `wizard.steps`. Positional only: it reports where the
 *               submit fired, never what got validated. A user who steps
 *               back, edits, and submits from the middle sees
 *               `isFinal === false`, yet the whole list is still
 *               processed and `done` still latches on success.
 */
export type WizardSubmitContext = {
  readonly values: Readonly<Record<FormKey, unknown>>
  readonly get: <F extends AnyForm>(form: F) => F extends { readonly values: infer V } ? V : unknown
  readonly currentKey: FormKey
  readonly isFinal: boolean
}

/**
 * `onSubmit` callback registered via `wizard.handleSubmit`. Sync or
 * async; the returned promise gates `wizard.submitting`.
 */
export type WizardOnSubmit = (ctx: WizardSubmitContext) => void | Promise<void>

/**
 * Optional `onError` callback registered via `wizard.handleSubmit`.
 * Receives the aggregate error list spanning EVERY step (handleSubmit
 * validates the whole wizard), so a failed submit surfaces every form's
 * errors at once, not just the active step's. Entries originate from
 * per-form validation, activation failures (`atta:activation-failed`),
 * and a submit callback that left errors on a processed step (the
 * `setErrors(...); return` server-rejection path). Sync or async; the
 * returned promise gates `wizard.submitting`.
 */
export type WizardOnError = (errors: readonly WizardAggregateError[]) => void | Promise<void>

/**
 * Options for `useWizard({ steps, … })`. `steps` is the only required
 * field; the rest are optional and default sensibly for the common
 * URL-synchronized wizard case.
 */
export type WizardOptions = {
  /**
   * Ordered list of slots that compile into the wizard's positional
   * step list. See `StepSlot` for the per-slot shape contract.
   */
  readonly steps: ReadonlyArray<StepSlot>
  /**
   * Identifier used to register the wizard handle in the per-app
   * registry. Descendant components call `injectWizard(key)` to reach
   * the same wizard without prop-threading. Anonymous wizards (option
   * omitted) get a synthetic `__atta:anon-wizard:<id>` key resolved
   * via `useId()` so SSR-rendered and client-hydrated trees agree on
   * the same registry entry; the synthetic key is opaque and
   * descendants reach an anonymous wizard via ambient `injectWizard()`
   * rather than by key.
   *
   * Duplicate-key registration is first-wins-silently (dev-warn on the
   * second registration) to mirror `useForm`'s shared-key behavior.
   * The dev-warn fires only for explicit keys — two anonymous wizards
   * are guaranteed distinct synthetic keys, so the warning never
   * misfires on independent anonymous wizards on the same page.
   */
  readonly key?: string
  /**
   * Seed status payload used while a form is pre-resolved (async
   * `defaultValues` in flight, or wizard-deferred non-current).
   * Mirrors `defaultValues`' trichotomy: plain object, sync factory,
   * or async factory.
   *
   * Status resolution priority per form:
   *   1. `store.defaultsResolved === true` → derive from `form.meta`
   *   2. else noop form → built-in always-valid status
   *   3. else seed value for this key → frozen seed
   *   4. else → pending sentinel
   *
   * Unknown keys in the seed object dev-warn so a stale resume payload
   * surfaces at construction.
   */
  readonly defaultStatuses?:
    | Record<string, FormStatus>
    | (() => Record<string, FormStatus>)
    | (() => Promise<Record<string, FormStatus>>)
  /**
   * Optional progress override. When omitted, the wizard exposes
   * `progress` as `valid_step_count / count` (normalised to `[0, 1]`).
   * When provided, the returned number is used as-is — the consumer is
   * responsible for any normalisation.
   *
   * The override is invoked inside a Vue `computed` so it must be
   * synchronous and may only read reactive sources.
   */
  readonly progress?: (steps: ReadonlyArray<CompiledStep>) => number
  /**
   * When `wizard.handleSubmit` finds errors, automatically focus the
   * first failing form: jump to its step and invoke its
   * `applyInvalidSubmitPolicy()` (focus / scroll per the form's own
   * `onInvalidSubmit` configuration). Default `true`; pass `false` to
   * keep the active step where the user left it and handle navigation
   * manually in the `onError` callback.
   */
  readonly focusFirstError?: boolean
  /**
   * Source of truth for the active step. Invoked at construction and
   * re-evaluated reactively via `watchEffect`. Default callback reads
   * `?step=<key>` from the URL via `wizard-history.ts`; pass `false`
   * to disable URL sync, or provide a custom callback for non-router
   * persistence (localStorage, broadcast channel, etc.).
   */
  readonly restore?: WizardRestoreFn | false
  /**
   * Destination for the active step. Invoked whenever `currentStep`
   * changes, with a diff check to break the restore-persist loop.
   * Default callback writes `?step=<key>` via `wizard-history.ts`;
   * pass `false` to disable persistence, or provide a custom callback
   * to scope the param name or write to alternate storage.
   */
  readonly persist?: WizardPersistFn | false
}

/**
 * True when a single slot is guaranteed to contribute exactly one
 * compiled step: a bare form or affordance string that is neither
 * nullish nor a (maybe-absent) function / `lazy()` slot. One of these
 * anywhere in the tuple proves the compiled list is non-empty.
 */
type IsGuaranteedStep<T> = [null] extends [T]
  ? false
  : [undefined] extends [T]
    ? false
    : T extends LazyMarker | ((...args: unknown[]) => unknown)
      ? false
      : T extends string
        ? true
        : T extends { readonly key: string }
          ? true
          : false

/**
 * Predicate: is the steps tuple statically guaranteed to compile to a
 * non-empty list? True when at least one element is a guaranteed step
 * (see `IsGuaranteedStep`). Function / `lazy()` slots may resolve to
 * nothing, and `null` / `undefined` (a literal absence or a
 * `cond ? form : null` union) is an explicit drop, so none of those
 * prove non-emptiness; a tuple of only maybe-absent slots stays
 * honestly `| undefined`.
 *
 * Used to narrow `currentStep` / `activeForm` to their non-`undefined`
 * shapes in the common-case wizard, while keeping the honest union
 * everywhere a runtime drop is reachable.
 */
export type StaticallyNonEmpty<S> = S extends readonly [infer First, ...infer Rest]
  ? IsGuaranteedStep<First> extends true
    ? true
    : StaticallyNonEmpty<Rest>
  : false

/** Active step's key, narrowed to `string` when `S` is statically safe. */
export type CurrentStepOf<S> = StaticallyNonEmpty<S> extends true ? FormKey : FormKey | undefined

/**
 * Active step's form handle, schema-erased to `UseFormReturnType<GenericForm>`
 * and narrowed to non-`undefined` when `S` is statically safe. The runtime
 * value is a live facade over the active step, so reads (`.values`, `.meta`,
 * `.history`) and `.handleSubmit` always target the current step. Values are
 * loose here because the active step's schema is not statically known; reach
 * for the original form ref or `ctx.get(ref)` when you need typed per-step
 * values.
 */
export type ActiveFormOf<S> =
  StaticallyNonEmpty<S> extends true
    ? UseFormReturnType<GenericForm>
    : UseFormReturnType<GenericForm> | undefined

/**
 * Per-slot contribution to {@link FormsRecordOf}. Strips a `null` /
 * `undefined` (a literal absence or a `cond ? form : null` union) off the
 * slot first, so a conditionally-present form still maps to its key and
 * stays concretely typed on `wizard.forms`; a purely nullish slot
 * contributes nothing.
 */
type SlotRecord<First, F = Exclude<First, null | undefined>> = [F] extends [never]
  ? unknown
  : F extends string
    ? { readonly [P in F]: AnyForm }
    : F extends { readonly key: infer K extends string }
      ? { readonly [P in K]: F }
      : unknown

/**
 * Recursive tuple walk that builds the static portion of
 * `wizard.forms`. Each step slot contributes to the record:
 *
 *  - **String slot** (`'review'`): the literal becomes the record key
 *    and the value is `AnyForm` (the noop form synthesized for the
 *    affordance position is opaque at the type level).
 *  - **Form slot** (a `useForm` reference with a literal `key` field):
 *    the form's own `key` becomes the record key, and the value is
 *    the concrete form handle type — so drilling
 *    `wizard.forms.shipping.values.address` carries the schema-derived
 *    field types through. A form kept behind a `cond ? form : null`
 *    conditional still maps to its key.
 *  - **`null` / `undefined` slot**: contributes nothing.
 *  - **Function / `lazy()` slot**: contributes nothing to the static
 *    map. Runtime-resolved forms are still reachable via the
 *    catch-all index signature on `WizardForms` (typed as `AnyForm`).
 *
 * Recursion is bounded by the tuple length; real-world wizards land
 * well below the TS instantiation budget.
 */
export type FormsRecordOf<S> = S extends readonly [
  infer First,
  ...infer Rest extends ReadonlyArray<StepSlot>,
]
  ? SlotRecord<First> & FormsRecordOf<Rest>
  : unknown

/**
 * `wizard.forms` typed view. Combines the static per-step type map
 * with a catch-all `Record<FormKey, AnyForm>` fallback so:
 *
 *   - Statically known slot keys → concrete form type via `FormsRecordOf`
 *   - Any other string key → `AnyForm` via the index signature
 *
 * The intersection collapses to the concrete form for statically
 * known keys (because the concrete form type extends `AnyForm`) and
 * to `AnyForm` for unknown keys.
 */
export type WizardForms<S> = FormsRecordOf<S> & Readonly<Record<FormKey, AnyForm>>

/**
 * Return shape of `useWizard({ steps, … })`. Every reactive read is a
 * plain getter (no `.value`) — `wizard.currentStep`, `wizard.progress`,
 * `wizard.allValues` track inside `computed` / template effects
 * directly.
 *
 * Parameterized by the steps tuple `S` so active-position fields
 * (`currentStep`, `activeForm`) narrow to non-undefined for the common
 * case (all positional Form / string slots) and stay as honest unions
 * when a function or `lazy()` slot can drop the compiled position at
 * runtime. The `const` type parameter on `useWizard` preserves literal
 * tuple types without consumer-side `as const`, so the narrowing
 * happens automatically from the call site.
 *
 *  - `currentStep` — key of the active step. Narrows to `string` when
 *                    the steps tuple is statically guaranteed to
 *                    compile to a non-empty list (all positional
 *                    Form / string slots, no function or `lazy()`
 *                    slots). Otherwise reads as `string | undefined`
 *                    so the degenerate case (empty list at runtime)
 *                    surfaces honestly.
 *  - `activeForm`  — a LIVE view of the active step's form. Operating
 *                    through it always targets the current step, so a
 *                    handler captured once at setup
 *                    (`wizard.activeForm.handleSubmit(() =>
 *                    wizard.next())`) retargets as the wizard advances.
 *                    No longer `===` the raw per-step handle; reach for
 *                    `wizard.forms[key]` when you need raw identity.
 *                    Same `undefined` narrowing as `currentStep`. Noop
 *                    forms cover string slots in the normal path.
 *  - `activeIndex` — 0-based position of the active step.
 *  - `isFinalStep` — `true` when `currentStep === steps[count - 1].key`.
 *  - `steps`       — ordered list of compiled `{ key, form }` slots.
 *  - `forms`       — record indexable by step key; the value is the
 *                    full form handle resolved for that slot.
 *  - `count`       — `steps.length`.
 *  - `statuses`    — callable readonly proxy over the per-key
 *                    `FormStatus` record. Noop-form keys always read
 *                    as default-valid.
 *  - `allValues`   — namespaced aggregate of each form's values, keyed
 *                    by step key.
 *  - `allErrors`   — namespaced aggregate of each form's validation
 *                    errors, keyed by step key. Noop forms map to an
 *                    empty list.
 *  - `progress`    — normalised step-validity ratio (or the consumer's
 *                    `progress` override). Forward-looking: noops count
 *                    as always-valid.
 *  - `canAdvance`  — `true` when `activeIndex < count - 1`. Pure
 *                    positional check; navigation never gates on
 *                    validity.
 *  - `canGoBack`   — `true` when `activeIndex > 0`.
 *  - `complete`    — `isFinalStep && every step's form is valid`.
 *                    Forward-looking; reactive to current form
 *                    validity. Gates "Finish button enable" style UI.
 *  - `done`        — monotonic latch: flips `true` the first time a
 *                    `handleSubmit` resolves without throwing AND leaves
 *                    no errors set on any step, and stays `true` through
 *                    subsequent edits or invalidations. A callback that
 *                    calls `setErrors` and returns (the documented
 *                    server-rejection path) is a failed submit, so it
 *                    does not flip `done`. Only `reset()` flips it back.
 *                    Gates "show success card" style UI that should
 *                    reflect submission history rather than current
 *                    validity.
 *  - `submitting`  — `true` while a `wizard.handleSubmit` call is in
 *                    flight. Global re-entrance guard: every
 *                    navigation method also refuses while this is on.
 *  - `submissionAttempts` — count of `wizard.handleSubmit` invocations
 *                    (success or failure). Always bumps, including on
 *                    noop-form steps.
 *  - `submitError` — the error THROWN by the most recent
 *                    `wizard.handleSubmit` callback (or its `onError`),
 *                    coerced to a real `Error`. Mirrors
 *                    `form.meta.submitError`: this is the unexpected-throw
 *                    channel, so an expected rejection handled via
 *                    `setErrors` (no throw) surfaces through the error
 *                    surface and `onError` instead, leaving this `null`.
 *                    Cleared at submit entry and by `reset()`, parked here
 *                    rather than re-thrown, so the handler resolves and
 *                    never manufactures a `window` unhandledrejection.
 *                    `null` on success.
 *  - `visited`     — append-only breadcrumb of navigated step keys.
 *                    `back()` does not pop; the trail is the audit
 *                    log, not the back-stack.
 *  - `next/back/goTo` — pure navigation. Refuses while `submitting`.
 *  - `tryNext()`   — validate the active step, then advance iff it
 *                    passed; invalid input keeps the pin put under the
 *                    form's standard error reveal (first error focused,
 *                    display state advanced). The inline-bindable
 *                    shorthand for `activeForm.handleSubmit(() =>
 *                    next())`. Resolves to whether the pin moved. No-ops
 *                    to `false` on a degenerate or final-step wizard
 *                    (finish via `handleSubmit`).
 *  - `handleSubmit(onSubmit, onError?)` — always validates the entire
 *                    step list, from any step, and never advances the
 *                    pin: on success it latches `done`; on any error it
 *                    focuses the first failing step and fires `onError`
 *                    with errors spanning every step. To gate advancing
 *                    a step on its own validity, compose with the active
 *                    form's submit: `activeForm.handleSubmit(() =>
 *                    wizard.next())`. Returns an event handler suitable
 *                    for `<form @submit>` or imperative use.
 *  - `reset()`     — zeros wizard lifecycle (`submissionAttempts`,
 *                    `visited`), resets every form, returns
 *                    `currentStep` to `steps[0].key`, and invokes
 *                    `persist` with the cleared state.
 */
export type UseWizardReturnType<S extends ReadonlyArray<StepSlot> = ReadonlyArray<StepSlot>> = {
  readonly key: string
  readonly currentStep: CurrentStepOf<S>
  readonly activeForm: ActiveFormOf<S>
  readonly activeIndex: number
  readonly isFinalStep: boolean
  readonly steps: ReadonlyArray<CompiledStep>
  readonly forms: WizardForms<S>
  readonly count: number
  readonly statuses: WizardStatusesProxy<Record<string, FormStatus>>
  readonly allValues: Readonly<Record<FormKey, unknown>>
  readonly allErrors: Readonly<Record<FormKey, readonly WizardAggregateError[]>>
  readonly progress: number
  readonly canAdvance: boolean
  readonly canGoBack: boolean
  readonly complete: boolean
  readonly done: boolean
  readonly submitting: boolean
  readonly submissionAttempts: number
  readonly submitError: Error | null
  readonly visited: readonly FormKey[]
  readonly next: () => Promise<void>
  readonly back: () => void
  readonly goTo: (key: string) => void
  readonly tryNext: () => Promise<boolean>
  readonly handleSubmit: (
    onSubmit: WizardOnSubmit,
    onError?: WizardOnError
  ) => (event?: Event) => Promise<void>
  readonly reset: () => void
}
