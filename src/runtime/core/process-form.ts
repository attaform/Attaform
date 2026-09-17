import { getCurrentScope, onScopeDispose, ref, watchEffect, type Ref } from 'vue'
import type {
  ErrorInput,
  FormKey,
  HandleSubmit,
  OnError,
  OnSubmit,
  ReactiveValidationStatus,
  SchemaParseResult,
  SubmitHandler,
  ValidationError,
  ValidationResponse,
} from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { __DEV__ } from './dev'
import { AttaformErrorCode } from './error-codes'
import { groupErrorsByKey, normalizeErrorInput, SubmitErrorHandlerError, toError } from './errors'
import {
  canonicalizePath,
  isPathPrefix,
  segmentsForPathKey,
  type Path,
  type Segment,
} from './paths'

/**
 * Stores that have already drawn the "validate() called outside an effect
 * scope" warning. One warn per store keeps the diagnostic loud the first time
 * and silent after, so a hot-loop caller does not fill the console.
 */
const warnedNoScopeStores: WeakSet<FormStore<GenericForm>> | null = __DEV__
  ? new WeakSet<FormStore<GenericForm>>()
  : null

/**
 * Whether `value` is a well-constructed `ErrorInput`, something the shared
 * normalizer can turn into a meaningful `ValidationError`. A real `Error`
 * qualifies, as does a plain object carrying a non-empty string `message`, an
 * array `path`, or both. Anything else, a bare primitive, `null`, `undefined`
 * or a shapeless object, would normalize to an empty "Unknown error", so the
 * submit-throw path handles it separately.
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
 * Turn whatever an `onSubmit` callback threw into the `ValidationError[]` for
 * the user-error layer, all under `atta:submit-error`. A well-constructed
 * throw, or an array of them, normalizes honouring its own `path` and `code`,
 * so a `{ path: ['email'], message }` becomes a field-scoped error while a bare
 * `Error` lands form-level. A garbage throw still injects one form-level entry
 * carrying the normalizer's canonical fallback, matching `setErrors`, and
 * reports `messageless` so the caller can nudge the dev in development.
 */
function deriveSubmitErrors(err: unknown): { entries: ValidationError[]; messageless: boolean } {
  if (Array.isArray(err) && err.length > 0 && err.every(isErrorInputLike)) {
    return {
      entries: err.map((item) =>
        normalizeErrorInput(item, undefined, AttaformErrorCode.SubmitError)
      ),
      messageless: false,
    }
  }
  if (isErrorInputLike(err)) {
    return {
      entries: [normalizeErrorInput(err, undefined, AttaformErrorCode.SubmitError)],
      messageless: false,
    }
  }
  // Garbage: a primitive, null, undefined, a shapeless object, or an array
  // holding a non-ErrorInput. Run an empty ErrorInput through the SAME
  // normalizer `setErrors` uses, so the rendered message is its canonical
  // fallback rather than a bespoke submit string. `toError`'s raw diagnostic
  // still lands on `submitError`; this is its rendered projection.
  return {
    entries: [normalizeErrorInput({}, undefined, AttaformErrorCode.SubmitError)],
    messageless: true,
  }
}

/**
 * `validate` and `handleSubmit`, both built against a `FormStore<F>`.
 *
 * Validation is async end-to-end: `AbstractSchema.validateAtPath` returns a
 * promise, so every caller here awaits. The reactive `validate()` ref carries a
 * `pending` flag separating in-flight from settled, and a per-call generation
 * counter drops a stale result.
 */

export type BuildProcessFormOptions = {
  /**
   * Called inside `handleSubmit` when validation fails, after the error store
   * is populated and before the consumer's `onError`. The form API supplies its
   * `focusOnInvalidSubmit` behaviour here; with nothing supplied, a failed
   * submit moves neither focus nor viewport.
   */
  applyInvalidSubmit?: () => void
}

export function buildProcessForm<F extends GenericForm, Out extends GenericForm = F>(
  state: FormStore<F, Out>,
  options: BuildProcessFormOptions = {}
) {
  const applyInvalidSubmit = options.applyInvalidSubmit

  function validate(pathInput?: string | Path): Readonly<Ref<ReactiveValidationStatus<F>>> {
    // Start pending: the first async run has not settled. When validation
    // fires, the ref takes `{ pending: false, ... }` with the resolved status,
    // and a write from an older generation is dropped so a slow earlier run
    // cannot overwrite a newer result.
    const result = ref<ReactiveValidationStatus<F>>({
      pending: true,
      errors: undefined,
      success: false,
      formKey: state.formKey,
    }) as Ref<ReactiveValidationStatus<F>>

    let gen = 0

    async function kickoff(data: unknown, path: Path | undefined, captured: number): Promise<void> {
      // Runs on a microtask outside the watchEffect's sync frame, where the
      // activeEffect stack is empty, so reads and writes here do NOT track
      // against the effect and writing `activeValidations` or `result` cannot
      // re-trigger the watchEffect below.
      //
      // The `pending: true` write sits INSIDE the guarded region, so a sync
      // watcher on `meta.validating` or on the returned ref that throws cannot
      // leak the counter: the shell's finally still decrements.
      await withActiveValidation(async () => {
        try {
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
          // The adapter contract is "return errors, do not throw", but a
          // throwing one must not leave the `validate()` ref pending forever.
          // Wrap it as a single adapter-level error so the form surfaces
          // something.
          result.value = settled(adapterThrowResponse(err))
        }
      })
    }

    const stop = watchEffect(() => {
      // Read `form.value`, or the subtree at `path`, so the effect re-runs on
      // any mutation. Touch NO other reactive state here, or the writes in
      // `kickoff` re-trigger the effect in a hot loop; deferring through
      // `queueMicrotask` puts them on a clean task where `activeEffect` is
      // null.
      const segments = pathInput === undefined ? undefined : toSegments(pathInput)
      const dataAtPath = segments === undefined ? state.form.value : state.getValueAtPath(segments)
      const localGen = ++gen
      queueMicrotask(() => {
        void kickoff(dataAtPath, segments, localGen)
      })
    })
    // Tie the watcher's lifetime to the caller's effect scope, so a component
    // calling `validate()` in setup releases it on unmount. A call from a raw
    // context leaks the watcher for the run's duration, which is why the
    // dev-warn above exists.
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
   * Shared shell for the imperative validation path, meaning `parse` in both
   * modes. It resolves the path segments, runs the `activeValidations`
   * lifecycle, translates an adapter throw into a structured failure, and
   * performs the pre-validate cancellation and post-validate schema-error
   * commit that `commit: true` switches on. Composing the blank class into the
   * refinement is the caller's job.
   *
   * The discriminated `ok` branch matters: an adapter-throw response is
   * returned verbatim, never folding `derivedBlankErrors` into it.
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
    return await withActiveValidation(async () => {
      try {
        // Abort in-flight per-field runs so a late write cannot clobber the
        // authoritative imperative result, as `handleSubmit` does.
        if (config.cancelInFlight) state.cancelFieldValidation()
        const refinement = await runRefinementValidation(dataAtPath, segments)
        // Commit the refinement to the schema side at the validated scope. The
        // adapter emits issue paths relative to the sub-schema it parsed, `[]`
        // for a leaf, while a whole-form pass is already absolute, so re-stamp
        // with `segments` to land at canonical store keys.
        // `applySchemaErrorsForSubtree` replaces every key under the scope, so
        // stale entries drop and current ones keep their insertion slots.
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
      }
    })
  }

  /**
   * The one `activeValidations` shell. It increments inside the guarded region,
   * so a sync watcher on `meta.validating` that throws on the increment still
   * hits the finally, runs `fn`, and decrements with the clamp on every exit
   * path. Every validation surface rides it, the reactive `validate()` kickoff,
   * the imperative paths and `handleSubmit`'s pre-dispatch pass, so the counter
   * can neither leak nor steal a concurrent run's count.
   */
  async function withActiveValidation<T>(fn: () => Promise<T>): Promise<T> {
    try {
      state.activeValidations.value += 1
      return await fn()
    } finally {
      state.activeValidations.value = Math.max(0, state.activeValidations.value - 1)
    }
  }

  /**
   * Imperative one-shot parse. It subscribes to no form reactivity; each call
   * runs the full pipeline once against the current snapshot, refinements,
   * `.transform()`s and blank-required composition alike, and RETAINS the
   * parsed data. What comes back is what `form.values` would be if every
   * refinement passed and every transform fired: storage holds the
   * pre-transform input view, Attaform running preprocess at write time and
   * never `.transform()`, and `parse` is the on-demand read of the
   * post-transform output. `handleSubmit`'s callback receives the same shape.
   *
   * `commit: false` is a PURE read: no store write, no effect on in-flight
   * field validation, just "what would the parsed form look like right now",
   * independent of the live `form.errors` surface.
   *
   * `commit: true` makes the run authoritative. It cancels in-flight per-field
   * validation, as `handleSubmit` does, so a late resolution cannot clobber the
   * result, and writes the refinement verdict back to the schema side at the
   * validated scope, so `await parse(path, { commit: true })` lands a
   * deterministic view of `form.errors.<path>` regardless of the background
   * race.
   *
   * Always async, with no synchronous variant by design. A schema can carry
   * async refinements or async transforms, so a sync parse would silently miss
   * them the moment one was added. One always-awaited `parse` closes that
   * category. `parse('email', ...)` scopes the run to that path.
   *
   * Never rejects on adapter misbehaviour: a throwing adapter, or any pipeline
   * failure, lands in the response as `success: false` with an `AdapterThrew`
   * error.
   */
  async function parse(
    pathInput: string | Path | undefined,
    options: { commit: boolean }
  ): Promise<ValidationResponse<Out>> {
    const result = await runImperativeValidation(pathInput, {
      cancelInFlight: options.commit,
      commitToSchemaErrors: options.commit,
    })
    if (!result.ok) return result.error
    return composeWithDerivedBlank(result.refinement, result.segments)
  }

  /**
   * Build an adapter-threw failure response, shared by `parse` and the reactive
   * `validate()`'s kickoff so every validation surface presents one shape on
   * adapter misbehaviour. `data` is `undefined`, so the `ValidationResponse`
   * union resolves to its no-data arm.
   */
  function adapterThrowResponse(err: unknown): ValidationResponse<Out> {
    return {
      success: false,
      data: undefined,
      errors: [
        {
          message: adapterThrowMessage(err),
          path: [],
          code: AttaformErrorCode.AdapterThrew,
        },
      ],
      formKey: state.formKey,
    }
  }

  /**
   * Refinement-only adapter pass-through. Returns the schema's refinement-class
   * result and leaves the blank-required class alone, that living reactively on
   * `state.derivedBlankErrors`. Callers compose the consumer-facing response
   * through `composeWithDerivedBlank`, so the schema-side writer only ever sees
   * refinement errors and the blank class is never counted twice.
   */
  async function runRefinementValidation(
    data: unknown,
    path: Path | undefined
  ): Promise<ValidationResponse<Out>> {
    return stampFormKey(await state.schema.validateAtPath(data, path), state.formKey)
  }

  /**
   * Fold the reactively-derived blank-required errors into a refinement
   * response. The derived class always reflects current state, so a snapshot at
   * call time matches what `form.errors` shows in the same tick.
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
   * `handleSubmit(onSubmit, onError?)` builds a submit handler. The two
   * callbacks dispatch on Attaform's validation verdict: a failed pre-dispatch
   * validation populates the schema-error store and calls `onError`, never
   * `onSubmit`, and a passing one calls `onSubmit` with the parsed data. So
   * `onError` fires iff validation rejected the submit; a throw, a `setErrors`
   * or a clean return out of `onSubmit` is the consumer's own outcome and never
   * routes back through it.
   *
   * A throwing or rejecting `onError` has its value wrapped in
   * `SubmitErrorHandlerError`, so inspection can tell a crashed error handler
   * from a failed submit body. Both converge on `submitError`, and neither
   * re-throws out of the handler.
   *
   * It drives the submission-lifecycle refs on the store:
   *   - `submitting` flips true at entry and false in `finally`.
   *   - `submissionAttempts` increments once per call whatever the outcome,
   *     because "how many times did the user click submit" is the
   *     consumer-facing question.
   *   - `submitError` clears at entry and captures anything thrown from the
   *     consumer callback, or the wrapped error-handler error, coerced to a
   *     real `Error`. A throw out of `onSubmit` ALSO pipes into the user-error
   *     layer under `atta:submit-error`, so it surfaces on `form.errors`,
   *     `meta.ownErrors` and `firstOwnError`, path-scoped when the throw was
   *     well-constructed and form-level otherwise. A wrapped
   *     `SubmitErrorHandlerError` is the exception and stays `submitError`-only.
   *
   * The handler does NOT re-throw. A rejecting `onSubmit` bound to `@submit`
   * would surface as a `window` unhandledrejection, a phantom crash for an
   * already-handled server failure. Template and imperative callers both read
   * the outcome from `submitError` and `submitted`, and the returned promise
   * always resolves.
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
      // Re-entry guard: a submission is already in flight. The double-click
      // case, `submit()` firing while a prior call still awaits validation or
      // the consumer's callback, would otherwise run the callback twice and
      // duplicate its side effects. `preventDefault` already ran above, so a
      // duplicate browser submit is suppressed even on this early return.
      //
      // The swallow is deliberate and silent for a DOM-driven double submit: a
      // second click is user input the guard exists to absorb, and there is
      // nothing for the consumer to fix. A call carrying NO event is code,
      // though, and code that silently does nothing is the worst shape to
      // debug: no callback, no `submitting` flip, no error, no
      // `firstOwnError`. Name it in dev so the loss is visible.
      if (state.activeSubmissions.value > 0) {
        if (__DEV__ && event === undefined) {
          console.warn(
            `[attaform] handleSubmit: a submit is already in flight on form ` +
              `"${String(state.formKey)}", so this call was ignored; its callback ` +
              `never ran. Await the first submit before starting another, or move ` +
              `the work into that submit's callback.`
          )
        }
        return
      }
      // A counter rather than a flag, so a generation bump during the run can
      // still tell the live submission from a stale prior one winding down,
      // through the generation snapshot taken at entry. `submitError` is shared
      // with the prior call's capture only when no `reset()` fired between
      // entry and throw; see the catch.
      const genAtEntry = state.submissionGeneration.value
      try {
        // Every lifecycle setter sits inside the try, so a throw from one, a
        // sync `watch` on `meta.submitting` or a defensive throw out of
        // `cancelFieldValidation`, still lands in the finally. Outside it, an
        // early-setup throw leaks `activeSubmissions` at 1 forever and silently
        // blocks every later submit. The finally's clamp already handles
        // partial-increment underflow.
        state.activeSubmissions.value += 1
        state.submitting.value = true
        state.submitError.value = null
        // Clear user-set errors, so a fresh attempt starts from a clean slate.
        // At ENTRY, before validation and before the callback: the callback is
        // where the NEW errors are set, so clearing on the way out would wipe
        // what was just set, and a client-validation failure never reaches the
        // callback, so only an entry-clear drops a prior server error there
        // too. The validation pass below recomputes the schema side; this is
        // the user store's equivalent. Unconditional and total, form and field,
        // because the dominant use of `setErrors` is the server's verdict on
        // the prior attempt, which a new attempt supersedes.
        state.clearUserErrors()
        // Drain in-flight async register transforms before validating, so a
        // submit fired the instant after a keystroke parses the field's
        // resolved value rather than its stale pre-transform one.
        //
        // Deliberately BEFORE `cancelFieldValidation()`: a transform committing
        // during the drain runs `onFormChange` and can schedule a fresh field
        // validation, and draining first lets the cancel below sweep those up,
        // so no stray run races this submit's authoritative whole-form pass.
        // The `while` re-checks because a transform can start during the await.
        // `settleTransforms` resolves and never rejects, so a failed transform
        // does not throw the submit: it proceeds against committed storage,
        // where a failed field keeps its prior value plus `transformError` for
        // the validation pass to flag. `meta.submitting` is already true, so
        // the button stays disabled across the drain, and the await is the
        // correctness net for where it is not.
        while (state.activeTransforms.value > 0) await state.settleTransforms()
        // Abort in-flight per-field runs so a late write cannot clobber the
        // authoritative submit result, and clear the debounce timers that never
        // fired.
        state.cancelFieldValidation()
        // Drop the anti-flash display state too. An explicit submit says "show
        // me the verdict now", so a leftover show-delay hold or a min-visible
        // spinner timer from pre-submit typing must not outlive it and delay
        // the reveal. `cancelFieldValidation` already cleared the streak
        // anchors, so the next read recomputes the settled verdict against the
        // post-submit gate immediately.
        state.displayEngine.clear()
        const refinement = await withActiveValidation(() =>
          runRefinementValidation(state.form.value, undefined)
        )
        const merged = composeWithDerivedBlank(refinement, undefined)
        // Generation guard: a `reset()` during the await zeroed the submission
        // surface, so this verdict is about state that has been replaced. Skip
        // the schema-error write and leave reset's empty store empty, but still
        // run the consumer's `onError`, since the result is theirs to
        // discard.
        const generationStillValid = state.submissionGeneration.value === genAtEntry
        if (!merged.success) {
          // Source-segregated writer: only refinement-class errors land on the
          // schema side. The blank-required class is already derived from
          // `blankPaths`, so writing it here would double-count, and
          // user-injected errors live in their own store, untouched by
          // validation.
          if (generationStillValid) {
            if (refinement.success) {
              state.clearSchemaErrors()
            } else {
              state.setAllSchemaErrors(refinement.errors)
            }
          }
          // Run the invalid-submit nudge AFTER populating the error store, so
          // the first-error walk sees the fresh entries, and BEFORE the
          // consumer's `onError`, so their logic can override it by focusing
          // something else. Skipped on a stale generation, the post-reset form
          // having no errors to focus.
          if (generationStillValid) {
            applyInvalidSubmit?.()
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
        // Schema-only clear. A successful submit means refinement validation
        // passed AND no required-blank errors exist, so the schema side empties
        // while user-injected errors persist: a consumer managing warning or
        // info state through `setErrors` keeps that lifecycle. Skipped when a
        // reset already cleared and bumped the generation, or an error injected
        // by a post-reset mutation would be wiped.
        if (generationStillValid) {
          state.clearSchemaErrors()
        }
        await onSubmit(merged.data)
        // A callback that left errors in the user layer did not succeed. This
        // is the documented `setErrors(...); return` server-rejection path, and
        // the entry-clear at submit start means any user error present now was
        // set by this callback. Focus the first error, generation-gated like
        // the validation-failure branch, and leave `submitted` false.
        //
        // `onError` is deliberately NOT called. The two callbacks dispatch on
        // Attaform's VALIDATION verdict, and `onError` fires iff pre-dispatch
        // validation rejected the submit, meaning `onSubmit` never ran. Once
        // `onSubmit` has run, Attaform has already ruled the submit valid, and
        // the consumer's own `setErrors` is a state write rather than a
        // re-verdict.
        if (hasUserErrorEntries(state)) {
          if (state.submissionGeneration.value === genAtEntry) {
            applyInvalidSubmit?.()
          }
          return
        }
        // Flip `submitted` true once the consumer callback resolved without
        // throwing AND left no errors behind, independent of
        // `submissionAttempts`. Generation-guarded: a `reset()` during the
        // await already zeroed the submission surface, so honour that intent
        // and leave `submitted` at its post-reset `false`.
        if (state.submissionGeneration.value === genAtEntry) {
          state.submitted.value = true
        }
        // Notify subscribers: the wizard's step-advance handler, the devtools
        // timeline. Fires only when the consumer callback resolved, so a
        // validation failure or a callback throw skips it.
        state.emitSubmitSuccess()
      } catch (err) {
        // Publish the error only when no `reset()` fired since this submission
        // began; otherwise the consumer zeroed the submission surface and
        // re-raising into `submitError` would undo their intent. Coerced to a
        // real `Error`, so the slot is `Error | null` and never `unknown`, with
        // a non-Error throw keeping its origin on `.cause`.
        //
        // Deliberately NOT re-thrown. The handler is bound to DOM events, so a
        // rejected promise here surfaces as a `window` unhandledrejection, a
        // phantom crash for what is usually an already-handled server failure.
        // The error is recorded on `submitError` for template and imperative
        // callers alike, and the `finally` still resets `submitting`, so a
        // rejected submit never strands the button.
        if (state.submissionGeneration.value === genAtEntry) {
          state.submitError.value = toError(err)
          // `submitError` alone is a raw-`Error` inspection channel most
          // templates never render, so a thrown submit would be invisible in
          // the UI. Pipe the throw into the user-error layer too, through the
          // normalizer `setErrors` uses, so it surfaces on `form.errors`,
          // `meta.ownErrors` and `firstOwnError` where the form already reads:
          // path-scoped for a well-constructed `{ path, message }` and
          // form-level otherwise. `submitError` keeps the raw Error; this is
          // the same failure rendered, not a duplicate.
          //
          // `SubmitErrorHandlerError` is excluded: it wraps a crash in the
          // consumer's VALIDATION `onError` handler rather than a failed
          // submit, so it stays a pure `submitError` diagnostic.
          if (!(err instanceof SubmitErrorHandlerError)) {
            const { entries, messageless } = deriveSubmitErrors(err)
            // Group by path, so a thrown array spanning several fields writes
            // one bucket per path. Per-path writes MERGE: a bucket the callback
            // set elsewhere through `setErrors` before it threw survives, and a
            // bucket at a colliding path is replaced, the throw being the newer
            // verdict. Keys come fresh out of the grouper, so the segment
            // lookup always hits, and the null guard keeps a corrupt key from
            // throwing into the consumer app.
            for (const [key, bucket] of groupErrorsByKey(entries)) {
              const segments = segmentsForPathKey(key)
              if (segments === null) continue
              state.setUserErrorsForPath([...segments], bucket)
            }
            // Focus the first error, as the validation-failure and
            // leftover-errors branches do. A form-level error owns no element,
            // so it is a no-op there.
            applyInvalidSubmit?.()
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
        state.activeSubmissions.value = Math.max(0, state.activeSubmissions.value - 1)
        // `activeSubmissions` always decrements, the submission being done,
        // but the VISIBLE counters, `submitting` and `submissionAttempts`,
        // update only while the generation still matches. A post-reset
        // completion is a no-op to the consumer: reset already flipped
        // `submitting` false and zeroed the attempts, and the finished
        // submission belongs to the prior generation.
        if (state.submissionGeneration.value === genAtEntry) {
          state.submitting.value = state.activeSubmissions.value > 0
          state.submissionAttempts.value += 1
        }
      }
    }
    return submitHandler
  }

  return { validate, parse, handleSubmit }
}

/**
 * Name the form a schema verdict belongs to.
 *
 * An `AbstractSchema` answers for the SCHEMA, one instance being shared by
 * every form built on it, so it cannot know which asked and returns a verdict
 * with no form key. The owning store holds that identity and stamps it here.
 */
function stampFormKey<T>(verdict: SchemaParseResult<T>, formKey: FormKey): ValidationResponse<T> {
  if (verdict.success) return { ...verdict, formKey }
  // Split on `data` as well as `success`: "failed with no data" and "failed
  // with partial data" are separate arms of the public response, and a spread
  // alone cannot tell them apart.
  return verdict.data === undefined
    ? { data: undefined, errors: verdict.errors, success: false, formKey }
    : { data: verdict.data, errors: verdict.errors, success: false, formKey }
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

function adapterThrowMessage(err: unknown): string {
  if (err instanceof Error) return `Adapter validateAtPath threw: ${err.message}`
  return 'Adapter validateAtPath threw a non-Error value'
}

/**
 * Snapshot the reactively-derived blank-required errors, filtered to paths
 * inside `scope`, or all of them when `scope` is `undefined`. The errors
 * themselves are computed on the store; this takes a scoped slice for the
 * validation or submit response. Mutating the returned array is safe, the
 * store's computed building a fresh map per recompute.
 */
/** `true` when any cell in the tagged store holds consumer-set (user-side) entries. */
function hasUserErrorEntries<F extends GenericForm>(state: FormStore<F, GenericForm>): boolean {
  for (const cell of state.errorCells.values()) {
    if (cell.user.length > 0) return true
  }
  return false
}

function collectScopedBlankErrors<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  scope: Path | undefined
): ValidationError[] {
  const derived = state.derivedBlankErrors.value
  if (derived.size === 0) return []
  const errors: ValidationError[] = []
  for (const [pathKey, entries] of derived) {
    if (scope !== undefined) {
      // A canonical PathKey hits the cache; a corrupt one returns null and is
      // skipped. Do NOT round-trip through `canonicalizePath(pathKey)`, which
      // reads the JSON-encoded string as a new dotted path and produces one
      // segment holding the literal JSON.
      const segments = segmentsForPathKey(pathKey)
      if (segments === null) continue
      if (!isPathPrefix(scope, segments)) continue
    }
    errors.push(...entries)
  }
  return errors
}
