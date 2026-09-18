/**
 * Public types for `useWizard`, the multistep-form orchestrator.
 *
 * A wizard is an ordered list of step slots. Each slot resolves to a
 * participating form: a `useForm` reference, a bare string key
 * (desugared to a noop form so affordance steps participate
 * uniformly), a function slot for runtime branching, or a `lazy()`
 * function slot that caches its resolution.
 *
 * The read surface is string-keyed (`Record<FormKey, ...>`), because a
 * flow threaded through `injectWizard` has no lexical key knowledge.
 * Typed per-form access flows back through the original form refs and
 * through `wizard.handleSubmit`'s `ctx.get(formRef)` accessor.
 */

import type { FormKey, UseFormReturnType } from './types-api'
import type { GenericForm } from './types-core'

/**
 * Minimum shape the wizard requires from a participating form. The
 * wizard routes by `key` at runtime and hands back the original form
 * objects untouched, so it never constrains their value shapes.
 */
export type AnyForm = {
  readonly key: FormKey
}

/**
 * Per-form summary at `wizard.statuses[key]`, and what `defaultStatuses`
 * seeds. This is the cross-step rollup built for templates
 * (`{{ wizard.statuses.cargo.valid }}`); `form.meta` carries the full
 * per-form lifecycle surface.
 *
 * A noop form generated for a string slot reads as default-valid,
 * unless that slot is a `gate('...')`, whose `gate` tracks the
 * in-session acknowledgment.
 */
export type FormStatus = {
  /** `form.meta.valid`. `false` while errors exist, or before the first validation pass. */
  readonly valid: boolean
  /** `form.meta.dirty`. `true` once any value differs from the original defaults. */
  readonly dirty: boolean
  /**
   * `form.meta.submitted`. `true` once a `handleSubmit` callback has
   * resolved without throwing. A failed submit leaves it `false`;
   * `submissionAttempts > 0` is the "user has tried" signal.
   */
  readonly submitted: boolean
  /** `form.meta.errorCount`. Active validation errors, zero when valid. */
  readonly errorCount: number
  /**
   * `true` when this step sits after an uncleared gate: its form is
   * frozen and navigation to it is refused, so a stepper can render it
   * as unreachable.
   *
   * Orthogonal to `gate`. The first uncleared gate reads
   * `locked: false`, since you must reach it to clear it; a later gate
   * sealed behind it reads both `gate: 'uncleared'` and `locked: true`.
   */
  readonly locked: boolean
  /**
   * This step's own role as a hard prerequisite. `null` when the step is
   * not a `gate()`, `'uncleared'` while its form is unconfirmed (so it
   * seals every later step), `'cleared'` once confirmed by a clean
   * submit or seeded via `defaultStatuses`.
   *
   * Reflects the live compiled shape, so a conditional `gate()` that a
   * function slot drops resolves to `null`.
   */
  readonly gate: 'cleared' | 'uncleared' | null
}

/**
 * Seed accepted by `useWizard({ defaultStatuses })`. An omitted field
 * falls back to the pending sentinel on read.
 *
 * `locked` is not accepted: it is derived live from the wizard's gates
 * and overlaid on every status read, so a seeded value would be ignored.
 */
export type FormStatusSeed = {
  readonly valid?: boolean
  readonly dirty?: boolean
  readonly submitted?: boolean
  readonly errorCount?: number
  /**
   * Write-only, and not echoed back on read. `'cleared'` latches the
   * gate's cleared state once at construction, for restoring a
   * confirmed prerequisite; the live `gate` overlay then owns the read.
   * `'uncleared'` is the default and seeds nothing. Only a step that
   * compiles to a `gate()` honors it.
   */
  readonly gate?: 'cleared' | 'uncleared'
}

/**
 * One error from `wizard.allErrors[key]`. Carries the formKey and path
 * so a wizard-wide error summary can route to the offending field.
 */
export type WizardAggregateError = {
  readonly formKey: FormKey
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  readonly code?: string
}

/**
 * The per-key `FormStatus` record, readable three ways:
 * `wizard.statuses.cargo.valid`, `wizard.statuses('cargo')`, or
 * `wizard.statuses()` for the whole record.
 */
export type WizardStatusesProxy<S extends Record<string, FormStatus>> = ((
  key?: keyof S
) => FormStatus | S) &
  Readonly<S>

/**
 * One compiled position in the flow, as exposed by `wizard.steps`.
 * String slots desugar to noop forms before compilation, so every
 * compiled step carries a `form` whatever its source kind.
 */
export type CompiledStep = {
  readonly key: FormKey
  readonly form: AnyForm
}

/**
 * A participating form as seen from a function slot's `ctx.forms[key]`.
 * Adds `values` to `AnyForm` so routing decisions can read live state.
 *
 * Values are loose here. For typed access inside a slot body, close
 * over the original form ref instead of routing through `ctx.forms`.
 */
export type WizardCtxForm = AnyForm & {
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Context passed to function slots in the `steps` array. `forms` holds
 * the statically-known forms: every top-level `AnyForm` slot plus every
 * noop form synthesized for a top-level string slot.
 *
 * Function slots re-evaluate reactively when the values they read
 * mutate, typically `ctx.forms.<key>.values.<path>`. The `forms`
 * accumulator keeps its identity across re-evaluations. Keep slot
 * bodies free of side effects; they are routing decisions.
 */
export type WizardCtx = {
  readonly forms: Readonly<Record<FormKey, WizardCtxForm>>
  readonly currentKey: FormKey | undefined
}

/**
 * What a function slot or a `lazy()` / `gate()` resolver may yield: a
 * participating form, a bare affordance key, a nested `lazy()` /
 * `gate()` wrapper (so the two compose in either order), or `null` /
 * `undefined` to drop the position from the compiled list.
 */
export type SlotResolution<Ctx = WizardCtx> =
  AnyForm | string | null | undefined | LazyMarker<Ctx> | GateMarker

/**
 * Phantom brand for `LazyMarker`. The runtime brand symbol lives in
 * `core/wizard-lazy.ts`; this declaration keeps the marker unforgeable
 * without a circular import.
 */
declare const _lazyBrand: unique symbol

/**
 * Marker returned by `lazy((ctx) => ...)`, which gives a function slot
 * its own memoization cache: the resolver fires once on the first
 * compile pass and stays cached until one of its own tracked reactive
 * reads changes, or `wizard.reset()` invalidates it. An unrelated
 * slot's deps changing does not re-fire it, so heavy or one-shot
 * lookups stay one-shot.
 *
 * Construct via the `lazy()` helper exported alongside `useWizard`. The
 * marker is opaque; consumers do not assemble it directly.
 */
export type LazyMarker<Ctx = WizardCtx> = {
  readonly [_lazyBrand]: true
  readonly resolve: (ctx: Ctx) => SlotResolution<Ctx>
}

/**
 * Phantom brand for `GateMarker`. The runtime brand symbol lives in
 * `core/wizard-gate.ts`; this declaration keeps the marker unforgeable
 * without a circular import.
 */
declare const _gateBrand: unique symbol

/**
 * Marker returned by `gate(step)`, which makes a slot a hard
 * prerequisite: an uncleared gate seals every step after it, and the
 * gate's own form is the only way past. A gate clears on a member
 * form's clean submit (confirmation), never on a value merely going
 * valid (intent), and its form freezes once cleared so a back
 * navigation is a read-only review.
 *
 * `Inner` carries the wrapped slot's static type, so `gate` is
 * transparent to the type machinery: `gate(form)` still contributes the
 * form's key to `wizard.forms` and still counts as a guaranteed step,
 * while `gate(lazy(fn))` stays maybe-absent exactly like the lazy slot
 * it wraps. See {@link UnwrapGate}.
 *
 * Construct via the `gate()` helper exported alongside `useWizard`. The
 * marker is opaque; consumers do not assemble it directly.
 */
export type GateMarker<Inner = unknown> = {
  readonly [_gateBrand]: true
  readonly inner: Inner
}

/**
 * Strip every `gate()` wrapper off a slot type. A gate changes runtime
 * reachability, never the compiled type, so the forms map and the
 * non-empty-tuple predicate both unwrap before inspecting a slot.
 * Recursive, which is what makes `gate(lazy(s))` and
 * `lazy((ctx) => gate(s))` agree at the type level as they do at
 * runtime.
 */
export type UnwrapGate<T> = T extends GateMarker<infer Inner> ? UnwrapGate<Inner> : T

/**
 * One position in the source `useWizard({ steps })` array. Each slot
 * compiles to a `{ key, form }` step, or drops out:
 *
 *  - `AnyForm`: a form declared via `useForm`. Surfaced as-is.
 *  - `string`: a bare key. The wizard generates a noop form so
 *    affordance positions (intro, terms, review, congratulations) look
 *    the same from outside as real steps.
 *  - `null` / `undefined`: dropped from the compiled list, so a
 *    conditional step reads inline as `cond ? form : null`.
 *  - function: eager slot, re-evaluated reactively. Returns a
 *    `SlotResolution`, or nullish to drop the position.
 *  - `LazyMarker`: memoized function slot, see `lazy`.
 *  - `GateMarker`: hard-prerequisite wrapper, see `gate`. Wraps any of
 *    the above.
 */
export type StepSlot<Ctx = WizardCtx> =
  | AnyForm
  | string
  | null
  | undefined
  | ((ctx: Ctx) => SlotResolution<Ctx>)
  | LazyMarker<Ctx>
  | GateMarker

/** What the `restore` callback returns: the key of the step to activate. */
export type WizardRestoreState = {
  readonly step?: FormKey
}

/**
 * `restore` callback. Invoked at construction and watched reactively,
 * so browser back/forward, cross-tab events and route changes re-apply
 * through the wizard. Returning `undefined` falls through to the first
 * step.
 */
export type WizardRestoreFn = () => WizardRestoreState | undefined

/**
 * `persist` callback. Invoked when `wizard.currentStep` actually moves;
 * the wizard diffs against the last persisted value to break the
 * restore-persist loop.
 */
export type WizardPersistFn = (state: WizardRestoreState) => void

/**
 * Context passed to the `onSubmit` registered via
 * `wizard.handleSubmit`. That call always processes the whole step
 * list, so `values` carries every form's parsed output no matter which
 * step fired the submit.
 */
export type WizardSubmitContext = {
  /**
   * Namespaced aggregate keyed by form key, mirroring
   * `wizard.allValues`. Noop forms contribute an empty record.
   */
  readonly values: Readonly<Record<FormKey, unknown>>
  /**
   * Typed parsed output for a specific form ref. Works across
   * cross-component graphs, because the ref carries its own schema.
   */
  readonly get: <F extends AnyForm>(form: F) => F extends { readonly values: infer V } ? V : unknown
  /** Key of the step that fired this submission. */
  readonly currentKey: FormKey
  /**
   * `true` when `currentKey` is the last position in `wizard.steps`.
   * Positional only: it reports where the submit fired, never what got
   * validated. A user who steps back, edits and submits from the middle
   * sees `false`, yet the whole list is still processed and `done` still
   * latches on success.
   */
  readonly isFinal: boolean
}

/**
 * `onSubmit` registered via `wizard.handleSubmit`. Sync or async; the
 * returned promise gates `wizard.submitting`.
 */
export type WizardOnSubmit = (ctx: WizardSubmitContext) => void | Promise<void>

/**
 * Optional `onError` registered via `wizard.handleSubmit`. Receives
 * errors spanning EVERY step, since `handleSubmit` validates the whole
 * wizard, so a failed submit surfaces every form's errors at once
 * rather than only the active step's. Entries come from per-form
 * validation, activation failures (`atta:activation-failed`), and a
 * submit callback that left errors on a processed step via the
 * `setErrors(...); return` server-rejection path. Sync or async; the
 * returned promise gates `wizard.submitting`.
 */
export type WizardOnError = (errors: readonly WizardAggregateError[]) => void | Promise<void>

/** Options for `useWizard({ steps, ... })`. Only `steps` is required. */
export type WizardOptions = {
  /**
   * Ordered list of slots that compile into the positional step list.
   * See `StepSlot` for the per-slot contract.
   */
  readonly steps: ReadonlyArray<StepSlot>
  /**
   * Identifier this wizard registers under, so descendants reach it
   * with `injectWizard(key)` instead of prop-threading. Omit it and the
   * wizard gets a synthetic key from `useId()`, so the server-rendered
   * and client-hydrated trees agree on one registry entry; that key is
   * opaque, and descendants reach an anonymous wizard through ambient
   * `injectWizard()`.
   *
   * Registering a key twice is first-wins, with a dev warning on the
   * second, mirroring `useForm`. The warning fires only for explicit
   * keys, since two anonymous wizards are always given distinct keys.
   */
  readonly key?: string
  /**
   * Seed statuses used while a form is still pre-resolved: async
   * `defaultValues` in flight, or a wizard-deferred non-current step.
   * Mirrors `defaultValues`' trichotomy of plain object, sync factory
   * or async factory.
   *
   * Per form, the first of these that applies wins:
   *   1. defaults resolved, so derive from `form.meta`
   *   2. noop form, so the built-in always-valid status
   *   3. a seed for this key
   *   4. the pending sentinel
   *
   * `gate: 'cleared'` is honored as a one-shot seed of the gate's
   * cleared latch at construction, for restoring a confirmed
   * prerequisite, and only on a step that compiles to a `gate()`. See
   * `FormStatusSeed` for what the seed does and does not carry.
   *
   * SSR note: an async factory resolves after hydration, so a gate
   * seeded through it clears client-side. For a gate that must render
   * open on the first server byte, use the plain or sync-factory form
   * and resolve server truth in the page's `setup` await.
   *
   * Unknown keys dev-warn, so a stale resume payload surfaces at
   * construction.
   *
   * A factory that throws, or a promise that rejects, seeds nothing and
   * reports once in development, the same as omitting the option.
   */
  readonly defaultStatuses?:
    | Record<string, FormStatusSeed>
    | (() => Record<string, FormStatusSeed>)
    | (() => Promise<Record<string, FormStatusSeed>>)
  /**
   * Override for `wizard.progress`. Omitted, progress is
   * `valid_step_count / count`, normalised to `[0, 1]`. Provided, the
   * returned number is used as-is and normalising it is yours to do.
   *
   * Invoked inside a `computed`, so it must be synchronous and may only
   * read reactive sources. A throw falls back to the built-in ratio and
   * reports once in development.
   */
  readonly progress?: (steps: ReadonlyArray<CompiledStep>) => number
  /**
   * When `wizard.handleSubmit` finds errors, jump to the first failing
   * form's step and invoke its `applyInvalidSubmitPolicy()`, which
   * honors that form's own `focusOnInvalidSubmit` choice. Default
   * `true`. Pass `false` to leave the active step where the user left
   * it and navigate yourself from `onError`.
   */
  readonly focusFirstError?: boolean
  /**
   * Source of truth for the active step, invoked at construction and
   * re-evaluated reactively. The default reads `?step=<key>` from the
   * URL. Pass `false` to disable URL sync, or your own callback for
   * non-router persistence.
   *
   * A throw yields no step, so the wizard stays where it is, and reports
   * once in development.
   */
  readonly restore?: WizardRestoreFn | false
  /**
   * Destination for the active step, invoked whenever `currentStep`
   * moves. The default writes `?step=<key>`. Pass `false` to disable
   * persistence, or your own callback to scope the param name or write
   * elsewhere.
   *
   * A throw does not block the navigation that triggered it, so the step
   * is live but unrecorded, and reports once in development.
   */
  readonly persist?: WizardPersistFn | false
}

/**
 * True when a slot is guaranteed to contribute exactly one compiled
 * step: a bare form or affordance string, neither nullish nor a
 * maybe-absent function / `lazy()` slot. One of these anywhere in the
 * tuple proves the compiled list is non-empty.
 */
type IsGuaranteedStep<T, U = UnwrapGate<T>> = [null] extends [U]
  ? false
  : [undefined] extends [U]
    ? false
    : U extends LazyMarker | ((...args: unknown[]) => unknown)
      ? false
      : U extends string
        ? true
        : U extends { readonly key: string }
          ? true
          : false

/**
 * Is the steps tuple statically guaranteed to compile to a non-empty
 * list? True when at least one element is an `IsGuaranteedStep`.
 * Function and `lazy()` slots may resolve to nothing, and nullish slots
 * are an explicit drop, so a tuple of only those stays honestly
 * `| undefined`.
 *
 * This is what narrows `currentStep` and `activeForm` in the
 * common-case wizard while keeping the union wherever a runtime drop is
 * reachable.
 */
export type StaticallyNonEmpty<S> = S extends readonly [infer First, ...infer Rest]
  ? IsGuaranteedStep<First> extends true
    ? true
    : StaticallyNonEmpty<Rest>
  : false

/** Active step's key, narrowed to `string` when `S` is statically safe. */
export type CurrentStepOf<S> = StaticallyNonEmpty<S> extends true ? FormKey : FormKey | undefined

/**
 * Active step's form handle, schema-erased to
 * `UseFormReturnType<GenericForm>` and narrowed to non-`undefined` when
 * `S` is statically safe. Values are loose because the active step's
 * schema is not statically known; reach for the original form ref or
 * `ctx.get(ref)` for typed per-step values.
 */
export type ActiveFormOf<S> =
  StaticallyNonEmpty<S> extends true
    ? UseFormReturnType<GenericForm>
    : UseFormReturnType<GenericForm> | undefined

/**
 * One slot's contribution to {@link FormsRecordOf}. Unwraps `gate()`
 * and strips nullish off the slot first, so a conditionally-present
 * form and a `gate(form)` both still map to their key and stay
 * concretely typed on `wizard.forms`. A purely nullish slot contributes
 * nothing.
 */
type SlotRecord<First, U = UnwrapGate<First>, F = Exclude<U, null | undefined>> = [F] extends [
  never,
]
  ? unknown
  : F extends string
    ? { readonly [P in F]: AnyForm }
    : F extends { readonly key: infer K extends string }
      ? { readonly [P in K]: F }
      : unknown

/**
 * Builds the static portion of `wizard.forms` by walking the steps
 * tuple. Per slot kind:
 *
 *  - **string** (`'review'`): the literal is the record key, and the
 *    value is `AnyForm`, since the synthesized noop form is opaque at
 *    the type level.
 *  - **form**: the form's own `key` is the record key and the value is
 *    the concrete handle, so `wizard.forms.shipping.values.address`
 *    carries schema-derived field types through. A form behind a
 *    `cond ? form : null` still maps to its key.
 *  - **nullish**: contributes nothing.
 *  - **function / `lazy()`**: contributes nothing statically.
 *    Runtime-resolved forms stay reachable as `AnyForm` through the
 *    catch-all index signature on `WizardForms`.
 *  - **`gate()`**: unwrapped, so it contributes exactly what the slot
 *    it wraps would.
 */
export type FormsRecordOf<S> = S extends readonly [
  infer First,
  ...infer Rest extends ReadonlyArray<StepSlot>,
]
  ? SlotRecord<First> & FormsRecordOf<Rest>
  : unknown

/**
 * `wizard.forms` typed view: the static per-step map, intersected with
 * a catch-all so a statically known key resolves to its concrete form
 * type and any other string key resolves to `AnyForm`.
 */
export type WizardForms<S> = FormsRecordOf<S> & Readonly<Record<FormKey, AnyForm>>

/**
 * What `useWizard({ steps, ... })` returns. Every reactive read is a
 * plain getter, no `.value`, so `wizard.currentStep`, `wizard.progress`
 * and `wizard.allValues` track inside `computed` and templates
 * directly.
 *
 * Parameterized by the steps tuple `S` so the active-position fields
 * narrow to non-`undefined` when every slot is positional, and stay
 * honest unions when a function or `lazy()` slot can drop the position
 * at runtime. `useWizard`'s `const` type parameter preserves the
 * literal tuple, so that narrowing happens without a consumer-side
 * `as const`.
 */
export type UseWizardReturnType<S extends ReadonlyArray<StepSlot> = ReadonlyArray<StepSlot>> = {
  readonly key: string
  /**
   * Key of the active step. Narrows to `string` when the steps tuple is
   * statically guaranteed non-empty; otherwise `string | undefined`, so
   * an empty compiled list surfaces honestly.
   */
  readonly currentStep: CurrentStepOf<S>
  /**
   * A live view of the active step's form, so operating through it
   * always targets the current step: a handler captured once at setup
   * (`wizard.activeForm.handleSubmit(() => wizard.next())`) retargets as
   * the wizard advances. It is a facade, not the raw per-step handle;
   * reach for `wizard.forms[key]` when you need identity. Same
   * `undefined` narrowing as `currentStep`.
   */
  readonly activeForm: ActiveFormOf<S>
  /** 0-based position of the active step. */
  readonly activeIndex: number
  /** `true` when `currentStep` is the last compiled step. */
  readonly isFinalStep: boolean
  /** The ordered compiled `{ key, form }` slots. */
  readonly steps: ReadonlyArray<CompiledStep>
  /** Every step's form, indexable by step key. */
  readonly forms: WizardForms<S>
  /** `steps.length`. */
  readonly count: number
  /**
   * Callable readonly proxy over the per-key `FormStatus` record.
   * Noop-form keys always read as default-valid.
   */
  readonly statuses: WizardStatusesProxy<Record<string, FormStatus>>
  /** Each form's values, keyed by step key. */
  readonly allValues: Readonly<Record<FormKey, unknown>>
  /** Each form's validation errors, keyed by step key. Noop forms map to an empty list. */
  readonly allErrors: Readonly<Record<FormKey, readonly WizardAggregateError[]>>
  /**
   * Normalised step-validity ratio, or the `progress` override's
   * return. Forward-looking: noop steps count as valid.
   */
  readonly progress: number
  /**
   * `true` when `activeIndex < count - 1`. Purely positional;
   * navigation never gates on validity.
   */
  readonly canAdvance: boolean
  /** `true` when `activeIndex > 0`. */
  readonly canGoBack: boolean
  /**
   * `isFinalStep` and every step's form valid. Reactive to current
   * validity, so this is the "enable the Finish button" signal.
   */
  readonly complete: boolean
  /**
   * Monotonic latch: `true` the first time a `handleSubmit` resolves
   * without throwing AND leaves no errors on any step, and stays `true`
   * through later edits. A callback that calls `setErrors` and returns
   * is a failed submit, so it does not flip this. Only `reset()` clears
   * it. Gates success UI that should reflect submission history rather
   * than current validity.
   */
  readonly done: boolean
  /**
   * `true` while a `wizard.handleSubmit` call is in flight. Every
   * navigation method refuses while it is on.
   */
  readonly submitting: boolean
  /** `wizard.handleSubmit` invocations, success or failure. */
  readonly submissionAttempts: number
  /**
   * The error THROWN by the most recent `handleSubmit` callback or its
   * `onError`, coerced to a real `Error`, and `null` on success. Like
   * `form.meta.submitError`, this is the unexpected-throw channel: an
   * expected rejection handled through `setErrors` surfaces on the
   * error surface and in `onError` instead, leaving this `null`. It is
   * parked here rather than re-thrown, so the handler always resolves
   * and never manufactures an unhandled rejection. Cleared at submit
   * entry and by `reset()`.
   */
  readonly submitError: Error | null
  /**
   * Append-only breadcrumb of navigated step keys. `back()` does not
   * pop: the trail is an audit log, not a back-stack.
   */
  readonly visited: readonly FormKey[]
  /**
   * Advance one step. Refuses while `submitting`. On an UNCLEARED
   * `gate()` step it behaves as `tryNext()`, so wiring a Next button
   * straight to it can never skip the gate's confirmation; once that
   * gate clears it is plain navigation again and does not re-submit.
   */
  readonly next: () => Promise<void>
  /** Go back one step. Refuses while `submitting`. */
  readonly back: () => void
  /** Jump to a step by key. Refuses while `submitting`. */
  readonly goTo: (key: string) => void
  /**
   * Submit the active step, and advance once that submit resolves
   * clean. Invalid input keeps the pin put under the form's standard
   * error reveal, with the first error focused and display state
   * advanced. The advance runs after the submit settles, so a `gate()`
   * on the active step clears in a single call.
   *
   * Inline-bindable (`@click="wizard.tryNext()"`), and resolves to
   * whether the pin moved. `false` on a degenerate or final-step wizard;
   * finish through `handleSubmit` instead.
   *
   * Called while the active step already has a submit in flight, the
   * usual case being from inside that form's own callback, it rides
   * that submit rather than starting a second one, so one action costs
   * one submission. The pin has not moved by the time it resolves, so
   * the answer is `false` and the advance lands with the in-flight
   * submit.
   */
  readonly tryNext: () => Promise<boolean>
  /**
   * Validate the entire step list, from any step, and never advance the
   * pin. On success `done` latches; on any error the first failing step
   * is focused and `onError` fires with errors spanning every step.
   *
   * To gate advancing a step on its own validity, compose with the
   * active form's submit instead:
   * `activeForm.handleSubmit(() => wizard.next())`.
   *
   * Returns a handler for `<form @submit>` or for imperative use.
   */
  readonly handleSubmit: (
    onSubmit: WizardOnSubmit,
    onError?: WizardOnError
  ) => (event?: Event) => Promise<void>
  /**
   * Zero the wizard lifecycle (`submissionAttempts`, `visited`, `done`),
   * reset every form, return to `steps[0].key`, and invoke `persist`
   * with the cleared state. Re-applies the `defaultStatuses` gate seed,
   * so a reboot returns to the seeded clearance rather than fully
   * sealed.
   */
  readonly reset: () => void
  /**
   * Re-seal a cleared gate, contingent on `commit`. Awaits `commit`, a
   * server-side revoke, and re-seals only if it resolves clean, so the
   * gate reflects server-confirmed truth the same way a clearing submit
   * does; a thrown `commit` leaves the gate as-is.
   *
   * Seal-only, so it can never become the leading-signal foot-gun
   * `gate()` exists to prevent. `commit` is required: pass `() => {}`
   * for a deliberate client-only re-seal. Resolves whether the gate
   * ended up sealed and never rejects; resolves `false` with a dev
   * warning on a non-gate key.
   */
  readonly relock: (key: FormKey, commit: () => void | Promise<void>) => Promise<boolean>
}
