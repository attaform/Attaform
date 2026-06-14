import { computed, getCurrentScope, onScopeDispose, reactive, readonly, type Ref } from 'vue'
import type {
  BlankPathsView,
  CoercionRegistry,
  DisplayState,
  FormErrorsSurface,
  FormHistoryNamespace,
  FormMeta,
  GetDisplayState,
  OnChangeHandler,
  OnChangeOptions,
  OnChangeSource,
  OnInvalidSubmitPolicy,
  ReactiveValidationStatus,
  RegisterValue,
  SetValueOptions,
  UseFormReturnType,
  ValidateOn,
  ValidationError,
  ValidationResponse,
  ValidationResponseWithoutValue,
  WriteMeta,
} from '../types/types-api'
import type { DeepPartial, DefaultValuesInput, GenericForm } from '../types/types-core'
import { __DEV__ } from './dev'
import type { FormStore } from './create-form-store'
import { structuralSnapshot } from './diff-apply'
import { buildErrorsProxy } from './errors-proxy'
import { buildFieldArrayApi } from './field-arrays'
import {
  aggregateErrorsAt,
  buildContainerFieldStateBase,
  buildFieldStateAccessor,
  type FieldStateBase,
  type FormMetaBase,
} from './field-state-api'
import { buildFieldStateProxy } from './field-state-proxy'
import type { HistoryModule } from './history'
import { getAtPath } from './path-walker'
import {
  canonicalizePath,
  FORM_ERRORS_PATH,
  FORM_ERRORS_PATH_KEY,
  ROOT_PATH,
  ROOT_PATH_KEY,
  segmentsForPathKey,
  type Path,
  type PathKey,
} from './paths'
import { applyInvalidSubmitPolicy, buildProcessForm } from './process-form'
import { buildRegister } from './register-api'
import { safeAssign } from './safe-assign'
import { isUnset, unset } from './unset'
import {
  blankForKind,
  expandUnsetAt,
  substituteUnsetSentinels,
  walkUnsetSentinels,
} from './unset-walker'
import { buildValuesProxy } from './values-proxy'

export type BuildFormApiOptions = {
  /** Forwarded to buildProcessForm. See `UseFormConfiguration.onInvalidSubmit`. */
  onInvalidSubmit?: OnInvalidSubmitPolicy
  /**
   * Pre-wired history module backing `form.history.{undo, redo, clear,
   * canUndo, canRedo, size}`. When omitted, the namespace's methods
   * are inert no-ops and its reactive flags read `false` / `0` —
   * consumers get a consistent API shape without opting into the feature.
   */
  history?: HistoryModule
  /**
   * Per-`useForm()`-instance config that the API layer threads through
   * writes / register / field-state so each callsite honors its own
   * `validateOn` / `debounceMs` / `getDisplayState` / `coerce` /
   * `rememberVariants` even when sharing a FormStore with sibling
   * instances (e.g., a modal and main form rendering the same logical
   * form). Anything omitted falls through to the store's
   * construction-time captured values.
   */
  validateOn?: ValidateOn
  debounceMs?: number
  getDisplayState?: GetDisplayState
  coerce?: boolean | CoercionRegistry
  rememberVariants?: boolean
  /**
   * Per-`useForm()`-instance `autoAria` resolution. Threaded into
   * register so each binding's `ariaEnabled` reflects this callsite's
   * setting. Omitted (undefined) is the library default, `true`.
   */
  autoAria?: boolean
}

/**
 * Build the public form API from a FormStore. Extracted from
 * `useAbstractForm` so that both the top-level form entry (which creates
 * a fresh state) and `injectForm` (which resolves state from an
 * ambient provide/inject) produce identical API shapes without
 * duplicating the wiring.
 *
 * `buildFormApi` does not interact with the registry, consumer ref-counts,
 * or the current Vue instance — those concerns belong to the caller. This
 * function is pure over (FormStore, options) → api.
 */
export function buildFormApi<Form extends GenericForm, GetValueFormType extends GenericForm = Form>(
  state: FormStore<Form, GetValueFormType>,
  formInstanceId: string,
  options: BuildFormApiOptions = {}
): UseFormReturnType<Form, GetValueFormType> {
  // Compose the per-instance write-meta bag once. Each public write
  // method below splices `instance: instanceMeta` into its forwarded
  // `meta` so the store's runtime reads of `validateOn` / `debounceMs`
  // / `rememberVariants` honor THIS instance's config. Sibling
  // instances sharing the same FormStore (modal + main) carry their
  // own instanceMeta in their own buildFormApi closure.
  const instanceMeta: WriteMeta['instance'] | undefined = (() => {
    const bag: {
      -readonly [K in keyof NonNullable<WriteMeta['instance']>]: NonNullable<
        WriteMeta['instance']
      >[K]
    } = {}
    if (options.validateOn !== undefined) bag.validateOn = options.validateOn
    if (options.debounceMs !== undefined) bag.debounceMs = options.debounceMs
    if (options.rememberVariants !== undefined) bag.rememberVariants = options.rememberVariants
    return Object.keys(bag).length > 0 ? bag : undefined
  })()
  // Helper used by every internal `state.setValueAtPath` call below to
  // splice the instance bag into the forwarded WriteMeta. Identity
  // when no instance overrides are active.
  const withInstanceMeta = (meta?: WriteMeta): WriteMeta | undefined => {
    if (instanceMeta === undefined) return meta
    return meta === undefined ? { instance: instanceMeta } : { ...meta, instance: instanceMeta }
  }

  // Re-mark each substituted leaf blank via a same-value setValueAtPath
  // with `{ blank: true }` so the gate hook re-adds them (any DU reshape
  // that ran during the parent write trimmed blanks under the variant
  // path). Reading from storage rather than `getEmptyValueAtPath` keeps
  // DU discriminator stubs intact.
  const reMarkBlanksAfterSubstitution = (paths: readonly PathKey[]): void => {
    for (const pathKey of paths) {
      const blankSegments = segmentsForPathKey(pathKey)
      if (blankSegments === null) continue
      state.setValueAtPath(
        blankSegments,
        state.getValueAtPath(blankSegments),
        withInstanceMeta({ blank: true })
      )
    }
  }

  // Thunk producing a fresh `FormMetaBase` on each call — the omit'd-shape
  // second argument to `state.getDisplayState`. Each call runs inside a
  // field-state computed, so every reactive primitive a getter touches
  // registers as a dependency of THAT computed; what a predicate does not
  // read, the field does not track (see the per-field laziness below). The
  // rollup getters bypass the cached field-state accessor by calling
  // `buildContainerFieldStateBase` directly — going through the accessor would
  // recurse through the root path's own showErrors computation.
  const getFormMetaBase = (): FormMetaBase => {
    // The whole-form ROLLUP is lazy: its fields are getters that build
    // `rootBase` once, on first access. Building it eagerly here was P3 vector
    // 1 — it made every field-state computed depend on every leaf (the edited
    // leaf's `updatedAt` bumps on each write), re-rendering all fields per
    // keystroke. The library-default predicate reads no rollup field (only the
    // O(1) form-level scalars below), so it never tracks the rollup. A custom
    // predicate that reads `valid` / `errorCount` / ... trips the shared memo
    // and tracks the rollup, exactly as before. Output is byte-identical for
    // every predicate; only the rollup dependency tightens. Getters are
    // enumerable, so `Object.keys` / spread / `JSON.stringify` over the meta
    // arg are unchanged. (Same getter-over-computed pattern the public
    // `form.meta` uses below.)
    //
    // The rollup's `validatingSince` is for the field machine, not the
    // predicate's meta arg — unused here; the root field-state computed threads
    // the root's own anchor when it resolves `form.meta.displayState`.
    let rollup: FieldStateBase | undefined
    const rootBase = (): FieldStateBase =>
      (rollup ??= buildContainerFieldStateBase(
        state,
        ROOT_PATH,
        ROOT_PATH_KEY,
        formInstanceId
      ).base)
    return {
      // Rollup-derived (FieldStateBase) — the whole rollup builds once, on the
      // first access of any of these.
      get value() {
        return rootBase().value
      },
      get original() {
        return rootBase().original
      },
      get pristine() {
        return rootBase().pristine
      },
      get dirty() {
        return rootBase().dirty
      },
      get focused() {
        return rootBase().focused
      },
      get blurred() {
        return rootBase().blurred
      },
      get touched() {
        return rootBase().touched
      },
      get interacted() {
        return rootBase().interacted
      },
      get blurredAfterInteraction() {
        return rootBase().blurredAfterInteraction
      },
      get connected() {
        return rootBase().connected
      },
      get element() {
        return rootBase().element
      },
      get elements() {
        return rootBase().elements
      },
      get updatedAt() {
        return rootBase().updatedAt
      },
      get errors() {
        return rootBase().errors
      },
      get validating() {
        return rootBase().validating
      },
      get valid() {
        return rootBase().valid
      },
      get transforming() {
        return rootBase().transforming
      },
      get busy() {
        return rootBase().busy
      },
      get transformError() {
        return rootBase().transformError
      },
      get path() {
        return rootBase().path
      },
      get id() {
        return rootBase().id
      },
      get aria() {
        return rootBase().aria
      },
      get key() {
        return rootBase().key
      },
      get blank() {
        return rootBase().blank
      },
      get label() {
        return rootBase().label
      },
      get description() {
        return rootBase().description
      },
      get placeholder() {
        return rootBase().placeholder
      },
      get meta() {
        return rootBase().meta
      },
      get errorCount() {
        return rootBase().errors.length
      },
      // Form-level scalars — EAGER reads, tracked on every field-state eval.
      // They are O(1) refs that never change on a keystroke, so tracking them
      // per field costs nothing on the hot path. Kept eager (NOT lazy like the
      // rollup) because behaviors beyond the predicate's own output depend on
      // every field re-evaluating when they flip — most notably, the display
      // engine is cleared on submit (revealing held spinners), and that
      // imperative reset only becomes visible if `submitting` is a tracked dep
      // of each field. Matches the pre-bust dependency set for these scalars
      // exactly.
      submitting: state.submitting.value,
      submissionAttempts: state.submissionAttempts.value,
      departAttempts: state.departAttempts.value,
      submitError: state.submitError.value,
      submitted: state.submitted.value,
      instanceId: formInstanceId,
    }
  }

  const fieldStateAccessorOptions =
    options.getDisplayState !== undefined ? { getDisplayState: options.getDisplayState } : undefined
  const getRootFieldStateAt = buildFieldStateAccessor(
    state,
    formInstanceId,
    getFormMetaBase,
    fieldStateAccessorOptions
  )
  // Gated `displayState` at any path, reusing the same memoised
  // field-state identity as `form.fields`. Threaded into register so a
  // binding's `ariaDisplayState` carries the exact verdict the visible
  // `form.fields.<path>.displayState` shows. Built before `register`
  // so the closure is ready when the factory bakes each RegisterValue.
  const getDisplayStateAt = (segments: Path): DisplayState =>
    getRootFieldStateAt(segments).value.displayState

  const registerConfig = {
    ...(instanceMeta !== undefined ? { instanceMeta } : {}),
    ...(options.coerce !== undefined ? { coerce: options.coerce } : {}),
    ...(options.autoAria !== undefined ? { autoAria: options.autoAria } : {}),
    getDisplayStateAt,
  }
  const register = buildRegister(state, formInstanceId, registerConfig) as (
    path: string | Path
  ) => RegisterValue<unknown>
  // Don't set `onInvalidSubmit: undefined` — exactOptionalPropertyTypes
  // treats an explicit-undefined value differently from an omitted
  // property. Only pass the key when the consumer opted in.
  const processOptions =
    options.onInvalidSubmit !== undefined ? { onInvalidSubmit: options.onInvalidSubmit } : {}
  const defaultInvalidSubmitPolicy: OnInvalidSubmitPolicy =
    options.onInvalidSubmit ?? 'focus-first-error'
  const {
    validate: validateBuilt,
    validateAsync: validateAsyncBuilt,
    parse: parseBuilt,
    handleSubmit,
  } = buildProcessForm<Form, GetValueFormType>(state, formInstanceId, processOptions)

  const validate = (pathInput?: string) =>
    validateBuilt(pathInput) as Ref<ReactiveValidationStatus<Form>>

  const validateAsync = (pathInput?: string) =>
    validateAsyncBuilt(pathInput) as Promise<ValidationResponseWithoutValue<Form>>

  const parse = (pathInput?: string) =>
    parseBuilt(pathInput) as Promise<ValidationResponse<GetValueFormType>>

  // --- toRef escape hatch — Readonly<Ref<...>> for the rare case
  // a consumer needs ref-shaped interop (external composables that
  // expect a Vue ref, watchers reading a single path). Writes still
  // funnel through `setValue`, never via the ref.
  function pathToRef(pathInput: string): Readonly<Ref<unknown>> {
    const segments = canonicalizePath(pathInput).segments
    return computed(() => getAtPath(state.form.value, segments)) as Readonly<Ref<unknown>>
  }

  function setValueImpl(
    pathOrValue: unknown,
    maybeValue?: unknown,
    maybeOptions?: unknown
  ): boolean {
    // A path is a dotted string or a segment array; with a single argument
    // this is always the whole form. So `(value)` / `(value, options)` are
    // whole-form writes, `(path, value)` / `(path, value, options)` are path
    // writes — disambiguated by the first argument's type, not arity.
    const argc = arguments.length
    const isPathForm = argc >= 2 && (typeof pathOrValue === 'string' || Array.isArray(pathOrValue))
    const options = (isPathForm ? maybeOptions : argc >= 2 ? maybeValue : undefined) as
      | SetValueOptions
      | undefined
    const silent = options?.silent === true
    // Fold the consumer's `{ silent }` opt-out into every write this call
    // makes, alongside the per-instance bag. Silent writes still validate;
    // they only skip the `form.onChange` side-channel.
    const writeMeta = (extra?: WriteMeta): WriteMeta | undefined =>
      withInstanceMeta(silent ? { ...extra, silent: true } : extra)
    if (!isPathForm) {
      // Whole-form: hand the consumer's callback a STABLE structural
      // snapshot of the form, not the live reactive value. The form
      // store mutates `form.value` in place on commit (so deep-watch
      // dependencies fire only for paths that actually changed), so
      // a callback that closes over `prev` would otherwise see its
      // `prev` reference silently follow the post-commit state. The
      // consumer's RETURN value passes through mergeStructural so any
      // gaps the consumer introduced (partial replacement) are filled
      // from defaults.
      const next =
        typeof pathOrValue === 'function'
          ? (pathOrValue as (prev: unknown) => unknown)(structuralSnapshot(state.form.value))
          : pathOrValue
      // Whole-form `unset` sentinels (consumer wrote `setValue(unset)`
      // or returned `unset` for some leaf in a function form) flow
      // through the walker — every leaf gets translated, the cleaned
      // value lands in storage, and the discovered paths land blank-
      // marks via same-value `{ blank: true }` writes that hit the
      // identity short-circuit (bookkeeping-only, no extra history
      // delta). Order matters: the root write FIRST so the
      // descendant-sweep in the gate hook doesn't reap the marks we're
      // about to set. Matching pattern in `writeUnsetAt` below.
      const walked = walkUnsetSentinels(
        next,
        state.schema as unknown as Parameters<typeof walkUnsetSentinels>[1]
      )
      const ok = state.setValueAtPath([], walked.cleanedValues, writeMeta())
      if (!ok) return false
      reMarkBlanksAfterSubstitution(walked.paths)
      return true
    }
    const segments = canonicalizePath(pathOrValue as string | Path).segments
    // `unset` at a specific path — direct or returned by the path-form
    // callback. Routed through a shared helper so leaves, containers,
    // and the discriminator-key special case all land the same shape.
    const writeUnsetAt = (): boolean => {
      // Discriminator-path special case: the slim default at a disc
      // path is the first variant's literal (e.g. 'email'). Seeding
      // that here would silently activate a variant the consumer
      // didn't pick. Use a kind-appropriate primitive blank instead so
      // setValueAtPath's stub branch lands `{ [discKey]: blank }`
      // with no variant body. The container `unset` at a DU's PARENT
      // path is handled by `expandUnsetAt` itself (it stubs the DU
      // there); this leaf check covers writes targeting the
      // discriminator directly.
      const last = segments.length > 0 ? segments[segments.length - 1] : undefined
      if (typeof last === 'string') {
        const parent = segments.slice(0, -1)
        const parentDU = state.schema.getUnionDiscriminatorAtPath(parent)
        if (parentDU?.discriminatorKey === last) {
          const slimDefault = state.schema.getEmptyValueAtPath(segments)
          const blank = blankForKind(slimDefault)
          return state.setValueAtPath(segments, blank, writeMeta({ blank: true }))
        }
      }
      // General case: `expandUnsetAt` writes the slim primitive at
      // leaves, the falsy concrete at arrays/tuples/records, the DU
      // stub `{ [discKey]: kind-blank }` at union containers, and
      // recurses for bare objects — marking every primitive
      // descendant. The schema's declared `.default(N)` is
      // intentionally bypassed — see the matching note in
      // unset-walker.ts.
      const blankPaths: PathKey[] = []
      const expanded = expandUnsetAt(
        segments,
        state.schema as unknown as Parameters<typeof expandUnsetAt>[1],
        blankPaths
      )
      const segmentsKey = canonicalizePath(segments).key
      // Leaf unset (single mark == write path): combine the value-
      // write and blank flag into ONE setValueAtPath call so
      // `applyFormReplacement` captures both the storage change AND
      // the new blank state in a single history delta. Splitting into
      // value-write-without-flag + mark-via-flag identity short-
      // circuits the second call and the blank change escapes history.
      if (blankPaths.length === 1 && blankPaths[0] === segmentsKey) {
        return state.setValueAtPath(segments, expanded, writeMeta({ blank: true }))
      }
      // Container unset: marks live at descendants. Write the value
      // first (this fires `applyFormReplacement` and goes through any
      // DU reshape's blank-trim), then re-mark each blank path via a
      // same-value setValueAtPath with `{blank: true}` so the gate
      // hook re-adds them. Reading from storage rather than
      // `getEmptyValueAtPath` keeps DU discriminator stubs intact:
      // at a disc path the schema's empty is the FIRST variant literal
      // (e.g. `'boat'`), which would silently overwrite the kind-blank
      // `''` the parent write just landed.
      const ok = state.setValueAtPath(segments, expanded, writeMeta())
      if (!ok) return false
      for (const pathKey of blankPaths) {
        const blankSegments = segmentsForPathKey(pathKey)
        if (blankSegments === null) continue
        state.setValueAtPath(
          blankSegments,
          state.getValueAtPath(blankSegments),
          writeMeta({ blank: true })
        )
      }
      return true
    }
    if (isUnset(maybeValue)) return writeUnsetAt()
    // Path-form callback: when the slot at `segments` is unpopulated,
    // hand the consumer the schema's default at that path instead of
    // `undefined` so `(prev) => prev.first.toUpperCase()` is safe.
    // For populated slots, prev is the live value — and stable: the
    // form store reassigns the changed first-segment of `form.value`
    // on commit (so the OLD subtree, which `prev` may close over, is
    // orphaned but unmutated). Consumers caching `prev` see frozen
    // pre-commit state.
    let resolvedValue: unknown
    if (typeof maybeValue === 'function') {
      const current = state.getValueAtPath(segments)
      const prev = current === undefined ? state.schema.getDefaultAtPath(segments) : current
      resolvedValue = (maybeValue as (prev: unknown) => unknown)(prev)
      // Callback returned bare `unset` — route through the same
      // helper as the direct case so leaves, containers, and the
      // discriminator-key special case all land identically.
      if (isUnset(resolvedValue)) return writeUnsetAt()
    } else {
      resolvedValue = maybeValue
    }
    // Nested-unset pass. The leaf-level cases above (`maybeValue ===
    // unset`, callback returned `unset`) are already done; what
    // remains is values like `{ type: 'oversized', lengthCm: unset, … }`
    // — the homepage REPL's discriminated-union Case B write. Without
    // this scrub, the symbols flow into the slim-primitive gate, fail
    // the kind check at the numeric leaf, and the whole write is
    // rejected — leaving the form on the prior variant.
    //
    // The walker is reference-stable on subtrees with no substitutions,
    // so the common case (no nested unsets) returns the same `resolvedValue`
    // identity and produces an empty `paths` list — no extra writes.
    const walked = substituteUnsetSentinels(
      resolvedValue,
      segments,
      state.schema as unknown as Parameters<typeof substituteUnsetSentinels>[2]
    )
    const ok = state.setValueAtPath(segments, walked.cleanedValues, writeMeta())
    if (!ok) return false
    reMarkBlanksAfterSubstitution(walked.paths)
    return true
  }

  // --- Error store API — leaf-aware drillable callable Proxy ---
  // `form.errors` merges three reactive sources at every leaf path:
  //   1. `schemaErrors` — refinement-class errors written by the
  //      validation pipeline (`scheduleFieldValidation`, `handleSubmit`,
  //      construction-time seed, hydration).
  //   2. `derivedBlankErrors` — the reactively-derived "No value supplied"
  //      class. Pure function of `(blankPaths, schema.isRequiredAtPath)`,
  //      no writers.
  //   3. `userErrors` — API-injected errors written by `setFieldErrors*`
  //      / `parseApiErrors`-fed entries.
  //
  // Iteration order at each leaf is schema → derived-blank → user, so
  // consumers reading `errors.email` see the structural / synthesised
  // errors first and any user-injected entries appended after. Mirrored
  // in `state.getErrorsForPath` and the per-field accessor.
  //
  // Active-path filter: errors whose `err.path` is no longer reachable
  // through the live form value (e.g. the inactive variant of a
  // discriminated union after a switch) are hidden from `form.errors`.
  // The store-side entries STAY — per-field accessors and the
  // `form.meta.errors` aggregate still expose them, so a programmatic
  // consumer reading errors at a specific path can see what's known
  // about it even when the path isn't currently in the active schema.
  //
  // Container paths are descend-only (no terminal). The "give me every
  // error" need is served by `form.meta.errors` (flat ValidationError[]).
  const errorsProxy = buildErrorsProxy(state)

  function filterToOwnFormKey(
    errors: ValidationError[],
    op: 'setFieldErrors' | 'addFieldErrors'
  ): ValidationError[] {
    const own: ValidationError[] = []
    let dropped = 0
    for (const e of errors) {
      if (e.formKey === state.formKey) own.push(e)
      else dropped++
    }
    if (__DEV__ && dropped > 0) {
      console.warn(
        `[attaform] ${op}: dropped ${dropped} error(s) with non-matching formKey ` +
          `(this form's key is "${String(state.formKey)}"). Errors are scoped to ` +
          `the form that produced them — pass them to the matching form instance.`
      )
    }
    return own
  }

  function setFieldErrors(errors: ValidationError[]): void {
    // `setAllUserErrors` clears the entire user-error map before
    // writing, which would also wipe the form-level bucket
    // (`FORM_ERRORS_PATH_KEY`). The form-level slot is owned by
    // `setFormErrors` / `clearFormErrors` and is logically separate
    // from field errors — replace-all field-error writes must not
    // touch it. Preserve the bucket across the call.
    const preserved = state.userErrors.get(FORM_ERRORS_PATH_KEY)
    state.setAllUserErrors(filterToOwnFormKey(errors, 'setFieldErrors'))
    if (preserved !== undefined && preserved.length > 0) {
      state.userErrors.set(FORM_ERRORS_PATH_KEY, preserved)
    }
  }

  function addFieldErrors(errors: ValidationError[]): void {
    state.addUserErrors(filterToOwnFormKey(errors, 'addFieldErrors'))
  }

  function clearFieldErrors(path?: string | (string | number)[]): void {
    // Pragmatic semantic: "make the errors at this path go away" —
    // clears both the schema-owned and user-owned stores. With always-on
    // validation the schema half re-populates on the next mutation if
    // the value is still invalid, so the inconsistency is short-lived
    // and confined to "before the next keystroke / submit." See
    // docs/migration/0.11-to-0.12.md for the rationale.
    if (path === undefined) {
      // Same logical separation as `setFieldErrors`: a no-arg
      // `clearFieldErrors()` clears every FIELD error but must NOT
      // wipe the form-level bucket. Form-level lifecycle belongs to
      // `clearFormErrors()`.
      const preserved = state.userErrors.get(FORM_ERRORS_PATH_KEY)
      state.clearSchemaErrors()
      state.clearUserErrors()
      if (preserved !== undefined && preserved.length > 0) {
        state.userErrors.set(FORM_ERRORS_PATH_KEY, preserved)
      }
      return
    }
    const segments = canonicalizePath(path as string | Path).segments
    state.clearSchemaErrors(segments)
    state.clearUserErrors(segments)
  }

  function setFormErrors(
    errors: ReadonlyArray<Partial<ValidationError> & { message: string }>
  ): void {
    // Surgically replace just the form-level entry. Going through
    // `setAllUserErrors` / `setFieldErrors` would clobber every field
    // error too — wrong for "set this top-of-form message without
    // disturbing field validation."
    //
    // Form-level errors live at the empty-string path bucket
    // (PathKey `'[""]'`, segments `['']`). Distinct from the root
    // subtree address `[]`: aggregate reads like `errors([])` /
    // `errors()` still surface them, while `errors('')` returns ONLY
    // this bucket — the dedicated channel for `<FieldErrors path="" />`.
    //
    // Caller-provided `path` and `formKey` are intentionally ignored:
    // this API is form-level-only by definition and the form knows
    // its own key. The lenient input shape lets callers pipe
    // `ValidationError[]` (e.g. from `parseApiErrors`) straight in
    // without having to map first.
    if (errors.length === 0) {
      state.userErrors.delete(FORM_ERRORS_PATH_KEY)
      return
    }
    state.userErrors.set(
      FORM_ERRORS_PATH_KEY,
      errors.map((e) => ({
        path: [...FORM_ERRORS_PATH],
        message: e.message,
        formKey: state.formKey,
        code: e.code ?? 'atta:form-error',
      }))
    )
  }

  function clearFormErrors(): void {
    state.userErrors.delete(FORM_ERRORS_PATH_KEY)
  }

  // --- Submission lifecycle ---
  const submitting = computed<boolean>(() => state.submitting.value)
  const submissionAttempts = computed<number>(() => state.submissionAttempts.value)
  const submitted = computed<boolean>(() => state.submitted.value)
  const submitError = computed<Error | null>(() => state.submitError.value)

  // --- Wizard departure lifecycle ---
  // `useWizard` bumps `state.departAttempts` whenever navigation
  // (`next` / `back` / `goTo`) actually departs this form. The
  // computed mirror surfaces on `form.meta.departAttempts` for
  // templates and layered `getDisplayState` predicates (introspection
  // only — the library default reveals via `submissionAttempts`).
  const departAttempts = computed<number>(() => state.departAttempts.value)

  // --- Validation lifecycle ---
  const validating = computed<boolean>(() => state.activeValidations.value > 0)
  // `valid` is "we've validated at least once AND no errors AND not
  // currently validating." The `firstValidationDone` gate closes the
  // brief flash window at mount time when the slim default-derivation
  // parse strips refinements (`.refine`, `.superRefine`, async
  // validators) and the queued construction-time microtask hasn't
  // run yet. Without it, frame 1 paints the form as "valid" before
  // the real verdict arrives. The `!validating.value` guard
  // distinguishes a genuinely-clean form from one in the window
  // between an async refinement starting and resolving (where errors
  // haven't been written yet, but the verdict is pending).
  // Submit-button gates and per-form clean indicators use this.
  const valid = computed<boolean>(
    () =>
      state.firstValidationDone.value &&
      state.schemaErrors.size === 0 &&
      state.userErrors.size === 0 &&
      state.derivedBlankErrors.value.size === 0 &&
      !validating.value
  )

  // --- History (undo/redo) ---
  // When the consumer doesn't configure history, fall back to inert
  // stubs so the `form.history.*` namespace shape stays consistent
  // whether or not the feature is enabled. Templates can read
  // `form.history.canUndo` etc. unconditionally.
  const history = options.history
  const formHistory = readonly(
    reactive({
      undo: history?.undo ?? (() => false),
      redo: history?.redo ?? (() => false),
      clear: history?.clear ?? (() => {}),
      canUndo: history?.canUndo ?? computed(() => false),
      canRedo: history?.canRedo ?? computed(() => false),
      size: history?.historySize ?? computed(() => 0),
    })
  ) as FormHistoryNamespace

  // --- Form-level meta aggregate ---
  // `metaErrors` flattens the three reactive error stores into a single
  // ValidationError[]. Unlike `form.errors.<path>` (per-leaf, active-
  // path filtered), this aggregate is UNFILTERED — inactive-variant
  // errors stay in. Consumers who want only addressable errors filter
  // the array themselves.
  //
  // Order is determined by the SET of errors currently present, not by
  // the temporal sequence of validations. Each path is bucketed at its
  // schema-declaration ordinal (`state.ensurePathOrdinal`); buckets sort
  // by ordinal and flatten in order. Within one ordinal slot the
  // per-store iteration order survives — schema → blank → user — so a
  // path with both a schema error and a userErrors entry surfaces both
  // at the same slot in their existing relative order. Resurrected
  // errors return to the slot they originally occupied: clearing
  // `email` then re-breaking it puts `email` back ahead of `password`,
  // not at the end of the aggregate.
  // The form-level error aggregate. Reads through the same shared
  // `aggregateErrorsAt` helper that `form.fields(path).errors` and
  // `form.errors(path)` use (with the empty-prefix path, which
  // collects every active-variant leaf). One source of truth — the
  // three surfaces never drift, and inactive-variant errors stay
  // hidden everywhere by default.
  const metaErrors = computed<readonly ValidationError[]>(() =>
    aggregateErrorsAt(state, [] as Path)
  )

  // --- Form-level meta bundle ---
  // Vue auto-unwraps refs that are top-level on a setup return, but not
  // refs nested in a return *object* — those render as their wrapper
  // (always truthy) and silently break bindings like `:disabled`. We
  // work around it by placing the scalars + computed array inside
  // `reactive()`, which unwraps ref values on property access at any
  // depth; `readonly()` layers a runtime write-guard on top.
  //
  // Named `formMeta` locally to avoid shadowing the `state: FormStore<F>`
  // param this function receives; exposed as `meta` on the public return.
  //
  // FormMeta = FieldState<F> at the root + lifecycle (submit / undo /
  // redo / instance identity). The FieldState fields are derived
  // through the shared `getFieldStateAt([])` accessor (memoised, same
  // reference returned by `form.fields()`) so `form.meta.dirty`,
  // `form.fields().dirty`, and `form.fields([]).dirty` all read
  // identical aggregated state.
  const rootFieldState = getRootFieldStateAt([] as Path)
  // FieldState fields surface as getters on a plain object passed
  // through `reactive(...)`. The original layout wrapped each of the
  // ~28 mirrored fields in a `computed(() => rootFieldState.value.X)`,
  // which double-memoises a single property read — the underlying
  // `rootFieldState` IS already a computed, so its `.value` is
  // memoised by Vue's reactive graph; the outer computed adds no
  // extra dep-tracking value, only a wrapper allocation per mount
  // (~30 per useForm). Getters compose with `reactive()`'s Proxy
  // `get` trap: a read triggers the trap, the trap calls the
  // getter, the getter reads `rootFieldState.value.X`, and the
  // dep-tracking lands on the underlying computed exactly as before.
  // `watch(() => form.meta.dirty, …)` collects the same dependency
  // graph either way.
  const formMeta = readonly(
    reactive({
      get value() {
        return rootFieldState.value.value
      },
      get original() {
        return rootFieldState.value.original
      },
      get pristine() {
        return rootFieldState.value.pristine
      },
      get dirty() {
        return rootFieldState.value.dirty
      },
      get focused() {
        return rootFieldState.value.focused
      },
      get blurred() {
        return rootFieldState.value.blurred
      },
      get touched() {
        return rootFieldState.value.touched
      },
      get interacted() {
        return rootFieldState.value.interacted
      },
      get blurredAfterInteraction() {
        return rootFieldState.value.blurredAfterInteraction
      },
      get connected() {
        return rootFieldState.value.connected
      },
      get element() {
        return rootFieldState.value.element
      },
      get elements() {
        return rootFieldState.value.elements
      },
      get updatedAt() {
        return rootFieldState.value.updatedAt
      },
      // Whole-form validating mirrors the LIFECYCLE counter
      // (`state.activeValidations`) ORed with any per-leaf validation
      // in flight (via `rootFieldState.validating`). A submit-time
      // validate run shows up as activeValidations; per-field
      // debounced validators show up as fieldValidationCounts. Either
      // flips the flag.
      validating: computed(
        () => state.activeValidations.value > 0 || rootFieldState.value.validating
      ),
      // Whole-form valid keeps the original `firstValidationDone`
      // mount gate so the surface doesn't lie about a yet-to-arrive
      // verdict at construction time. The shared `aggregateErrorsAt`
      // ensures `form.meta.errors` and `rootFieldState.errors` match,
      // so `errors.length === 0` here would agree with `valid` —
      // keep the explicit form-level computation for the gate.
      valid,
      errors: metaErrors,
      // Whole-form transforming mirrors the global `activeTransforms`
      // counter ORed with any per-leaf transform in flight (the root
      // rollup), exactly as `validating` composes its lifecycle and
      // per-field sources. `busy` is the union of both work signals at
      // the form level. `transformError` is leaf-only, so the root
      // rollup reads it as `null` (kept for FieldState-shape parity).
      transforming: computed(
        () => state.activeTransforms.value > 0 || rootFieldState.value.transforming
      ),
      busy: computed(
        () =>
          state.activeValidations.value > 0 ||
          state.activeTransforms.value > 0 ||
          rootFieldState.value.validating ||
          rootFieldState.value.transforming
      ),
      get transformError() {
        return rootFieldState.value.transformError
      },
      // `displayState` / the `show*` booleans / `firstError` flow
      // through the same root field-state computed as the rest of the
      // FieldState surface, so `form.meta.displayState` matches
      // `form.fields().displayState` exactly — the predicate runs once
      // at the root and the result is shared.
      get displayState() {
        return rootFieldState.value.displayState
      },
      get showErrors() {
        return rootFieldState.value.showErrors
      },
      get showPending() {
        return rootFieldState.value.showPending
      },
      get showSuccess() {
        return rootFieldState.value.showSuccess
      },
      get showIdle() {
        return rootFieldState.value.showIdle
      },
      get firstError() {
        return rootFieldState.value.firstError
      },
      get path() {
        return rootFieldState.value.path
      },
      get id() {
        return rootFieldState.value.id
      },
      get aria() {
        return rootFieldState.value.aria
      },
      get key() {
        return rootFieldState.value.key
      },
      get blank() {
        return rootFieldState.value.blank
      },
      get label() {
        return rootFieldState.value.label
      },
      get description() {
        return rootFieldState.value.description
      },
      get placeholder() {
        return rootFieldState.value.placeholder
      },
      get meta() {
        return rootFieldState.value.meta
      },
      // Lifecycle (form-level only — not on FieldState).
      submitting,
      submissionAttempts,
      departAttempts,
      submitError,
      // Scalar mirror over the array — meta is a single sticky surface
      // for both templates and `useWizard`'s `FormStatus`, so the
      // projection lives here.
      get errorCount() {
        return metaErrors.value.length
      },
      submitted,
      // Per-`useForm()`-call identity. Stable for one mount; new on
      // re-mount; orthogonal to `form.key` (which is the user-supplied
      // shared identifier). Useful for devtools panels disambiguating
      // shared-key instances, telemetry hooks tagging events with
      // "which mount", and E2E tests stamping `data-form-id`.
      instanceId: formInstanceId,
    })
  ) as FormMeta<Form>

  // --- Reset ---
  // Reset semantics are "fresh start across every layer": the form
  // value, blank-path set, and error stores all rebaseline to the new
  // defaults.
  const reset = (nextDefaultValues?: DefaultValuesInput<Form>): void => {
    if (nextDefaultValues === undefined) {
      state.reset()
    } else {
      // Walk the consumer's overrides for `unset` symbols, replacing
      // them with the schema's slim defaults and capturing the marked
      // paths. The cleaned values land in form storage via state.reset;
      // the marked paths get added back via direct setValueAtPath
      // calls AFTER the reset so the FormStore's own reset (which
      // clears the blank set in the args branch) doesn't
      // wipe them.
      const walked = walkUnsetSentinels(
        nextDefaultValues,
        state.schema as unknown as Parameters<typeof walkUnsetSentinels>[1]
      )
      // After the walker, `cleanedValues` has had every `unset` symbol
      // replaced with the schema's slim default — the result is
      // structurally compatible with `WriteShape<Form>`, so the cast
      // here is safe.
      state.reset(walked.cleanedValues as DeepPartial<unknown> as Parameters<typeof state.reset>[0])
      // `state.reset` clears `blankPaths` along with the values; re-
      // seed it now with the walker-discovered paths. Direct add is
      // safe because we just established the new baseline via
      // `state.reset`, so there's no history bookkeeping conflict.
      // Mirror each into `originalBlankPaths` too, so the post-reset
      // dirty=false reference holds these as part of the baseline.
      for (const pathKey of walked.paths) {
        state.blankPaths.add(pathKey)
        state.originalBlankPaths.add(pathKey as PathKey)
      }
    }
  }

  const resetField = (pathInput: string): void => {
    const segments = canonicalizePath(pathInput).segments
    state.resetField(segments)
  }

  // --- Clear ---
  // `clear()` and `clear(path)` are sugar over `setValue(unset)` /
  // `setValue(path, unset)` — same storage (the schema's slim default
  // at every reached primitive leaf, with `.default()` / `.catch()`
  // wrappers skipped) AND the matching blank-marks so the verbs settle
  // on identical observable state. The PASS2-S1 alignment closed a
  // gap where `clear()` silently silenced required-validation by
  // writing the slim default without the blank-mark (a required
  // `z.string()` cleared via `clear` quietly passed submit with `''`).
  // The `pathInput === undefined` check distinguishes "no arg" (whole-
  // form) from explicit `clear('')` (the empty-string path slot);
  // canonicalizePath preserves the distinction. Mirrors `touch`'s arg
  // handling.
  function clear(pathInput?: string | readonly (string | number)[]): boolean {
    if (pathInput === undefined) {
      return setValueImpl(unset)
    }
    return setValueImpl(pathInput as string | Path, unset)
  }

  // --- Programmatic touch ---
  // Flip `touched: true` on a leaf, every leaf under a container, or
  // every leaf in the form (no arg). Closes the post-import / paste /
  // autofill gap where there's no DOM blur to drive the standard
  // gesture-based touched flow. Touched is the sticky-true flag the
  // standard "show errors after interaction" pattern reads.
  function touch(pathInput?: string | Path): void {
    const segments = pathInput === undefined ? ROOT_PATH : canonicalizePath(pathInput).segments
    state.touchAtPath(segments)
  }

  // --- Focus / scroll to first error ---
  // Both helpers scope to `formInstanceId` so two `useForm()` callsites
  // sharing a `key` (e.g. sidebar + main mounting the same form) only
  // focus / scroll within their own registered elements.
  const focusFirstError = (options?: { preventScroll?: boolean }): boolean => {
    const target = state.getFirstErrorElement(formInstanceId)
    if (target === null) return false
    target.element.focus(options)
    return true
  }

  const scrollToFirstError = (options?: ScrollIntoViewOptions): boolean => {
    const target = state.getFirstErrorElement(formInstanceId)
    if (target === null) return false
    target.element.scrollIntoView(options)
    return true
  }

  // Drives the same focus/scroll policy that `handleSubmit` runs after a
  // failed submit, but exposed as a method so the wizard's failed-path
  // navigation can invoke the failing form's own configured policy after
  // a `goTo`. Defaults to the form's `onInvalidSubmit` option so the
  // caller doesn't have to repeat the configured choice.
  const applyInvalidSubmitPolicyPublic = (policy?: OnInvalidSubmitPolicy): void => {
    applyInvalidSubmitPolicy(state, formInstanceId, policy ?? defaultInvalidSubmitPolicy)
  }

  // --- Field arrays ---
  const fieldArrays = buildFieldArrayApi(state)

  // --- Bulk blank introspection ---
  // Read-only view of the form's blank path set. Snapshots the internal
  // `Set<PathKey>` (JSON-form keys) at evaluation time and exposes a
  // `BlankPathsView` that canonicalises inputs and yields `Path` arrays
  // — see [[BlankPathsView]] for the rationale. Vue 3.5's reactive Set
  // tracking on the `state.blankPaths` iteration makes this computed
  // re-evaluate whenever entries change. Writes still go through
  // `setValue(_, unset)` / `markBlank()` / the directive's input
  // listener.
  const blankPathsView = computed<BlankPathsView>(() => {
    const keys = new Set<PathKey>()
    const paths: Path[] = []
    for (const pk of state.blankPaths) {
      keys.add(pk)
      const segs = segmentsForPathKey(pk)
      if (segs !== null) paths.push(segs)
    }
    Object.freeze(paths)
    const view: BlankPathsView = {
      get size() {
        return keys.size
      },
      has(input: string | Path): boolean {
        const { key } = canonicalizePath(input)
        return keys.has(key)
      },
      values(): readonly Path[] {
        return paths
      },
      [Symbol.iterator](): IterableIterator<Path> {
        return paths[Symbol.iterator]()
      },
    }
    return Object.freeze(view)
  })

  // --- Pinia-style reactive readonly proxy over the form's value ---
  // `valuesProxyComputed.value` is a deeply-readonly Vue proxy. The
  // computed wrapping ensures `state.form.value` reassignments (the
  // `applyFormReplacement` path used by `reset()` and whole-form
  // `setValue`) invalidate the inner readonly proxy and produce a
  // fresh one keyed to the new target. The callable proxy itself is
  // identity-stable — consumers caching `form.values` get a stable
  // reference whose underlying data tracks the live form value.
  const valuesProxy = buildValuesProxy(state.form)

  // --- Pinia-style reactive per-field state proxy ---
  // Allocated once per buildFormApi call (one per consumer). Each Proxy
  // node memoizes its descendants and the per-path FieldState
  // computed it reads through, so repeated access to the same path
  // (`form.fields.email` twice) returns the same object — useful
  // for downstream `===` checks and Vue's render diff.
  const fieldStateProxy = buildFieldStateProxy(
    state,
    formInstanceId,
    getFormMetaBase,
    fieldStateAccessorOptions
  )

  // Lazy-activation gate: every public method routes through `activate`
  // so the first reactive interaction kicks the captured factory. The
  // activation promise is intentionally ignored — recursive activates,
  // factory rejections, and SSR awaiting are coordinated on `state`.
  //
  // Fast path: forms with no `defaultValuesFactory` AND no SSR
  // prefetch queue have nothing for `state.activate()` to do. The
  // factory is captured exactly once at `useAbstractForm` time
  // (BEFORE this closure runs), so absence here means absence
  // forever; SSR prefetch is bound at `buildFreshState` and is
  // never set client-side. Short-circuiting `gated` to identity in
  // that combined case saves one closure allocation per public-
  // method binding AND one reactive ref read per method call, which
  // adds up across the ~30 gated methods in the API surface.
  const needsLazyGate = state.defaultValuesFactory.value !== undefined || state.hasSsrPrefetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function gated<F extends (...args: any[]) => any>(fn: F): F {
    if (!needsLazyGate) return fn
    return ((...args: Parameters<F>) => {
      void state.activate()
      return fn(...args)
    }) as F
  }

  // `form.list(path)`: the array at `path` as one field state per
  // element, in index order. Entries are the cached `form.fields`
  // terminals, so each stays live and carries its element `key`. Reading
  // the value tracks the array length, so the view recomputes when the
  // array grows or shrinks. The frozen result enforces the read-only
  // contract; mutate through `append` / `remove` / `move` / `swap`.
  const callTerminal = fieldStateProxy as unknown as (path: string) => unknown
  const EMPTY_FIELD_LIST: readonly unknown[] = Object.freeze([])
  function list(path: string): readonly unknown[] {
    const { segments } = canonicalizePath(path)
    const value = state.getValueAtPath(segments)
    if (!Array.isArray(value)) return EMPTY_FIELD_LIST
    const out = new Array<unknown>(value.length)
    for (let i = 0; i < value.length; i += 1) out[i] = callTerminal(`${path}.${i}`)
    return Object.freeze(out)
  }

  // `form.record(path)`: the record at `path` as one field state per
  // entry, keyed by the entry's own key. The array counterpart of `list`,
  // shaped as a keyed object rather than an ordered array. Entries are the
  // cached `form.fields` terminals, so each stays live. Reading the value
  // and its keys tracks the key set, so the view recomputes when an entry
  // joins or leaves. The frozen result is read-only; grow or shrink the
  // record through `setValue` at an entry path.
  const EMPTY_FIELD_RECORD: Readonly<Record<string, unknown>> = Object.freeze({})
  function record(path: string): Readonly<Record<string, unknown>> {
    const { segments } = canonicalizePath(path)
    const value = state.getValueAtPath(segments)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return EMPTY_FIELD_RECORD
    }
    // Container carries `Object.prototype` so a third-party walker
    // reading the frozen view (`.hasOwnProperty(...)`, `in`, JSON
    // serializer with a reducer) sees the standard chain. The keys
    // come from the live form value, which can include a literal
    // `__proto__` own property after a `setValue('record.__proto__', …)`
    // write — `safeAssign` lands it as an own data property here.
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      safeAssign(out, key, callTerminal(`${path}.${key}`))
    }
    return Object.freeze(out)
  }

  // `form.onChange(...)` — subscribe to form value changes (the autosave
  // primitive). Disambiguates the two call forms by whether the second
  // argument is a function: `(source, handler, options?)` when it is,
  // `(handler, options?)` (whole form) when it is not. The store owns
  // dispatch; here we hand the registry a lazy resolver for `ctx.form` (the
  // public handle, assigned just below) and, when called inside a component
  // scope, auto-stop on unmount. The returned stop() is idempotent, so a
  // consumer can also tear it down early. Not gated: a subscription is
  // passive and must not kick an async-defaults factory; the form activates
  // on the first real write, which is also the first time dispatch can fire.
  // Holds the public handle for `ctx.form`. A holder (not a reassigned
  // `let`) because the resolver closure below captures it before the handle
  // exists — it is read only at fire time, long after the assignment below.
  const formHandle: { current: UseFormReturnType<Form, GetValueFormType> | undefined } = {
    current: undefined,
  }
  function onChangeImpl(
    a: OnChangeSource | OnChangeHandler,
    b?: OnChangeHandler | OnChangeOptions,
    c?: OnChangeOptions
  ): () => void {
    const sourced = typeof b === 'function'
    const source = sourced ? (a as OnChangeSource) : undefined
    const handler = (sourced ? b : a) as OnChangeHandler
    const options = (sourced ? c : b) as OnChangeOptions | undefined
    const stop = state.registerOnChange(source, handler, options, () => formHandle.current)
    if (getCurrentScope() !== undefined) onScopeDispose(stop)
    return stop
  }

  const api: UseFormReturnType<Form, GetValueFormType> = {
    handleSubmit: gated(handleSubmit),
    // Callable readonly Proxies (`values`, `fields`, `errors`) and the
    // reactive containers (`meta`, `history`, `blankPaths`) are exposed
    // through getters so reading them activates the form on first
    // touch. Each underlying object is identity-stable across reads.
    get values(): UseFormReturnType<Form, GetValueFormType>['values'] {
      void state.activate()
      return valuesProxy as unknown as UseFormReturnType<Form, GetValueFormType>['values']
    },
    get fields(): UseFormReturnType<Form, GetValueFormType>['fields'] {
      void state.activate()
      return fieldStateProxy as unknown as UseFormReturnType<Form, GetValueFormType>['fields']
    },
    setValue: gated(setValueImpl) as UseFormReturnType<Form, GetValueFormType>['setValue'],
    validate: gated(validate) as UseFormReturnType<Form, GetValueFormType>['validate'],
    validateAsync: gated(validateAsync) as UseFormReturnType<
      Form,
      GetValueFormType
    >['validateAsync'],
    parse: gated(parse) as UseFormReturnType<Form, GetValueFormType>['parse'],
    settleTransforms: gated(state.settleTransforms) as UseFormReturnType<
      Form,
      GetValueFormType
    >['settleTransforms'],
    register: gated(register) as UseFormReturnType<Form, GetValueFormType>['register'],
    key: state.formKey,
    // Auto-unwrapping views over the per-store async-defaults lifecycle
    // refs (see FormStore.hydrating / hydrateError). Reading either
    // activates the form — observing factory state implies use.
    get hydrating(): boolean {
      void state.activate()
      return state.hydrating.value
    },
    get hydrateError(): ValidationError | null {
      void state.activate()
      return state.hydrateError.value
    },
    // Orthogonal to `hydrating` and `hydrateError`: `ready` flips true
    // once defaults are applied (sync at construction or async factory
    // resolved successfully). One-way latch — stays true through later
    // refetches even when those refetches fail, so stale-while-
    // revalidate UIs keep rendering the prior values while
    // `hydrateError` surfaces the refresh failure.
    get ready(): boolean {
      void state.activate()
      return state.defaultsResolved.value
    },
    // `rehydrate` and `activate` are themselves activation entry points
    // — they fire the factory by design. Wrapping them with `gated`
    // would double-fire (`state.activate()` plus the underlying call),
    // so they call `state` directly.
    rehydrate: () => state.rehydrate(),
    activate: () => state.activate(),
    get errors(): FormErrorsSurface<Form> {
      void state.activate()
      return errorsProxy as unknown as FormErrorsSurface<Form>
    },
    toRef: gated(pathToRef) as UseFormReturnType<Form, GetValueFormType>['toRef'],
    setFieldErrors: gated(setFieldErrors),
    addFieldErrors: gated(addFieldErrors),
    clearFieldErrors: gated(clearFieldErrors),
    setFormErrors: gated(setFormErrors),
    clearFormErrors: gated(clearFormErrors),
    get meta() {
      void state.activate()
      return formMeta
    },
    reset: gated(reset) as UseFormReturnType<Form, GetValueFormType>['reset'],
    resetField: gated(resetField) as UseFormReturnType<Form, GetValueFormType>['resetField'],
    clear: gated(clear) as UseFormReturnType<Form, GetValueFormType>['clear'],
    focusFirstError: gated(focusFirstError),
    scrollToFirstError: gated(scrollToFirstError),
    applyInvalidSubmitPolicy: gated(applyInvalidSubmitPolicyPublic),
    touch: gated(touch) as UseFormReturnType<Form, GetValueFormType>['touch'],
    get history() {
      void state.activate()
      return formHistory
    },
    append: gated(fieldArrays.append) as UseFormReturnType<Form, GetValueFormType>['append'],
    prepend: gated(fieldArrays.prepend) as UseFormReturnType<Form, GetValueFormType>['prepend'],
    insert: gated(fieldArrays.insert) as UseFormReturnType<Form, GetValueFormType>['insert'],
    remove: gated(fieldArrays.remove) as UseFormReturnType<Form, GetValueFormType>['remove'],
    swap: gated(fieldArrays.swap) as UseFormReturnType<Form, GetValueFormType>['swap'],
    move: gated(fieldArrays.move) as UseFormReturnType<Form, GetValueFormType>['move'],
    replace: gated(fieldArrays.replace) as UseFormReturnType<Form, GetValueFormType>['replace'],
    list: gated(list) as UseFormReturnType<Form, GetValueFormType>['list'],
    record: gated(record) as UseFormReturnType<Form, GetValueFormType>['record'],
    get blankPaths() {
      void state.activate()
      return blankPathsView
    },
    onChange: onChangeImpl as UseFormReturnType<Form, GetValueFormType>['onChange'],
  }
  // Publish the handle so `ctx.form` (resolved lazily, only at fire time)
  // reaches the same object the consumer holds.
  formHandle.current = api
  return api
}
