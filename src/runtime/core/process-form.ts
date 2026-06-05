import { getCurrentScope, onScopeDispose, ref, watchEffect, type Ref } from 'vue'
import type {
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
import { SubmitErrorHandlerError, toError } from './errors'
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
   * wrote, while `(await form.process()).data?.email` is the boolean
   * the transform produces. handleSubmit's callback already receives
   * this same shape (it's what the parse pipeline emits before
   * onSubmit runs); `process()` is the standalone read-only form.
   *
   * Async because refinements may be async (`.refine(async ...)`).
   * The path-scoped variant mirrors `validateAsync(path?)` —
   * `process('email')` returns the parsed value at that path only.
   *
   * Unlike `validateAsync`, `process` does NOT cancel in-flight
   * field validation and does NOT commit the parsed result to
   * `schemaErrors` — `process` is a pure read of "what would the
   * parsed form look like right now", independent of the live
   * `form.errors` surface.
   *
   * Like `validateAsync`, this never rejects on adapter misbehavior:
   * a throwing adapter (or any pipeline failure) lands in the
   * response as a `success: false, errors: [{ code: AdapterThrew }]`
   * shape so the library stays robust against a bad adapter.
   */
  async function process(pathInput?: string | Path): Promise<ValidationResponse<Out>> {
    const result = await runImperativeValidation(pathInput, {
      cancelInFlight: false,
      commitToSchemaErrors: false,
    })
    if (!result.ok) return result.error
    return composeWithDerivedBlank(result.refinement, result.segments)
  }

  /**
   * Build an adapter-threw failure response. Shared between
   * `validateAsync`, `process`, and the reactive `validate()`'s
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
   * handleSubmit(onSubmit, onError?) builds a submit handler. On success:
   * clear errors, call onSubmit. On failure: populate errors via
   * setAllErrors, then call onError if provided.
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
   *     a real `Error` via `toError`. The handler does NOT re-throw: a
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
        // setFieldErrors keep ownership of that lifecycle. Skip the
        // clear when reset already cleared (and bumped gen) — any
        // errors injected by post-reset user mutations would be wrongly
        // wiped otherwise.
        if (generationStillValid) {
          state.clearSchemaErrors()
        }
        await onSubmit(merged.data)
        // Flip `submitted` true once the user callback resolved
        // without throwing — independent of `submissionAttempts`.
        // Generation guard: a `reset()` that fired during the await
        // already zeroed the submission surface; honor the consumer's
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

  return { validate, validateAsync, process, handleSubmit }
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
    target.element.focus()
    return
  }
  // 'both' — scroll first, then focus with preventScroll so the
  // browser doesn't undo the explicit scroll.
  target.element.scrollIntoView()
  target.element.focus({ preventScroll: true })
}
