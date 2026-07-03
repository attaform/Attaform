import { getCurrentScope, onScopeDispose, ref, watchEffect, type Ref } from 'vue'
import type {
  ErrorInput,
  FormKey,
  HandleSubmit,
  OnError,
  OnInvalidSubmitPolicy,
  OnSubmit,
  ReactiveValidationStatus,
  SubmitHandler,
  ValidationError,
  ValidationResponse,
  ValidationResponseWithoutValue,
} from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { __DEV__ } from './dev'
import { AttaformErrorCode } from './error-codes'
import { normalizeErrorInput, SubmitErrorHandlerError, toError } from './errors'
import { canonicalizePath, segmentsForPathKey, type Path, type Segment } from './paths'

/**
 * Tracks FormStores for which we've already emitted the
 * "validate() called outside an effect scope" warning. One warn per
 * store keeps the diagnostic loud the first time and silent for the
 * rest of the run — important for hot-loop callers that would
 * otherwise spam the console (a tight test loop calling validate()
 * 1000 times shouldn't produce 1000 warnings).
 */
const warnedNoScopeStores: WeakSet<FormStore<GenericForm>> | null = __DEV__
  ? new WeakSet<FormStore<GenericForm>>()
  : null

/**
 * Does `value` look like a well-constructed `ErrorInput` — something the
 * shared normalizer can turn into a meaningful `ValidationError`? A real
 * `Error` qualifies; so does a plain object carrying a non-empty string
 * `message` and/or an array `path` (a thrown `{ path, message, code? }`).
 * Everything else (a bare primitive, `null`, `undefined`, a shapeless
 * object) is garbage that would normalize to an empty "Unknown error", so
 * the submit-throw path treats it separately.
 */
function isErrorInputLike(value: unknown): value is ErrorInput {
  if (value instanceof Error) return true
  if (typeof value !== 'object' || value === null) return false
  const shape = value as { message?: unknown; path?: unknown }
  return (
    (typeof shape.message === 'string' && shape.message.length > 0) || Array.isArray(shape.path)
  )
}

/**
 * Turn whatever a `handleSubmit` `onSubmit` callback threw into the
 * `ValidationError[]` to pipe into the user-error layer, all under the
 * `atta:submit-error` code. A well-constructed throw (or array of them)
 * is normalized honoring its own `path` / `code`, so a dev who threw
 * `{ path: ['email'], message }` gets a field-scoped error and a bare
 * `Error` lands form-level (`[]`). A garbage throw still injects one
 * form-level entry carrying `toError`'s diagnostic message, and reports
 * `messageless` so the caller can nudge the dev in development.
 */
function deriveSubmitErrors(
  err: unknown,
  formKey: FormKey
): { entries: ValidationError[]; messageless: boolean } {
  if (Array.isArray(err) && err.length > 0 && err.every(isErrorInputLike)) {
    return {
      entries: err.map((item) =>
        normalizeErrorInput(item, undefined, formKey, AttaformErrorCode.SubmitError)
      ),
      messageless: false,
    }
  }
  if (isErrorInputLike(err)) {
    return {
      entries: [normalizeErrorInput(err, undefined, formKey, AttaformErrorCode.SubmitError)],
      messageless: false,
    }
  }
  return {
    entries: [
      { message: toError(err).message, path: [], formKey, code: AttaformErrorCode.SubmitError },
    ],
    messageless: true,
  }
}

/**
 * validate + handleSubmit, both built against a FormStore<F>. Replaces
 * use-form-store's validation factory + the submit wrapper in
 * use-abstract-form.ts.
 *
 * Phase 5.6: validation is async end-to-end. `AbstractSchema.validateAtPath`
 * returns `Promise<ValidationResponse<F>>`, so every caller here awaits.
 * The reactive `validate()` ref carries a `pending` flag to distinguish
 * "in-flight" from "settled"; stale results are dropped via a per-call
 * generation counter.
 */

export type BuildProcessFormOptions = {
  /**
   * Policy applied inside handleSubmit when validation fails. Invoked
   * after the error store is populated and before the user's `onError`
   * callback. Default `'none'`.
   */
  onInvalidSubmit?: OnInvalidSubmitPolicy
}

export function buildProcessForm<F extends GenericForm, Out extends GenericForm = F>(
  state: FormStore<F, Out>,
  formInstanceId: string,
  options: BuildProcessFormOptions = {}
) {
  const invalidPolicy: OnInvalidSubmitPolicy = options.onInvalidSubmit ?? 'focus-first-error'

  function validate(pathInput?: string | Path): Readonly<Ref<ReactiveValidationStatus<F>>> {
    // Start in a pending state — the first async run has not settled yet.
    // When validation fires, this ref writes `{ pending: false, ... }`
    // with the resolved status; stale writes (older generation) are
    // dropped so a slow earlier run can't overwrite a newer result.
    const result = ref<ReactiveValidationStatus<F>>({
      pending: true,
      errors: undefined,
      success: false,
      formKey: state.formKey,
    }) as Ref<ReactiveValidationStatus<F>>

    let gen = 0

    async function kickoff(data: unknown, path: Path | undefined, captured: number): Promise<void> {
      // Runs on a microtask outside the watchEffect's sync frame. Reads
      // and writes to reactive state inside this function DO NOT track
      // against the effect — the activeEffect stack is empty here —
      // so writing to `activeValidations` / `result` can't re-trigger
      // the watchEffect below.
      //
      // The lifecycle setup (counter increment + `pending: true` write)
      // lives INSIDE the try block so a sync watcher on
      // `meta.validating` or on the returned `result` ref that throws
      // can't leak the counter — the finally still decrements (Math.max
      // clamps the partial-increment underflow case at zero).
      try {
        state.activeValidations.value += 1
        result.value = {
          pending: true,
          errors: undefined,
          success: false,
          formKey: state.formKey,
        }
        const refinement = await runRefinementValidation(data, path)
        if (captured !== gen) return
        result.value = settled(composeWithDerivedBlank(refinement, path))
      } catch (err) {
        if (captured !== gen) return
        // Adapters are contractually "return errors, don't throw"; if
        // one does throw we don't want the validate() ref to hang in
        // `pending: true` forever. Wrap the throw as a single
        // adapter-level error so the form surfaces something.
        result.value = {
          pending: false,
          errors: [
            {
              message: adapterThrowMessage(err),
              path: [],
              formKey: state.formKey,
              code: AttaformErrorCode.AdapterThrew,
            },
          ],
          success: false,
          formKey: state.formKey,
        }
      } finally {
        state.activeValidations.value = Math.max(0, state.activeValidations.value - 1)
      }
    }

    const stop = watchEffect(() => {
      // Read form.value (or the subtree at path) so the effect re-runs
      // on any mutation. We must NOT touch any other reactive state
      // here — the writes in `kickoff` would otherwise re-trigger the
      // effect in a hot loop. Deferring via `queueMicrotask` puts the
      // writes on a clean task where `activeEffect` is null.
      const segments = pathInput === undefined ? undefined : toSegments(pathInput)
      const dataAtPath = segments === undefined ? state.form.value : state.getValueAtPath(segments)
      const localGen = ++gen
      queueMicrotask(() => {
        void kickoff(dataAtPath, segments, localGen)
      })
    })
    // Tie the watcher's lifetime to the caller's effect scope so
    // components that call validate() in setup release the watcher on
    // unmount. Tests calling validate() in a raw context simply leak
    // the watcher for the test's duration — acceptable given tests
    // tear down the module context per run.
    if (getCurrentScope() !== undefined) {
      onScopeDispose(stop)
    } else if (
      __DEV__ &&
      warnedNoScopeStores !== null &&
      !warnedNoScopeStores.has(state as FormStore<GenericForm>)
    ) {
      warnedNoScopeStores.add(state as FormStore<GenericForm>)
      console.warn(
        '[attaform] validate() called outside a Vue effect scope; ' +
          'its reactive watcher will leak until the form is garbage-collected. ' +
          'Fix: call validate() inside setup() / a child component, ' +
          'or wrap the call in `effectScope().run(...)`.'
      )
    }
    return result as Readonly<Ref<ReactiveValidationStatus<F>>>
  }

  /**
   * Shared shell for the imperative validation paths (`validateAsync`,
   * `process`). Handles the path-segment resolution, the
   * `activeValidations` increment/decrement (Math.max-guarded against
   * a sync watcher throw between increment and refinement), the
   * adapter-throw → structured-failure translation, and the optional
   * pre-validate cancellation + post-validate schema-error commit
   * that distinguishes `validateAsync` from `process`. Callers
   * post-process the refinement themselves (the blank-class
   * composition, the data strip — both unique to their public
   * contract).
   *
   * The discriminated `ok` branch lets each caller preserve the
   * exact behavior on adapter throw: `validateAsync` and `process`
   * historically returned the adapter-throw response verbatim, never
   * folding `derivedBlankErrors` into it, so the helper returns the
   * raw `adapterThrowResponse` for the failure leg.
   */
  type ImperativeValidationOptions = {
    cancelInFlight: boolean
    commitToSchemaErrors: boolean
  }
  type ImperativeValidationResult =
    | { ok: true; refinement: ValidationResponse<Out>; segments: Path | undefined }
    | { ok: false; error: ValidationResponse<Out> }
  async function runImperativeValidation(
    pathInput: string | Path | undefined,
    config: ImperativeValidationOptions
  ): Promise<ImperativeValidationResult> {
    const segments = pathInput === undefined ? undefined : toSegments(pathInput)
    const dataAtPath = segments === undefined ? state.form.value : state.getValueAtPath(segments)
    try {
      state.activeValidations.value += 1
      // Abort any in-flight per-field validation runs so their late
      // writes can't clobber the authoritative imperative result.
      // Mirrors handleSubmit's pre-validate cancellation.
      if (config.cancelInFlight) state.cancelFieldValidation()
      const refinement = await runRefinementValidation(dataAtPath, segments)
      // Commit the refinement to schemaErrors at the validated scope.
      // The adapter emits issue paths relative to the sub-schema it
      // parsed (`[]` for a leaf; whole-form pass emits absolute paths
      // already), so re-stamp with `segments` to land at canonical
      // store keys. `applySchemaErrorsForSubtree` replaces every key
      // under the scope so stale entries drop and current ones
      // survive in their original insertion slots.
      if (config.commitToSchemaErrors) {
        const scopePath: Path = segments ?? []
        const errors = refinement.success ? [] : refinement.errors
        const reStamped =
          segments === undefined
            ? errors
            : errors.map((err) => ({
                ...err,
                path: [...segments, ...(err.path as Segment[])],
              }))
        state.applySchemaErrorsForSubtree(scopePath, reStamped)
      }
      return { ok: true, refinement, segments }
    } catch (err) {
      return { ok: false, error: adapterThrowResponse(err) }
    } finally {
      state.activeValidations.value = Math.max(0, state.activeValidations.value - 1)
    }
  }

  /**
   * Imperative one-shot validation. Doesn't subscribe to form reactivity;
   * each call runs validation once against the current form snapshot.
   * Used by consumers who want to `await` a single validation run — the
   * debounced field-level path in 5.7, server-side round-trips, tests.
   *
   * Cancels any in-flight per-field validation (mirroring `handleSubmit`)
   * so a late SFV resolution can't clobber this call's authoritative
   * result, and writes the parsed refinement back to `schemaErrors` at
   * the validated scope — `await validateAsync(path)` therefore lands
   * a deterministic view of `form.errors.<path>` regardless of the
   * background SFV race.
   */
  async function validateAsync(
    pathInput?: string | Path
  ): Promise<ValidationResponseWithoutValue<F>> {
    const result = await runImperativeValidation(pathInput, {
      cancelInFlight: true,
      commitToSchemaErrors: true,
    })
    if (!result.ok) return result.error
    return stripData(composeWithDerivedBlank(result.refinement, result.segments))
  }

  /**
   * Imperative one-shot parse — same pipeline as `validateAsync` but
   * RETAINS the parsed data. Returns what `form.values` WOULD be if
   * every refinement passed and every transform fired. Useful when
   * the form's storage holds the pre-transform input view (the
   * "honest input view" — Attaform doesn't run `.transform()` at
   * write time, only preprocess) and the consumer wants the
   * post-transform output on demand.
   *
   * For a schema like `z.object({ email: z.string().transform(v =>
   * v.length > 10) })`, `form.values.email` is the string the user
   * wrote, while `(await form.parse()).data?.email` is the boolean
   * the transform produces. handleSubmit's callback already receives
   * this same shape (it's what the parse pipeline emits before
   * onSubmit runs); `parse()` is the standalone read-only form.
   *
   * Always async, and there is no synchronous variant by design. A
   * schema can carry async refinements (`.refine(async ...)`) or async
   * transforms, so a sync parse would silently miss them the moment
   * one is added — a latent correctness bug. One always-awaited `parse`
   * closes that category entirely. The path-scoped variant mirrors
   * `validateAsync(path?)` — `parse('email')` returns the parsed value
   * at that path only.
   *
   * Unlike `validateAsync`, `parse` does NOT cancel in-flight field
   * validation and does NOT commit the parsed result to `schemaErrors`
   * — `parse` is a pure read of "what would the parsed form look like
   * right now", independent of the live `form.errors` surface.
   *
   * Like `validateAsync`, this never rejects on adapter misbehavior:
   * a throwing adapter (or any pipeline failure) lands in the
   * response as a `success: false, errors: [{ code: AdapterThrew }]`
   * shape so the library stays robust against a bad adapter.
   */
  async function parse(pathInput?: string | Path): Promise<ValidationResponse<Out>> {
    const result = await runImperativeValidation(pathInput, {
      cancelInFlight: false,
      commitToSchemaErrors: false,
    })
    if (!result.ok) return result.error
    return composeWithDerivedBlank(result.refinement, result.segments)
  }

  /**
   * Build an adapter-threw failure response. Shared between
   * `validateAsync`, `parse`, and the reactive `validate()`'s
   * kickoff so every imperative validation surface presents the same
   * shape on adapter misbehavior: `{ success: false, errors: [{ code
   * AdapterThrew, message: adapterThrowMessage(err), path: [],
   * formKey }] }`. The `data` field is `undefined` so the
   * ValidationResponse union resolves to ErrorWithoutData.
   */
  function adapterThrowResponse(err: unknown): ValidationResponse<Out> {
    return {
      success: false,
      data: undefined,
      errors: [
        {
          message: adapterThrowMessage(err),
          path: [],
          formKey: state.formKey,
          code: AttaformErrorCode.AdapterThrew,
        },
      ],
      formKey: state.formKey,
    }
  }

  /**
   * Refinement-only adapter pass-through. Returns the schema's
   * refinement-class result without touching the blank-required class
   * — that lives reactively on `state.derivedBlankErrors`. Callers
   * compose the consumer-facing response via `composeWithDerivedBlank`
   * so `setAllSchemaErrors` only ever sees refinement errors and the
   * blank class never gets double-counted (once in `schemaErrors`, once
   * in `derivedBlankErrors`).
   */
  async function runRefinementValidation(
    data: unknown,
    path: Path | undefined
  ): Promise<ValidationResponse<Out>> {
    return await state.schema.validateAtPath(data, path)
  }

  /**
   * Fold the reactively-derived blank-required errors into a refinement
   * response. The derived class always reflects current state, so this
   * snapshot at call time matches what `form.errors` shows in the same
   * tick.
   */
  function composeWithDerivedBlank(
    refinement: ValidationResponse<Out>,
    scope: Path | undefined
  ): ValidationResponse<Out> {
    const blankErrors = collectScopedBlankErrors(state, scope)
    if (blankErrors.length === 0) return refinement
    if (refinement.success) {
      return {
        data: undefined,
        errors: blankErrors,
        success: false,
        formKey: state.formKey,
      }
    }
    return { ...refinement, errors: [...refinement.errors, ...blankErrors] }
  }

  /**
   * handleSubmit(onSubmit, onError?) builds a submit handler. The two
   * callbacks dispatch on Attaform's validation verdict: when pre-dispatch
   * validation fails, populate the schema-error store and call `onError`
   * (never `onSubmit`); when it passes, call `onSubmit` with the parsed
   * data. `onError` fires iff validation rejected the submit — a throw, a
   * `setErrors`, or a clean return out of `onSubmit` is the dev's own
   * outcome and never routes back through `onError`.
   *
   * If the user's onError throws/rejects, the thrown value is wrapped in
   * SubmitErrorHandlerError so inspection can tell "my error handler
   * crashed" apart from "my submit body failed". Both converge on
   * `submitError` (see below); neither re-throws out of the handler.
   *
   * Drives the submission-lifecycle refs on FormStore:
   *   - `submitting` flips true at entry, false in `finally`.
   *   - `submissionAttempts` increments once per call, regardless of outcome —
   *     "how many times did the user click submit" is the consumer-facing
   *     question, independent of whether anything awaited.
   *   - `submitError` clears at entry and captures anything thrown from
   *     the user callback (or the wrapped error-handler error), coerced to
   *     a real `Error` via `toError`. A throw out of `onSubmit` is ALSO
   *     piped into the user-error layer under `atta:submit-error`, so it
   *     surfaces on `form.errors` / `meta.ownErrors` / `firstOwnError`
   *     (path-scoped when the throw was well-constructed, form-level `[]`
   *     otherwise); a wrapped `SubmitErrorHandlerError` is the exception
   *     and stays `submitError`-only. The handler does NOT re-throw: a
   *     rejecting `onSubmit` bound to `@submit.prevent` would otherwise
   *     surface as a `window` unhandledrejection (a phantom crash for an
   *     already-handled server failure). Both template and imperative
   *     callers read the outcome from `submitError` / `submitted`; the
   *     returned promise always resolves.
   *
   * Phase 5.6: the pre-dispatch validation is now async, so the handler
   * awaits `runValidation` before branching on success/failure. The
   * `validating` ref (backed by `state.activeValidations`) is true
   * for the validation window.
   */
  const handleSubmit: HandleSubmit<Out> = (onSubmit: OnSubmit<Out>, onError?: OnError) => {
    const submitHandler: SubmitHandler = async (event?: Event): Promise<void> => {
      if (
        event !== undefined &&
        'preventDefault' in event &&
        typeof event.preventDefault === 'function'
      ) {
        event.preventDefault()
      }
      // Re-entry guard: a submission is already in flight. The classic
      // double-click case — `submit()` fires while a prior call is still
      // awaiting validation or the consumer's onSuccess — would otherwise
      // drive `onSuccess` twice and duplicate side-effects (POSTs, etc).
      // `preventDefault` already ran above, so a duplicate browser submit
      // is suppressed even when this branch returns early.
      if (state.activeSubmissions.value > 0) {
        return
      }
      // Track in-flight via a counter (not a flag) so that a generation
      // bump during the run can still distinguish "I'm the live submission"
      // from "a stale prior submission winding down" via the early
      // generation snapshot. submitError is shared with the prior call's
      // capture only when a `reset()` hasn't fired between entry and
      // throw (see the catch block).
      const genAtEntry = state.submissionGeneration.value
      let validationSettled = false
      try {
        // All lifecycle setup happens inside the try so a throw from
        // any of the setters (e.g. a sync `watch` on `meta.submitting`
        // that rejects, or a defensive throw from
        // `cancelFieldValidation`) still lands in the finally block.
        // Without this, an early-setup throw would leak
        // `activeSubmissions` at 1 forever and silently block every
        // subsequent submit. Math.max in the finally already clamps
        // partial-increment underflow at zero.
        state.activeSubmissions.value += 1
        state.submitting.value = true
        state.submitError.value = null
        // Clear user-set errors (set via `setErrors`) so a
        // fresh attempt starts from a clean user-error slate. Done at
        // ENTRY (before validation, before the callback): the consumer's
        // callback is where the NEW errors are set, so clearing on the way
        // out would wipe what was just set; and a client-validation
        // failure never reaches the callback, so only an entry-clear drops
        // a prior server error in that case too. Schema errors are
        // recomputed by the validation pass below; this is the user store's
        // equivalent reset. Unconditional and total (form + field) — the
        // dominant `setErrors` use is the server's verdict on the
        // prior attempt, which a new attempt supersedes.
        state.clearUserErrors()
        // Drain in-flight async register transforms before validating, so a
        // submit fired the instant after a keystroke parses the field's
        // resolved value rather than its stale pre-transform one. This sits
        // BEFORE `cancelFieldValidation()` deliberately: a transform that
        // commits during the drain runs `onFormChange` and can schedule a
        // fresh field validation, and draining first lets the cancel below
        // sweep those up so no stray run races this submit's authoritative
        // whole-form pass. The `while` re-checks because a transform can start
        // during the await (re-entrancy-safe). `settleTransforms` resolves and
        // never rejects, so a failed transform does not throw the submit — it
        // proceeds against committed storage (a failed field keeps its prior
        // value plus `transformError`, which the validation pass may flag).
        // `meta.submitting` is already `true` here, so the button stays
        // disabled across the drain; the await is the correctness net for the
        // case where it is not.
        while (state.activeTransforms.value > 0) await state.settleTransforms()
        // Abort any in-flight per-field validation runs so their late
        // writes can't clobber the authoritative submit result. Also
        // clears debounce timers that never fired.
        state.cancelFieldValidation()
        // Drop the anti-flash display state too. An explicit submit is a
        // "show me the verdict now" signal, so a leftover show-delay hold
        // or a min-visible spinner timer from pre-submit typing must not
        // outlive the submit and delay the reveal. `cancelFieldValidation`
        // already cleared `fieldValidatingSince`, so the next read recomputes
        // the settled verdict against the post-submit gate immediately.
        state.displayEngine.clear()
        state.activeValidations.value += 1
        const refinement = await runRefinementValidation(state.form.value, undefined)
        const merged = composeWithDerivedBlank(refinement, undefined)
        state.activeValidations.value = Math.max(0, state.activeValidations.value - 1)
        validationSettled = true
        // Generation guard: if `reset()` fired while we were awaiting
        // validation, the consumer just zeroed the submission surface
        // — the validation result is for state that's been replaced.
        // Skip the schema-error write so reset's empty store stays
        // empty; still run the user's onError so they get the result
        // (it's their data, not ours, to discard).
        const generationStillValid = state.submissionGeneration.value === genAtEntry
        if (!merged.success) {
          // Source-segregated writer: only refinement-class errors land
          // in `schemaErrors`. The blank-required class is already in
          // `derivedBlankErrors` (reactively derived from `blankPaths`),
          // so writing it here would double-count. User-injected errors
          // live in their own store and are NOT clobbered by validation.
          if (generationStillValid) {
            if (refinement.success) {
              state.clearSchemaErrors()
            } else {
              state.setAllSchemaErrors(refinement.errors)
            }
          }
          // Apply the invalid-submit focus/scroll policy AFTER populating
          // the error store (so getFirstErrorElement walks the fresh
          // entries) and BEFORE the user's onError callback (so consumer
          // logic can override by calling .focus on something else).
          // Skip the policy too on a stale generation — the post-reset
          // form has no errors to focus.
          if (generationStillValid) {
            applyInvalidSubmitPolicy(state, formInstanceId, invalidPolicy)
          }
          if (onError !== undefined) {
            try {
              await onError(merged.errors)
            } catch (cause) {
              throw new SubmitErrorHandlerError('User-provided onError threw', { cause })
            }
          }
          return
        }
        // Schema-only clear: a successful submit means refinement
        // validation passed AND no required-blank errors exist, so the
        // schema-error store goes empty. User-injected errors persist —
        // consumers managing their own warning/info state via
        // setErrors keep ownership of that lifecycle. Skip the
        // clear when reset already cleared (and bumped gen) — any
        // errors injected by post-reset user mutations would be wrongly
        // wiped otherwise.
        if (generationStillValid) {
          state.clearSchemaErrors()
        }
        await onSubmit(merged.data)
        // A callback that left errors in the user-error layer did not
        // succeed (the documented `setErrors(...); return` server-rejection
        // path — the entry-clear at submit start means any user error
        // present now was set by this callback). Focus the first error
        // (generation-gated, like the validation-failure branch) and leave
        // `submitted` false.
        //
        // `onError` is deliberately NOT called here. The two `handleSubmit`
        // callbacks are a dispatch on Attaform's *validation* verdict:
        // `onError` fires iff pre-dispatch validation rejected the submit
        // (so `onSubmit` never ran). Once `onSubmit` has run, Attaform
        // already ruled the submit valid; the dev's own `setErrors` is a
        // state write, not a re-verdict, so it must not route back through
        // the `onError` arm.
        if (state.userErrors.size > 0) {
          if (state.submissionGeneration.value === genAtEntry) {
            applyInvalidSubmitPolicy(state, formInstanceId, invalidPolicy)
          }
          return
        }
        // Flip `submitted` true once the user callback resolved without
        // throwing AND left no errors behind — independent of
        // `submissionAttempts`. Generation guard: a `reset()` that fired during
        // the await already zeroed the submission surface; honor the consumer's
        // intent by leaving `submitted` at the post-reset `false`.
        if (state.submissionGeneration.value === genAtEntry) {
          state.submitted.value = true
        }
        // Notify subscribers (persistence's clear-on-success handler,
        // future hooks). Fires only when the user callback resolved —
        // validation-failure and callback-throw skip it.
        state.emitSubmitSuccess()
      } catch (err) {
        // Only publish the error if `reset()` hasn't fired since this
        // submission began. Otherwise the consumer just zeroed the
        // submission surface and we'd undo their intent by re-raising
        // into `submitError`. Coerce to a real `Error` so the slot is
        // `Error | null`, never `unknown` (a non-Error throw keeps its
        // origin on `.cause`).
        //
        // Deliberately NOT re-thrown: the handler is bound to DOM events
        // (`@submit.prevent` / `@click`), so a rejected promise here would
        // surface as a `window` unhandledrejection — a phantom crash for
        // what is usually an already-handled server failure. The error is
        // recorded on `submitError` for both template and imperative
        // callers; the `finally` still resets `submitting`, so a rejected
        // submit never strands the button.
        if (state.submissionGeneration.value === genAtEntry) {
          state.submitError.value = toError(err)
          // `submitError` alone is a raw-`Error` inspection channel most
          // templates never render, so a thrown submit would otherwise be
          // invisible in the UI. Pipe the throw into the user-error layer
          // too (the same normalizer `setErrors` uses) so it surfaces on
          // `form.errors` / `meta.ownErrors` / `firstOwnError` where the
          // form already reads: path-scoped when the dev threw a
          // well-constructed `{ path, message }`, form-level (`[]`)
          // otherwise. `submitError` keeps the raw Error; this is the
          // rendered projection of the same failure, not a duplicate.
          //
          // Excludes `SubmitErrorHandlerError`: that wraps a crash in the
          // dev's *validation* `onError` handler, not a failed submit, so
          // it stays a pure `submitError` diagnostic and is never shown as
          // a form error.
          if (!(err instanceof SubmitErrorHandlerError)) {
            const { entries, messageless } = deriveSubmitErrors(err, state.formKey)
            // Group by path so a thrown array spanning several fields writes
            // one bucket per path. Per-path writes MERGE: a bucket the
            // callback set at another path via `setErrors` before it threw
            // survives, while a bucket at a colliding path is replaced (the
            // throw is the newer verdict).
            const byPath = new Map<string, { segments: Path; entries: ValidationError[] }>()
            for (const entry of entries) {
              const { key } = canonicalizePath(entry.path)
              const bucket = byPath.get(key)
              if (bucket === undefined) byPath.set(key, { segments: entry.path, entries: [entry] })
              else bucket.entries.push(entry)
            }
            for (const { segments, entries: bucket } of byPath.values()) {
              state.setUserErrorsForPath(segments, bucket)
            }
            // Focus the first error, mirroring the validation-failure and
            // leftover-errors branches. A form-level `[]` error owns no
            // element, so this is a no-op in that case.
            applyInvalidSubmitPolicy(state, formInstanceId, invalidPolicy)
            if (__DEV__ && messageless) {
              console.warn(
                '[attaform] handleSubmit callback threw a non-Error value; throw an ' +
                  'Error or a ValidationError ({ message, path? }) so the failure ' +
                  'surfaces with a usable message.'
              )
            }
          }
        }
      } finally {
        // If validation threw before we decremented, drop the counter now
        // so `validating` doesn't hang true after a failed submit.
        if (!validationSettled) {
          state.activeValidations.value = Math.max(0, state.activeValidations.value - 1)
        }
        state.activeSubmissions.value = Math.max(0, state.activeSubmissions.value - 1)
        // `activeSubmissions` always decrements (the submission is done),
        // but the *visible* lifecycle counters — `submitting` and
        // `submissionAttempts` — only update when the submission's generation
        // still matches. A post-reset completion is a no-op from the
        // consumer's point of view: reset already flipped `submitting`
        // to false and zeroed `submissionAttempts`, and the finished submission
        // belongs to the prior generation.
        if (state.submissionGeneration.value === genAtEntry) {
          state.submitting.value = state.activeSubmissions.value > 0
          state.submissionAttempts.value += 1
        }
      }
    }
    return submitHandler
  }

  return { validate, validateAsync, parse, handleSubmit }
}

function toSegments(pathInput: string | Path): Path {
  return canonicalizePath(pathInput).segments
}

function settled<F extends GenericForm>(
  response: ValidationResponse<F>
): ReactiveValidationStatus<F> {
  if (response.success) {
    return { pending: false, errors: undefined, success: true, formKey: response.formKey }
  }
  return { pending: false, errors: response.errors, success: false, formKey: response.formKey }
}

function stripData<F extends GenericForm>(
  response: ValidationResponse<F>
): ValidationResponseWithoutValue<F> {
  if (response.success) {
    return { errors: undefined, success: true, formKey: response.formKey }
  }
  return { errors: response.errors, success: false, formKey: response.formKey }
}

function adapterThrowMessage(err: unknown): string {
  if (err instanceof Error) return `Adapter validateAtPath threw: ${err.message}`
  return 'Adapter validateAtPath threw a non-Error value'
}

/**
 * Read the reactively-derived blank-required errors out of the store,
 * filtered to paths inside `scope` (or all paths when `scope` is
 * `undefined`). The errors themselves are computed on the FormStore via
 * `derivedBlankErrors` — this helper just snapshots a scoped slice for
 * the validation/submit response. Mutating the returned array is safe;
 * the store's computed builds a fresh map per recompute.
 */
function collectScopedBlankErrors<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  scope: Path | undefined
): ValidationError[] {
  const derived = state.derivedBlankErrors.value
  if (derived.size === 0) return []
  const errors: ValidationError[] = []
  for (const [pathKey, entries] of derived) {
    if (scope !== undefined) {
      // Cache hit on canonical PathKeys; cold (corrupt) keys return
      // null and we skip. Don't round-trip through
      // `canonicalizePath(pathKey)` — that would treat the JSON-encoded
      // string as a NEW dotted path and produce a single segment
      // containing the literal JSON.
      const segments = segmentsForPathKey(pathKey)
      if (segments === null) continue
      if (!pathStartsWith(segments, scope)) continue
    }
    errors.push(...entries)
  }
  return errors
}

/**
 * `true` if `target`'s segments start with `prefix`. Used to honour the
 * per-path scope of `validate(path)` / `validateAsync(path)` — only
 * blank paths inside the validated subtree contribute. An empty prefix
 * matches every path.
 */
function pathStartsWith(target: Path, prefix: Path): boolean {
  if (prefix.length > target.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (!Object.is(target[i], prefix[i])) return false
  }
  return true
}

export function applyInvalidSubmitPolicy<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  formInstanceId: string,
  policy: OnInvalidSubmitPolicy
): void {
  if (policy === 'none') return
  const target = state.getFirstErrorElement(formInstanceId)
  if (target === null) return
  if (policy === 'scroll-to-first-error') {
    target.element.scrollIntoView()
    return
  }
  if (policy === 'focus-first-error') {
    // `focusVisible: true` asks the UA to paint a focus ring as if
    // `:focus-visible` matched. Without it, focus moved by script right
    // after a pointer-driven submit doesn't satisfy the heuristic for
    // non-text controls (radio / checkbox / custom widgets), so the
    // field is focused but ringless and the user can't see where focus
    // landed. Honored where supported, silently ignored elsewhere.
    target.element.focus({ focusVisible: true })
    return
  }
  // 'both' — scroll first, then focus with preventScroll so the
  // browser doesn't undo the explicit scroll. `focusVisible` paints the
  // ring on the moved-to field even for non-text controls.
  target.element.scrollIntoView()
  target.element.focus({ preventScroll: true, focusVisible: true })
}
