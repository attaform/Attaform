import { computed, reactive, readonly, type Ref } from 'vue'
import type {
  BlankPathsView,
  DisplayState,
  ErrorInput,
  FormErrorsSurface,
  FormHistoryNamespace,
  FormMeta,
  HistoryModule,
  ReactiveValidationStatus,
  RegisterValue,
  UseFormReturnType,
  ValidateOn,
  ValidationError,
  ValidationResponse,
  ParseOptions,
  WriteMeta,
} from '../types/types-api'
import type { DeepPartial, DefaultValuesInput, GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { pickDefined } from './defaults'
import { structuralSnapshot } from './diff-apply'
import { AttaformErrorCode } from './error-codes'
import { normalizeErrorInputs } from './errors'
import {
  FIELD_STATE_KEYS,
  buildErrorsSurface,
  buildFieldsSurface,
  buildValuesSurface,
} from './callable-tree'
import { buildFieldArrayApi } from './array-engine'
import {
  aggregateErrorsAt,
  buildContainerFieldStateBase,
  buildFieldStateAccessor,
  type FieldStateBase,
  type FormMetaBase,
} from './field-state-api'
import { getAtPath } from './path-walker'
import {
  canonicalizePath,
  ROOT_PATH,
  ROOT_PATH_KEY,
  segmentsForPathKey,
  type Path,
  type PathKey,
} from './paths'
import { buildProcessForm } from './process-form'
import { buildRegister } from './register-api'
import { safeAssign } from './safe-assign'
import { isUnset, unset } from './unset'
import {
  blankForKind,
  expandUnsetAt,
  substituteUnsetSentinels,
  walkUnsetSentinels,
} from './unset-walker'

/**
 * Derived display props (`FieldStateDerivedKey`): computed by the reducer, so
 * absent from the predicate-safe base shape.
 */
const DERIVED_DISPLAY_KEYS = new Set([
  'displayState',
  'showErrors',
  'showPending',
  'showSuccess',
  'showIdle',
  'firstError',
  'firstOwnError',
])
/** `form.meta`'s enumerable key set: every FieldState prop, plus lifecycle. */
const META_KEYS = [
  ...FIELD_STATE_KEYS,
  'submitting',
  'submissionAttempts',
  'departAttempts',
  'submitError',
  'submitted',
  'instanceId',
  'errorCount',
]
/**
 * `getFormMetaBase()`'s enumerable key set (`FormMetaBase`): the same,
 * minus the derived display props the predicate may not see.
 */
const BASE_META_KEYS = META_KEYS.filter((k) => !DERIVED_DISPLAY_KEYS.has(k))

/**
 * The `form.history` namespace for a form that never configured history. Every
 * answer is a constant, so one instance serves every such form in the app.
 *
 * `readonly()` rather than `Object.freeze()`: a stray consumer write warns and
 * no-ops here, where freezing would throw a `TypeError` into strict-mode
 * consumer code. Built on first use, so a module-scope side effect cannot pin
 * it into a bundle that never reads it.
 */
let INERT_HISTORY: FormHistoryNamespace | undefined
function inertHistory(): FormHistoryNamespace {
  INERT_HISTORY ??= readonly({
    undo: () => false,
    redo: () => false,
    clear: () => {},
    canUndo: false,
    canRedo: false,
    size: 0,
  }) as FormHistoryNamespace
  return INERT_HISTORY
}

/**
 * One Proxy in place of a forest of `Object.defineProperty` getters.
 *
 * Both meta surfaces mirror a key set off a computed. One accessor per key
 * mints an AccessorPair, a closure and a closure context PER KEY PER FORM, and
 * a bag of 30-odd accessors sends the object to V8 dictionary mode besides:
 * 78 AccessorPairs and 7,810 B per `useForm()` callsite, 11% of a form's heap
 * spent on property plumbing. A Proxy answers the same questions with one
 * object and one closure, the shape `callable-tree.ts`'s field views use.
 * `read` resolves a live value per hit, so nothing is captured and the
 * reactive dependency lands exactly where the getter put it.
 *
 * `get` falls through to the target for anything outside `keys`, which keeps
 * `Object.prototype` reachable: `meta.hasOwnProperty(...)` and
 * `JSON.stringify(meta)`'s `toJSON` probe both read through the prototype
 * chain rather than off the key set.
 */
const denyWrite = (): boolean => false

function buildMetaProxy(
  keys: readonly string[],
  read: (key: string) => unknown
): Record<string, unknown> {
  const target: Record<string, unknown> = {}
  const owns = new Set(keys)
  return new Proxy(target, {
    get: (_, key: string | symbol): unknown =>
      owns.has(key as string) ? read(key as string) : Reflect.get(target, key),
    has: (_, key: string | symbol): boolean => owns.has(key as string) || Reflect.has(target, key),
    // Safe to hand back the same array every time: the spec copies a trap's
    // key list before using it.
    ownKeys: () => keys,
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (!owns.has(key as string)) return Reflect.getOwnPropertyDescriptor(target, key)
      // Configurable because a Proxy may not report a non-configurable
      // property the target does not have; enumerable because both meta key
      // sets are pinned enumerable.
      return { configurable: true, enumerable: true, value: read(key as string), writable: false }
    },
    // A getter with no setter throws on assignment under strict mode, which
    // every module here is; `false` keeps that.
    set: denyWrite,
    deleteProperty: denyWrite,
    defineProperty: denyWrite,
  })
}

export type BuildFormApiOptions = {
  /** See `UseFormConfiguration.focusOnInvalidSubmit`. Defaults to `true`. */
  focusOnInvalidSubmit?: boolean
  /**
   * Pre-wired history module behind `form.history`. Omitted, the namespace's
   * methods are inert no-ops and its flags read `false` / `0`, so the API
   * shape is the same whether or not the feature is on.
   */
  history?: HistoryModule
  /**
   * Per-`useForm()`-instance config threaded through writes, register and
   * field state, so each callsite honours its own `validateOn`, `debounceMs`,
   * `coerce` and `rememberVariants` even while sharing a FormStore with a
   * sibling instance, a modal and a main form over one logical form. Anything
   * omitted falls through to the store's construction-time values.
   */
  validateOn?: ValidateOn
  debounceMs?: number
  coerce?: boolean
  rememberVariants?: boolean
}

/**
 * Build the public form API from a FormStore. Both the top-level form entry,
 * which creates a fresh state, and `injectForm`, which resolves one from an
 * ambient provide, come through here, so their API shapes cannot drift.
 *
 * Pure over `(FormStore, options)`. It touches neither the registry, nor
 * consumer ref-counts, nor the current Vue instance; those belong to the
 * caller.
 */
export function buildFormApi<Form extends GenericForm, GetValueFormType extends GenericForm = Form>(
  state: FormStore<Form, GetValueFormType>,
  formInstanceId: string,
  options: BuildFormApiOptions = {}
): UseFormReturnType<Form, GetValueFormType> {
  // Compose the per-instance write-meta bag once. Every public write below
  // splices it into its forwarded `meta`, so the store's runtime reads of
  // `validateOn`, `debounceMs` and `rememberVariants` honour THIS instance.
  // A sibling instance sharing the FormStore carries its own in its own
  // closure.
  const instanceBag = pickDefined({
    validateOn: options.validateOn,
    debounceMs: options.debounceMs,
    rememberVariants: options.rememberVariants,
  })
  const instanceMeta: WriteMeta['instance'] | undefined =
    Object.keys(instanceBag).length > 0 ? instanceBag : undefined
  // Helper used by every internal `state.setValueAtPath` call below to
  // splice the instance bag into the forwarded WriteMeta. Identity
  // when no instance overrides are active.
  const withInstanceMeta = (meta?: WriteMeta): WriteMeta | undefined => {
    if (instanceMeta === undefined) return meta
    return meta === undefined ? { instance: instanceMeta } : { ...meta, instance: instanceMeta }
  }

  // Re-mark each substituted leaf blank through a same-value write carrying
  // `{ blank: true }`, so the gate hook re-adds them: a DU reshape during the
  // parent write trims blanks under the variant path. Read from storage rather
  // than `getEmptyValueAtPath`, which keeps DU discriminator stubs intact.
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

  // The form-meta argument the display predicate receives, built ONCE per
  // `buildFormApi` call as a bag of enumerable getters. Every getter read
  // happens inside the calling field-state computed, so a field tracks exactly
  // what its predicate reads and nothing more. The library-default predicate
  // reads no rollup field, so it never subscribes to the whole-form rollup.
  //
  // The rollup mirrors read a per-form computed over
  // `buildContainerFieldStateBase`, the base only and NOT the cached
  // field-state accessor, which would recurse through the root path's own
  // showErrors computation. The computed memoises the rollup across predicate
  // invocations. Its `validatingSince` belongs to the field machine rather
  // than to the predicate's meta argument, so only `.base` is exposed.
  const rootBaseComputed = computed<FieldStateBase>(
    () => buildContainerFieldStateBase(state, ROOT_PATH, ROOT_PATH_KEY, formInstanceId).base
  )
  // The lifecycle scalars read their ref on demand; everything else
  // mirrors the root rollup. One Proxy, not 36 accessors.
  const metaBase = buildMetaProxy(BASE_META_KEYS, (key) => {
    switch (key) {
      case 'instanceId':
        return formInstanceId
      case 'errorCount':
        return rootBaseComputed.value.errors.length
      case 'submitting':
        return state.submitting.value
      case 'submissionAttempts':
        return state.submissionAttempts.value
      case 'departAttempts':
        return state.departAttempts.value
      case 'submitError':
        return state.submitError.value
      case 'submitted':
        return state.submitted.value
      default:
        return (rootBaseComputed.value as unknown as Record<string, unknown>)[key]
    }
  })
  const getFormMetaBase = (): FormMetaBase => {
    // Form-level scalars, EAGERLY tracked on every field-state eval. They are
    // O(1) refs that never move on a keystroke, so per-field tracking costs
    // nothing on the hot path. Eager rather than lazy like the rollup because
    // behaviour beyond the predicate's own output depends on every field
    // re-evaluating when they flip: the display engine is cleared on submit,
    // revealing held spinners, and that imperative reset is visible only if
    // `submitting` is a tracked dep of each field.
    void state.submitting.value
    void state.submissionAttempts.value
    void state.departAttempts.value
    void state.submitError.value
    void state.submitted.value
    return metaBase as unknown as FormMetaBase
  }

  // One liveness sweep shared by every per-path cache in this form; the store
  // owns it. The surfaces below register their evictions into the same
  // registry, so there is one subscription and one liveness walk per candidate
  // rather than a set per cache. See `dynamic-path-sweep.ts`.
  const pathSweep = state.pathSweep
  const getRootFieldStateAt = buildFieldStateAccessor(
    state,
    formInstanceId,
    getFormMetaBase,
    pathSweep
  )
  // Gated `displayState` at any path, reusing `form.fields`' memoised
  // field-state identity, so a binding's `ariaDisplayState` carries the exact
  // verdict `form.fields.<path>.displayState` shows. Built before `register`,
  // so the closure is ready when the factory bakes each RegisterValue.
  const getDisplayStateAt = (segments: Path): DisplayState =>
    getRootFieldStateAt(segments).value.displayState

  const registerConfig = {
    ...pickDefined({ instanceMeta, coerce: options.coerce }),
    getDisplayStateAt,
  }
  const register = buildRegister(state, formInstanceId, registerConfig) as (
    path: string | Path
  ) => RegisterValue<unknown>

  // --- Focus / scroll to first error ---
  // Both scope to `formInstanceId`, so two `useForm()` callsites sharing a
  // `key`, a sidebar and a main mounting the same form, focus and scroll only
  // within their own registered elements.
  const focusFirstError = (options?: { preventScroll?: boolean }): boolean => {
    const target = state.domBinding.value?.getFirstErrorElement(formInstanceId) ?? null
    if (target === null) return false
    // `focusVisible: true` asks for the focus ring even though the move is
    // programmatic, so a radio, checkbox or custom widget focused right after
    // a pointer submit still shows where focus landed. Honoured where
    // supported and ignored elsewhere; the caller's `options` layer over it.
    target.element.focus({ focusVisible: true, ...options })
    return true
  }

  const scrollToFirstError = (options?: ScrollIntoViewOptions): boolean => {
    const target = state.domBinding.value?.getFirstErrorElement(formInstanceId) ?? null
    if (target === null) return false
    target.element.scrollIntoView(options)
    return true
  }

  // The form's own invalid-submit nudge, in one place. `handleSubmit` runs it
  // on a failed submit, and it is a public method so the wizard's failed-path
  // navigation can fire the failing form's configured behaviour after a
  // `goTo`. `focusFirstError` stays unconditional: opting out of the automatic
  // nudge is not opting out of driving it yourself.
  const applyInvalidSubmitPolicyPublic = (): void => {
    if (options.focusOnInvalidSubmit !== false) focusFirstError()
  }

  const {
    validate: validateBuilt,
    parse: parseBuilt,
    handleSubmit,
  } = buildProcessForm<Form, GetValueFormType>(state, {
    applyInvalidSubmit: applyInvalidSubmitPolicyPublic,
  })

  const validate = (pathInput?: string) =>
    validateBuilt(pathInput) as Ref<ReactiveValidationStatus<Form>>

  // Two call forms, dispatching on the first argument the way `setErrors`
  // does: a path-shaped string scopes the run, a lone options bag applies to
  // the whole form. `commit` defaults false, the pure read.
  const parse = (arg1?: string | ParseOptions, arg2?: ParseOptions) => {
    const isPathArg = typeof arg1 === 'string' || Array.isArray(arg1)
    const pathInput = isPathArg ? (arg1 as string) : undefined
    const options = isPathArg ? arg2 : (arg1 as ParseOptions | undefined)
    return parseBuilt(pathInput, { commit: options?.commit === true }) as Promise<
      ValidationResponse<GetValueFormType>
    >
  }

  // --- toRef escape hatch ---
  // `Readonly<Ref<...>>` for ref-shaped interop: an external composable that
  // expects a Vue ref, a watcher reading a single path. Writes still funnel
  // through `setValue`, never through the ref.
  function pathToRef(pathInput: string): Readonly<Ref<unknown>> {
    const segments = canonicalizePath(pathInput).segments
    return computed(() => getAtPath(state.form.value, segments)) as Readonly<Ref<unknown>>
  }

  /**
   * `true` when the schema declares this path as holding a function.
   *
   * `setValue(path, fn)` normally reads `fn` as a functional update.
   * At a `z.function()` leaf that overload would make the kind
   * unwritable: the updater runs, its RETURN value is written, and a
   * consumer storing a callback gets whatever the callback returned.
   *
   * The schema is the authority on which reading is right, so this asks it
   * rather than guessing from the value. Opaque leaves (`z.any()`,
   * `z.unknown()`, `z.custom()`) are excluded deliberately: their accept set
   * is the permissive one, which contains every kind including `'function'`,
   * and a schema that describes nothing is no reason to drop the updater
   * overload. A consumer storing a callback in an opaque slot can wrap it, or
   * name the slot `z.function()` and say so.
   */
  function pathStoresFunctions(segments: Path): boolean {
    if (state.schema.isOpaqueLeafAtPath(segments)) return false
    return state.schema.getSlimPrimitiveTypesAtPath(segments).has('function')
  }

  function setValueImpl(pathOrValue: unknown, maybeValue?: unknown): boolean {
    // A path is a dotted string or a segment array, so `(value)` is a
    // whole-form write and `(path, value)` a path write, disambiguated by the
    // first argument's type rather than by arity.
    const argc = arguments.length
    const isPathForm = argc >= 2 && (typeof pathOrValue === 'string' || Array.isArray(pathOrValue))
    const writeMeta = (extra?: WriteMeta): WriteMeta | undefined => withInstanceMeta(extra)
    if (!isPathForm) {
      // Hand the consumer's callback a STABLE structural snapshot, not the
      // live reactive value. The store mutates `form.value` in place on commit,
      // so deep-watch deps fire only for paths that changed, and a callback
      // closing over `prev` would otherwise watch its own reference follow the
      // post-commit state. The RETURN value passes through `mergeStructural`,
      // so gaps from a partial replacement fill from defaults.
      const next =
        typeof pathOrValue === 'function'
          ? (pathOrValue as (prev: unknown) => unknown)(structuralSnapshot(state.form.value))
          : pathOrValue
      // Whole-form `unset` sentinels, from a `setValue(unset)` or a function
      // form returning `unset` at some leaf, flow through the walker: every
      // leaf is translated, the cleaned value lands in storage, and the
      // discovered paths take blank marks through same-value `{ blank: true }`
      // writes that hit the identity short-circuit, so they are bookkeeping
      // only and add no history delta. Order matters: the root write goes
      // FIRST, or the gate hook's descendant sweep reaps the marks this is
      // about to set. `writeUnsetAt` below follows the same pattern.
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
    // `unset` at a specific path, direct or returned by the path-form
    // callback. Routed through a shared helper so leaves, containers,
    // and the discriminator-key special case all land the same shape.
    const writeUnsetAt = (): boolean => {
      // Discriminator-path special case: the slim default at a disc path is
      // the first variant's literal, and seeding it would silently activate a
      // variant the consumer did not pick. A kind-appropriate primitive blank
      // instead lands `setValueAtPath`'s stub branch with no variant body.
      // `expandUnsetAt` already stubs a DU for a container `unset` at its
      // PARENT path; this check covers a write targeting the discriminator.
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
      // General case: `expandUnsetAt` writes the slim primitive at a leaf, the
      // falsy concrete at an array, tuple or record, the DU stub at a union
      // container, and recurses through a bare object, marking every primitive
      // descendant. It bypasses the schema's declared `.default(N)`
      // deliberately; see `unset-walker.ts`.
      const blankPaths: PathKey[] = []
      const expanded = expandUnsetAt(
        segments,
        state.schema as unknown as Parameters<typeof expandUnsetAt>[1],
        blankPaths
      )
      const segmentsKey = canonicalizePath(segments).key
      // Leaf unset, where the single mark is the write path: combine the value
      // write and the blank flag into ONE call, so the replacement captures
      // both the storage change and the new blank state in a single history
      // delta. Split in two, the second call hits the identity short-circuit
      // and the blank change escapes history.
      if (blankPaths.length === 1 && blankPaths[0] === segmentsKey) {
        return state.setValueAtPath(segments, expanded, writeMeta({ blank: true }))
      }
      // Container unset, where the marks live at descendants. Write the value
      // first, firing the replacement and passing through any DU reshape's
      // blank trim, then re-mark each blank path through a same-value write
      // carrying `{ blank: true }`. Read from storage rather than
      // `getEmptyValueAtPath`, which keeps DU discriminator stubs intact: at a
      // disc path the schema's empty is the FIRST variant literal, which would
      // overwrite the kind-blank the parent write just landed.
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
    // Path-form callback. An unpopulated slot hands the consumer the schema's
    // default at that path rather than `undefined`, so
    // `(prev) => prev.first.toUpperCase()` is safe. A populated slot hands the
    // live value, and it is stable: the store reassigns the changed
    // first-segment of `form.value` on commit, so the old subtree `prev` may
    // close over is orphaned but unmutated, and a consumer caching `prev` sees
    // frozen pre-commit state.
    let resolvedValue: unknown
    if (typeof maybeValue === 'function' && !pathStoresFunctions(segments)) {
      const current = state.getValueAtPath(segments)
      const prev = current === undefined ? state.schema.getDefaultAtPath(segments) : current
      resolvedValue = (maybeValue as (prev: unknown) => unknown)(prev)
      // Callback returned a bare `unset`, so route through the same
      // helper as the direct case so leaves, containers, and the
      // discriminator-key special case all land identically.
      if (isUnset(resolvedValue)) return writeUnsetAt()
    } else {
      resolvedValue = maybeValue
    }
    // Nested-unset pass. The leaf cases above are done; what remains is a
    // value like `{ type: 'oversized', lengthCm: unset }`, the
    // discriminated-union Case B write. Without this scrub the symbols reach
    // the slim-primitive gate, fail the kind check at the numeric leaf, and
    // the whole write is rejected, leaving the form on the prior variant.
    //
    // The walker is reference-stable on a subtree with no substitutions, so
    // the common case returns the same `resolvedValue` identity and an empty
    // `paths` list, costing no extra writes.
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

  // --- Error store API: a leaf-aware drillable callable Proxy ---
  // `form.errors` merges three reactive sources at every leaf path: the schema
  // side written by the validation pipeline, the derived "No value supplied"
  // class synthesized from `(blankPaths, schema.isRequiredAtPath)`, and the
  // user side written by `setErrors` / `clearErrors`.
  //
  // Iteration order at each leaf is schema, then derived blank, then user, so
  // a consumer reading `errors.email` sees the structural and synthesized
  // errors first and user-injected entries after. `state.getErrorsForPath` and
  // the per-field accessor iterate the same way.
  //
  // Active-path filter: an error whose `err.path` is no longer reachable
  // through the live form value, the inactive variant of a discriminated union
  // after a switch, is hidden from `form.errors`. The store-side entries STAY,
  // and per-field accessors and the `form.meta.errors` aggregate still expose
  // them, so a programmatic consumer can read what is known about a path even
  // when the active schema does not hold it.
  //
  // Container paths are descend-only, with no terminal. `form.meta.errors`
  // serves the "give me every error" need as a flat array.
  const errorsProxy = buildErrorsSurface(state, pathSweep)

  // `setErrors` / `clearErrors` own the user error layer, which merges with
  // the schema side on read. Two surfaces cover both field and form scope,
  // because a field error and a global error are the same thing at different
  // paths: a field path against the root path.
  //
  // Input is lenient: a real `Error`, a partial
  // `{ message?, path?, code?, data? }`, or an array of either. A missing
  // `code` defaults, and a missing or empty message becomes "Unknown error"
  // rather than throwing, since Attaform never throws into the consumer app.
  // What the store holds is always a firm `ValidationError`.
  type SetErrorsArg =
    ErrorInput | ErrorInput[] | ((prev: ValidationError[]) => ErrorInput | ErrorInput[])

  function flattenUserErrors(): ValidationError[] {
    const all: ValidationError[] = []
    for (const cell of state.errorCells.values()) all.push(...cell.user)
    return all
  }

  function setErrors(arg1: SetErrorsArg | string | (string | number)[], arg2?: SetErrorsArg): void {
    // The path form needs two arguments AND a path-shaped first one, exactly
    // like `setValue`: a lone array argument is a whole-layer error list, not
    // a path. `setErrors(path, …)` stamps `path` onto every entry and replaces
    // only that bucket, while the no-path forms replace the entire user layer.
    // A default-path entry lands in the global bucket, so no separate
    // form-level setter is needed.
    const isScoped = arguments.length >= 2 && (typeof arg1 === 'string' || Array.isArray(arg1))
    if (isScoped) {
      const { segments, key } = canonicalizePath(arg1 as string | Path)
      const input = arg2 as SetErrorsArg
      const resolved =
        typeof input === 'function' ? input([...(state.errorCells.get(key)?.user ?? [])]) : input
      state.setUserErrorsForPath(
        segments,
        normalizeErrorInputs(resolved, segments, AttaformErrorCode.UserError)
      )
      return
    }
    const input = arg1 as SetErrorsArg
    const resolved = typeof input === 'function' ? input(flattenUserErrors()) : input
    state.setAllUserErrors(normalizeErrorInputs(resolved, undefined, AttaformErrorCode.UserError))
  }

  function clearErrors(path?: string | (string | number)[]): void {
    // Pragmatically "make the errors here go away": clears BOTH the schema and
    // user sides at the target, or everywhere with no path. Under always-on
    // validation the schema half re-populates on the next mutation if the
    // value is still invalid, so the inconsistency is short-lived. No
    // form-level bucket is special-cased: global errors live at the root path
    // like any other bucket.
    if (path === undefined) {
      state.clearSchemaErrors()
      state.clearUserErrors()
      return
    }
    const segments = canonicalizePath(path as string | Path).segments
    state.clearSchemaErrors(segments)
    state.clearUserErrors(segments)
  }

  // --- Submission lifecycle ---
  const submitting = computed<boolean>(() => state.submitting.value)
  const submissionAttempts = computed<number>(() => state.submissionAttempts.value)
  const submitted = computed<boolean>(() => state.submitted.value)
  const submitError = computed<Error | null>(() => state.submitError.value)

  // --- Wizard departure lifecycle ---
  // `useWizard` bumps `state.departAttempts` whenever navigation actually
  // departs this form, and the mirror surfaces on `form.meta.departAttempts`
  // for templates and layered display predicates. Introspection only: the
  // library default reveals through `submissionAttempts`.
  const departAttempts = computed<number>(() => state.departAttempts.value)

  // --- Validation lifecycle ---
  const validating = computed<boolean>(() => state.activeValidations.value > 0)
  // `valid` means validated at least once, no errors, and not currently
  // validating. The `firstValidationDone` gate closes the mount-time flash
  // window where the slim default-derivation parse strips refinements and the
  // queued construction microtask has not run, which would paint frame 1
  // valid before the real verdict. The `!validating.value` guard separates a
  // genuinely clean form from one between an async refinement starting and
  // resolving, where no errors are written yet but a verdict is pending.
  // Submit-button gates and per-form clean indicators read this.
  const valid = computed<boolean>(
    () =>
      state.firstValidationDone.value &&
      state.errorCells.size === 0 &&
      state.derivedBlankErrors.value.size === 0 &&
      !validating.value
  )

  // --- History (undo/redo) ---
  // Without configured history the namespace falls back to inert stubs, so
  // `form.history.*` keeps one shape either way and a template can read
  // `form.history.canUndo` unconditionally.
  //
  // Unconfigured, it is a module-level singleton, because none of its answers
  // can differ: three inert methods and three constants. Spelling it per form
  // costs 3 computeds, a reactive proxy, a readonly proxy and 3 closures per
  // `useForm()` callsite, 1,079 B a form, to represent `false`.
  const history = options.history
  const formHistory =
    history === undefined
      ? inertHistory()
      : (readonly(
          reactive({
            undo: history.undo,
            redo: history.redo,
            clear: history.clear,
            canUndo: history.canUndo,
            canRedo: history.canRedo,
            size: history.historySize,
          })
        ) as FormHistoryNamespace)

  // --- Form-level meta aggregate ---
  // `metaErrors` flattens the three error stores into one array through the
  // same `aggregateErrorsAt` helper `form.fields(path).errors` and
  // `form.errors(path)` use, at the empty prefix, so the three surfaces cannot
  // drift.
  //
  // Order follows the SET of errors currently present, not the temporal
  // sequence of validations. Each path is bucketed at its schema-declaration
  // ordinal, buckets sort by ordinal and flatten in order, and within one slot
  // the per-store order survives as schema, then blank, then user, so a path
  // carrying both a schema and a user error surfaces both at that slot in
  // their existing relative order. A resurrected error returns to the slot it
  // occupied: clearing `email` and re-breaking it puts `email` back ahead of
  // `password` rather than at the end.
  const metaErrors = computed<readonly ValidationError[]>(() =>
    aggregateErrorsAt(state, [] as Path, ROOT_PATH_KEY)
  )

  // --- Form-level meta bundle ---
  // `FormMeta` is `FieldState<F>` at the root plus the lifecycle: submit, undo,
  // redo, instance identity. Its FieldState half derives from the shared
  // `getFieldStateAt([])` accessor, memoised and the same reference
  // `form.fields()` returns, so `form.meta.dirty`, `form.fields().dirty` and
  // `form.fields([]).dirty` read identical aggregated state.
  //
  // Everything goes inside `reactive()`, which unwraps ref values on property
  // access at any depth, because Vue auto-unwraps only refs that are top-level
  // on a setup return: a ref nested in a returned object renders as its
  // always-truthy wrapper and silently breaks a binding like `:disabled`.
  // `readonly()` layers the write guard on top.
  //
  // Named `formMeta` locally so it does not shadow the `state` parameter;
  // exposed as `meta` on the public return.
  const rootFieldState = getRootFieldStateAt([] as Path)
  // FieldState fields surface as plain getters, NOT as a
  // `computed(() => rootFieldState.value.X)` each. `rootFieldState` is already
  // a computed, so its `.value` is memoised by Vue's graph, and an outer
  // computed per field adds no dep-tracking, only ~30 wrapper allocations per
  // `useForm`. A getter composes with `reactive()`'s get trap just as well: the
  // read triggers the trap, the trap calls the getter, and dep-tracking lands
  // on the underlying computed, so `watch(() => form.meta.dirty, …)` collects
  // the same graph.
  const metaOwn: Record<string, unknown> = {
    // Whole-form work signals compose the LIFECYCLE counters with the per-leaf
    // rollup: a submit-time validate shows up in `activeValidations` and a
    // per-field debounced validator in `fieldValidationCounts`, and either
    // flips the flag. `valid` keeps the form-level mount gate, and `errors` is
    // the unfiltered whole-form aggregate.
    validating: computed(
      () => state.activeValidations.value > 0 || rootFieldState.value.validating
    ),
    valid,
    errors: metaErrors,
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
    // Lifecycle, form-level only and never on FieldState.
    submitting,
    submissionAttempts,
    departAttempts,
    submitError,
    submitted,
    // Per-`useForm()`-call identity. Stable for one mount; new on
    // re-mount; orthogonal to `form.key` (the user-supplied shared
    // identifier).
    instanceId: formInstanceId,
  }
  // Every remaining FieldState prop mirrors the root field-state computed, so
  // `form.meta.displayState` matches `form.fields().displayState` exactly: the
  // predicate runs once at the root and the result is shared. `errorCount` is a
  // scalar mirror over the aggregate, making meta one surface for both
  // templates and `useWizard`'s `FormStatus`.
  //
  // `reactive()` still wraps the Proxy, for the ref-unwrapping reason above:
  // the own entries are refs, and its get trap is what unwraps them.
  const metaTarget = buildMetaProxy(META_KEYS, (key) => {
    if (key === 'errorCount') return metaErrors.value.length
    if (Object.hasOwn(metaOwn, key)) return metaOwn[key]
    return (rootFieldState.value as unknown as Record<string, unknown>)[key]
  })
  const formMeta = readonly(reactive(metaTarget)) as FormMeta<Form>

  // --- Reset ---
  // A fresh start across every layer: form value, blank-path set and error
  // stores all rebaseline to the new defaults.
  const reset = (nextDefaultValues?: DefaultValuesInput<Form>): void => {
    if (nextDefaultValues === undefined) {
      state.reset()
    } else {
      // Walk the consumer's overrides for `unset` symbols, replacing them with
      // the schema's slim defaults and capturing the marked paths. The cleaned
      // values reach storage through `state.reset`; the marks go back on after
      // it.
      //
      // The trust-the-caller walker, NOT `walkUnsetSentinels`. The argument is
      // sparse and folds over the defaults already in force, so it has to STAY
      // sparse on the way down. `walkUnsetSentinels` synthesizes the schema
      // keys the caller omitted and auto-marks them blank, which would turn
      // every key the caller did not mention into an explicit "no value here",
      // overriding the default that key had (#576).
      const walked = substituteUnsetSentinels(
        nextDefaultValues,
        [],
        state.schema as unknown as Parameters<typeof substituteUnsetSentinels>[2]
      )
      // Every `unset` symbol is now the schema's slim default, so the result
      // is structurally compatible with `WriteShape<Form>`.
      state.reset(walked.cleanedValues as DeepPartial<unknown> as Parameters<typeof state.reset>[0])
      // `state.reset` clears `blankPaths` with the values, so re-seed it from
      // the walker-discovered paths. A direct add is safe, the new baseline
      // having just been established, so there is no history conflict. Mirror
      // each into `originalBlankPaths` too, so the post-reset pristine
      // reference holds them as part of the baseline.
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
  // `clear()` and `clear(path)` are sugar over `setValue(unset)`: the same
  // storage, the schema's slim default at every reached primitive leaf with
  // `.default()` and `.catch()` wrappers skipped, AND the matching blank marks,
  // so the two verbs settle on identical observable state. Writing the slim
  // default WITHOUT the mark silently silences required-validation: a required
  // `z.string()` cleared that way passes submit with `''`.
  //
  // The `pathInput === undefined` check separates no argument, meaning the
  // whole form, from an explicit `clear('')` at the empty-string path slot;
  // `canonicalizePath` preserves the distinction. `touch` handles its argument
  // the same way.
  function clear(pathInput?: string | readonly (string | number)[]): boolean {
    if (pathInput === undefined) {
      return setValueImpl(unset)
    }
    return setValueImpl(pathInput as string | Path, unset)
  }

  // --- Programmatic touch ---
  // Flip `touched: true` on a leaf, on every leaf under a container, or on
  // every leaf in the form. `touched` is the descriptive "this field was
  // visited" flag, recording a bare focus-then-blur for custom heuristics and
  // analytics. The default display gate deliberately does NOT read it: it
  // reads `blurredAfterInteraction`, which a tab-through never sets. Reach for
  // `interact()` when the goal is to reveal errors.
  function touch(pathInput?: string | Path): void {
    const segments = pathInput === undefined ? ROOT_PATH : canonicalizePath(pathInput).segments
    state.touchAtPath(segments)
  }

  // --- Programmatic interaction ---
  // Simulate a complete focus, edit and blur over every leaf under a path, so
  // seeded, imported or out-of-band values reveal their errors under the
  // default display heuristic without a form-wide submit. The flags land
  // synchronously and the promise resolves once the subtree's validation has
  // committed, so an awaiting caller can read `showErrors` straight after.
  //
  // Never rejects. The common call is fire-and-forget, arming a modal row's
  // errors and then closing it, and that must not surface an unhandled
  // rejection in the consumer's app.
  async function interact(pathInput?: string | Path): Promise<void> {
    const segments = pathInput === undefined ? ROOT_PATH : canonicalizePath(pathInput).segments
    // The store owns the dev-warn for an unresolved path, so a frozen
    // form (which legitimately resolves nothing) stays quiet.
    if (!state.interactAtPath(segments)) return
    try {
      await parseBuilt(pathInput === undefined ? undefined : segments, { commit: true })
    } catch {
      // The committing parse reports failure through its return value, so a
      // throw here means the adapter itself blew up. The flags are already
      // set and the gate is open either way, so swallow rather than reject
      // into the consumer's app.
    }
  }

  // --- Field arrays ---
  const fieldArrays = buildFieldArrayApi(state)

  // --- Bulk blank introspection ---
  // Read-only view of the form's blank path set. Snapshots the internal
  // `Set<PathKey>` at evaluation time and exposes a `BlankPathsView` that
  // canonicalises inputs and yields `Path` arrays; see `BlankPathsView`.
  // Reactive Set tracking on the iteration re-evaluates the computed whenever
  // entries change. Writes still go through `setValue(_, unset)`,
  // `markBlank()` or the directive's input listener.
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

  // --- Readonly proxy over the form's value ---
  // `valuesProxyComputed.value` is a deeply-readonly Vue proxy. Wrapping it in
  // a computed is what makes a `state.form.value` reassignment, the
  // replacement path `reset()` and whole-form `setValue` take, invalidate the
  // inner proxy and produce a fresh one keyed to the new target. The callable
  // proxy itself is identity-stable, so a consumer caching `form.values` holds
  // a stable reference whose data tracks the live form value.
  const valuesProxy = buildValuesSurface(state.form, state.onFormChange)

  // --- Per-field state proxy ---
  // Allocated once per `buildFormApi` call, so once per consumer. Each Proxy
  // node memoises its descendants, and the per-path FieldState computeds come
  // from the SAME accessor `meta` and register read through, so every consumer
  // of a path shares one computed and reading `form.fields.email` twice
  // returns the same object, which downstream `===` checks and Vue's render
  // diff both use.
  const fieldStateProxy = buildFieldsSurface(state, getRootFieldStateAt, pathSweep)

  // Lazy-activation gate: every public method routes through `activate`, so
  // the first reactive interaction kicks the captured factory. The activation
  // promise is deliberately ignored, since recursive activates, factory
  // rejections and SSR awaiting are coordinated on `state`.
  //
  // Fast path: a form with no `defaultValuesFactory` AND no SSR prefetch queue
  // gives `state.activate()` nothing to do. The factory is captured exactly
  // once at `useAbstractForm` time, BEFORE this closure runs, so absence here
  // is absence forever, and SSR prefetch binds at `buildFreshState` and is
  // never set client-side. Collapsing `gated` to identity there saves a
  // closure per public-method binding and a reactive ref read per call, across
  // some 30 gated methods.
  const needsLazyGate = state.defaultValuesFactory.value !== undefined || state.hasSsrPrefetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function gated<F extends (...args: any[]) => any>(fn: F): F {
    if (!needsLazyGate) return fn
    return ((...args: Parameters<F>) => {
      void state.activate()
      return fn(...args)
    }) as F
  }

  // `form.list(path)`: the array at `path` as one field state per element, in
  // index order. Entries are the cached `form.fields` terminals, so each stays
  // live and carries its element `key`. Reading the value tracks the array
  // length, so the view recomputes when the array grows or shrinks. The frozen
  // result enforces the read-only contract; mutate through `append`, `remove`,
  // `move` and `swap`.
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

  // `form.record(path)`: the record at `path` as one field state per entry,
  // keyed by the entry's own key. `list`'s counterpart, shaped as a keyed
  // object rather than an ordered array. Entries are the cached `form.fields`
  // terminals, so each stays live, and reading the value and its keys tracks
  // the key set, so the view recomputes when an entry joins or leaves. The
  // frozen result is read-only; grow or shrink the record through `setValue`
  // at an entry path.
  //
  // With no argument it views the root, for a dictionary form whose schema
  // root is itself a record. The typed surface offers the no-arg form only
  // when the root is an open record.
  const EMPTY_FIELD_RECORD: Readonly<Record<string, unknown>> = Object.freeze({})
  function record(path?: string): Readonly<Record<string, unknown>> {
    // No argument addresses the form root (a dictionary form whose schema
    // root is a record). A bare `''` is the literal empty-key path, not
    // the root, so the root case keys off `undefined`, not a default `''`.
    const segments = path === undefined ? [] : canonicalizePath(path).segments
    const value = state.getValueAtPath(segments)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return EMPTY_FIELD_RECORD
    }
    // The container carries `Object.prototype`, so a third-party walker
    // reading the frozen view through `.hasOwnProperty(...)`, `in`, or a JSON
    // serializer with a reducer sees the standard chain. The keys come from
    // the live form value, which can hold a literal `__proto__` own property
    // after a `setValue('record.__proto__', …)`, and `safeAssign` lands it as
    // an own data property here.
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      // Root (`segments` empty) addresses entries by bare key; a nested
      // record prefixes the entry path with its own path.
      safeAssign(out, key, callTerminal(segments.length === 0 ? key : `${path}.${key}`))
    }
    return Object.freeze(out)
  }

  const api: UseFormReturnType<Form, GetValueFormType> = {
    handleSubmit: gated(handleSubmit),
    // The callable readonly Proxies (`values`, `fields`, `errors`) and the
    // reactive containers (`meta`, `history`, `blankPaths`) are exposed through
    // getters, so reading one activates the form on first touch. Each
    // underlying object is identity-stable across reads.
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
    parse: gated(parse) as UseFormReturnType<Form, GetValueFormType>['parse'],
    settleTransforms: gated(state.settleTransforms) as UseFormReturnType<
      Form,
      GetValueFormType
    >['settleTransforms'],
    register: gated(register) as UseFormReturnType<Form, GetValueFormType>['register'],
    key: state.formKey,
    // Auto-unwrapping views over the per-store async-defaults lifecycle
    // refs (see FormStore.hydrating / hydrateError). Reading either
    // activates the form: observing factory state implies use.
    get hydrating(): boolean {
      void state.activate()
      return state.hydrating.value
    },
    get hydrateError(): ValidationError | null {
      void state.activate()
      return state.hydrateError.value
    },
    // Orthogonal to `hydrating` and `hydrateError`. `ready` flips true once
    // defaults are applied, whether sync at construction or from a factory
    // that resolved, and it is a one-way latch: it stays true through later
    // refetches even when those fail, so a stale-while-revalidate UI keeps
    // rendering the prior values while `hydrateError` surfaces the failure.
    get ready(): boolean {
      void state.activate()
      return state.defaultsResolved.value
    },
    // `rehydrate` and `activate` are activation entry points themselves and
    // fire the factory by design, so wrapping them in `gated` would
    // double-fire. They call `state` directly.
    rehydrate: () => state.rehydrate(),
    activate: () => state.activate(),
    get errors(): FormErrorsSurface<Form> {
      void state.activate()
      return errorsProxy as unknown as FormErrorsSurface<Form>
    },
    toRef: gated(pathToRef) as UseFormReturnType<Form, GetValueFormType>['toRef'],
    setErrors: gated(setErrors) as UseFormReturnType<Form, GetValueFormType>['setErrors'],
    clearErrors: gated(clearErrors),
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
    interact: gated(interact) as UseFormReturnType<Form, GetValueFormType>['interact'],
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
  }
  return api
}
