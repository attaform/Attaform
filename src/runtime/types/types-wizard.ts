/**
 * Public types for `useWizard` — the multistep-form orchestrator.
 *
 * The wizard is built around an ordered list of step slots. Each slot
 * resolves to a participating form: an existing `useForm` reference, a
 * bare string key (desugared to a noop form so affordance steps
 * participate uniformly), an eagerly-evaluated function slot for
 * runtime branching, or a `defer()`-wrapped function slot whose
 * resolution sticks across re-evaluations.
 *
 * The wizard surface is loosely keyed (`Record<FormKey, …>`).
 * Cross-component flows threaded through `injectWizard` lose lexical
 * key knowledge anyway, so the public read surface is a string-keyed
 * record. Typed per-form access flows back through the original form
 * refs and through `wizard.handleSubmit`'s `ctx.get(formRef)` accessor.
 */

import type { FormKey } from './types-api'

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
export type AggregateError = {
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
 * Internal phantom brand for `DeferMarker`. The runtime brand symbol
 * lives in `core/wizard-defer.ts`; this declaration keeps the marker
 * type unforgeable without circular module imports.
 */
declare const _deferBrand: unique symbol

/**
 * Brand-typed marker returned by `defer((ctx) => …)`. Wrapping a
 * function slot in `defer()` opts that slot into sticky resolution:
 * the slot resolves once on the first compile pass and the result
 * sticks across subsequent re-evaluations, so heavy or one-shot
 * lookups (network-backed factories, expensive derivations) do not
 * fire repeatedly.
 *
 * Construct via the `defer()` helper exported from the same entry as
 * `useWizard`. The marker is opaque at the type level; consumers do
 * not assemble it directly.
 */
export type DeferMarker<Ctx = WizardCtx> = {
  readonly [_deferBrand]: true
  readonly resolve: (ctx: Ctx) => AnyForm | string | undefined
}

/**
 * One position in the source `useWizard({ steps })` array. Each slot
 * resolves to a compiled `{ key, form }` step:
 *
 *  - `AnyForm`         — a form declared via `useForm`. Surfaced as-is.
 *  - `string`          — bare key. The wizard generates a noop form
 *                        under the hood so the external surface stays
 *                        uniform across affordance positions (intro,
 *                        terms, congratulations, review surfaces).
 *  - function          — eager slot, re-evaluates reactively. Returns
 *                        one of the above, or `undefined` to drop the
 *                        slot from the compiled list.
 *  - `DeferMarker`     — sticky function slot (see `defer`).
 */
export type StepSlot<Ctx = WizardCtx> =
  | AnyForm
  | string
  | ((ctx: Ctx) => AnyForm | string | undefined)
  | DeferMarker<Ctx>

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
 * `wizard.handleSubmit(onSubmit, onError?)`. Same shape on every step;
 * `isFinal` distinguishes intermediate vs final calls.
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
 *               `wizard.steps`. Intermediate calls validate the active
 *               form only and advance; final calls validate every form
 *               and stay on the terminal step.
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
 * Receives the aggregate error list — entries originate from per-form
 * validation and activation failures (`atta:activation-failed`). Sync
 * or async; the returned promise gates `wizard.submitting`.
 */
export type WizardOnError = (errors: readonly AggregateError[]) => void | Promise<void>

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
   * omitted) skip the registry and are reachable only via ambient
   * `injectWizard()` from descendants of the parent that called
   * `useWizard`.
   *
   * Duplicate-key registration is first-wins-silently (dev-warn on the
   * second registration) to mirror `useForm`'s shared-key behavior.
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
 * Return shape of `useWizard({ steps, … })`. Every reactive read is a
 * plain getter (no `.value`) — `wizard.currentStep`, `wizard.progress`,
 * `wizard.allValues` track inside `computed` / template effects
 * directly.
 *
 *  - `currentStep` — key of the active step. Always defined (the steps
 *                    array is non-empty by construction).
 *  - `activeForm`  — the active step's form handle. Always defined
 *                    (noop forms cover string slots).
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
 *                    Forward-looking; no dirty tracking under eager
 *                    activation.
 *  - `submitting`  — `true` while a `wizard.handleSubmit` call is in
 *                    flight. Global re-entrance guard: every
 *                    navigation method also refuses while this is on.
 *  - `submissionAttempts` — count of `wizard.handleSubmit` invocations
 *                    (success or failure). Always bumps, including on
 *                    noop-form steps.
 *  - `visited`     — append-only breadcrumb of navigated step keys.
 *                    `back()` does not pop; the trail is the audit
 *                    log, not the back-stack.
 *  - `next/back/goTo` — pure navigation. Refuses while `submitting`.
 *  - `handleSubmit(onSubmit, onError?)` — universal across all steps.
 *                    Intermediate calls validate the active form and
 *                    advance; final calls validate every form. Returns
 *                    an event handler suitable for `<form @submit>` or
 *                    imperative use.
 *  - `reset()`     — zeros wizard lifecycle (`submissionAttempts`,
 *                    `visited`), resets every form, returns
 *                    `currentStep` to `steps[0].key`, and invokes
 *                    `persist` with the cleared state.
 */
export type UseWizardReturnType = {
  readonly key: string | undefined
  readonly currentStep: FormKey
  readonly activeForm: AnyForm
  readonly activeIndex: number
  readonly isFinalStep: boolean
  readonly steps: ReadonlyArray<CompiledStep>
  readonly forms: Readonly<Record<FormKey, AnyForm>>
  readonly count: number
  readonly statuses: WizardStatusesProxy<Record<string, FormStatus>>
  readonly allValues: Readonly<Record<FormKey, unknown>>
  readonly allErrors: Readonly<Record<FormKey, readonly AggregateError[]>>
  readonly progress: number
  readonly canAdvance: boolean
  readonly canGoBack: boolean
  readonly complete: boolean
  readonly submitting: boolean
  readonly submissionAttempts: number
  readonly visited: readonly FormKey[]
  readonly next: () => Promise<void>
  readonly back: () => void
  readonly goTo: (key: string) => void
  readonly handleSubmit: (
    onSubmit: WizardOnSubmit,
    onError?: WizardOnError
  ) => (event?: Event) => Promise<void>
  readonly reset: () => void
}
