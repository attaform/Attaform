import {
  computed,
  reactive,
  ref,
  shallowRef,
  toRaw,
  toValue,
  triggerRef,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from 'vue'
import type {
  AbstractSchema,
  AttaformDomBinding,
  CoercionRegistry,
  ErrorCell,
  FormKey,
  DefaultValuesResponse,
  GetDisplayState,
  TransformAbortHolder,
  ValidateOn,
  ValidationError,
  WriteMeta,
} from '../types/types-api'
import { resolveGetDisplayState } from './display-state'
import { createDisplayEngine, type DisplayEngine } from './display-engine'
import {
  cloneVariantSnapshot,
  createArrayBookkeeping,
  createArrayIdentity,
  createVariantMemory,
  remapForOp,
  type ArrayBookkeeping,
  type ArrayIdentity,
  type FieldValidationEntry,
  type IndexRemap,
  type VariantMemory,
} from './array-engine'
import type { FieldRecord, OriginalsRecord } from './store-records'
import type { DeepPartial, GenericForm, WriteShape } from '../types/types-core'
import { DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS, normalizeNumericOption } from './defaults'
import { applyChangedKeys, diffAndApply, structuralSnapshot, type Patch } from './diff-apply'
import { makeBlankRequiredError, NO_ERRORS } from './error-codes'
import { groupErrorsByKey } from './errors'
import { runFactoryAndApply } from './form-activation'
import {
  canonicalizePath,
  coerceToPathKey,
  isPathPrefix,
  ROOT_PATH_KEY,
  segmentsForPathKey,
  type Path,
  type PathKey,
  type Segment,
} from './paths'
import {
  getAtPath,
  hasAtPath,
  isPlainRecord,
  mergeStructural,
  setAtPath,
  setAtPathWithSchemaFill,
  tryInPlaceLeafWrite,
} from './path-walker'
import { isShadowedKey, safeAssign } from './safe-assign'
import { __DEV__ } from './dev'
import { resolveCoercionIndex, type CoercionIndex } from './schema-coerce'
import { isSlimPrimitiveValid } from './slim-primitive-gate'
import { walkAuthoredFromConstraints, walkUnspecified } from './unset-walker'

/**
 * A value that holds descendant leaves — an array or a plain object. The dirty
 * machinery treats anything else (primitive, `undefined`, `null`) as a leaf, so
 * replacing a container with one of those drops a whole subtree at once.
 */
const isContainer = (value: unknown): boolean => Array.isArray(value) || isPlainRecord(value)

/**
 * Per-form kernel state — the single store owned by each `useForm` call.
 * Bundles the form value, the summary record, element references, field
 * state, the meta tracker, and the error stores under one keyed-by-
 * `(formKey, path)` record so cross-form DOM state cannot collide. The
 * record's behavior lives in module-level kernel functions that take the
 * state record as their required first argument (see `FormState` below);
 * the store allocates data, not function bodies.
 *
 * This is NOT a singleton. Each call to `useForm` creates its own FormStore
 * instance. The registry provides SSR hydration; otherwise the state is
 * per-component-per-form.
 */

// Hydration shape guards — defend against rolling deploys / stale cache
// where the SSR bundle's record shape diverges from the client's. The
// `as FieldRecord` / `as ValidationError[]` casts in the hydration loop
// would otherwise silently admit malformed entries; downstream reads of
// `.touched` / `.code` then crash with "Cannot read properties of
// undefined" far away from the actual cause. Skip the malformed entries
// and warn once per key in dev so the rolling-deploy diagnosis is loud.
function isHydratedFieldRecord(value: unknown): value is FieldRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<FieldRecord>
  return (
    Array.isArray(r.path) &&
    (typeof r.updatedAt === 'string' || r.updatedAt === null) &&
    typeof r.connected === 'boolean' &&
    (typeof r.focused === 'boolean' || r.focused === null) &&
    (typeof r.blurred === 'boolean' || r.blurred === null) &&
    typeof r.touched === 'boolean' &&
    typeof r.interacted === 'boolean' &&
    typeof r.blurredAfterInteraction === 'boolean'
  )
}

/**
 * Return a copy of `record` with its interaction-history flags cleared
 * (`touched` / `interacted` / `blurredAfterInteraction` to false) and
 * `updatedAt` stamped to `now`. DOM-truth (`focused` / `blurred`) and
 * `connected` are preserved: a reset doesn't synthetically blur the
 * focused input or disconnect the field, so the library shouldn't claim
 * it did. Shared by `reset()` (one `now` across the whole form) and
 * `resetField()`'s per-path clear (a fresh `now` per call), so the
 * caller supplies the timestamp rather than reading the clock here.
 */
function withClearedHistoryFlags(record: FieldRecord, now: string): FieldRecord {
  return {
    path: record.path,
    updatedAt: now,
    connected: record.connected,
    focused: record.focused,
    blurred: record.blurred,
    touched: false,
    interacted: false,
    blurredAfterInteraction: false,
  }
}

function isHydratedValidationErrorArray(value: unknown): value is ValidationError[] {
  if (!Array.isArray(value)) return false
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Partial<ValidationError>
    if (typeof e.message !== 'string') return false
    if (!Array.isArray(e.path)) return false
    if (typeof e.code !== 'string') return false
    // `data` is an opaque JSON passthrough: it arrived via JSON.parse,
    // so it is structurally JSON by construction. Don't hard-validate
    // it here — it rides along on the entry untouched.
  }
  return true
}

function warnMalformedHydration(formKey: FormKey, kind: string, rawKey: string): void {
  if (!__DEV__) return
  console.warn(
    `[attaform] hydration: skipping malformed ${kind} entry at key '${rawKey}' on form '${formKey}'. ` +
      `This usually means the SSR bundle is on a different version than the client (rolling deploy / stale cache).`
  )
}

export type FormStore<F extends GenericForm, G extends GenericForm = F> = {
  readonly formKey: FormKey
  readonly form: Ref<F>
  readonly fields: Map<PathKey, FieldRecord>
  /**
   * The tagged error store: one cell per error-bearing path, each cell
   * segregating its two sources. The `schema` side is written ONLY by
   * the validation pipeline (`scheduleFieldValidation`, `handleSubmit`,
   * the construction-time seed, history restore, hydration) and cleared
   * by `reset` / `resetField` and a successful submit; the `user` side
   * is written ONLY by the `setErrors` / `clearErrors` API surface (and
   * history / hydration replay) and survives schema revalidation and
   * successful submits — the consumer owns its lifetime explicitly.
   * A key exists iff a side is non-empty; cells are replaced, never
   * mutated, so Vue's per-key Map tracking fires for either side's
   * change. Derived blank entries are NOT stored here — they synthesize
   * at read (`derivedBlankErrors`).
   */
  readonly errorCells: Map<PathKey, ErrorCell>
  /**
   * Reactively-derived "No value supplied" errors. Pure function of
   * `(blankPaths, schema.isRequiredAtPath)` — no writers, no clears.
   * Membership tracks `blankPaths` automatically: typing a value into
   * a blank required numeric field removes the path from `blankPaths`
   * and the derived error vanishes; clearing the numeric input re-adds
   * the path and the error reappears. The `errors` proxy and
   * `getErrorsForPath` merge this map in alongside `schemaErrors` and
   * `userErrors`, so consumers see the "this required field is empty"
   * error the moment it's true — no `validate()` / `handleSubmit`
   * call required. Honors the founding principle that
   * `errors = f(schema, state)`.
   *
   * Most entries flow through this map for `number` / `bigint` leaves
   * (where the side-channel is needed to distinguish "user typed 0"
   * from "user supplied nothing"). String / boolean leaves only land
   * here when the consumer explicitly opted in via the `unset`
   * sentinel — see `docs/validation/blank.md`.
   */
  readonly derivedBlankErrors: ComputedRef<ReadonlyMap<PathKey, ValidationError[]>>
  readonly originals: Map<PathKey, OriginalsRecord>
  /**
   * Reactive set of paths whose displayed state should be EMPTY even
   * though storage holds a real, schema-conformant value (the slim
   * default). It exists exclusively to record **storage / display
   * divergence** — the case where the runtime can't tell "user typed
   * 0" from "user supplied nothing" by looking at storage alone.
   *
   * The mechanism shines for `number` / `bigint`: storage holds the
   * slim default (`0` / `0n`) but the DOM input shows `''`, so the
   * directive's input listener marks the path here on clear. Strings
   * and booleans don't need it — `''` storage equals `''` display,
   * `false` storage equals unchecked display — so they're never
   * auto-marked. Consumers can still mark any primitive leaf
   * explicitly via the `unset` sentinel (`defaultValues: { x: unset }`,
   * `setValue('x', unset)`, `reset({ x: unset })`); the mark is then
   * a documented signal of consumer intent rather than runtime
   * inference.
   *
   * Reads (`displayValue` computed, `fields.<path>.blank`,
   * `derivedBlankErrors` computed) track via Vue 3.5's reactive Set
   * handlers. Writes happen inside `setValueAtPath` (gate-hook
   * bookkeeping: `blank: true` meta adds the path; any other write
   * removes it) and `reset`.
   *
   * Storage NEVER reflects this set — calculations and reads against
   * `form.value` see the slim default. The set is purely a UI/intent
   * channel that `derivedBlankErrors` consults to surface
   * "No value supplied" errors for required schemas.
   *
   * See `docs/validation/blank.md` for the conceptual model.
   */
  readonly blankPaths: Set<PathKey>
  /**
   * Snapshot of `blankPaths` captured at construction (and
   * re-captured on `reset(args)`). Used by dirty calculation: a path
   * whose membership differs from the snapshot is dirty even if
   * storage matches the original. Eagerly populated to avoid a "dirty
   * on first read" race after construction.
   */
  readonly originalBlankPaths: Set<PathKey>
  readonly schema: AbstractSchema<F, G>

  /**
   * Server-side flag, plumbed in from `registry.ssr`. The
   * `register()`-returned `markConnectedOptimistically()` reads this
   * before flipping `connected: true`; on the client it's a no-op so
   * the eventual directive lifecycle remains the source of truth.
   */
  readonly ssr: boolean

  /**
   * Resolved `getDisplayState` predicate driving `field.displayState`,
   * the `show*` booleans, and their `form.meta` rollups. Resolved once
   * at construction via `resolveGetDisplayState(options.getDisplayState)`;
   * `undefined` config falls through to `defaultDisplayState`. The
   * field-state computeds read the resolved function directly on every
   * read.
   */
  readonly getDisplayState: GetDisplayState

  /**
   * Per-form display engine: owns the clock and the single timer the timed
   * `getDisplayState` reducer policy needs, keeping the reducer itself a
   * pure `(prev, ctx) => next` function. The field-state computeds route
   * every `displayState` read through `displayEngine.resolve(...)`, which
   * threads the path's previous machine, persists or evicts the result, and
   * re-arms the nearest-deadline timer. Constructed once at form
   * construction; torn down via `registerCleanup` on store eviction.
   */
  readonly displayEngine: DisplayEngine

  // --- submission lifecycle ---
  // Driven by buildProcessForm's handleSubmit wrapper. See use-abstract-form.ts
  // for the public readonly surface. Mutations happen in exactly one place
  // (the submit handler) so there's no "source of truth" ambiguity — these
  // refs live on FormStore so a `reset()` can clear them too.
  //
  // `activeSubmissions` is the source of truth for "is anything in flight".
  // `submitting` mirrors `activeSubmissions > 0` and is what consumers
  // read; tracking the counter separately means overlapping submissions
  // don't prematurely flip submitting to false when the first completes.
  readonly submitting: Ref<boolean>
  readonly activeSubmissions: Ref<number>
  readonly submissionAttempts: Ref<number>
  /**
   * `true` once a `handleSubmit` callback resolved without throwing.
   * Independent of `submissionAttempts` — a failed submit increments
   * attempts but leaves `submitted` at `false`. Cleared by `reset()`
   * alongside the rest of the submission surface.
   */
  readonly submitted: Ref<boolean>
  readonly submitError: Ref<Error | null>

  // --- wizard navigation lifecycle ---
  // Bumped by `useWizard` each time wizard navigation (`next`, `back`,
  // `goTo`) actually departs this form. Cleared by `reset()` alongside
  // the submission lifecycle. Feeds `submissionAttempts`-style reveal in
  // layered `getDisplayState` predicates but does NOT drive the
  // library default. Distinct from `submissionAttempts` (which counts
  // `handleSubmit` passes only) so submission accounting stays
  // unambiguous; distinct from `form.validate()`, which is a read-only
  // primitive that never bumps any counter.
  readonly departAttempts: Ref<number>

  /**
   * Effective data-freeze state: `true` when either the form's own
   * `disabled` config resolves truthy or `externalLock` is set. Read at
   * the write chokepoint (`setValueAtPath`), the register value's
   * `disabled`, and the field display predicate.
   */
  readonly effectiveDisabled: ComputedRef<boolean>
  /**
   * Wizard-driven freeze channel. `useWizard` sets this `true` for a
   * locked step's member form; ORed into `effectiveDisabled` so the
   * wizard lock is authoritative and a member form cannot escape it by
   * passing `disabled: false`. Default `false`.
   */
  readonly externalLock: Ref<boolean>

  /**
   * `true` while a function-form `defaultValues` factory is in flight.
   * Stays `false` for plain-value `defaultValues`. Shared across every
   * `useForm({ key })` call that resolves to this store — the second
   * caller sees the first caller's hydration state.
   */
  readonly hydrating: Ref<boolean>
  /**
   * Error from the most recent function-form `defaultValues` factory.
   * Normalized to a `ValidationError` (code `atta:hydration-failed`) so the
   * shape matches `form.errors` / `form.meta.errors` entries. `null` when
   * no factory has fired or the last one succeeded.
   */
  readonly hydrateError: Ref<ValidationError | null>
  /**
   * The function-form `defaultValues` factory, captured at the first
   * `useForm({ key })` call that wired this store. `undefined` for
   * plain-value forms. Read by `form.rehydrate()`.
   */
  readonly defaultValuesFactory: Ref<(() => unknown | Promise<unknown>) | undefined>
  /**
   * `true` when this store carries an SSR prefetch queue (server path
   * where `state.activate()` must enqueue intent before deciding
   * whether to fire). The flag lets `buildFormApi` skip the lazy
   * activation gate for forms with no factory AND no SSR prefetch —
   * the common client-side case where `gated()` is otherwise pure
   * reactive overhead on every public method call.
   */
  readonly hasSsrPrefetch: boolean
  /**
   * `true` once the form's effective defaults have been applied —
   * sync `defaultValues` at construction, or async factory whose
   * settle completed. Stays `false` for dormant lazy forms until they
   * activate. Read by `useWizard` to decide whether seed status or
   * live meta should surface.
   */
  readonly defaultsResolved: Ref<boolean>
  /**
   * `true` once the captured async factory has been kicked off (set
   * synchronously by `activate()`, before the factory itself resolves).
   * Distinct from `defaultsResolved`, which only flips after the factory
   * settles. The pair lets the API surface tell "we've started" apart
   * from "we're done."
   */
  readonly activated: Ref<boolean>
  /**
   * In-flight activation promise. Concurrent callers (cross-component
   * SSR consumers, recursive factory reads, parallel `activate()`
   * calls) receive the same promise, ensuring the factory runs once
   * even under contention.
   */
  readonly activationPromise: Ref<Promise<void> | undefined>
  /**
   * Idempotent activation entrypoint. Fires the captured function-form
   * `defaultValues` factory on first call and stores the in-flight
   * promise. Subsequent calls return the same promise until the factory
   * settles; thereafter calls return `Promise.resolve()`. Plain-value
   * forms (no factory captured) always return a resolved promise. The
   * public API surface routes all reactive interactions (getters and
   * methods, except `key`) through this entrypoint so the form
   * activates on first use.
   */
  activate(): Promise<void>
  /**
   * Re-fire the captured function-form `defaultValues` factory. Throws
   * synchronously when no factory was captured (plain-value form).
   * Resolves after `hydrating` flips back to `false`; consumers can
   * `await form.rehydrate()` to gate UI on the fresh load.
   *
   * Does NOT touch dirty / touched / submit state — chain
   * `form.reset()` if you want a clean baseline.
   */
  rehydrate(): Promise<void>
  /**
   * Incremented by every `reset()` call. The submit wrapper captures
   * this at entry and skips writing `submitError` from a catch that
   * fires *after* a reset — otherwise a reset-during-submit would
   * visibly clear `submitError` and then have it reappear when the
   * in-flight promise rejects.
   */
  readonly submissionGeneration: Ref<number>
  /**
   * Counts in-flight validation calls across every `validate()` ref and
   * every committing `parse(...)` / `handleSubmit` pre-check. `validating`
   * on the public API mirrors `activeValidations.value > 0`. Tracked
   * separately from submissions because a validate-while-submitting
   * (e.g. a debounced field check overlapping a submit) needs to show
   * the union of both surfaces.
   */
  readonly activeValidations: Ref<number>
  /**
   * `true` once the form has completed at least one validation pass
   * — flips when `activeValidations` returns to 0 from any positive
   * value. Until that happens, `meta.valid` and `field.valid` report
   * `false` even when `schemaErrors.size === 0`, because the absence
   * of errors at frame 1 is just "we haven't checked yet," not "we
   * checked and it's clean."
   *
   * This closes the brief flash window for schemas where the slim
   * default-derivation parse strips refinements (`.refine`,
   * `.superRefine`, async validators): the slim parse passes, no
   * construction-time errors land, and the queued microtask hasn't
   * run yet — so without the gate, frame 1 paints the form as
   * "valid" before the real verdict arrives a tick later.
   *
   * Initialized to `!strict`: non-strict consumers opt out of the
   * validation pipeline by design, so locking them on
   * `firstValidationDone === false` would defeat the opt-out.
   * Reset is left untouched — the post-reset validation flips it
   * back true on completion, same as the construction-time path.
   */
  readonly firstValidationDone: Ref<boolean>
  /**
   * `true` when the sub-schema rooted at `path` (or any of its
   * descendants) declares async work — composes
   * `schema.getSchemasAtPath(path)` with each candidate's
   * `needsAsyncValidation()`, memoised per canonical path key for
   * the lifetime of the FormStore. Used by `meta.valid` /
   * `field.valid` to skip the `firstValidationDone` gate on subtrees
   * that are fully synchronous: their verdict resolves at construction
   * (or on the next per-field run) without waiting on a microtask, so
   * honouring the form-wide gate would just play dumb about a known
   * answer.
   */
  pathHasAsyncValidation(path: Path): boolean
  /**
   * Precomputed-key shortcut for `pathHasAsyncValidation`. The
   * canonical key is required and must correspond to `segments`; the
   * helper skips the `canonicalizePath` round-trip so descendant-walk
   * loops (whose Map iteration already yields the canonical key) can
   * read the async-gate verdict without a per-leaf canonicalize.
   */
  pathHasAsyncValidationByKey(key: PathKey, segments: Path): boolean
  /**
   * Per-path counter of in-flight field-level validation runs.
   * `field.validating` on `FieldState` mirrors
   * `(fieldValidationCounts.get(key) ?? 0) > 0`.
   *
   * Incremented at the same point as `activeValidations` inside
   * `scheduleFieldValidation`'s `run` closure (right before the schema
   * call) and decremented in the matching `.finally` — so the per-path
   * bookkeeping is exactly co-extensive with the form-wide counter for
   * the field-scheduled branch. Whole-form `validate()` /
   * `parse()` runs touch `activeValidations` only; they don't
   * have a single field path and so don't contribute here.
   *
   * Counter (not Set) because two runs for the same path can briefly
   * overlap: when an in-flight run is aborted and a new run starts,
   * the new run increments before the aborted run's `.finally`
   * decrements. With `> 0` semantics the field stays "validating"
   * across the abort/restart boundary.
   *
   * Reactive Map: Vue 3's `reactive(new Map())` proxy makes `.get()`,
   * `.has()`, and `.size` track per-key, so the FieldState
   * computed only re-runs when the count for ITS key changes.
   */
  readonly fieldValidationCounts: Map<PathKey, number>
  /**
   * Per-path `Date.now()` stamp marking when the field's LATEST validation
   * run started, re-anchored on every run start (every increment), deleted
   * on the `→ 0` edge. The display reducer reads it as `ctx.validatingSince`
   * to time the anti-flash spinner, which measures `now - validatingSince`:
   * re-anchoring on each run means a burst of keystrokes (each aborting the
   * prior run and starting a new one) keeps pushing the stamp forward, so the
   * spinner stays suppressed until the user pauses rather than surfacing
   * mid-typing. Anchoring only at the streak start would pin it to the first
   * keystroke, because with `debounceMs: 0` the aborted run's decrement lands
   * after the next run's increment and the count never returns to 0 between
   * fast keystrokes. The field-state container walk takes the descendant-min
   * so a row spinner anchors at its earliest still-active leaf. Runtime-only,
   * never hydrated, like the counts. REACTIVE: the display computed reads this
   * (as `ctx.validatingSince`) but not the `validating` flag, and a long
   * validation that settles with an unchanged verdict (same error, still
   * invalid) leaves `errors` / `valid` untouched — so a non-reactive map would
   * leave a held `pending` spinner stranded after the run ends, until some
   * unrelated reactive change happened to re-run the computed. Reactivity ties
   * the computed to both the streak start (set) and end (delete).
   */
  readonly fieldValidatingSince: Map<PathKey, number>
  /**
   * Per-path counter of in-flight async-transform runs (the async
   * branch of the `register({ transforms })` pipeline). `> 0` drives
   * `field.transforming` / `field.busy`. Counter, not flag, for the
   * same overlap reason as `fieldValidationCounts`, except a superseding
   * input releases the prior run synchronously before incrementing the
   * new one — so the count is the live in-flight depth at the path
   * (effectively 0 or 1). Reactive Map, like the validation counters.
   */
  readonly fieldTransformCounts: Map<PathKey, number>
  /**
   * Per-path `ssr ? 0 : Date.now()` stamp marking when the path's latest
   * async transform opened; the display reducer reads it (as
   * `ctx.transformingSince`) to time the gated busy spinner. Mirrors
   * `fieldValidatingSince` exactly: re-anchored on each run start,
   * deleted on the `→ 0` edge, reactive for the held-spinner reason.
   */
  readonly fieldTransformingSince: Map<PathKey, number>
  /**
   * Per-path latest async-transform failure (a rejected transform, or a
   * resolved value the write gate refused), surfaced as
   * `field.transformError`. Cleared when a fresh run opens at the path
   * and on `reset()`. A channel separate from validation `errors`.
   */
  readonly transformErrors: Map<PathKey, Error | null>
  /**
   * Form-wide count of in-flight async-transform runs. Drives the
   * `settleTransforms` quiescence guard and the `handleSubmit` drain
   * barrier. `Math.max(0, …)`-clamped on release so a doubled decrement
   * (a run's own `endTransform` after a synchronous cancel release)
   * can't drive it negative.
   */
  readonly activeTransforms: Ref<number>

  // --- form mutations ---
  /**
   * Replace the form value wholesale. Optional `meta` is forwarded to
   * every `onFormChange` listener so they can decide whether THIS write
   * is one they care about (e.g. history tagging a hydration replay).
   */
  applyFormReplacement(next: F, meta?: WriteMeta): void
  /**
   * Set a single path's value. `meta` is forwarded to listeners via
   * `applyFormReplacement` (see above). Public `form.setValue` passes no
   * meta.
   *
   * Returns `false` when the slim-primitive gate rejects the write
   * (the value's primitive shape doesn't match the schema's slim
   * shape at the path). The store is unchanged in that case.
   */
  setValueAtPath(path: Path, value: unknown, meta?: WriteMeta): boolean
  getValueAtPath(path: Path): unknown
  /**
   * Stable identity for the array element at `path`. An array element
   * (numeric last segment) carries its allocated identity token,
   * maintained by the arrays engine across structural mutations.
   * Empty for any non-array-element path: a record entry, a
   * fixed-object field, a container, or the root. Backs `FieldState.key`.
   */
  arrayElementKey(path: Path): string

  // --- reset ---
  reset(nextDefaultValues?: DeepPartial<WriteShape<F>>): void
  resetField(path: Path): void

  // --- errors ---
  // Schema-driven writers. Used by the validation pipeline + handleSubmit.
  setSchemaErrorsForPath(path: Path, errors: ValidationError[]): void
  setAllSchemaErrors(errors: readonly ValidationError[]): void
  clearSchemaErrors(path?: Path): void
  /**
   * Replace `schemaErrors` under `path` with `errors`, keying each
   * error by its OWN absolute path. Used by validation pipelines
   * (scheduleFieldValidation, the committing parse, handleSubmit, reset)
   * to commit a parse result wholesale — entries not in the new
   * pass get dropped from the subtree, surviving keys update in
   * place to preserve insertion order. Pass `path === []` for the
   * whole-form scope.
   */
  applySchemaErrorsForSubtree(path: Path, errors: ValidationError[]): void

  // User-driven writers. Used by build-form-api's setErrors / clearErrors.
  setAllUserErrors(errors: readonly ValidationError[]): void
  setUserErrorsForPath(path: Path, errors: readonly ValidationError[]): void
  clearUserErrors(path?: Path): void

  /**
   * Rebuild the whole tagged store from a snapshot's `[key, cell]`
   * entries — the history ring buffer's restore road. Entry arrays are
   * cloned in, so the snapshot stays detached from the live store;
   * cells with both sides empty are skipped.
   */
  restoreErrorCells(entries: ReadonlyArray<readonly [PathKey, ErrorCell]>): void

  /**
   * Merged read — the cell at `path` in schema -> blank -> user order.
   * Schema errors come first (structural validation before business
   * logic), the derived blank entry synthesizes between, and user
   * entries close, matching the iteration order for
   * `getFirstErrorElement` and the top-level `errors` drillable Proxy.
   */
  getErrorsForPath(path: Path): ValidationError[]

  /**
   * Returns a stable schema-declaration ordinal for `key`, assigning a
   * fresh one if the path hasn't been seen before. Drives
   * `form.meta.errors` sort order so the aggregate is a function of the
   * SET of errors currently present (not the temporal order their
   * Map keys were last `set`). Construction-time seed walks every leaf
   * in the schema's slim default; runtime callers (DU variant 2, dynamic
   * array indices, refines targeting cross-field paths) pick up
   * first-encounter ordinals and keep them for the form's lifetime.
   */
  ensurePathOrdinal(key: PathKey): number

  // --- DOM ---
  /**
   * The store's DOM slice, `null` until the directive cluster or
   * `useRegister` arms it via `RegisterValue.ensureDomBinding`. Element
   * registration, host anchors, and first-error focus resolution all
   * live behind it; eager readers treat `null` as an empty registry.
   */
  readonly domBinding: ShallowRef<AttaformDomBinding | null>
  /**
   * Field-record connect transition, driven by the DOM binding on
   * element attach / host connect (and by the SSR-only
   * `markConnectedOptimistically`): `connected: true`, with
   * `focused` / `blurred` lifted from `null` to optimistic booleans
   * only when currently null — an existing boolean from an early focus
   * event is never clobbered.
   */
  noteDomConnected(path: Path): void
  /**
   * Field-record disconnect transition, driven by the DOM binding when
   * a path's last element detaches or its host disconnects:
   * `connected: false`, `focused` / `blurred` back to `null` (DOM-state
   * properties are meaningless with nothing attached; interaction
   * history stays).
   */
  noteDomDisconnected(path: Path): void
  /**
   * Optional `meta.instance` carries per-`useForm()`-instance overrides
   * for `validateOn` / `debounceMs` so the blur-trigger respects the
   * caller's config when sibling instances share a FormStore.
   */
  markFocused(
    path: Path,
    focused: boolean,
    meta?: { readonly instance?: WriteMeta['instance'] }
  ): void
  /**
   * Flip `interacted: true` on a leaf — the sticky value-mutation flag.
   * Driven by the directive's input listeners (via the RegisterValue's
   * `markInteracted`); idempotent, never set by programmatic writes.
   */
  markInteracted(path: Path): void
  /**
   * Walk every active-variant leaf under `segments` and flip
   * `touched: true`. Powers `form.touch(path?)`. Idempotent;
   * does not mutate value / focused / blurred or trigger validation.
   */
  touchAtPath(segments: Path): void
  /**
   * Walk every active-variant leaf under `segments` and flip the full
   * interaction ladder (`touched` / `interacted` /
   * `blurredAfterInteraction`), as though the user had focused,
   * edited, and left each one. Powers `form.interact(path?)`.
   * Idempotent; does not mutate value / focused / blurred. Returns
   * whether any leaf resolved, so the caller can skip validation and
   * dev-warn on an empty path.
   */
  interactAtPath(segments: Path): boolean
  /**
   * SSR-only optimistic mark: flip `connected: true` on the field
   * record without an actual DOM element. Called by the `vRegisterHint`
   * compile-time transform via `RegisterValue.markConnectedOptimistically()`
   * for every element rendered with `v-register`. Idempotent + no-op on
   * the client (the directive's `created` hook is the authoritative
   * source there).
   */
  markConnectedOptimistically(path: Path): void

  // --- derived ---
  /**
   * Leaf-only pristine check. `originals` is populated via
   * `diffAndApply`'s `added` patches, which fire only on primitive
   * leaves — a container path (e.g. `['profile']`) that isn't in
   * `originals` returns `true` here even when a descendant is dirty.
   * Callers that need container semantics should either loop over
   * leaves or walk `originals` manually. The public `getFieldState`
   * surface is typed to accept leaf paths only, so in practice this
   * isn't exposed to consumers.
   */
  isPristineAtPath(path: Path): boolean
  /**
   * Precomputed-key shortcut for `isPristineAtPath`. The canonical
   * key is required and must correspond to `segments`; the helper
   * skips the `canonicalizePath` round-trip so descendant-walk loops
   * (whose Map iteration already yields the canonical key) can read
   * the pristine verdict without a per-leaf canonicalize.
   */
  isPristineAtPathByKey(key: PathKey, segments: Path): boolean
  /**
   * Whether any tracked array under `path` has changed shape — a reorder,
   * insert, or removal — relative to its construction/reset baseline. The
   * structural half of `dirty`: per-element baselines travel with their
   * element across a mutation, so a positional value comparison alone can
   * no longer see the shape change.
   */
  hasStructuralChangeUnder(path: Path): boolean
  /**
   * Whether a baseline-present container under `path` was replaced wholesale by
   * a non-container (e.g. `setValue('profile', undefined)`) and is still absent.
   * The other half of removal-driven `dirty`: such a subtree's leaves vanish
   * from the live value, so neither the present-leaf walk nor the array tracker
   * can see the loss. Self-filters by current liveness, so a refilled path stops
   * counting.
   */
  hasRemovedSubtreeUnder(path: Path): boolean
  getFieldRecord(path: Path): FieldRecord | undefined
  getOriginalAtPath(path: Path): unknown

  /**
   * Cancel every in-flight field-level validation run — clears timers
   * for debounced 'change' runs that haven't fired, latches `aborted`
   * for runs whose async parse is in flight. Called by `handleSubmit`
   * at entry (submit validation is authoritative) and by `reset()`.
   */
  cancelFieldValidation(): void

  /**
   * Open an async-transform run at `key` — bump the run token, increment
   * the in-flight counters, stamp `transformingSince`, clear any prior
   * `transformError`, register `holder` for later abort. Returns the run
   * token. See `InternalRegisterValue.beginTransform`.
   */
  beginTransform(key: PathKey, holder: TransformAbortHolder): number
  /** `true` while `token` is the live async-transform run at `key`. */
  isCurrentTransform(key: PathKey, token: number): boolean
  /**
   * Close the run `token` at `key`: release the counters (no-op if the
   * run was already released by a supersede / cancel) and flush settled
   * `settleTransforms` waiters.
   */
  endTransform(key: PathKey, token: number): void
  /** Record a per-field normalization failure at `key` (`field.transformError`). */
  setTransformError(key: PathKey, err: Error): void
  /**
   * Abort + release every in-flight async-transform run (all paths) and
   * clear `transformErrors`. Mirrors `cancelFieldValidation`; called by
   * `reset()` and store teardown.
   */
  cancelTransforms(): void
  /**
   * Path-scoped counterpart to `cancelTransforms`: abort + release only
   * the runs at-or-under `prefix`, clearing their `transformError`.
   * Called by `resetField`.
   */
  cancelTransformsUnder(prefix: Path): void
  /**
   * Resolve once async transforms are quiescent — globally (`path`
   * omitted) or at-or-under `path`. Resolve-never-reject. See
   * `UseFormReturnType.settleTransforms`.
   */
  settleTransforms(path?: string | Path): Promise<void>

  /**
   * Kick off (or schedule) a field-level validation run for `path`. Pass
   * `path = []` to cover the whole form; `applySchemaErrorsForSubtree`
   * then wipes every `schemaErrors` entry and replaces them with the
   * adapter's full async response. Used by persistence's post-hydration
   * revalidation and by the construction-time async-refine seed.
   *
   * `immediate: true` skips the debounce window — the runtime kicks off
   * the adapter call on the next microtask. Internal callsites use this
   * for one-shot triggers; the per-keystroke writers pass `false` to
   * coalesce rapid mutations under the configured debounceMs.
   *
   * `override` carries per-`useForm()`-instance values: when provided,
   * the scheduler honors `override.mode` instead of the store's
   * captured `validateOn`, and `override.debounceMs` instead of the
   * store's captured `debounceMs`. Used so sibling instances sharing a
   * FormStore can each validate on their own cadence.
   */
  scheduleFieldValidation(
    path: Path,
    immediate: boolean,
    override?: { readonly mode?: ValidateOn; readonly debounceMs?: number }
  ): void

  /**
   * Subscribe to every `applyFormReplacement`. Fires synchronously
   * after `form.value` has been swapped to `next` and all field /
   * originals bookkeeping has run. Used by undo/redo to hook the single
   * mutation funnel. The optional `meta` carries the originating call
   * site's intent; subscribers that don't care about meta can ignore the
   * parameter. Returns an unsubscribe function.
   */
  onFormChange(listener: (next: F, meta?: WriteMeta) => void): () => void

  /**
   * Subscribe to successful submissions. Fires after the consumer's
   * `onSubmit` callback has resolved — not on validation failure,
   * not on callback throw. The DevTools panel rides this to surface a
   * submit event. Returns an unsubscribe function.
   */
  onSubmitSuccess(listener: () => void): () => void

  /**
   * Subscribe to `reset()` calls. Fires AFTER reset has replaced
   * the form and cleared errors + lifecycle, so listeners see the
   * fresh post-reset state. Used by the history module to drop the
   * undo/redo stack on reset. Returns an unsubscribe function.
   */
  onReset(listener: () => void): () => void

  /**
   * Internal: notify submit-success subscribers. Called by
   * `handleSubmit` in `process-form.ts` once the user callback has
   * resolved. Consumers shouldn't call this directly.
   */
  emitSubmitSuccess(): void

  /**
   * Register a teardown function whose lifetime is bound to the
   * FormStore itself (not a consumer's Vue effect scope). Called by
   * `dispose()` when the last consumer unmounts. Used by persistence /
   * history wiring so their subscribers aren't detached prematurely
   * when only the first consumer unmounts but others remain.
   */
  registerCleanup(fn: () => void): void

  /**
   * Register an async drain function. Called by the registry before
   * `dispose()` so async background work — chiefly the persistence
   * layer's debounced storage writes — has a chance to settle without
   * losing the last keystroke. Each registered function is awaited in
   * parallel; failures are swallowed to keep eviction reliable.
   */
  registerDrain(fn: () => Promise<void>): void

  /**
   * Drain async work registered via `registerDrain`. Resolves once
   * every registered drain has settled (in parallel). Safe to call
   * repeatedly — registered drains decide their own idempotency.
   */
  awaitPendingWrites(): Promise<void>

  /**
   * Cache for per-state modules (history, persistence) that must
   * outlive any single consumer. Subsequent `useForm` / `injectForm`
   * calls for the same key read from this map so the public API shape
   * is identical regardless of mount order. Keyed by a string identifier
   * owned by the caller (e.g. `'history'`).
   */
  readonly modules: Map<string, unknown>

  /**
   * Resolved schema-coercion index — the merged config from
   * `createAttaform({ defaults: { coerce } })` ∪ `useForm({ coerce })`,
   * keyed by `${input}->${output}` for O(1) per-keystroke dispatch.
   * Empty Map when coercion is disabled. Read at `register()` time
   * by `buildCoerceFn` to bake the per-path coerce closure on
   * `RegisterValue.coerce`.
   */
  readonly coerceIndex: CoercionIndex

  /**
   * Tear down non-reactive resources owned by this FormStore. Invoked
   * by the registry when the last consumer unmounts. Cancels pending
   * field-validation timers, drops every subscriber, and fires each
   * cleanup hook registered via `registerCleanup`.
   */
  dispose(): void
}

/**
 * Hydration payload shape accepted by `createFormStore`. When provided, the
 * initial form value comes from here rather than from `schema.getDefaultValues`.
 * Used to replay SSR state on the client; originals are reconstructed from
 * the schema because they're not serialised.
 */
export type FormStoreHydration = {
  readonly form: unknown
  /**
   * Schema-driven errors snapshot. Replayed into `schemaErrors` at
   * construction; takes precedence over the construction-time seed.
   */
  readonly schemaErrors: ReadonlyArray<readonly [string, unknown]>
  /**
   * User-injected errors snapshot. Replayed into `userErrors` at
   * construction. Allows server-side errors set through `setErrors` to
   * round-trip through hydration.
   */
  readonly userErrors: ReadonlyArray<readonly [string, unknown]>
  readonly fields: ReadonlyArray<readonly [string, unknown]>
  /**
   * Path keys that were in the form's `blankPaths` set at
   * SSR time. Replayed into the reactive Set on the client so the
   * "displayed empty" state survives the round-trip. Optional —
   * pre-v3 envelopes don't carry it; missing means "no transient-
   * empty paths".
   */
  readonly blankPaths?: ReadonlyArray<string>
}

export type CreateFormStoreOptions<F extends GenericForm, G extends GenericForm = F> = {
  readonly formKey: FormKey
  readonly schema: AbstractSchema<F, G>
  readonly defaultValues?: DeepPartial<WriteShape<F>> | undefined
  readonly strict?: boolean | undefined
  readonly hydration?: FormStoreHydration | undefined
  /**
   * When per-field validation runs. Default `'change'`. See `ValidateOn`.
   * The discriminated union `ValidateOnConfig` lives at the public
   * `useForm` boundary; the internal store accepts the resolved
   * fields directly so the type-narrowing dance stays at the public
   * surface.
   */
  readonly validateOn?: ValidateOn | undefined
  /**
   * Per-field debounce when `validateOn === 'change'`. Default `0`
   * (disabled). Ignored under `'blur'` and `'submit'`.
   */
  readonly debounceMs?: number | undefined
  readonly ssr?: boolean | undefined
  /**
   * Path keys to seed the `blankPaths` set with at construction.
   * Only consulted when `hydration` is undefined — hydration data is
   * authoritative when present (its own `blankPaths` field
   * takes precedence). Used by `useAbstractForm`'s `unset`-symbol pre-
   * pass (commit 7 wires the producer); commit 2 plumbs the channel
   * through with no callers yet.
   */
  readonly initialBlankPaths?: ReadonlyArray<string> | undefined
  /**
   * Whether to remember per-variant typed state across discriminated-
   * union switches. Default `true`. See `UseFormConfiguration.rememberVariants`
   * for full semantics.
   */
  readonly rememberVariants?: boolean | undefined
  /**
   * Raw `disabled` config (boolean / ref / computed / getter /
   * undefined), unwrapped live via `toValue` into
   * `FormStore.effectiveDisabled`. Threaded raw (not resolved at merge)
   * so a reactive source keeps tracking. See
   * `UseFormConfiguration.disabled` for the full contract.
   */
  readonly disabled?: MaybeRefOrGetter<boolean | undefined> | undefined
  /**
   * Schema-driven coercion config. See
   * `UseFormConfiguration.coerce` for the full contract. Resolved
   * once via `resolveCoercionIndex(options.coerce)` and cached on
   * `FormStore.coerceIndex`.
   */
  readonly coerce?: boolean | CoercionRegistry | undefined
  /**
   * Configurable predicate driving `field.displayState`, the `show*`
   * booleans, and their `form.meta` rollups. Function | undefined;
   * resolved once at construction via `resolveGetDisplayState`. See
   * `UseFormConfiguration.getDisplayState` and
   * `AttaformDefaults.getDisplayState` for the full contract and
   * three-tier resolution rules.
   */
  readonly getDisplayState?: GetDisplayState | undefined
  /**
   * SSR prefetch coordination, bound at `buildFreshState` time. Omitted
   * on the client where the queue is never read.
   *
   * `enqueue()` records this form's key on the registry's prefetch set
   * so any activation path (explicit `form.activate()`, gated reads
   * through the public surface, recursive factory reads) signals
   * intent to the SSR drain.
   *
   * `shouldFire()` returns whether `state.activate()` should actually
   * fire the captured factory on the server. The wizard's negative
   * override — `registry.skipPrefetch(key)` for non-current steps —
   * flips this to `false` even when `enqueue()` has been called, so
   * the render-efficiency skip for non-current steps survives a stray
   * `form.activate()` or a future transform mark on a skipped step.
   * Returns `true` for any form the wizard hasn't skipped, including
   * plain-value forms where the factory branch is skipped anyway.
   */
  readonly ssrPrefetch?:
    | {
        enqueue: () => void
        shouldFire: () => boolean
      }
    | undefined
}

/**
 * `true` when the JSON-encoded PathKey identifies a path strictly
 * nested under `parentPath` — i.e. shares every parent segment and
 * has at least one more. Used by the union-variant reshape to clear
 * blank-bookkeeping for paths that no longer exist in the new
 * variant's effective shape.
 */
function isPathKeyUnder(existingKey: PathKey, parentPath: Path): boolean {
  const parsed = segmentsForPathKey(existingKey)
  if (parsed === null) return false
  if (parsed.length <= parentPath.length) return false
  for (let i = 0; i < parentPath.length; i++) {
    if (parsed[i] !== parentPath[i]) return false
  }
  return true
}

/**
 * Walk an `initialData` / restored payload and collapse any object whose
 * position carries a discriminated union but whose `discriminator` value
 * isn't a known variant literal into a stub holding only the
 * discriminator key. Drops any first-variant fields that snuck in past
 * the parser to keep the form value structurally consistent with the
 * schema's view of "no variant selected yet."
 *
 * The walker is intentionally pure — every dependency (schema, data,
 * base path, warning-set policy) is a parameter, not a closure capture
 * — so `createFormStore` can call it both at construction (for the
 * authored defaults) and inside `reshapeUnionAtPath` (for runtime
 * variant transitions) without sharing state across calls.
 *
 * SSR hydration payloads (third-party storage JSON) flow through the
 * same walker. Pollution defense routes every untrusted-key write
 * through `safeAssign`, which uses `Object.defineProperty` for the
 * `__proto__` key (own data property, no chain mutation) and plain
 * bracket-assign for every other key. Legitimate fields literally
 * named `prototype` / `constructor` / `__proto__` round-trip the same
 * way every other key does.
 *
 * `warn: true` opts in to a `__DEV__`-only one-shot per
 * `(dotted-path, disc-value)` console warning when a non-blank
 * discriminator value falls back to a stub — typo-style bugs where the
 * consumer wrote `kind: 'BAD'` and got a stub by accident. The blank
 * literals `''` / `0` / `0n` / `false` / `null` are the intentional
 * "no variant selected" signal from `expandUnsetAt` and never warn.
 */
export function applyDuStubs(
  schema: AbstractSchema<unknown, unknown>,
  data: unknown,
  options: { warn?: boolean; basePath?: Path } = {}
): unknown {
  const warned = options.warn === true ? new Set<string>() : undefined
  return walkDuStubs(schema, data, options.basePath ?? [], warned)
}

function walkDuStubs(
  schema: AbstractSchema<unknown, unknown>,
  value: unknown,
  path: Path,
  warned: Set<string> | undefined
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    typeof value === 'function'
  ) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => walkDuStubs(schema, item, [...path, i], warned))
  }
  const rec = value as Record<string, unknown>
  const du = schema.getUnionDiscriminatorAtPath(path)
  if (du !== undefined) {
    const discValue = rec[du.discriminatorKey]
    if (discValue !== undefined && !du.isVariantSelected(discValue)) {
      // Kind-blank stub (`''` / `0` / `0n` / `false` / `null`) is the
      // intentional "no variant selected yet" signal from
      // `expandUnsetAt` — don't warn. The warn is for typo-style bugs
      // where the user wrote `kind: 'BAD'` and got a stub by accident.
      const isKindBlank =
        discValue === '' ||
        discValue === 0 ||
        discValue === 0n ||
        discValue === false ||
        discValue === null
      if (!isKindBlank && warned !== undefined && __DEV__) {
        const dotted = path.map((s) => String(s)).join('.') || '(root)'
        const key = `${dotted}::${String(discValue)}`
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(
            `[attaform] defaultValues at '${dotted}' carries discriminator ` +
              `'${du.discriminatorKey}=${JSON.stringify(discValue)}' which isn't a known variant. ` +
              `Form mounts in a stub holding only the discriminator key. Validation will surface the mismatch.`
          )
        }
      }
      // The disc-only stub routes the discriminator-key write through
      // `safeAssign` so a schema using `z.discriminatedUnion('__proto__', …)`
      // (vanishingly rare, but possible) lands the disc value as an
      // own data property instead of invoking the inherited setter.
      const stub: Record<string, unknown> = {}
      safeAssign(stub, du.discriminatorKey, discValue)
      return stub
    }
  }
  // SSR-walk container. The `safeAssign` per key lands a literal
  // `__proto__` segment as an own data property; every other key
  // takes the plain bracket-assign branch. A hostile payload carrying
  // `__proto__` can't reassign the container's prototype chain.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(rec)) {
    safeAssign(out, k, walkDuStubs(schema, rec[k], [...path, k], warned))
  }
  return out
}

/**
 * Walk a consumer-supplied value and drop Symbol-keyed properties
 * recursively. Form values are string-keyed by schema design — symbols
 * at any level would trip JSON serialization (persistence adapters),
 * the variant-memory snapshot, and surface as
 * `Object.getOwnPropertySymbols(values.x).length > 0`.
 *
 * Fast path: returns the input unchanged when the tree contains no
 * symbols at any level. Only allocates a new object/array on the
 * spine that contains a stripped node, so the common no-symbol
 * case has zero allocation cost.
 */
function stripSymbolsDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let mutated = false
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const cleaned = stripSymbolsDeep(value[i])
      out[i] = cleaned
      if (cleaned !== value[i]) mutated = true
    }
    return mutated ? out : value
  }
  // Skip non-plain objects (Date, Map, Set, RegExp, class instances) —
  // their semantics aren't "key:value" and stripping would corrupt
  // them. Symbol-keyed properties on these are a consumer concern.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const symKeys = Object.getOwnPropertySymbols(value)
  const stringKeys = Object.keys(value)
  let mutated = symKeys.length > 0
  const out: Record<string, unknown> = {}
  const src = value as Record<string, unknown>
  for (const k of stringKeys) {
    const cleaned = stripSymbolsDeep(src[k])
    out[k] = cleaned
    if (cleaned !== src[k]) mutated = true
  }
  return mutated ? out : value
}

/**
 * Diff the schema's with-defaults data against its blank baseline (the
 * raw `deriveDefault(false)` walk) to find every path where the schema
 * author declared a `.default(...)` chain. Paths whose value differs
 * between the two are positions where a declared default takes effect,
 * including `.default(undefined)` — which still differs from the blank
 * baseline because the latter falls through to the inner schema's
 * empty value (`''`, `0`, etc.) rather than the wrapper's chosen
 * undefined.
 */
function walkAuthoredFromSchemaDiff(
  withDefaults: unknown,
  withoutDefaults: unknown,
  prefix: Path,
  out: Set<PathKey>
): void {
  if (isPlainRecord(withDefaults) && isPlainRecord(withoutDefaults)) {
    const left = withDefaults as Record<string, unknown>
    const right = withoutDefaults as Record<string, unknown>
    const keys = new Set<string>([...Object.keys(left), ...Object.keys(right)])
    for (const k of keys) {
      walkAuthoredFromSchemaDiff(left[k], right[k], [...prefix, k], out)
    }
    return
  }
  if (Array.isArray(withDefaults) && Array.isArray(withoutDefaults)) {
    const len = Math.max(withDefaults.length, withoutDefaults.length)
    for (let i = 0; i < len; i++) {
      walkAuthoredFromSchemaDiff(withDefaults[i], withoutDefaults[i], [...prefix, i], out)
    }
    return
  }
  if (!Object.is(withDefaults, withoutDefaults) && prefix.length > 0) {
    out.add(canonicalizePath(prefix).key)
  }
}

/**
 * One in-flight async-transform run at a path: a monotonic `token`
 * (globally unique via `FormState.transformTokenSeq`, so a superseded run
 * can never collide with a future one even after the entry is deleted and
 * recreated) plus the directive-owned abort `holder`. `released` guards
 * the count so a synchronous cancel / supersede release isn't
 * double-counted by the run's own late `endTransform`.
 */
type TransformRun = { token: number; holder: TransformAbortHolder; released: boolean }

/**
 * The kernel's full state record: the public `FormStore` contract plus the
 * internal slots the module-level kernel functions operate on. Everything a
 * per-form closure used to capture lives here as an explicit member, and
 * every kernel function takes the record as its required first argument —
 * the store allocates data, not function bodies. The `FormStore` methods on
 * the returned record are thin per-instance arrows delegating into the
 * shared module functions.
 */
export type FormState<F extends GenericForm, G extends GenericForm = F> = FormStore<F, G> & {
  // --- resolved configuration (fixed at construction) ---
  readonly strict: boolean
  /** Construction-time `defaultValues`, kept as `reset()`'s fallback source. */
  readonly defaultValues: DeepPartial<WriteShape<F>> | undefined
  readonly ssrPrefetch: CreateFormStoreOptions<F, G>['ssrPrefetch']
  readonly rememberVariants: boolean
  readonly fieldValidationMode: ValidateOn
  readonly fieldValidationDebounceMs: number

  // --- internal containers ---
  readonly fieldValidationState: Map<PathKey, FieldValidationEntry>
  readonly formChangeListeners: Set<(next: F, meta?: WriteMeta) => void>
  readonly submitSuccessListeners: Set<() => void>
  readonly resetListeners: Set<() => void>
  readonly cleanupHooks: (() => void)[]
  readonly drainHooks: (() => Promise<void>)[]
  readonly authoredPaths: Set<PathKey>
  readonly arrayIdentity: ArrayIdentity
  readonly removedSubtrees: Set<PathKey>
  readonly variantMemory: VariantMemory
  readonly pathOrdinals: Map<PathKey, number>
  readonly pathSnapshots: Map<PathKey, unknown>
  readonly pathAsyncCache: Map<PathKey, boolean>
  readonly transformRuns: Map<PathKey, TransformRun>
  readonly transformWaiters: { key: PathKey | null; resolve: () => void }[]
  readonly arrayBookkeeping: ArrayBookkeeping

  /**
   * Per-form DU capability flag, computed once at construction from
   * `schema.hasDiscriminatedUnions?.()` (absent reads as `true` — the
   * conservative per-write probes stay on). `false` skips the
   * cross-variant ancestor guard, the variant-reshape dispatch, and
   * construction-time stub correction entirely.
   */
  readonly hasDU: boolean

  // --- mutable scalars (plain fields; never read reactively) ---
  nextOrdinal: number
  scheduleEpoch: number
  lastCommittedEpoch: number
  transformTokenSeq: number
  warnedDisabledWrite: boolean
}

// --- Construction = reset: the shared baseline sequence ---
// Construction and `reset()` both establish a pristine baseline. The steps
// they genuinely share live in the helpers below so the two paths cannot
// drift; the mode-specific work (field-record seeding vs history-flag
// clearing, hydration replay vs lifecycle teardown) stays at each call
// site.

/**
 * Compute the effective baseline for `source` (consumer `defaultValues` at
 * construction, `nextDefaultValues ?? defaultValues` at reset). Sparse
 * constraints pre-merge through `mergeStructural` BEFORE `getDefaultValues`
 * so partial constraints against tuple shapes (e.g. `coords: [42]` for
 * `z.tuple([_, _, _])`) get padded with position defaults before the
 * adapter's validate-then-fix loop sees them — and so the adapter's
 * verdict is rendered against the FILLED form, keeping the construction
 * and reset responses byte-equivalent for the same source.
 */
function computeBaselineResponse<F extends GenericForm, G extends GenericForm = F>(
  schema: AbstractSchema<F, G>,
  strict: boolean,
  source: DeepPartial<WriteShape<F>> | undefined
): DefaultValuesResponse<F> {
  const completed =
    source === undefined
      ? undefined
      : (mergeStructural(schema, [], source) as DeepPartial<WriteShape<F>>)
  return schema.getDefaultValues({
    useDefaultSchemaValues: true,
    constraints: completed,
    strict,
  })
}

/**
 * Initial value of the `firstValidationDone` gate — shared by the ref's
 * construction seed and `reset()`'s restore, so the post-reset window
 * gates container `.valid` exactly like the post-mount window does. Only
 * async-validating strict schemas need the gate; see the
 * `FormStore.firstValidationDone` JSDoc.
 */
function initialFirstValidationGate<F extends GenericForm, G extends GenericForm = F>(
  schema: AbstractSchema<F, G>,
  strict: boolean
): boolean {
  return !strict || schema.needsAsyncValidation?.() !== true
}

/**
 * Rebuild `originals` from a fresh baseline value tree. `diffAndApply`
 * visits every leaf in declaration order. Construction passes
 * `ensureOrdinals: true` so `pathOrdinals` gets schema-declaration order
 * for free in the same walk; `reset()` passes `false`, preserving its
 * lazy first-encounter ordinal assignment for paths a reset baseline
 * introduces (ordinals never reset — a path keeps its slot for the
 * form's lifetime).
 */
function seedOriginalsFromBaseline<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  baseline: unknown,
  ensureOrdinals: boolean
): void {
  st.originals.clear()
  diffAndApply({}, baseline, [], (patch) => {
    if (patch.kind !== 'added') return
    const { key } = canonicalizePath(patch.path)
    st.originals.set(key, { segments: patch.path, value: patch.newValue })
    if (ensureOrdinals) ensurePathOrdinal(st, key)
  })
}

/**
 * Queue the one-shot full-form validation pass that surfaces async-only
 * verdicts (e.g. zod's `.refine(async (v) => ...)`), which can't surface
 * from the sync `getDefaultValues` contract. Shared by construction and
 * `reset()`. Two gates: SKIP on SSR (microtasks don't get awaited before
 * `renderToString` serialises, so firing would only stamp a misleading
 * `validating: true` into the SSR HTML that the client's hydration pass
 * wouldn't reproduce), and `queueMicrotask` so the increment lands AFTER
 * Vue's synchronous hydration / first render. Gated to strict mode AND to
 * schemas that actually need async work — sync-only schemas would
 * otherwise pay a redundant microtask + briefly flash
 * `meta.validating: true`, misrepresenting "validation is running" when
 * nothing is.
 */
function queueInitialAsyncValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  if (!st.ssr && st.strict && st.schema.needsAsyncValidation?.() === true) {
    queueMicrotask(() => scheduleFieldValidation(st, [], true /* immediate */))
  }
}

/**
 * Rebuild `authoredPaths` from a fresh constraints baseline + schema
 * defaults. Used at construction AND at `reset()` time. Both moments
 * replace the form's pristine reference, so the authoring set must
 * track the new baseline. Idempotent: clears the Set first, then
 * re-populates from (1) the constraints argument and (2) a diff of
 * the schema's with-defaults data against its blank baseline.
 */
function rebuildAuthoredPaths<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  constraints: unknown,
  schemaWithDefaultsData: unknown
): void {
  st.authoredPaths.clear()
  if (constraints !== undefined) {
    walkAuthoredFromConstraints(constraints, [], st.authoredPaths)
  }
  // The authored-default diff needs only the schema's BLANK baseline
  // value tree (every `.default()` skipped), not a validated parse of
  // it. `getEmptyValueAtPath([])` is the raw `deriveDefault(false)`
  // walk — structurally identical to a full slim-mode
  // `getDefaultValues({ useDefaultSchemaValues: false })` here (the
  // blank tree round-trips through the slim parse unchanged), without
  // the schema clone + double `safeParse` that pass pays. Locked by
  // `test/core/authored-baseline-equivalence.test.ts`.
  const slimBaseline = st.schema.getEmptyValueAtPath([])
  walkAuthoredFromSchemaDiff(schemaWithDefaultsData, slimBaseline, [], st.authoredPaths)
}

/**
 * Filter schema-source verdicts: drop issues at preprocess / coerce
 * leaves whose storage is undefined AND whose path the consumer
 * never authored. Form-level errors (`path.length === 0`) and
 * verdicts at paths with non-undefined storage always pass through.
 * Mount and field-validation pipelines run errors through this
 * filter; `handleSubmit` does not (submit is the moment "you must
 * have supplied all fields" applies, and the consumer should see
 * every verdict).
 */
function filterAuthoredErrors<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  errors: readonly ValidationError[]
): ValidationError[] {
  return errors.filter((err) => {
    const pathSegments = err.path as Path
    if (pathSegments.length === 0) return true
    const value = getAtPath(st.form.value, pathSegments)
    if (value !== undefined) return true
    if (st.authoredPaths.has(canonicalizePath(pathSegments).key)) return true
    return !st.schema.isPreprocessOrCoerceLeaf(pathSegments)
  })
}

// FieldState.key: an array element (numeric last segment) carries its
// allocated identity token, which travels with the element across
// structural mutations so a keyed `v-for` survives reorders. Empty for
// any non-array-element path; a record entry's stable identity is its
// own key, surfaced through `form.record`, so it needs no token here.
function arrayElementKey<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): string {
  if (path.length === 0) return ''
  const last = path[path.length - 1]
  if (typeof last === 'number') return st.arrayIdentity.tokenAt(path.slice(0, -1), last)
  return ''
}

function ensurePathOrdinal<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey
): number {
  let ordinal = st.pathOrdinals.get(key)
  if (ordinal === undefined) {
    ordinal = st.nextOrdinal
    st.pathOrdinals.set(key, ordinal)
    st.nextOrdinal += 1
  }
  return ordinal
}

function pathHasAsyncValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): boolean {
  const { key } = canonicalizePath(path)
  return pathHasAsyncValidationByKey(st, key, path)
}

function pathHasAsyncValidationByKey<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  segments: Path
): boolean {
  const cached = st.pathAsyncCache.get(key)
  if (cached !== undefined) return cached
  // `getSchemasAtPath` returns every candidate sub-schema (DU
  // variants, intersections all surface here). Async work in any
  // candidate means the prefix is "could be async" — be
  // conservative and gate. Adapters that don't expose
  // `needsAsyncValidation` are treated as `false`, matching the
  // optional-method contract on AbstractSchema.
  const candidates = st.schema.getSchemasAtPath(segments)
  const hasAsync = candidates.some((sub) => sub.needsAsyncValidation?.() === true)
  st.pathAsyncCache.set(key, hasAsync)
  return hasAsync
}

function incFieldValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey
): void {
  // Stamp `validatingSince` BEFORE bumping the count so the two signals can
  // never disagree mid-flight. The count drives `field.validating` (and so
  // clamps `field.valid` to false for the duration of a run); `validatingSince`
  // is what the display reducer reads to decide "settled vs in-flight". If the
  // count led, a synchronous reader landing between the two writes would see
  // `validating: true, validatingSince: null` — the reducer would read the run
  // as settled and return the in-flight verdict (idle, because `valid` is
  // clamped), flashing idle at the start of every re-validation. Stamping the
  // anchor first makes `validatingSince !== null` an outer bracket around
  // `count > 0` (it is cleared only AFTER the count reaches 0, in
  // `decFieldValidation`), so the reducer never sees a run as settled while
  // `valid` is still clamped.
  //
  // Re-anchored on every run start, not just the 0 → 1 edge: the anti-flash
  // show-delay measures `now - validatingSince`, so a burst of keystrokes —
  // each aborting the prior run and starting a new one — keeps pushing the
  // anchor forward and the spinner stays suppressed until the user pauses.
  // Anchoring only at the streak start would surface the spinner mid-typing:
  // with `debounceMs: 0` the aborted run's `.finally` decrement lands a
  // microtask AFTER the next run's increment, so the count oscillates
  // 1 → 2 → 1 and never returns to 0 between fast keystrokes, pinning the
  // stamp to the first keystroke. `ssr` never reaches here in practice (no
  // field validation is scheduled server-side); the `0` keeps the stamp
  // clock-free.
  st.fieldValidatingSince.set(key, st.ssr ? 0 : Date.now())
  const prevCount = st.fieldValidationCounts.get(key) ?? 0
  st.fieldValidationCounts.set(key, prevCount + 1)
}

function decFieldValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey
): void {
  const next = (st.fieldValidationCounts.get(key) ?? 0) - 1
  if (next <= 0) {
    // → 0 edge: clear the count FIRST (so `field.valid` is accurate again),
    // THEN drop the anchor — the trailing edge of the bracket described in
    // `incFieldValidation`. Whenever the reducer sees `validatingSince ===
    // null` the count is already 0 and `valid` is settled, so a run is never
    // read as settled while `valid` is still clamped. Co-extensive across the
    // abort / cancel / migrate paths that release a count.
    st.fieldValidationCounts.delete(key)
    st.fieldValidatingSince.delete(key)
  } else {
    st.fieldValidationCounts.set(key, next)
  }
}

function incFieldTransform<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey
): void {
  // Stamp-before-bump, same bracket invariant as `incFieldValidation`:
  // `transformingSince !== null` is the outer bracket around
  // `count > 0`, so a reader landing between the two writes never sees
  // a run as settled while the field still reads `transforming`.
  st.fieldTransformingSince.set(key, st.ssr ? 0 : Date.now())
  st.fieldTransformCounts.set(key, (st.fieldTransformCounts.get(key) ?? 0) + 1)
}

function decFieldTransform<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey
): void {
  const next = (st.fieldTransformCounts.get(key) ?? 0) - 1
  if (next <= 0) {
    st.fieldTransformCounts.delete(key)
    st.fieldTransformingSince.delete(key)
  } else {
    st.fieldTransformCounts.set(key, next)
  }
}

// Resolve every queued `settleTransforms` waiter that has gone idle —
// a keyed waiter when its path count hits 0, a global waiter when
// `activeTransforms` hits 0. Re-checks live state per waiter, so it is
// safe to call from any `→ 0` edge (`endTransform` / cancel).
function flushSettledTransformWaiters<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  if (st.transformWaiters.length === 0) return
  const globalIdle = st.activeTransforms.value === 0
  for (let i = st.transformWaiters.length - 1; i >= 0; i--) {
    const w = st.transformWaiters[i]
    if (w === undefined) continue
    const idle = w.key === null ? globalIdle : (st.fieldTransformCounts.get(w.key) ?? 0) === 0
    if (idle) {
      st.transformWaiters.splice(i, 1)
      w.resolve()
    }
  }
}

// Synchronously tear down one run: latch the abort holder, abort its
// controller if the chain ever reached for `ctx.signal`, and release
// the counters. Idempotent via `released`, so a supersede / cancel
// release and the run's own late `endTransform` don't double-count.
// Does NOT remove the map entry — the caller decides that.
function releaseTransformRun<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  run: TransformRun
): void {
  if (run.released) return
  run.released = true
  run.holder.aborted = true
  run.holder.controller?.abort()
  st.activeTransforms.value = Math.max(0, st.activeTransforms.value - 1)
  decFieldTransform(st, key)
}

function beginTransform<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  holder: TransformAbortHolder
): number {
  // Supersede: a new input at the same path aborts + releases the
  // prior run synchronously (so `field.transforming` reflects only the
  // live run and the count stays 0/1 per path), then this run opens.
  const prior = st.transformRuns.get(key)
  if (prior !== undefined) releaseTransformRun(st, key, prior)
  const token = ++st.transformTokenSeq
  st.transformRuns.set(key, { token, holder, released: false })
  incFieldTransform(st, key)
  st.activeTransforms.value += 1
  // A fresh run supersedes the prior verdict — drop any stale error so
  // a recovered input doesn't keep showing the last failure.
  if (st.transformErrors.has(key)) st.transformErrors.delete(key)
  return token
}

function isCurrentTransform<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  token: number
): boolean {
  return st.transformRuns.get(key)?.token === token
}

function endTransform<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  token: number
): void {
  const run = st.transformRuns.get(key)
  // Only the live run releases the counters and clears the entry. A
  // superseded / cancelled run (token no longer matches, or already
  // released) was released at teardown — its late `endTransform` only
  // flushes waiters.
  if (run?.token === token) {
    if (!run.released) {
      st.activeTransforms.value = Math.max(0, st.activeTransforms.value - 1)
      decFieldTransform(st, key)
    }
    st.transformRuns.delete(key)
  }
  flushSettledTransformWaiters(st)
}

function setTransformError<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  err: Error
): void {
  st.transformErrors.set(key, err)
}

function cancelTransforms<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  for (const [key, run] of [...st.transformRuns]) {
    releaseTransformRun(st, key, run)
    st.transformRuns.delete(key)
  }
  // A cleared form starts from a clean transform slate — drop
  // normalization failures that have no in-flight run of their own.
  if (st.transformErrors.size > 0) st.transformErrors.clear()
  flushSettledTransformWaiters(st)
}

function cancelTransformsUnder<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  prefix: Path
): void {
  for (const [key, run] of [...st.transformRuns]) {
    const segs = segmentsForPathKey(key)
    if (segs === null) continue
    if (!isPathPrefix(prefix, segs)) continue
    releaseTransformRun(st, key, run)
    st.transformRuns.delete(key)
    st.transformErrors.delete(key)
  }
  flushSettledTransformWaiters(st)
}

function settleTransforms<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path?: string | Path
): Promise<void> {
  if (path === undefined) {
    if (st.activeTransforms.value === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      st.transformWaiters.push({ key: null, resolve })
    })
  }
  const { key } = canonicalizePath(path)
  if ((st.fieldTransformCounts.get(key) ?? 0) === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    st.transformWaiters.push({ key, resolve })
  })
}

function touchFieldRecord<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  pathKey: PathKey,
  path: Path,
  patch: Partial<Omit<FieldRecord, 'path'>>
): void {
  const current = st.fields.get(pathKey)
  st.fields.set(pathKey, {
    path,
    updatedAt: patch.updatedAt ?? current?.updatedAt ?? null,
    connected: patch.connected ?? current?.connected ?? false,
    // focused/blurred use an explicit-undefined guard because
    // patches legitimately carry `null` to mark a disconnect — the
    // `??` operator would short-circuit on null and fall through to
    // `current`, losing the intent. `!== undefined` honours an
    // explicit null and preserves current only on absence.
    focused: patch.focused !== undefined ? patch.focused : (current?.focused ?? null),
    blurred: patch.blurred !== undefined ? patch.blurred : (current?.blurred ?? null),
    // touched is plain `boolean`; `??` is equivalent to the explicit
    // guard here because `false` is not nullish.
    touched: patch.touched ?? current?.touched ?? false,
    // interacted is sticky-true; a merge patch only ever sets it, so
    // `??` preserves the current bit. It flips back to false solely
    // through the reset paths, which reconstruct the record outright.
    interacted: patch.interacted ?? current?.interacted ?? false,
    blurredAfterInteraction:
      patch.blurredAfterInteraction ?? current?.blurredAfterInteraction ?? false,
  })
}

// Shared commit tail for every value mutation: stamp per-leaf field
// metadata from the captured patches, then notify change listeners.
// Runtime-added paths (e.g. `append('posts', {...})` introducing a new
// array index) compare against `undefined` for `dirty` — appearing IS a
// mutation; only `reset()` rebaselines the originals map, so this records
// absence-as-original to keep the first appearance dirty. Listeners fire
// after field bookkeeping (they must see a fully-updated form), and their
// throws are isolated so one bad subscriber can't block the rest; `meta`
// propagates the call-site's intent (e.g. an array op or hydration tag).
function commitWritePatches<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  patches: readonly Patch[],
  meta?: WriteMeta
): void {
  const now = new Date().toISOString()
  for (const patch of patches) {
    const { key } = canonicalizePath(patch.path)
    if (patch.kind === 'added' && !st.originals.has(key)) {
      st.originals.set(key, { segments: patch.path, value: undefined })
    }
    touchFieldRecord(st, key, patch.path, { updatedAt: now })
  }
  for (const listener of st.formChangeListeners) {
    try {
      listener(st.form.value, meta)
    } catch (err) {
      console.error('[attaform] onFormChange threw:', err)
    }
  }
}

function applyFormReplacementWithPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  next: F,
  meta: WriteMeta | undefined,
  arrayOpPath: Path | null
): void {
  const prev = st.form.value
  if (Object.is(prev, next)) return
  // Capture the diff before any mutation lands — `commitWritePatches`
  // needs the per-leaf patches against the OLD shape, and
  // `applyChangedKeys` consumes the same list to decide which keys to
  // reassign, so every replacement pays exactly one content walk.
  const patches: Patch[] = []
  diffAndApply(prev, next, [], (patch) => {
    patches.push(patch)
  })
  // Mutate `form.value` in place so Vue's deep-reactivity dependencies
  // fire ONLY for the first-level keys whose subtree changed. A
  // wholesale `form.value = next` would fire every deep watch (including
  // watches on sub-trees that didn't change), which deadlocks the
  // browser when a watcher reacts by writing back to the form (the
  // canonical "same as pickup address" mirror pattern).
  //
  // On a top-level shape mismatch (object → array, etc.) fall back
  // to wholesale replacement — that's the only case where in-place
  // merging can't preserve existing reactive proxies anyway.
  // The typed array helpers thread the mutated array's path (`arrayOpPath`);
  // on those writes a changed container-valued key reconciles in place, keeping
  // stable references for the mutated array AND every ancestor container on the
  // path to it, at any depth. So a reorder fires only the moved indices and a
  // nested-array append re-renders only that list, never the whole-array /
  // whole-parent re-render. A non-helper replacement (`arrayOpPath` null:
  // explicit setValue, reset, undo / redo, cross-tab, hydration, DU reshape)
  // reassigns changed keys wholesale, so a container target gets a fresh ref.
  if (!applyChangedKeys(prev, next, arrayOpPath, [], patches)) {
    st.form.value = next
  } else if (
    patches.some(
      (p) => p.path.length > 0 && typeof p.path[0] === 'string' && isShadowedKey(p.path[0])
    )
  ) {
    // A root-level prototype-shadowed key (`hasOwnProperty`, `toString`,
    // `valueOf`, …) changed. Its reactive readers descend through
    // `safeOwnRead` (`Object.getOwnPropertyDescriptor`), which bypasses
    // Vue's reactive get-trap, so they registered NO per-key dependency —
    // they ride only on this ref's own dep. `applyChangedKeys` mutated the
    // slot in place (the set-trap fires the key's dep, but nothing
    // subscribed to it) and kept root identity stable, so `form.value` was
    // not reassigned. Fire the ref explicitly to wake those readers; this
    // is the coarse whole-`form`-ref signal the shadowed-descent path
    // documents as its reactivity mechanism. Only fires for the rare write
    // that touches a root-level shadowed field — every ordinary field keeps
    // its fine-grained per-key dependency untouched.
    triggerRef(st.form)
  }
  commitWritePatches(st, patches, meta)
}

// Public whole-value replacement (history restore, cross-tab merge, reset,
// hydration, DU reshape, devtools, tests). Threads a null array path, so the
// reconcile reassigns changed keys wholesale and a container target gets a
// fresh reference. Only the targeted array-helper write path opts into the
// stable-reference container reconcile, via `applyFormReplacementWithPath`.
function applyFormReplacement<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  next: F,
  meta?: WriteMeta
): void {
  applyFormReplacementWithPath(st, next, meta, null)
}

// Fast path for a single `setValue` whose target leaf already exists:
// mutate that leaf's slot in place (O(depth)), preserving every ancestor
// container's identity, then commit the exact per-leaf patches the
// full-tree diff would have emitted (the old root diff only ever
// descended this same subtree). Structural writes — a missing
// intermediate, array growth, a new key, a container target, or a
// prototype-shadowed segment — fall back to the copy-on-write
// `applyFormReplacement`, which correctly re-references the grown
// container. The contract: a container's reference changes IFF the write
// targets it or alters its structure; a descendant-leaf edit preserves
// every ancestor reference.
function applyTargetedWrite<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  completedValue: unknown,
  meta?: WriteMeta
): void {
  const result = tryInPlaceLeafWrite(st.form.value, path, completedValue)
  if (!result.applied) {
    // A structural write (array growth / reorder, a new key, a container
    // target). For a typed array-helper op (`meta.arrayOp` set), `path` IS the
    // mutated array's canonical path — thread it so the reconcile keeps every
    // ancestor container on the way to it stable. Any other structural write
    // passes null and reassigns changed keys wholesale.
    applyFormReplacementWithPath(
      st,
      setAtPathWithSchemaFill(st.form.value, st.schema, path, completedValue) as F,
      meta,
      meta?.arrayOp !== undefined ? path : null
    )
    return
  }
  const patches: Patch[] = []
  diffAndApply(result.old, completedValue, path, (patch) => {
    patches.push(patch)
  })
  commitWritePatches(st, patches, meta)
}

/**
 * The single write funnel: every value mutation (consumer `setValue`,
 * directive assign, array op, DU variant reshape) lands here. Kept whole
 * as deliberate complexity — it touches essentially all of the state
 * record, and the ordering of its phases (the
 * slim-primitive gate, DU reshape, structural fill, storage write, then
 * blank / error bookkeeping and the change-listener notify) is itself
 * the correctness. Splitting it into argument-passed helpers would
 * scatter that ordering and trade a single source of truth for a
 * fan-out of partial writers (net-negative).
 *
 * Its observable contracts are pinned by characterization suites rather
 * than unit-tested internals: variant-memory restore + nested-DU stub
 * correction (discriminated-union-variant-switch, du-variant-persistence),
 * blank-path insertion-order stability (blank-paths-order-stability), and
 * the same-tick value + schemaErrors commit / no-flicker reshape
 * (du-variant-error-flicker).
 */
function setValueAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  value: unknown,
  meta?: WriteMeta
): boolean {
  // Data-freeze gate: when the form is disabled (own `disabled` config
  // or a wizard lock), every value write no-ops here — the single
  // chokepoint all three write origins funnel through (programmatic
  // `setValueImpl`, the directive's `setValueWithInternalPath`, and
  // `setValueFromHost` including its `markBlank` path). The first
  // blocked write dev-warns once; thereafter silent, never throws.
  // `reset()` and hydration bypass this (they route through
  // `applyFormReplacementWithPath`), so a frozen form can still be
  // populated or cleared programmatically.
  if (st.effectiveDisabled.value) {
    if (__DEV__ && !st.warnedDisabledWrite) {
      st.warnedDisabledWrite = true
      console.warn(
        `[attaform] Ignored a write to a disabled form ("${String(st.formKey)}"). ` +
          `Value writes no-op while \`disabled\` resolves truthy. This warning fires once.`
      )
    }
    return false
  }
  // Decode a structural array op into its index permutation exactly
  // once, against the PRE-op array still live at `path`. Every
  // consumer below derives from this one remap: the fresh-slot
  // scoping (symbol strip, slim gate, structural completion,
  // authoring) reads `remap.fresh`, and the post-write bookkeeping
  // pass replays the whole permutation.
  let arrayOpRemap: IndexRemap | null = null
  if (meta?.arrayOp !== undefined) {
    const preOpValue = getAtPath(st.form.value, path)
    arrayOpRemap = remapForOp(meta.arrayOp, Array.isArray(preOpValue) ? preOpValue.length : 0)
  }
  // Drop any Symbol-keyed properties before the value flows through
  // the gate, DU reshape, or storage. Form values are string-keyed
  // by schema design and the consumer-side leak would otherwise
  // surface in `Object.getOwnPropertySymbols(values.x)` and break
  // downstream JSON serialization (persistence) + variant memory. On an
  // array structural op only the fresh element(s) carry consumer input;
  // existing elements were stripped when first written and only shift
  // position here, so strip just the new slot(s) instead of deep-walking
  // all N. The field-array helper owns this fresh array copy, so the
  // in-place element strip is safe — the same scoping the slim gate,
  // mergeStructural, and the authored walk apply below.
  if (arrayOpRemap !== null && Array.isArray(value)) {
    for (const idx of arrayOpRemap.fresh) {
      value[idx] = stripSymbolsDeep(value[idx])
    }
  } else {
    value = stripSymbolsDeep(value)
  }
  // Slim-primitive write gate: every leaf in the value must match
  // the schema's slim primitive set at its sub-path. Refinement-level
  // constraints (.email/.min/enum membership/etc.) are NOT enforced
  // here — they're a validation concern. See ./slim-primitive-gate.ts.
  // The gate short-circuits at `z.preprocess` / `z.coerce` wrappers
  // so storage retains the consumer's raw input; the schema-side
  // normalizers fire during `safeParse`, not at the write boundary.
  let slimOk = true
  if (arrayOpRemap !== null && Array.isArray(value)) {
    // Array structural op: only the freshly-introduced element(s) carry new
    // leaf values. Existing elements were gated when first written and only
    // shift position here, so validate just the fresh slots, not all N.
    for (const idx of arrayOpRemap.fresh) {
      if (!isSlimPrimitiveValid(st.schema, st.form, [...path, idx], value[idx])) {
        slimOk = false
        break
      }
    }
  } else {
    slimOk = isSlimPrimitiveValid(st.schema, st.form, path, value)
  }
  if (!slimOk) {
    return false
  }
  // Cross-variant write guard: walking the path, if any ancestor is
  // a DU whose ACTIVE disc value resolves to a known variant that
  // doesn't contain the next path segment, the write targets an
  // inactive-variant key (e.g. `setValue('notify.number', ...)`
  // while the active channel is 'email'). Or the ancestor is in
  // stub state (disc isn't a known variant). Reject so foreign
  // sibling-variant fields can't leak into form.values.
  //
  // The DU's own disc key is always reachable — writes to it
  // recover the form from stub state by selecting a valid variant
  // — so the guard skips when the next path segment IS the disc.
  if (st.hasDU && path.length >= 2) {
    for (let i = 0; i < path.length - 1; i++) {
      const ancestorPath = path.slice(0, i + 1)
      const du = st.schema.getUnionDiscriminatorAtPath(ancestorPath)
      if (du === undefined) continue
      const nextSeg = path[i + 1]
      if (nextSeg === du.discriminatorKey) continue
      const ancestorValue = getAtPath(st.form.value, ancestorPath)
      if (!isPlainRecord(ancestorValue)) continue
      const discValue = (ancestorValue as Record<string, unknown>)[du.discriminatorKey]
      if (discValue === undefined) {
        return false
      }
      if (!du.isVariantSelected(discValue)) {
        return false
      }
      const variantDefault = du.getVariantDefault(discValue)
      if (!isPlainRecord(variantDefault)) continue
      if (typeof nextSeg !== 'string') continue
      if (!(nextSeg in (variantDefault as Record<string, unknown>))) {
        return false
      }
    }
  }

  // Latest-write-wins over the transform channel. The write has cleared
  // the slim gate + cross-variant guards, so it WILL commit (here, via a
  // DU reshape below, or the normal mutation) — a committed synchronous
  // write to this path (or a container write above it) supersedes any
  // in-flight async transform at or under it, whose eventual resolved
  // value is now stale. Covers `setValueWithInternalPath`, `markBlank`,
  // and `form.setValue` uniformly (all funnel through here). The deferred
  // orchestrator releases its own run before committing, so a transform
  // landing its own value is not caught. Guarded on `transformRuns.size`
  // so the common no-transforms write stays allocation-free.
  if (st.transformRuns.size !== 0) cancelTransformsUnder(st, path)

  // Discriminated-union variant transitions. Writing a discriminator
  // — whether as a leaf write to the discriminator key or as a
  // wholesale write of the union value carrying a different
  // discriminator — changes the schema's effective shape at the
  // union's location. Old-variant keys (e.g. `address` on the email
  // branch) become foreign once `channel: 'sms'` lands; new-variant
  // required keys need their slim defaults populated so the
  // errors-as-state pipeline sees the new shape. Two flavours, both
  // routed through `reshapeUnionVariant`:
  //
  //   Case A — leaf write to the discriminator key
  //   (`setValue('notify.channel', 'sms')`). Parent path is the
  //   union; the new value names a variant directly.
  //
  //   Case B — wholesale write of the union itself
  //   (`setValue('notify', { channel: 'sms', number: '...' })`).
  //   Path is the union; the consumer's value carries the
  //   discriminator. Layer the consumer's value on top of the
  //   matched variant default so consumer-supplied keys win.
  if (st.hasDU && meta?.skipDiscriminatorReshape !== true) {
    // Case A: discriminator-key write.
    if (path.length > 0) {
      const last = path[path.length - 1]
      if (typeof last === 'string') {
        const parentPath = path.slice(0, -1)
        const parentDU = st.schema.getUnionDiscriminatorAtPath(parentPath)
        if (parentDU?.discriminatorKey === last) {
          const oldValue = getAtPath(st.form.value, path)
          if (!Object.is(oldValue, value)) {
            const variantDefault = parentDU.getVariantDefault(value)
            if (variantDefault !== undefined) {
              return reshapeUnionVariant(
                st,
                parentPath,
                oldValue,
                value,
                variantDefault,
                undefined,
                meta
              )
            }
            // Disc value isn't a known variant literal. Storage at
            // the union path becomes a stub holding only the disc
            // key — prior variant body dropped, no first-variant-
            // default leak. Validation surfaces the issue via Zod's
            // natural invalid_union_discriminator at parentPath.
            return reshapeUnionVariant(
              st,
              parentPath,
              oldValue,
              value,
              { [last]: value },
              undefined,
              meta
            )
          }
        }
      }
    }
    // Case B: whole-union write.
    if (isPlainRecord(value)) {
      const selfDU = st.schema.getUnionDiscriminatorAtPath(path)
      if (selfDU !== undefined) {
        const valueRecord = value as Record<string, unknown>
        const discKey = selfDU.discriminatorKey
        const discValue = valueRecord[discKey]
        const currentUnionValue = getAtPath(st.form.value, path)
        const oldDiscValue = isPlainRecord(currentUnionValue)
          ? (currentUnionValue as Record<string, unknown>)[discKey]
          : undefined
        if (discValue !== undefined) {
          const variantDefault = selfDU.getVariantDefault(discValue)
          if (variantDefault !== undefined && isPlainRecord(variantDefault)) {
            return reshapeUnionVariant(
              st,
              path,
              oldDiscValue,
              discValue,
              variantDefault,
              valueRecord,
              meta
            )
          }
          // Consumer supplied a disc value that's not a known
          // variant. Stub holds only the disc key; non-disc consumer
          // keys are dropped (consumerOverrides = undefined) so
          // foreign fields don't leak into form.values.
          return reshapeUnionVariant(
            st,
            path,
            oldDiscValue,
            discValue,
            { [discKey]: discValue },
            undefined,
            meta
          )
        }
        // Consumer wrote a whole-union value with NO discriminator.
        // The form is "between selections" — empty stub {} ; every
        // consumer key is dropped (no auto-merge with the first-
        // variant default).
        return reshapeUnionVariant(st, path, oldDiscValue, undefined, {}, undefined, meta)
      }
    }
  }

  // Blank bookkeeping. `blank: true` adds the path
  // to the set (the call site declares "this write represents an
  // empty intent"); any other write removes the exact key. A
  // container write also drops every descendant blank-mark under
  // `path` (mirrors the DU-reshape path's `isPathKeyUnder` sweep) —
  // a write to `addr` replaces every leaf beneath, so any prior
  // "I'm blank" mark at `addr.zip` is now stale. The arrayOp branch
  // skips the descendant sweep because `migrateArrayElementState`
  // relocates per-element blank-marks across the operation's exact
  // permutation downstream; sweeping ahead of it would delete the
  // marks the migration needs to carry forward. The mark/unmark
  // sit BEFORE the identity short-circuit so transitions that
  // don't change storage value (e.g. typing 0 over slim-default 0)
  // still update the visual / blank state correctly.
  // Pre-write value at `path`, read once: `form.value` is not mutated
  // until `applyFormReplacement` below, so the same read serves the
  // descendant-sweep gate (just below) and the identity short-circuit.
  const currentValue = getAtPath(st.form.value, path)
  const pathKey = canonicalizePath(path).key
  if (meta?.blank === true) {
    st.blankPaths.add(pathKey)
  } else {
    if (st.blankPaths.has(pathKey)) st.blankPaths.delete(pathKey)
    // Descendant sweep: a write replaces the whole subtree at `path`, so
    // any blank-mark UNDER `path` is now stale. Only a container can have
    // had descendants, so gate on the PRE-WRITE value being one. A scalar
    // leaf write (the keystroke hot path) has no descendants; running the
    // sweep there scans the entire blank set for nothing, O(F) per write.
    // Clearing a container with a non-container (null / undefined) still
    // sweeps, since `currentValue` was the container. `isPathKeyUnder`
    // returns true at root for every non-empty key, so a root write still
    // drops all marks.
    if (
      meta?.arrayOp === undefined &&
      (isPlainRecord(currentValue) || Array.isArray(currentValue))
    ) {
      for (const existingKey of [...st.blankPaths]) {
        if (isPathKeyUnder(existingKey, path)) st.blankPaths.delete(existingKey)
      }
    }
  }

  // Authored bookkeeping: a setValue is the consumer authoring `path`
  // (and every sub-path inside `value`, if it's a container). The
  // schema-error filter consults this set to distinguish "no consumer
  // input at this preprocess / coerce leaf" from "consumer wrote
  // undefined here." The latter must surface verdicts; the former
  // is the runtime no-value-yet stub the filter exists to suppress.
  // Marking before the identity short-circuit covers the
  // setValue('url', undefined) over an already-undefined leaf case;
  // the mark is cheap and consistent either way.
  const wasAuthoredBefore = st.authoredPaths.has(pathKey)
  if (arrayOpRemap !== null && Array.isArray(value)) {
    // The array container itself is authored (the consumer wrote it via a
    // field-array op), matching the whole-array walk this replaces. Existing
    // elements keep their authored marks (relocated with the op by
    // the structural-op bookkeeping), so only the fresh element(s) need a
    // fresh walk.
    if (path.length > 0) st.authoredPaths.add(pathKey)
    for (const idx of arrayOpRemap.fresh) {
      walkAuthoredFromConstraints(value[idx], [...path, idx], st.authoredPaths)
    }
  } else {
    walkAuthoredFromConstraints(value, path, st.authoredPaths)
  }
  const newlyAuthored = !wasAuthoredBefore && st.authoredPaths.has(pathKey)

  // Structural-completeness invariant: every write must leave the
  // form satisfying the slim schema. Two ingress points to fill:
  //   1. The target value (consumer may have passed a partial; the
  //      schema's element default fills missing keys / array
  //      elements via mergeStructural).
  //   2. Intermediate gaps along the path (missing object property,
  //      array length below target index — setAtPathWithSchemaFill
  //      asks the schema for defaults at each gap site).
  // The common case (write to existing slot with a complete value)
  // hits no schema lookups: mergeStructural short-circuits on
  // ref-equal sub-trees, and the fill walker only queries the
  // schema at gap sites.
  let completedValue: unknown
  if (arrayOpRemap !== null && Array.isArray(value)) {
    // Complete only the fresh element(s) against the schema element default;
    // existing elements are already structurally complete from prior writes.
    // Mutating the caller's fresh array copy in place is safe (the field-array
    // helper builds and hands it off exactly once).
    for (const idx of arrayOpRemap.fresh) {
      value[idx] = mergeStructural(st.schema, [...path, idx], value[idx])
    }
    completedValue = value
  } else {
    completedValue = mergeStructural(st.schema, path, value)
  }
  // Identity short-circuit: if the path's current value already
  // matches what we'd write, skip the replacement. Without this,
  // every keystroke that produces an unchanged trimmed/cast value
  // (e.g. typing a trailing space into a `.trim` input — trim → ""
  // → form already at "") would still replace `form.value` with a
  // new object identity, triggering Vue to re-render the input and
  // patch the `:value` binding (which compares against the live
  // DOM `el.value`, not the previous vnode prop). The patch
  // overwrites the user's transient whitespace and the spacebar
  // appears broken.
  if (Object.is(currentValue, completedValue)) {
    // Storage unchanged, skip the replacement to avoid spurious
    // re-renders. Narrow exception: at a preprocess / coerce leaf,
    // a write that newly authors the path changes the filter's
    // verdict semantics. Prior validation passes were suppressed
    // because the path wasn't authored yet; a fresh pass needs to
    // fire so the verdict surfaces. The narrow scope (preprocess /
    // coerce only) preserves the original short-circuit for plain
    // primitives — `setValue('income', 0)` over a mount-time `0`
    // stays a true no-op and doesn't kick off a validation cycle.
    if (newlyAuthored && st.schema.isPreprocessOrCoerceLeaf(path)) {
      const modeForAuthoringTransition = meta?.instance?.validateOn ?? st.fieldValidationMode
      if (modeForAuthoringTransition === 'change') {
        scheduleFieldValidation(st, path, false /* debounced */, {
          ...(meta?.instance?.validateOn !== undefined ? { mode: meta.instance.validateOn } : {}),
          ...(meta?.instance?.debounceMs !== undefined
            ? { debounceMs: meta.instance.debounceMs }
            : {}),
        })
      }
    }
    return true
  }
  // For a wholesale array replacement (no `arrayOp` to follow), anchor the
  // identity baseline at the PRE-write order before `applyTargetedWrite`
  // resizes the array in place. On an array's first track this is the only
  // chance to capture its baseline length: realigning only afterwards (below)
  // would anchor the already-resized order, so a shrink — an element removal —
  // on a never-rendered array would read structurally pristine and fail to
  // dirty the form (#420). The post-write realign then advances the current
  // order while the baseline stays put, so the length delta surfaces through
  // `hasStructuralChangeUnder`. Idempotent once the array is tracked, and it
  // mirrors what the `arrayOp` branch gets for free from the remap's
  // recorded pre-op length.
  if (arrayOpRemap === null && Array.isArray(value) && Array.isArray(currentValue)) {
    st.arrayIdentity.realign(path)
  }
  applyTargetedWrite(st, path, completedValue, meta)
  // Structural-mutation bookkeeping. The field-array helpers tag each
  // op with an `arrayOp`; the remap decoded at funnel entry drives one
  // engine pass — per-element state relocation, fresh-element seeding,
  // derived-state eviction (schema verdicts + variant memory),
  // in-flight validation aborts at vacated indices, and the identity
  // replay. Runs after `applyFormReplacement` so it overwrites the
  // placeholder originals replacement seeds at shifted destinations
  // with each moved element's true baseline. Raw whole-array setValues
  // (`setValue('events', [...])`) instead clear all memory under the
  // array path because identity bookkeeping was lost wholesale —
  // memory keyed by absolute index would otherwise bleed onto new
  // occupants of those indices on a future variant switch.
  if (arrayOpRemap !== null) {
    st.arrayBookkeeping.applyStructuralOp(path, arrayOpRemap)
  } else if (Array.isArray(value) && Array.isArray(currentValue)) {
    st.variantMemory.clearUnderPath(path)
    st.arrayIdentity.realign(path)
  } else if (isContainer(currentValue) && !isContainer(value)) {
    // A baseline-present container dropped to a non-container: record the path
    // so the container dirty check still fires for the vanished subtree (see
    // `removedSubtrees`). Gated on real baseline presence so removing an
    // optional section that was empty at construction — added, then cleared
    // again — lands back at pristine rather than reading dirty.
    if (subtreeHadRealBaseline(st, path, currentValue)) {
      st.removedSubtrees.add(canonicalizePath(path).key)
    }
  }
  const effectiveModeAfterWrite = meta?.instance?.validateOn ?? st.fieldValidationMode
  if (effectiveModeAfterWrite === 'change') {
    scheduleFieldValidation(st, path, false /* debounced */, {
      ...(meta?.instance?.validateOn !== undefined ? { mode: meta.instance.validateOn } : {}),
      ...(meta?.instance?.debounceMs !== undefined ? { debounceMs: meta.instance.debounceMs } : {}),
    })
  }
  return true
}

/**
 * Replace the union's parent storage with the activated variant's
 * value, atomically. Two flavours fold into one machine:
 *
 *   - `oldDiscValue !== newDiscValue` is a TRUE switch. The
 *     outgoing variant's subtree (deep-cloned) and its blank-path
 *     bookkeeping under `parentPath` snapshot into `variantMemory`
 *     keyed by the union's PathKey. Then memory is consulted for
 *     `newDiscValue`: a hit restores the prior typed state; a miss
 *     falls back to `variantDefault` (the adapter's slim default
 *     for the matching `z.object`).
 *   - `oldDiscValue === newDiscValue` is NOT a switch — the
 *     reshape was entered via Case B with a partial whole-union
 *     write. Skip memory I/O entirely (memory is for switches),
 *     just merge `consumerOverrides` on top of `variantDefault`.
 *
 * `consumerOverrides` carries Case B's whole-union value (e.g.
 * `setValue('notify', { channel: 'email', address: 'x' })`).
 * Merge order: memory baseline (or `variantDefault`) first,
 * consumer overrides on top — so a memory-restored `address`
 * survives a partial write that doesn't override it. Case A
 * passes `undefined` for `consumerOverrides`.
 *
 * Direct write — the resolved value IS structurally complete
 * (from the adapter's `deriveDefault` or a matching prior
 * snapshot). Routing through `mergeStructural` would re-add
 * foreign keys from the FIRST variant (the union's
 * `getDefaultAtPath` falls back to the first option), which is
 * exactly what the reshape is meant to clear.
 *
 * Deliberate-complexity: the sync-ahead reshape (storage + schema
 * errors committed in the same tick) is the no-flicker mitigation no
 * unit test can verify in isolation, so it stays inline rather than
 * fragmenting into argument-passed helpers. Its observable contracts
 * are pinned by characterization suites — the same-tick no-flicker
 * transition (du-variant-error-flicker), variant-memory restore
 * (discriminated-union-variant-switch, du-variant-persistence), and
 * blank-path order stability (blank-paths-order-stability).
 */
function reshapeUnionVariant<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  parentPath: Path,
  oldDiscValue: unknown,
  newDiscValue: unknown,
  variantDefault: unknown,
  consumerOverrides: Record<string, unknown> | undefined,
  meta?: WriteMeta
): boolean {
  const sameDisc = Object.is(oldDiscValue, newDiscValue)
  const parentKey = canonicalizePath(parentPath).key

  // Snapshot OUTGOING. Deep-clone the value: `getAtPath(form.value,
  // parentPath)` returns a Vue reactive proxy into the live tree
  // (form is `ref(initialData)`); after the upcoming `form.value =
  // nextForm` overwrites the union path, the proxy still points to
  // the orphaned raw target. `cloneVariantSnapshot` walks the
  // subtree, calling `toRaw` at each level to bypass Vue reactivity
  // and preserves `BigInt`, `Date`, `Map`, `Set` natively — types
  // Zod schemas can validate at leaves but the prior `JSON.parse(
  // JSON.stringify(...))` cycle either crashed on (BigInt) or
  // silently degraded (Date → ISO string, Map/Set → `{}`).
  // `structuredClone` won't work as a one-shot replacement: nested
  // reactive children stored as Proxies cause `DataCloneError`.
  // Skip when `oldDiscValue` is undefined (initial state had no
  // discriminator) — nothing meaningful to remember.
  let baseline: unknown = variantDefault
  let restoredBlanks: PathKey[] | undefined
  const effectiveRemember = meta?.instance?.rememberVariants ?? st.rememberVariants
  if (effectiveRemember && !sameDisc) {
    if (oldDiscValue !== undefined) {
      const currentValue: unknown = cloneVariantSnapshot(getAtPath(st.form.value, parentPath))
      const outgoingBlanks: PathKey[] = []
      for (const k of st.blankPaths) {
        if (isPathKeyUnder(k, parentPath)) outgoingBlanks.push(k)
      }
      st.variantMemory.recordOutgoing(parentKey, oldDiscValue, {
        value: currentValue,
        blankPaths: outgoingBlanks,
      })
    }
    // Look up INCOMING. Stored value is already a deep clone — safe
    // to use directly without re-cloning.
    const restored = st.variantMemory.lookupIncoming(parentKey, newDiscValue)
    if (restored !== undefined) {
      baseline = restored.value
      restoredBlanks = [...restored.blankPaths]
    }
  }

  // Layer consumer overrides on top of the baseline (Case B).
  // For Case A (`consumerOverrides === undefined`), the baseline
  // is the final value.
  const layered: unknown =
    consumerOverrides !== undefined
      ? { ...(baseline as Record<string, unknown>), ...consumerOverrides }
      : baseline
  // Stub-correct any nested DU paths inside `layered` whose disc
  // value isn't a known variant — the consumer's Case B payload may
  // carry a valid outer disc but a bad inner disc (e.g.
  // `{step:'choose', inner:{kind:'BAD_INNER', a:'x'}}`). Without
  // this, the inner mixed shape leaks through reshape; with it,
  // every level ends in either a real variant or a disc-only stub.
  const finalValue: unknown = applyDuStubs(st.schema as AbstractSchema<unknown, unknown>, layered, {
    basePath: parentPath,
  })

  // New blanks: restored from memory (preserves the user's prior
  // explicit blanks + numeric auto-marks together) or recomputed
  // from the resolved `finalValue` (mount-time rule: storage /
  // display divergence for `number` / `bigint` numeric leaves).
  // Compute BEFORE the drop loop so we know which old keys survive
  // — `Set.add` on a deleted-and-re-added key re-inserts at the END
  // of insertion order, which would shift `derivedBlankErrors` (and
  // therefore `form.meta.errors`) on every same-disc reshape even
  // when nothing about the post-reshape shape actually changed.
  let newBlankPaths: PathKey[]
  if (restoredBlanks !== undefined) {
    newBlankPaths = restoredBlanks
  } else {
    newBlankPaths = []
    walkUnspecified(finalValue, [...parentPath], newBlankPaths)
  }
  const survivingBlankKeys = new Set<PathKey>(newBlankPaths)
  // Drop blank-path bookkeeping under `parentPath` — those paths
  // belong to the OLD variant's leaves and don't exist in the new
  // effective shape. Skip keys present in `survivingBlankKeys`: the
  // `add` below is a no-op for an existing Set member (preserves the
  // original insertion slot).
  for (const existingKey of [...st.blankPaths]) {
    if (isPathKeyUnder(existingKey, parentPath) && !survivingBlankKeys.has(existingKey)) {
      st.blankPaths.delete(existingKey)
    }
  }

  const currentValue = getAtPath(st.form.value, parentPath)
  if (Object.is(currentValue, finalValue)) {
    // Apply the auto-marks even on no-op (the bookkeeping must
    // catch up even when storage identity matches by coincidence).
    for (const k of newBlankPaths) st.blankPaths.add(k)
    return true
  }
  // `setAtPathWithSchemaFill` (not the plain `setAtPath`) so that
  // writing to an array index past current length pads positions in
  // between with the schema's element default — otherwise a
  // `setValue('events.10', { type: 'text', value: 'far' })` on a
  // length-1 array would leave `events[1..9]` as `undefined` holes,
  // which break downstream iteration and validation.
  const nextForm =
    parentPath.length === 0
      ? (finalValue as F)
      : (setAtPathWithSchemaFill(st.form.value, st.schema, parentPath, finalValue) as F)
  // Sync-validate AHEAD of the form mutation when the schema
  // permits it. Both writes (schemaErrors + form.value) then land
  // in the same Vue reactive batch, so a single render emits the
  // fully-consistent post-reshape state. Without this, the render
  // queued by `applyFormReplacement` runs BEFORE the async
  // validation lands — the active-path filter hides the OLD
  // variant's schemaErrors (their leaves vanished from form.value)
  // and the NEW variant's haven't been written yet, producing a
  // visible `{}` flicker between the two meaningful states.
  //
  // We pass `{ sync: true }` to opt into the adapter's sync arm.
  // The adapter MAY still return a Promise (async refinements,
  // async transforms / pipes — schemas where sync isn't possible);
  // we detect that with `instanceof Promise` and fall through to
  // the existing debounced async pipeline in that case.
  let appliedSync = false
  const reshapeMode = meta?.instance?.validateOn ?? st.fieldValidationMode
  if (reshapeMode === 'change') {
    const syncOrPromise = st.schema.validateAtPath(finalValue, parentPath, { sync: true })
    if (!(syncOrPromise instanceof Promise)) {
      const reStamped = syncOrPromise.success
        ? []
        : syncOrPromise.errors.map((err) => ({
            ...err,
            path: [...parentPath, ...(err.path as Segment[])],
          }))
      applySchemaErrorsForSubtree(st, parentPath, reStamped)
      // Cancel any in-flight async validation at this path so a
      // late-arriving result can't clobber the sync write.
      const { key: parentKey } = canonicalizePath(parentPath)
      const prevValidation = st.fieldValidationState.get(parentKey)
      if (prevValidation !== undefined) {
        if (prevValidation.timer !== null) clearTimeout(prevValidation.timer)
        prevValidation.aborted = true
        st.fieldValidationState.delete(parentKey)
      }
      appliedSync = true
    }
  }
  applyFormReplacement(st, nextForm, meta)
  for (const k of newBlankPaths) st.blankPaths.add(k)
  if (reshapeMode === 'change' && !appliedSync) {
    scheduleFieldValidation(st, parentPath, false /* debounced */, {
      ...(meta?.instance?.validateOn !== undefined ? { mode: meta.instance.validateOn } : {}),
      ...(meta?.instance?.debounceMs !== undefined ? { debounceMs: meta.instance.debounceMs } : {}),
    })
  }
  return true
}

/**
 * Schedule (or kick off immediately) a field-level validation run
 * for `path`. Per-path one-shot `aborted` latch: a new schedule
 * cancels any prior in-flight run for the same path, so rapid
 * successive writes don't pile up concurrent validations.
 *
 * The validation reads the current value at `path` from `form.value`
 * AT THE TIME THE TIMER FIRES, not at schedule time. That's the
 * correct semantics for a debounced change trigger: the user's
 * latest-keystroke value is what matters, not whichever value
 * tripped the timer scheduler N milliseconds ago.
 */
function scheduleFieldValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  immediate: boolean,
  override?: { readonly mode?: ValidateOn; readonly debounceMs?: number }
): void {
  const effectiveMode = override?.mode ?? st.fieldValidationMode
  if (effectiveMode === 'submit') return
  const effectiveDebounce = override?.debounceMs ?? st.fieldValidationDebounceMs
  const { key } = canonicalizePath(path)
  const prev = st.fieldValidationState.get(key)
  if (prev !== undefined) {
    if (prev.timer !== null) clearTimeout(prev.timer)
    prev.aborted = true
  }
  const fresh: FieldValidationEntry = {
    aborted: false,
    timer: null,
    settled: false,
    released: false,
  }
  st.fieldValidationState.set(key, fresh)
  // Capture a fresh epoch at schedule time. Closed over by `run`
  // below and re-checked at the commit site so a later-scheduled
  // run that resolves first protects its verdict from clobber by
  // an earlier-scheduled run that resolves later (PASS2-2).
  const myEpoch = ++st.scheduleEpoch

  const run = () => {
    fresh.timer = null
    if (fresh.aborted) return
    // Defense-in-depth: the increments below trigger reactive
    // subscribers (sync watchers on `api.meta.validating` or
    // `api.fields.X.validating`). If one of those subscribers throws,
    // the Promise chain whose `.finally` does the decrements never
    // starts, leaking the per-path counter — `validating` would
    // stay true forever, and the mount-gate's
    // `pathHasAsyncValidation` would report a permanently-pending
    // verdict. Roll back the increments that succeeded on a sync
    // throw before letting the error propagate.
    let activeIncremented = false
    try {
      st.activeValidations.value += 1
      activeIncremented = true
      incFieldValidation(st, key)
    } catch (err) {
      // `incFieldValidation` is the last statement above and is
      // structurally a `Map.set` — if it throws, it threw before the
      // map entry was written, so there's nothing to roll back on the
      // field counter. The only rollback that matters is the global
      // `activeValidations` increment that happened on the first line.
      if (activeIncremented) {
        st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
      }
      throw err
    }
    // Per-keystroke scope. When the schema carries no container or
    // root refine (predicate returns `false` and the schedule is at
    // a real path), every verdict it can produce lives at the
    // edited subtree or below — a subtree-scoped pass is sufficient
    // and the runtime avoids the O(N) whole-form parse on each
    // keystroke. Predicate `true` (or missing — adapters that don't
    // implement detection) keeps the conservative whole-form pass
    // so ancestor refines (cross-field equality, sum constraints,
    // etc.) still re-evaluate against the live form value. An
    // empty `path` (root schedule, mount / reset / explicit
    // whole-form) also folds to whole-form.
    const subtreeScope = path.length > 0 && st.schema.hasContainerOrRootRefine?.() === false
    const scopePath: Path | undefined = subtreeScope ? path : undefined
    const dataAtScope: unknown = subtreeScope ? getAtPath(st.form.value, path) : st.form.value
    const scopeKey: PathKey = subtreeScope ? canonicalizePath(path).key : ROOT_PATH_KEY
    void Promise.resolve()
      .then(() => st.schema.validateAtPath(dataAtScope, scopePath))
      .then((response) => {
        if (fresh.aborted) return
        // Form-level epoch gate. If a later-scheduled run has
        // already committed its verdict, dropping this stale
        // commit prevents an asymmetric-latency race from
        // overwriting the fresher result. `<=` is conservative
        // — counter monotonicity makes equality impossible in
        // practice, but a re-entrant commit at the same epoch
        // would still be a no-op.
        if (myEpoch <= st.lastCommittedEpoch) return
        st.lastCommittedEpoch = myEpoch
        // Record the value this pass validates so a later blur can
        // recognise an unchanged form and skip. Blur-mode only: the
        // blur guard is the sole reader, so change-mode never pays
        // for the snapshot. Lives in the applied branch — an aborted
        // run never advances the snapshot, so a later blur with
        // nothing committed for this path still re-validates instead
        // of falsely skipping against a stale-but-uncommitted anchor.
        //
        // Snapshot scope = validation scope: under subtree-scoped
        // commits (CORE-P1a), only the subtree-at-`path` participates
        // in the blur dedup, so cloning the whole form just to throw
        // away unused branches is wasted work proportional to (form
        // size − subtree size). Read the live subtree directly from
        // `form.value` (matching the original "snapshot at commit
        // time" semantics, where the post-async write may differ
        // from `dataAtScope` captured before the await) and clone
        // only that. The blur reader subtracts the snapshot's
        // scope segments from the blur path to project back into
        // the stored subtree. Whole-form scope (`scopePath ===
        // undefined`) stores the full clone, identical to the
        // prior behaviour for that branch.
        if (effectiveMode === 'blur') {
          const snapshotSource =
            scopePath !== undefined ? getAtPath(st.form.value, scopePath) : st.form.value
          st.pathSnapshots.set(scopeKey, structuralSnapshot(snapshotSource))
        }
        const errors = response.success ? [] : response.errors
        // Drop schema verdicts at preprocess / coerce paths whose
        // storage is undefined AND the consumer didn't author a
        // starting value there. Under the no-write-mutation contract,
        // a refine running against the preprocess sentinel for "no
        // value" produces a verdict against state nobody authored —
        // suppressing it keeps the construction-time async seed
        // from flickering when the field is first touched. Authored
        // paths (defaultValues OR schema `.default(...)`) skip the
        // filter; their verdicts ARE legitimate.
        const filtered = filterAuthoredErrors(st, errors)
        // Subtree-scoped responses carry paths relative to the
        // subtree; restamp with absolute paths so the storage
        // convention holds. Whole-form responses are already
        // absolute — pass through.
        const restamped: ValidationError[] = subtreeScope
          ? filtered.map((err) => ({
              ...err,
              path: [...path, ...(err.path as Segment[])],
            }))
          : filtered
        applySchemaErrorsForSubtree(st, scopePath ?? [], restamped)
      })
      .catch(() => {
        // Adapter contract forbids throws — swallow here so a misbehaving
        // custom adapter doesn't surface as an uncaught rejection. The
        // silent drop matches the reactive `validate()` ref's catch
        // branch for adapter-level throws (see process-form.ts).
      })
      .finally(() => {
        // Skip the decrements if an external release (a path-scoped reset)
        // already did them — otherwise this late `.finally` would
        // double-count against a run rescheduled at the same key after the
        // release. Normal runs leave `released` false and decrement here.
        if (!fresh.released) {
          st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
          decFieldValidation(st, key)
        }
        fresh.settled = true
      })
  }

  // `debounceMs: 0` is the off switch — `setTimeout(fn, 0)` would
  // punt to the next macrotask (browsers also clamp to ~4 ms), and
  // the indirection serves no purpose when the consumer asked for
  // "no debounce." Run synchronously like the `immediate` branch.
  if (immediate || effectiveDebounce === 0) {
    run()
  } else {
    fresh.timer = setTimeout(run, effectiveDebounce)
  }
}

function cancelFieldValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  for (const [pkey, entry] of st.fieldValidationState) {
    if (entry.timer !== null) {
      // Debounce timer hasn't fired yet — run() never executed, so
      // no `activeValidations` / `fieldValidationCounts` increment
      // happened. Just clear the timer; nothing to roll back.
      clearTimeout(entry.timer)
    } else if (!entry.settled) {
      // run() already fired and the chain is still in flight. Its
      // own `.finally` will decrement when the chain settles, but
      // the chain could outlive the caller (handleSubmit /
      // a committing parse) that's cancelling us. Release the counters
      // synchronously here so `meta.validating` reflects the cancel
      // immediately; the late `.finally`'s `Math.max(0, ...)`
      // clamps the duplicate decrement to zero.
      st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
      decFieldValidation(st, pkey)
    }
    // Settled entries left in the map (waiting for the next
    // schedule to evict them) have already decremented in their
    // own `.finally` — skip the counter touch entirely.
    entry.aborted = true
  }
  st.fieldValidationState.clear()
}

// Path-scoped counterpart to `cancelFieldValidation`: abort and release only
// the in-flight runs whose path sits at or under `prefix`, leaving sibling
// fields' validations untouched. Used by `resetField` so resetting one field
// tears down its own validation. Releases the count + streak anchor in
// lockstep through `decFieldValidation` (preserving the bracket invariant)
// and marks each entry `released` so the run's late `.finally` can't
// double-decrement a run rescheduled at the same key (the change-mode restore
// write that follows `resetField`'s call schedules exactly such a run).
function cancelFieldValidationUnder<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  prefix: Path
): void {
  for (const [key, entry] of [...st.fieldValidationState]) {
    const segs = segmentsForPathKey(key)
    if (segs === null) continue
    if (!isPathPrefix(prefix, segs)) continue
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
    } else if (!entry.settled && !entry.released) {
      st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
      decFieldValidation(st, key)
      entry.released = true
    }
    entry.aborted = true
    st.fieldValidationState.delete(key)
  }
}

function onFormChange<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  listener: (next: F, meta?: WriteMeta) => void
): () => void {
  st.formChangeListeners.add(listener)
  return () => {
    st.formChangeListeners.delete(listener)
  }
}

function onSubmitSuccess<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  listener: () => void
): () => void {
  st.submitSuccessListeners.add(listener)
  return () => {
    st.submitSuccessListeners.delete(listener)
  }
}

function onReset<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  listener: () => void
): () => void {
  st.resetListeners.add(listener)
  return () => {
    st.resetListeners.delete(listener)
  }
}

function emitSubmitSuccess<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  for (const listener of st.submitSuccessListeners) {
    try {
      listener()
    } catch (err) {
      console.error('[attaform] onSubmitSuccess threw:', err)
    }
  }
}

function registerCleanup<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  fn: () => void
): void {
  st.cleanupHooks.push(fn)
}

function registerDrain<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  fn: () => Promise<void>
): void {
  st.drainHooks.push(fn)
}

async function awaitPendingWrites<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): Promise<void> {
  if (st.drainHooks.length === 0) return
  // Run drains in parallel — each owns its own retry / failure
  // semantics; we just need to know when all have settled.
  await Promise.allSettled(st.drainHooks.map((fn) => fn()))
}

function dispose<F extends GenericForm, G extends GenericForm = F>(st: FormState<F, G>): void {
  // Run state-scoped teardowns BEFORE clearing listener sets, so a
  // module that wants to flush something by emitting one last event
  // from its cleanup (unlikely but harmless) doesn't find the
  // listener set already empty. Each hook runs inside try/catch so
  // one misbehaving module can't block the others.
  for (const hook of st.cleanupHooks) {
    try {
      hook()
    } catch (err) {
      console.error('[attaform] cleanup threw:', err)
    }
  }
  st.cleanupHooks.length = 0
  st.drainHooks.length = 0
  st.modules.clear()
  cancelFieldValidation(st)
  cancelTransforms(st)
  st.fieldValidatingSince.clear()
  st.formChangeListeners.clear()
  st.submitSuccessListeners.clear()
  st.resetListeners.clear()
}

function getValueAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): unknown {
  return getAtPath(st.form.value, path)
}

// --- Errors ---
// One tagged store: each path's cell segregates the two sources that can
// put an error there (`schema` = the validation pipeline, `user` =
// setErrors). The three shared channel writers below are the only
// mutation road; each replaces exactly one side of a cell, cells are
// immutable, and a key exists iff a side is non-empty. Derived blank
// entries stay a read-side synthesis (`derivedBlankErrors`); the merged
// view is exposed via `getErrorsForPath` and the top-level `errors`
// drillable Proxy in schema -> blank -> user order.

type ErrorSource = 'schema' | 'user'

const ERROR_SOURCES: readonly ErrorSource[] = ['schema', 'user']

/**
 * Shared channel writer 1 — replace one side of the cell at `key` with
 * `entries` (the caller owns the array). The other side rides along
 * unchanged; a cell whose sides are both empty leaves the map. Always
 * sets a FRESH cell object, so Vue's per-key collection dep fires for
 * either side's change.
 */
function setErrorChannelForKey<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  src: ErrorSource,
  entries: readonly ValidationError[]
): void {
  const current = st.errorCells.get(key)
  const schema = src === 'schema' ? entries : (current?.schema ?? NO_ERRORS)
  const user = src === 'user' ? entries : (current?.user ?? NO_ERRORS)
  if (schema.length === 0 && user.length === 0) {
    if (current !== undefined) st.errorCells.delete(key)
    return
  }
  st.errorCells.set(key, { schema, user })
}

/**
 * Shared channel writer 2 — replace one source's entries wholesale
 * across the form. Cells holding the OTHER source keep their map slot
 * (that side must survive, and `Map.set` on an existing key updates in
 * place); cells holding only `src` are deleted first so a re-written
 * key re-inserts in this pass's entry order — the slotting the old
 * clear-and-rebuild produced on a single-source map.
 */
function replaceErrorChannel<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  src: ErrorSource,
  entries: readonly ValidationError[]
): void {
  const other: ErrorSource = src === 'schema' ? 'user' : 'schema'
  const grouped = groupErrorsByKey(entries)
  for (const [key, cell] of st.errorCells) {
    if (cell[other].length === 0) {
      st.errorCells.delete(key)
      continue
    }
    const fresh = grouped.get(key)
    if (fresh !== undefined) {
      setErrorChannelForKey(st, key, src, fresh)
      grouped.delete(key)
    } else if (cell[src].length > 0) {
      setErrorChannelForKey(st, key, src, NO_ERRORS)
    }
  }
  for (const [key, list] of grouped) {
    setErrorChannelForKey(st, key, src, list)
  }
}

/**
 * Shared channel writer 3 — clear one source at `path`, or everywhere
 * when `path` is omitted (a whole-channel replace with nothing). Cells
 * whose other side holds entries survive with `src` stripped; cells
 * left empty leave the map.
 */
function clearErrorChannel<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  src: ErrorSource,
  path?: Path
): void {
  if (path === undefined) {
    replaceErrorChannel(st, src, NO_ERRORS)
    return
  }
  setErrorChannelForKey(st, canonicalizePath(path).key, src, NO_ERRORS)
}

/**
 * Replace the schema side of the subtree rooted at `path` with
 * `entries`, keying each entry by its OWN absolute path rather than
 * `path`. Used by `scheduleFieldValidation` so a re-validation of a
 * container (e.g. a DU parent after reshape) lands every leaf-keyed
 * issue at its canonical store key — `form.errors.<path>` reads
 * hit, and stale entries from a previous variant don't survive.
 *
 * Insertion-order stability: `Map.set` on an EXISTING key updates the
 * cell in place and preserves the slot's position; `Map.delete`
 * followed by `Map.set` re-inserts at the END. `form.meta.errors`
 * iterates this Map in insertion order, so a per-field
 * re-validation that delete-then-sets the scheduled key flips the
 * aggregate's order on every keystroke. The grouped pass below
 * computes the surviving key set FIRST so only keys that genuinely
 * drop out lose their schema side (an old DU-variant leaf the new
 * pass doesn't write); keys that survive get an in-place cell swap
 * that keeps their original slot. User sides ride along untouched.
 */
function applySchemaErrorsForSubtree<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  entries: ValidationError[]
): void {
  // The container being re-validated. A root-scope pass (path === [])
  // of a schema with a top-level `.refine()` produces an entry at the
  // empty path `[]`, which canonicalises to the same `'[]'` key as
  // `parentKey`, so the surviving refine entry and the parent
  // reconcile naturally without any rerouting.
  const parentKey = canonicalizePath(path).key
  const grouped = groupErrorsByKey(entries)
  // Drop the parent key's schema side only if not in the new pass.
  if (!grouped.has(parentKey)) setErrorChannelForKey(st, parentKey, 'schema', NO_ERRORS)
  // Drop stale descendants: schema-bearing keys under `path` that the
  // new pass doesn't write (DU-variant leaves that disappeared on
  // reshape). Keys that DO appear in `grouped` stay where they are —
  // the write below updates them in place. The parent key is exempt
  // (handled just above), so a root-scope pass keeps its own `'[]'`
  // refine entry rather than sweeping it into the descendant set.
  for (const [existingKey, cell] of st.errorCells) {
    if (existingKey === parentKey) continue
    if (cell.schema.length === 0) continue
    if (isPathKeyUnder(existingKey, path) && !grouped.has(existingKey)) {
      setErrorChannelForKey(st, existingKey, 'schema', NO_ERRORS)
    }
  }
  for (const [leafKey, group] of grouped) {
    setErrorChannelForKey(st, leafKey, 'schema', group)
  }
}

// --- History restore ---

function restoreErrorCells<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  entries: ReadonlyArray<readonly [PathKey, ErrorCell]>
): void {
  st.errorCells.clear()
  for (const [key, cell] of entries) {
    if (cell.schema.length === 0 && cell.user.length === 0) continue
    st.errorCells.set(key, { schema: [...cell.schema], user: [...cell.user] })
  }
}

// --- Merged read ---

function getErrorsForPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): ValidationError[] {
  const { key } = canonicalizePath(path)
  const cell = st.errorCells.get(key)
  const blankForKey = st.derivedBlankErrors.value.get(key)
  if (cell === undefined && blankForKey === undefined) {
    return []
  }
  const result: ValidationError[] = []
  if (cell !== undefined) result.push(...cell.schema)
  if (blankForKey !== undefined) result.push(...blankForKey)
  if (cell !== undefined) result.push(...cell.user)
  return result
}

// --- DOM ---

function noteDomConnected<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  // Connect transition. Lift focused/blurred from `null`
  // (no-element-meaningless) to optimistic booleans only when they
  // are currently null; preserve existing booleans so a reconnect
  // doesn't blow away DOM-truth from an autofocus event that landed
  // before the registration.
  const { key } = canonicalizePath(path)
  const current = st.fields.get(key)
  touchFieldRecord(st, key, path, {
    connected: true,
    focused: current?.focused ?? false,
    blurred: current?.blurred ?? true,
  })
}

function noteDomDisconnected<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  // Disconnect transition. `focused` / `blurred` are DOM-state
  // properties — with no element to be focused or blurred, the
  // concepts don't apply, so flip back to `null`. `touched` is
  // interaction history and is preserved across disconnects
  // (a v-if'd-away field that was previously blurred stays
  // touched).
  const { key } = canonicalizePath(path)
  touchFieldRecord(st, key, path, { connected: false, focused: null, blurred: null })
}

function markConnectedOptimistically<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  // Client-side: the directive's `created` / `beforeUnmount` hooks are
  // authoritative for `connected`, so this is a no-op there. SSR is
  // the only environment where we can't observe the DOM and need an
  // upfront hint that the field WILL be wired up after hydration.
  if (!st.ssr) return
  // Idempotent: a second SSR mark for an already-connected path leaves
  // the record untouched. The lift itself (via `noteDomConnected`)
  // never clobbers an existing focused/blurred boolean, since a prior
  // `markFocused` may have landed ahead of the optimistic mark
  // (uncommon but possible during SSR when a custom directive flips
  // focus state up-front). Server-rendered FieldState then matches the
  // post-hydration optimistic state (`focused: false, blurred: true`)
  // without a flash from `null` on the first reactive tick after
  // hydration; real focus state lands as soon as the browser fires a
  // focus event — the directive's listener catches it and flips the
  // booleans.
  const { key } = canonicalizePath(path)
  if (st.fields.get(key)?.connected === true) return
  noteDomConnected(st, path)
}

function markFocused<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  focused: boolean,
  meta?: { readonly instance?: WriteMeta['instance'] }
): void {
  // See `markInteracted`: a frozen form records no focus / blur
  // lifecycle, so no stale `blurredAfterInteraction` survives a
  // disable -> enable toggle. A disabled native input can't receive
  // focus anyway; this covers component hosts and programmatic focus.
  if (st.effectiveDisabled.value) return
  const { key } = canonicalizePath(path)
  const current = st.fields.get(key)
  touchFieldRecord(st, key, path, {
    focused,
    blurred: !focused,
    // `touched` flips to true on blur and stays true thereafter; while
    // a field is currently focused we keep whatever value it held.
    touched: focused ? (current?.touched ?? false) : true,
    // `blurredAfterInteraction` flips true on the first blur that lands
    // after a value edit and stays true. A tab-through blur before any
    // edit leaves it false (`interacted` is still false at that blur),
    // which is what keeps a clean tab-through from arming the gate.
    blurredAfterInteraction:
      !focused && current?.interacted === true ? true : (current?.blurredAfterInteraction ?? false),
  })
  // On blur (focused → false), `validateOn: 'blur'` fires an immediate
  // (no-debounce) validation for this path. Ignored for change/submit modes
  // so behaviour matches the declared config. Two reasons to run; else skip:
  //
  //   1. First interactive blur. The user edited the field and is leaving it
  //      for the first time, so its verdict becomes visible now
  //      (`blurredAfterInteraction` flips above). Run unconditionally: a
  //      snapshot seeded before any interaction — e.g. the construction pass
  //      over an unauthored initial value, whose verdict may have been
  //      filtered out — must not suppress this first real verdict, even when
  //      the value round-tripped back to its initial state.
  //   2. The value changed since the last pass. Skipping an unchanged form
  //      keeps a settled error from flickering through 'pending' on every
  //      refocus; comparing the value (not a write count) keeps editing away
  //      and back to the last-validated value quiet too.
  const focusMode = meta?.instance?.validateOn ?? st.fieldValidationMode
  if (!focused && focusMode === 'blur') {
    const firstInteractiveBlur =
      current?.interacted === true && current.blurredAfterInteraction !== true
    // Walk from the blurred path up to the root and pick the first
    // ancestor scope that's been committed at. The blur-dedup
    // compares the SUBTREE-AT-PATH of that snapshot against the
    // live subtree — a sibling-only edit between blurs leaves
    // this path's subtree unchanged and the dedup correctly
    // skips. Under whole-form scope today every commit lives at
    // `ROOT_PATH_KEY`, so the walk falls through to that single
    // entry; under subtree scope (CORE-P1a) the closest ancestor
    // entry is the one this leaf was actually validated under.
    let snapshot: unknown | undefined = undefined
    let snapshotScopeLength = 0
    for (let i = path.length; i >= 0; i--) {
      const ancestorKey = canonicalizePath(path.slice(0, i)).key
      const entry = st.pathSnapshots.get(ancestorKey)
      if (entry !== undefined) {
        snapshot = entry
        snapshotScopeLength = i
        break
      }
    }
    let changed = true
    if (!firstInteractiveBlur && snapshot !== undefined) {
      // Extract the SUBTREE-AT-PATH on both sides — `diffAndApply`'s
      // `prefix` only labels emitted patch paths, it doesn't scope
      // the walk. Subtree extraction is what makes a sibling-only
      // edit between blurs (this path unchanged) read as
      // `changed === false`. The snapshot itself is already scoped
      // to its commit's `scopePath` (length tracked above), so the
      // blur path needs the scope prefix subtracted before
      // descending into the stored subtree.
      const relPath = path.slice(snapshotScopeLength)
      const snapshotSubtree = getAtPath(snapshot, relPath)
      const liveSubtree = getAtPath(st.form.value, path)
      changed = false
      diffAndApply(snapshotSubtree, liveSubtree, path, () => {
        changed = true
      })
    }
    if (changed) {
      scheduleFieldValidation(st, path, true /* immediate */, {
        ...(meta?.instance?.validateOn !== undefined ? { mode: meta.instance.validateOn } : {}),
        ...(meta?.instance?.debounceMs !== undefined
          ? { debounceMs: meta.instance.debounceMs }
          : {}),
      })
    }
  }
}

function markInteracted<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  // A frozen form records no interaction lifecycle: value writes no-op,
  // so a stray host emit (`setValueFromHost` marks interacted before
  // its gated write) or a direct `rv.markInteracted()` must not arm
  // blur-validation or the reward-early display. Keeps interaction
  // state clean across a disable -> enable toggle.
  if (st.effectiveDisabled.value) return
  const { key } = canonicalizePath(path)
  // Fired per keystroke from the directive's input listeners; skip the
  // reactive write once the bit is set so only the first edit notifies.
  if (st.fields.get(key)?.interacted === true) return
  touchFieldRecord(st, key, path, { interacted: true })
}

/**
 * Walk every active-variant leaf under `segments` and flip its
 * `touched` flag to `true`. Powers the public `form.touch(path?)`
 * API: leaf path → exactly that leaf; container path → every
 * descendant leaf; root path `[]` → every leaf in the form.
 *
 * Idempotent: leaves already touched are skipped (no reactive
 * notification). Inactive DU-variant leaves are filtered via
 * `hasAtPath` against the live form value — same gate the
 * field-state aggregation walk uses, so touch never marks a leaf
 * the consumer can't see.
 *
 * Dev-warns when no leaves resolve under the path (typo'd input,
 * empty container, dead variant). Does NOT mutate value, focused,
 * blurred, or trigger validation — touched is the single sticky
 * flag this helper writes.
 */
/**
 * Shared leaf walk behind `touchAtPath` / `interactAtPath`. Visits
 * every active-variant leaf at or under `segments` and reports
 * whether any resolved, so each caller can dev-warn on an empty
 * path. Enumerates `originals` (the schema's leaf set) rather than
 * `fields`, so it reaches leaves that were never mounted; inactive
 * DU-variant leaves are filtered via `hasAtPath` against the live
 * form value, the same gate the field-state aggregation walk uses.
 */

function touchAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  segments: Path
): void {
  const formValue = st.form.value
  let touchedAny = false
  for (const [, entry] of st.originals) {
    if (!isPathPrefix(segments, entry.segments)) continue
    if (!hasAtPath(formValue, entry.segments)) continue
    touchedAny = true
    const leafKey = canonicalizePath(entry.segments).key
    const current = st.fields.get(leafKey)
    if (current?.touched === true) continue
    touchFieldRecord(st, leafKey, entry.segments, { touched: true })
  }
  if (!touchedAny && __DEV__) {
    console.warn(
      `[attaform] form.touch(): no fields resolved at path ${JSON.stringify(segments)}. ` +
        `Check the path matches an existing field or container.`
    )
  }
}

/**
 * Walk every active-variant leaf under `segments` and flip the whole
 * interaction ladder — `touched`, `interacted`, and
 * `blurredAfterInteraction` — as though the user had focused, edited,
 * and left each one. Powers the public `form.interact(path?)` API,
 * whose job is to open the default display gate
 * (`submissionAttempts > 0 || blurredAfterInteraction`) for a subtree
 * without a form-wide submit.
 *
 * `interacted` is the load-bearing bit. Writing only `touched` /
 * `blurred` reproduces the tab-through no-op the gate deliberately
 * ignores, since `markFocused` flips `blurredAfterInteraction` solely
 * on a blur that follows an edit. Setting the ladder outright is what
 * lets the gate open through its front door, unchanged.
 *
 * Deliberately does NOT write `focused` / `blurred`: those are
 * DOM-owned, and `null` is their documented "no element connected"
 * value. Fabricating a blur on an unmounted leaf would lie about DOM
 * history, and forcing `focused: false` on a leaf the user is
 * currently typing in would desync the store from the live document.
 * The display gate reads neither, so the simulation loses nothing.
 *
 * Walks `originals` rather than `fields`, so it reaches schema leaves
 * that were never mounted or are currently `v-if`'d away; the flags
 * are sticky, so such a subtree stays revealed when it remounts.
 * Inactive DU-variant leaves are filtered via `hasAtPath` against the
 * live form value, matching `touchAtPath`.
 *
 * Returns whether any leaf resolved. Validation is the caller's job:
 * the store has no awaitable validation handle, and `form.interact()`
 * resolves only once the subtree's errors are committed.
 */
function interactAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  segments: Path
): boolean {
  // A frozen form records no interaction lifecycle — same guard as
  // `markFocused` / `markInteracted`. Arming the ladder here would
  // survive a disable -> enable toggle and reveal errors on a subtree
  // the consumer had deliberately taken out of play.
  if (st.effectiveDisabled.value) return false
  const formValue = st.form.value
  let interactedAny = false
  for (const [, entry] of st.originals) {
    if (!isPathPrefix(segments, entry.segments)) continue
    if (!hasAtPath(formValue, entry.segments)) continue
    interactedAny = true
    const leafKey = canonicalizePath(entry.segments).key
    const current = st.fields.get(leafKey)
    // Skip the reactive write once the whole ladder is already set —
    // records are replaced wholesale, so an unconditional
    // `fields.set` would notify for nothing.
    if (
      current?.touched === true &&
      current.interacted === true &&
      current.blurredAfterInteraction === true
    ) {
      continue
    }
    touchFieldRecord(st, leafKey, entry.segments, {
      touched: true,
      interacted: true,
      blurredAfterInteraction: true,
    })
  }
  if (!interactedAny && __DEV__) {
    console.warn(
      `[attaform] form.interact(): no fields resolved at path ${JSON.stringify(segments)}. ` +
        `Check the path matches an existing field or container.`
    )
  }
  return interactedAny
}

// --- Rehydrate ---
// Imperative re-fire of the captured function-form `defaultValues`
// factory. Lives on the store so every consumer of the shared key
// sees one source of truth for `hydrating`. Mirrors the
// construction-time settle path: factory result merges over the
// current values via `mergeSparseHydration`, applies through
// `applyFormReplacement({ hydration: true })` (history-module aware),
// and triggers a post-hydration validation sweep. Does NOT clear
// dirty / touched / submit state — chain `form.reset()` for that.

function rehydrate<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): Promise<void> {
  const factory = st.defaultValuesFactory.value
  if (factory === undefined) {
    // Sync throw — misuse should surface at the call site, not at
    // await time. Mirrors the type-system contract: `rehydrate()`
    // only makes sense after a function-form `defaultValues` was
    // captured.
    throw new Error(
      __DEV__
        ? '[attaform] form.rehydrate(): no defaultValues factory was captured. Configure useForm({ defaultValues: () => ... }) to enable rehydrate.'
        : '[attaform] AF10 attaform.dev/e/AF10'
    )
  }
  return fireFactory(st, factory)
}

// Shared kickoff path for `activate` and `rehydrate`. Both fire the
// captured factory, mark the form `activated`, and publish the
// in-flight promise so concurrent `activate()` calls join rather
// than double-fire. The promise self-clears on settle so a
// subsequent refetch can publish a fresh one. The gating flips
// (`activated`, `hydrating`) publish synchronously before the
// orchestrator runs, so gated readers and `onServerPrefetch` (which
// awaits the composed promise) observe a consistent in-flight state.
// (A lazy-chunk split of the orchestrator was measured and declined:
// the cross-chunk overhead outweighed the moved bytes — see
// plans/size-teardown/P5-store-kernel.md.)
function fireFactory<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  factory: () => unknown | Promise<unknown>
): Promise<void> {
  st.activated.value = true
  st.hydrating.value = true
  const promise = runFactoryAndApply(st, factory)
  st.activationPromise.value = promise
  void promise.finally(() => {
    if (st.activationPromise.value === promise) st.activationPromise.value = undefined
  })
  return promise
}

// Idempotent activation. The new lazy-by-default model fires the
// captured function-form `defaultValues` factory only via this
// entrypoint — public getters/methods on the form API surface call
// through to it so the first reactive interaction triggers the
// factory. Concurrent callers share the in-flight promise so two
// SSR consumers reading the same store await the same fetch. A
// previously-rejected attempt leaves `activated === true` and
// `defaultsResolved === false`; subsequent `activate()` calls are
// no-ops so reading `form.hydrateError` doesn't replay the failure.
// `form.rehydrate()` is the explicit replay primitive.
function activate<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): Promise<void> {
  // SSR coordination — enqueue intent first so the diff against any
  // wizard skip / transform mark is consistent across resolved /
  // dormant / mid-activation states. Then consult `shouldFire`: when
  // a wizard skipped this key, the backstop wins even over an
  // explicit consumer `form.activate()` call. The closure is bound
  // to the registry at construction time and is absent on the
  // client where the queue is never read.
  if (st.ssrPrefetch !== undefined) {
    st.ssrPrefetch.enqueue()
    if (!st.ssrPrefetch.shouldFire()) return Promise.resolve()
  }
  if (st.defaultsResolved.value === true) return Promise.resolve()
  if (st.activationPromise.value !== undefined) return st.activationPromise.value
  if (st.activated.value === true) return Promise.resolve()
  const factory = st.defaultValuesFactory.value
  if (factory === undefined) return Promise.resolve()
  return fireFactory(st, factory)
}

// --- Reset ---

function reset<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  nextDefaultValues?: DeepPartial<WriteShape<F>>
): void {
  // Fall back to construction-time `defaultValues` when the caller
  // doesn't provide a fresh override. Otherwise `reset()` produces
  // schema-only defaults — losing the consumer's initial state from
  // `useForm({ defaultValues: ... })`. The structural-completeness
  // invariant covers post-write correctness; preserving construction
  // defaults across reset is a separate semantic the consumer expects.
  //
  // `computeBaselineResponse` is the same primitive construction runs, so
  // the construction and reset responses stay byte-equivalent for the
  // same source (including the sparse-constraints pre-merge; see its
  // JSDoc).
  const resetSource = nextDefaultValues ?? st.defaultValues
  const resetResponse = computeBaselineResponse(st.schema, st.strict, resetSource)
  const next = resetResponse.data
  // Rebuild authoredPaths against the post-reset baseline. Reset is
  // "fresh start" semantics, so the prior authoring set is wiped and
  // re-derived from (1) the reset's constraints argument (consumer
  // authored those paths) and (2) the schema-default diff (schema-
  // declared `.default(...)` paths, including `.default(undefined)`).
  rebuildAuthoredPaths(st, resetSource, next)
  // Replace form in one shot. `applyFormReplacement` emits diffAndApply
  // patches and touches field records for every changed leaf. History
  // still sees it via `formChangeListeners`.
  applyFormReplacement(st, next)
  // Re-anchor array identity baselines to the post-reset shape, so a
  // reorder or removal made before this reset no longer reads as a
  // structural change once the form is back at its baseline.
  st.arrayIdentity.rebaselineAll()
  // The post-reset value is the new baseline, so any subtree dropped before
  // this reset is no longer a removal to flag.
  st.removedSubtrees.clear()
  // Rebuild originals from the new baseline. The set becomes the
  // post-reset pristine reference — a subsequent dirty comparison
  // returns false until the consumer mutates again. `ensureOrdinals`
  // stays false: ordinals never reset, and a path a reset baseline
  // introduces keeps the lazy first-encounter assignment.
  seedOriginalsFromBaseline(st, next, false)
  // Blank: with `nextDefaultValues` provided, both sets
  // adopt the new baseline (commit 7 plugs the `unset`-symbol walker
  // into this branch — for now the new defaults can't carry unset
  // symbols at the type level, so the post-reset baseline is empty).
  // With no args, restore `blankPaths` from the snapshot so
  // construction-time membership returns; originalBlankPaths is
  // preserved (the snapshot encodes the consumer's last declared
  // baseline, which `reset()` should honour).
  if (nextDefaultValues !== undefined) {
    st.blankPaths.clear()
    st.originalBlankPaths.clear()
  } else {
    st.blankPaths.clear()
    for (const key of st.originalBlankPaths) {
      st.blankPaths.add(key)
    }
  }
  // Drop every recorded error — the form is a fresh surface again.
  // Both sides clear: reset is "fresh start" semantics, so user-injected
  // errors are not preserved across a reset (different from submit-success,
  // which preserves them).
  st.errorCells.clear()
  // Re-derive schemaErrors from the post-reset state under strict mode,
  // mirroring the construction-time seed. Without this,
  // reset clears the error store but never re-runs validation — so a
  // form mounted with invalid defaults (e.g. empty required strings)
  // would surface as `valid: true` immediately after reset even though
  // the values it landed back on are the same INVALID defaults it
  // mounted with. `field.valid` aggregates over schemaErrors and would
  // otherwise come up empty, flipping every leaf green.
  //
  // Gated on `strict` to honor the same opt-out construction uses:
  // a non-strict form opted out of construction-time validation
  // explicitly, and post-reset behaviour follows suit.
  if (st.strict && !resetResponse.success) {
    replaceErrorChannel(st, 'schema', resetResponse.errors)
  }
  // `getDefaultValues` strips refinements before parsing (see
  // `adapters/zod-v4/default-values.ts:290`) — it produces usable
  // starting data, not refinement-level verdicts. So `.min(1)` /
  // `.email()` / etc. failures on the post-reset defaults DON'T
  // surface via the sync re-derive above. Run a synchronous
  // full-schema parse against the post-reset form value to populate
  // refinement errors IMMEDIATELY (no flash where step titles flip
  // green between reset() returning and the async pass landing).
  // Async-only verdicts can't surface this way (adapter returns a
  // Promise) — they're handled by the queueMicrotask below.
  //
  // Construction has the same gap mount-side, but the flash is
  // invisible: the form mounts before the user is looking, errors
  // land within a microtask, and the UI never has time to render
  // the empty-errors state.
  if (st.strict) {
    const syncResult = st.schema.validateAtPath(st.form.value, undefined, { sync: true })
    if (!(syncResult instanceof Promise) && !syncResult.success) {
      applySchemaErrorsForSubtree(st, [], syncResult.errors)
    }
  }
  // Restore the `firstValidationDone` gate to its construction-time
  // value (`initialFirstValidationGate`, the same primitive that seeds
  // the ref). Async-validating schemas init this flag to
  // `false`, gating container `.valid` until the construction-time
  // async pass completes. After mount the flag flips `true` via the
  // watch on `activeValidations`. Across reset, leaving it `true`
  // removes the gate AND clears errors AND the sync re-derive
  // can't fill them (the zod-v4 adapter strips refinements in
  // `getDefaultValues`, returns `success: true`; sync
  // `validateAtPath` throws on schemas with always-running async
  // refines and falls through to async-only). The window between
  // `reset()` returning and the re-queued async pass landing reads
  // `valid: true` for every container — the docs-site wizard
  // demo's step titles turn green for ~600ms-1.5s. Restoring the
  // gate keeps containers `valid: false` throughout that window.
  st.firstValidationDone.value = initialFirstValidationGate(st.schema, st.strict)
  // Re-queue the async validation pass through the same primitive
  // construction uses (`queueInitialAsyncValidation`). Picks up
  // async-only verdicts the sync pass above can't reach
  // (`.refine(async ...)` on `pickup.postalCode`, etc.).
  queueInitialAsyncValidation(st)
  // Clear every field's interaction history, stamping a single `now`
  // across the whole form (see `withClearedHistoryFlags` for which
  // flags clear and which DOM-truth flags are preserved).
  const now = new Date().toISOString()
  for (const [pathKey, record] of st.fields) {
    st.fields.set(pathKey, withClearedHistoryFlags(record, now))
  }
  // Clear submission lifecycle so a reset surface reports "nothing has
  // been submitted yet" rather than holding on to the prior run's
  // count. The generation counter is bumped first so any in-flight
  // submission's catch block knows its error write would land on the
  // post-reset state and skips it. `activeSubmissions` is zeroed
  // unconditionally — the finally-block's Math.max clamps the
  // decrement at zero, and `submitting` stays false afterwards
  // because the clamped value never exceeds zero.
  st.submissionGeneration.value += 1
  st.submitting.value = false
  st.activeSubmissions.value = 0
  st.submissionAttempts.value = 0
  st.submitted.value = false
  st.submitError.value = null
  st.departAttempts.value = 0
  // Drop any pending field-validation timers / in-flight runs. Writes
  // that reached the aborted branch resolve to a no-op, so
  // the error store stays clean after the reset clears it above.
  cancelFieldValidation(st)
  // Abort + release any in-flight async transforms too, so a deferred
  // commit from before the reset can't land on the cleared form (the
  // run's token goes stale, so its resolve discards). Also clears
  // `transformErrors`.
  cancelTransforms(st)
  // Drop any held spinner state so an in-flight min-visible hold can't
  // outlive the reset; clear the streak anchors to match (the cancel above
  // already released the counts, this wipes the parallel map wholesale).
  st.displayEngine.clear()
  st.fieldValidatingSince.clear()
  // Reset the per-path blur-dedup snapshots and the form-level epoch
  // counters. After `cancelFieldValidation` no in-flight run can
  // commit, so clearing here can't be raced by a late commit
  // re-populating the map. Survivor snapshots from before the reset
  // would otherwise match a post-reset value that happens to mirror
  // a pre-reset state and skip a real revalidation that the reset's
  // cleared error stores need to repopulate.
  st.pathSnapshots.clear()
  st.scheduleEpoch = 0
  st.lastCommittedEpoch = 0
  // Variant memory is UX state — a fresh start drops the per-variant
  // typed-data cache too. Without this, a post-reset switch would
  // surface stale variant values from before the reset.
  st.variantMemory.clear()
  // Notify subscribers (history module clears its stack, persistence
  // sees the reset via onFormChange already). Listener throws are
  // isolated so one bad subscriber can't block the others.
  for (const listener of st.resetListeners) {
    try {
      listener()
    } catch (err) {
      console.error('[attaform] onReset threw:', err)
    }
  }
}

function resetField<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  const { key: targetKey, segments: targetSegments } = canonicalizePath(path)

  // Variant memory: drop any union memory whose path equals or sits
  // under `targetSegments`. Memory under the reset subtree is
  // semantically "user's prior typed state at a discriminator that
  // no longer corresponds to anything live"; preserving it would
  // surface stale variants on a future switch. Memory ABOVE the
  // reset subtree (e.g. union at ['notify'] for resetField('notify.address'))
  // is intentionally preserved — the snapshot self-corrects on the
  // next switch-out.
  st.variantMemory.clearUnderPath(targetSegments)

  // Tear down any in-flight validation for this subtree BEFORE the restore.
  // Without this the run validating the pre-reset value outlives the reset:
  // `validating` stays true on the field and, when it settles, it commits its
  // verdict back over the errors cleared below. In change mode the restore
  // write reschedules a fresh run for the restored value (the cancel's
  // `released` flag keeps the orphan's late `.finally` off the new run's
  // counters); in blur / submit mode no run follows and the field rests
  // clean. Drop the subtree's blur-dedup snapshots too, so a post-reset blur
  // re-validates instead of skipping against a pre-reset anchor.
  cancelFieldValidationUnder(st, targetSegments)
  // Same teardown for async transforms under the reset subtree, so a
  // deferred commit can't land on the just-reset field.
  cancelTransformsUnder(st, targetSegments)
  for (const [snapKey] of [...st.pathSnapshots]) {
    const segs = segmentsForPathKey(snapKey)
    if (segs === null) continue
    if (isPathPrefix(targetSegments, segs)) st.pathSnapshots.delete(snapKey)
  }

  // Storage restore: leaf > container > nothing.
  //
  // Leaf shortcut: direct originals hit means one setValueAtPath does
  // it. A miss falls through to the container case, which assembles a
  // subtree from every original under the prefix. When neither
  // matches — e.g. `resetField('')` (the form-level error path, never
  // a storage slot) or `resetField('unknownPath')` — storage stays
  // untouched but the cleanup below still runs.
  const leafEntry = st.originals.get(targetKey)
  if (leafEntry !== undefined) {
    const wrote = setValueAtPath(st, targetSegments, leafEntry.value)
    if (!wrote) {
      // Originals come from the construction-time pipeline, which
      // guarantees primitive-correctness. A rejected reset write
      // signals an invariant violation upstream.
      console.error(
        __DEV__
          ? `[attaform] resetField: leaf write rejected for path '${targetKey}' — ` +
              `originals contain a value that doesn't satisfy the slim primitive shape. ` +
              `This is a bug in the construction pipeline.`
          : `[attaform] AF11 attaform.dev/e/AF11 '${targetKey}'`
      )
    }
  } else {
    // Container case — reconstruct the subtree by walking originals for
    // every leaf whose path is a descendant of `targetSegments`. We assemble
    // the subtree first, then apply it in one setValueAtPath so diffAndApply
    // sees a single coherent replacement (rather than N mutations).
    //
    // The iteration reads `entry.segments` directly; the alternative
    // (JSON.parse on the Map key) both allocates and pays a parse cost per
    // entry even on cold paths.
    let subtree: unknown = undefined
    let anyMatch = false
    for (const [, entry] of st.originals) {
      const leafSegments = entry.segments
      if (!isPathPrefix(targetSegments, leafSegments)) continue
      if (leafSegments.length === targetSegments.length) continue // would have hit the leaf shortcut
      anyMatch = true
      const relative = leafSegments.slice(targetSegments.length)
      if (subtree === undefined) {
        // Seed root container type from the first relative segment. Numeric
        // index → array; string key → plain object. setAtPath will stay
        // consistent with that choice for the rest of the walk.
        subtree = typeof relative[0] === 'number' ? [] : {}
      }
      subtree = setAtPath(subtree, relative, entry.value)
    }
    if (anyMatch) {
      const wroteSubtree = setValueAtPath(st, targetSegments, subtree)
      if (!wroteSubtree) {
        console.error(
          __DEV__
            ? `[attaform] resetField: subtree write rejected at path '${targetKey}' — ` +
                `originals contain values that don't satisfy the slim primitive shape. ` +
                `This is a bug in the construction pipeline.`
            : `[attaform] AF12 attaform.dev/e/AF12 '${targetKey}'`
        )
      }
    }
  }

  // Cleanup runs regardless of whether storage was restored. Clears
  // errors and field-record flags for the target path AND every
  // descendant. `deleteErrorsUnderPrefix` covers the exact-path entry
  // too (an array is a prefix of itself), so a leaf reset clears the
  // single matching entry and a container reset sweeps the subtree.
  // Crucially, this also makes `resetField('')` a usable form-level-
  // error wipe: there's no storage at `''`, but errors do live there,
  // and a consumer who calls resetField on that path expects them
  // cleared. Same reasoning applies to consumer-set errors at any
  // path the schema doesn't model.
  deleteErrorCellsUnderPrefix(st, targetSegments)
  for (const [fieldKey, record] of Array.from(st.fields.entries())) {
    if (isPathPrefix(targetSegments, record.path)) clearFieldRecordFlags(st, fieldKey)
  }
}

function deleteErrorCellsUnderPrefix<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  prefix: readonly Segment[]
): void {
  // Judge each side by its own first entry's embedded path (entries at a
  // key share the key's path), mirroring the per-map prefix delete this
  // replaces: a side whose entries sit under `prefix` is stripped, the
  // other side rides along, and a cell left empty leaves the map.
  for (const [errorKey, cell] of st.errorCells) {
    for (const src of ERROR_SOURCES) {
      const first = cell[src][0]
      if (first !== undefined && isPathPrefix(prefix, first.path)) {
        setErrorChannelForKey(st, errorKey, src, NO_ERRORS)
      }
    }
  }
}

function clearFieldRecordFlags<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  pathKey: PathKey
): void {
  const record = st.fields.get(pathKey)
  if (record === undefined) return
  // The name is historical: this clears only the interaction-history
  // flags, not every flag (same as `reset()`'s field loop), but with a
  // fresh `now` per path rather than one stamp across the form.
  st.fields.set(pathKey, withClearedHistoryFlags(record, new Date().toISOString()))
}

// --- Derived ---

function isPristineAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): boolean {
  const { key, segments } = canonicalizePath(path)
  return isPristineAtPathByKey(st, key, segments)
}

function isPristineAtPathByKey<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  segments: Path
): boolean {
  // Storage match is necessary but not sufficient: a primitive leaf
  // toggled between "displayed empty" (blank + slim default)
  // and "explicitly the slim default" carries the same storage value
  // but differs visually. Compare both surfaces against the originals
  // snapshot so the blank contract dirties when membership
  // diverges.
  if (st.blankPaths.has(key) !== st.originalBlankPaths.has(key)) return false
  const entry = st.originals.get(key)
  if (entry === undefined) return true
  return Object.is(getAtPath(st.form.value, segments), entry.value)
}

function hasStructuralChangeUnder<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): boolean {
  return st.arrayIdentity.hasStructuralChangeUnder(path)
}

// Did the subtree at `prefix` (its pre-write value in `removedValue`) hold any
// leaf that was part of the construction / reset baseline — a real recorded
// value, not an absence baseline seeded for a runtime-added path? Bounds the
// check to the subtree being dropped by enumerating that subtree's own leaves,
// so it only walks what `setValue` is removing, on the rare container ->
// non-container write.
function subtreeHadRealBaseline<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  prefix: Path,
  removedValue: unknown
): boolean {
  let had = false
  diffAndApply(removedValue, undefined, prefix, (patch) => {
    if (had || patch.kind !== 'removed') return
    const record = st.originals.get(canonicalizePath(patch.path).key)
    if (record?.value !== undefined) had = true
  })
  return had
}

function hasRemovedSubtreeUnder<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  prefix: Path
): boolean {
  if (st.removedSubtrees.size === 0) return false
  for (const key of st.removedSubtrees) {
    const segments = segmentsForPathKey(key)
    if (segments === null) continue
    if (!isPathPrefix(prefix, segments)) continue
    // Skip a recorded path that a later write refilled with a container: the
    // present-leaf walk then judges it (an identical refill reads pristine, a
    // changed one dirties), so only a still-absent subtree counts as removed
    // here. Read raw — the accompanying write already fired the dirty walk's
    // own dep on this path, so no reactive tracking is needed to re-run.
    if (isContainer(getAtPath(toRaw(st.form.value), segments))) continue
    return true
  }
  return false
}

function getFieldRecord<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): FieldRecord | undefined {
  const { key } = canonicalizePath(path)
  return st.fields.get(key)
}

function getOriginalAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): unknown {
  const { key } = canonicalizePath(path)
  return st.originals.get(key)?.value
}

export function createFormStore<F extends GenericForm, G extends GenericForm = F>(
  options: CreateFormStoreOptions<F, G>
): FormStore<F, G> {
  const { formKey, schema, defaultValues, strict = true, hydration } = options
  const ssr = options.ssr === true
  const ssrPrefetch = options.ssrPrefetch
  const rememberVariants: boolean = options.rememberVariants !== false
  const fieldValidationMode: ValidateOn = options.validateOn ?? 'change'
  // Sanitise the debounce value before threading it into `setTimeout`.
  // `NaN` would fire synchronously (defeating the debounce); negatives
  // clamp to 0 (consumer intent: "no debounce"); `Infinity` would stall
  // the event loop for ~24.8 days then wrap, so it falls back to the
  // library default.
  const fieldValidationDebounceMs = normalizeNumericOption({
    value: options.debounceMs ?? DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS,
    source: 'useForm.debounceMs',
    allowInfinity: false,
    min: 0,
    defaultValue: DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS,
  })

  // Resolve the coercion config to a concrete index ONCE per form.
  // The index is keyed by `${input}->${output}` for O(1) per-keystroke
  // dispatch. `register()` reads it via `state.coerceIndex` to bake
  // path-scoped coerce closures on each `RegisterValue`.
  const coerceIndex: CoercionIndex = resolveCoercionIndex(options.coerce)

  // Resolve `getDisplayState` once. `undefined` falls back to
  // `defaultDisplayState`. The field-state computeds read the resolved
  // function directly on every read.
  const resolvedGetDisplayState: GetDisplayState = resolveGetDisplayState(options.getDisplayState)

  // State-scoped teardown hooks. History / any other per-state module
  // registers its disposer here so the cleanup is bound to the
  // FormStore's own lifetime (`dispose()` call at registry-eviction)
  // and not the first consumer's effect scope.
  const cleanupHooks: (() => void)[] = []
  const drainHooks: (() => Promise<void>)[] = []
  const modules = new Map<string, unknown>()

  // Anti-flash display engine + its episode-timing companion. The engine
  // owns the clock and the single timer the timed `getDisplayState` reducer
  // needs; `fieldValidatingSince` records when each path's latest validation
  // run started (re-stamped on every run, cleared on the → 0 edge, in
  // inc/decFieldValidation). Disposed with the store so a held spinner
  // can't outlive eviction.
  //
  // Reactive: the display computed reads `validatingSince` but NOT the
  // `validating` flag, and a long validation that settles with an unchanged
  // verdict (same error, still invalid) leaves `errors` / `valid` untouched —
  // so without reactivity here the held spinner would never re-evaluate when
  // the run ends, stranding `pending` until some unrelated reactive change.
  // Reactivity ties the computed to the streak's start AND end.
  const fieldValidatingSince: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const displayEngine = createDisplayEngine(ssr)
  cleanupHooks.push(() => displayEngine.dispose())

  // Schema is ALWAYS consulted: we need the schema-derived originals even
  // when hydrating, so pristine/dirty computation survives SSR round-trip.
  // The form's actual starting value, though, prefers hydration data.
  const schemaResponse: DefaultValuesResponse<F> = computeBaselineResponse(
    schema,
    strict,
    defaultValues
  )
  const schemaInitialData = schemaResponse.data

  // Paths the consumer or schema-author explicitly authored a starting
  // value at — used by the schema-error filter to distinguish "missing
  // user input" from "consumer chose this starting state." Populated by
  // `rebuildAuthoredPaths` once the state record exists below.
  const authoredPaths = new Set<PathKey>()

  // Clone per instance so two forms sharing a schema (or one form
  // re-mounted from the same schema cache) don't alias the same
  // initial-data object. Without the clone, the in-place merge that
  // `applyFormReplacement` runs on every setValue would reach across
  // the alias and mutate sibling forms' state.
  const initialData: F =
    hydration !== undefined ? (hydration.form as F) : (structuralSnapshot(schemaInitialData) as F)

  // Construction-time DU stub walk: every DU path whose disc value
  // isn't a known variant literal collapses to a stub holding only
  // the discriminator key. Drops any first-variant fields that snuck
  // in via `mergeStructural` / `getDefaultValues` when the consumer's
  // `defaultValues` (or hydration payload) carried a bad discriminator.
  // Mirrors the runtime stub-state contract `setValueAtPath` uses for
  // bad-disc Case A/B writes; emits a one-shot dev warning per bad path.
  // One clone walk: for a DU-carrying schema the stub walk's rebuild is
  // itself a fresh tree, so the snapshot above stays the pre-stub view
  // (field records seed from it) and the stub pass produces the storage
  // tree. A schema with no discriminated unions skips the stub walk —
  // the snapshot IS the storage tree.
  const hasDU = schema.hasDiscriminatedUnions?.() !== false
  const stubbedInitialData = hasDU
    ? (applyDuStubs(schema as AbstractSchema<unknown, unknown>, initialData, {
        warn: true,
      }) as F)
    : initialData

  const form = ref(stubbedInitialData) as Ref<F>

  // Operation-maintained per-element identity. Reads the live array
  // length so it can seed and realign token lists by position for writes
  // it can't follow; structural mutations replay their permutation onto
  // the tokens through `applyOp`.
  const arrayIdentity = createArrayIdentity((arraySegs) => {
    // Read the length off the RAW form value so this lookup never registers a
    // reactive dependency. The identity-token read (`arrayElementKey` ->
    // `tokenAt`) runs inside every array-element's FieldState computed; tracking
    // the array length here would couple every element's rollup to the array
    // length, so a single append / remove (a length change) would invalidate
    // all N element rollups and re-walk O(N x M). An element's state depends
    // only on its own subtree: a structural op that changes which element sits
    // at a slot also changes that slot's value reference (the field-array
    // helpers relocate element references in place), firing the element's own
    // value dep and re-running exactly its rollup. The length is needed only to
    // seed / bounds-check the token list, never as a reactive input.
    const v = getAtPath(toRaw(form.value), arraySegs)
    return Array.isArray(v) ? v.length : 0
  })

  // Per-path state. `reactive(new Map())` uses Vue's collection handlers —
  // reads of specific keys track those keys only, so a change to one field
  // doesn't invalidate computeds watching another.
  const fields = reactive(new Map<PathKey, FieldRecord>()) as Map<PathKey, FieldRecord>

  // The DOM slice (element registry, no-latch host anchors, DOM-order
  // sort cache, focus listeners, first-error focus resolution) lives in
  // `dom-binding.ts` inside the directive cluster's lazy graph, armed
  // into this slot through `RegisterValue.ensureDomBinding` on first
  // element use. `shallowRef` so eager readers (field-state's
  // `element` / `elements`, the invalid-submit focus walk) re-run when
  // the slot arms; `null` means nothing in this app ever registered an
  // element, and every reader treats that as the empty registry it is.
  const domBinding = shallowRef<AttaformDomBinding | null>(null)

  // The tagged error store. Each cell segregates its two sources so each
  // writer touches exactly one side; schema validation owns the `schema`
  // side, the `setErrors` / `clearErrors` API owns `user`. Reads merge via
  // `getErrorsForPath` and the top-level `errors` drillable Proxy in
  // build-form-api, schema -> blank -> user.
  const errorCells = reactive(new Map<PathKey, ErrorCell>()) as Map<PathKey, ErrorCell>

  // Originals are captured at init and on first appearance of a path; never
  // re-assigned. Reactive: the dirty computed iterates this map AND accesses
  // `form.value` per entry. With `applyFormReplacement` mutating
  // `form.value` in place (so deep watches fire only for genuinely-
  // changed paths), the form Ref's value-setter dep no longer fires
  // for every write — so a plain Map here would leave the dirty
  // computed stuck on stale deps when new originals are added (e.g.
  // `append` introduces a new array index and seeds an originals
  // entry for it). Wrapping in `reactive(new Map(...))` makes the
  // Map's iteration / set / delete fire Vue's collection deps,
  // picking up exactly the change that prompted the originals
  // mutation.
  const originals = reactive(new Map<PathKey, OriginalsRecord>()) as Map<PathKey, OriginalsRecord>

  // Paths where a baseline-present container (object or array) was replaced
  // wholesale by a non-container — `setValue('profile', undefined)` and the
  // like. Every leaf under such a path vanishes from the live value at once, so
  // the present-leaf dirty walk can't see the loss and the array identity
  // tracker (which only follows array -> array writes) doesn't apply; this set
  // is how a container removal still dirties the form (#420, the non-array
  // sibling of an array shrink). Reactivity rides on the form-value mutation
  // that always accompanies a write here, so a plain Set is enough — and the
  // membership read self-filters by current liveness, so it needs no reactive
  // collection deps of its own. Cleared on `reset()`.
  const removedSubtrees = new Set<PathKey>()

  // Blank bookkeeping. The reactive Set tracks paths whose
  // displayed state should be EMPTY even though storage holds a real
  // slim default; the originals snapshot mirrors construction-time
  // membership so dirty calculation can detect the user's clear /
  // un-clear actions. Hydration takes precedence over `initialBlankPaths`
  // (the SSR snapshot wins when present), matching how the hydrated
  // `form` value overrides the schema's getDefaultValues result.
  //
  // The I/O boundary accepts strings in either shape:
  //
  //  - dotted-string paths (`'user.email'`) — what the public path
  //    notation looks like, also what persistence writes to disk
  //    (`buildPersistedPayload` converts via `pathKeyToDotted`);
  //  - already-canonical `PathKey` strings (`'["user","email"]'`) —
  //    what the construction-time unset walker emits and what the rest
  //    of the runtime keys on.
  //
  // `coerceToPathKey` normalises both shapes to a canonical `PathKey`
  // so the live Set is uniformly keyed regardless of which seed source
  // (walker, SSR hydration payload, persisted draft) supplied the entry.
  const initialTransientList: ReadonlyArray<string> =
    hydration?.blankPaths ?? options.initialBlankPaths ?? []
  const blankPaths = reactive(new Set<PathKey>()) as Set<PathKey>
  const originalBlankPaths = new Set<PathKey>()
  for (const raw of initialTransientList) {
    const key = coerceToPathKey(raw)
    blankPaths.add(key)
    originalBlankPaths.add(key)
  }

  // Per-form variant memory. On a discriminated-union switch the
  // outgoing variant's subtree (deep-cloned) and its blank-path
  // bookkeeping are stashed here keyed by `(unionPath, oldDiscValue)`;
  // on switch-in the entry for the incoming discriminator is
  // restored. Memory is in-memory only (never persisted, never on
  // form.value), and is cleared on `reset()` / whole-form replace /
  // `resetField` of an ancestor of the union path. Disabled when
  // `rememberVariants === false`.
  const variantMemory = createVariantMemory()

  // Schema-declaration ordinal map for `form.meta.errors` sort order.
  // Plain (non-reactive) Map: it's mutated lazily from inside the
  // `metaErrors` computed when an unseen path appears, and a reactive
  // Map would retrigger that computed on every assignment. Plain
  // Map.set is invisible to Vue 3.5's reactivity tracking, so the
  // computed only re-runs when one of the error stores changes — not
  // when we extend the ordinal book during the same pass.
  //
  // Lifetime = FormStore lifetime. Never shrinks: an ordinal is
  // assigned once per path and survives `reset()`, undo/redo, and
  // hydration replay. Clearing then re-introducing an error at the
  // same path returns to the SAME slot, so `meta.errors` doesn't
  // shuffle when the user fixes a field and breaks it again.
  const pathOrdinals = new Map<PathKey, number>()

  // Reactively-derived blank-required errors. Recomputes whenever
  // `blankPaths` mutates (Vue 3.5 reactive Set handlers track size + has).
  // The schema's `isRequiredAtPath` is referentially stable for a given
  // form (schema is fixed at construction), so it doesn't need to be a
  // dep — only the membership of `blankPaths` drives invalidation.
  const derivedBlankErrors = computed<ReadonlyMap<PathKey, ValidationError[]>>(() => {
    const result = new Map<PathKey, ValidationError[]>()
    if (blankPaths.size === 0) return result
    for (const pathKey of blankPaths) {
      const segments = segmentsForPathKey(pathKey)
      if (segments === null) continue
      if (!schema.isRequiredAtPath(segments)) continue
      result.set(pathKey, [makeBlankRequiredError(segments)])
    }
    return result
  })

  // Submission lifecycle refs. Initial values encode "no submission has
  // happened yet": not in flight, zero attempts, no captured error.
  // `activeSubmissions` counts concurrent in-flight submissions so the
  // last completion (count → 0) is what flips `submitting` to false,
  // not just the first.
  const submitting = ref(false)
  const activeSubmissions = ref(0)
  const submissionAttempts = ref(0)
  const submitted = ref(false)
  const submitError = ref<Error | null>(null)
  // Counts wizard departures from this form. Bumped by `useWizard`
  // when `next` / `back` / `goTo` actually leaves this form; zeroed by
  // `reset()`. Introspection only — the library-default
  // `getDisplayState` reveals via `submissionAttempts`, not this.
  const departAttempts = ref(0)
  // Data-freeze channel. `externalLock` is written by `useWizard` to
  // force a locked step's form frozen; the form's own config contributes
  // via `toValue(options.disabled)`. `effectiveDisabled` ORs the two
  // toward frozen so a member form can't pass `disabled: false` to
  // escape a wizard lock. A throwing consumer getter falls back to the
  // config side reading not-frozen (with a one-time dev warning); the
  // wizard lock stays authoritative regardless.
  const externalLock = ref(false)
  let warnedDisabledThrow = false
  const effectiveDisabled = computed<boolean>(() => {
    let own = false
    try {
      own = Boolean(toValue(options.disabled))
    } catch (err) {
      // `own` stays `false` (the try reassigns it atomically or throws
      // before touching it), so the config side reads not-frozen.
      if (__DEV__ && !warnedDisabledThrow) {
        warnedDisabledThrow = true
        console.warn(
          `[attaform] useForm({ disabled }) getter threw for form "${String(formKey)}"; ` +
            `treating its config as enabled. Fix the getter to clear this warning.`,
          err
        )
      }
    }
    return own || externalLock.value
  })
  const submissionGeneration = ref(0)
  const activeValidations = ref(0)

  // Per-path snapshots of `form.value` keyed by the canonical
  // PathKey of the SCOPE each blur-mode `run()` commits at. The
  // blur-dedup at path P walks from P up to the root and reads the
  // closest ancestor entry, then compares the subtree-at-P from
  // that snapshot against the live subtree-at-P — so a sibling-only
  // edit between blurs leaves A's subtree-at-A unchanged and A's
  // re-blur correctly skips, without depending on whether B's
  // commit happened to advance a shared anchor.
  //
  // Under today's whole-form validation scope every commit lands at
  // the root key, so all blurs share a single entry (equivalent
  // semantics to the old form-wide `let`). Per-path lookup keeps
  // the design correct once subtree-scope commits land: a commit
  // at B advances B's entry only; A's blur-dedup walks up to
  // whatever ancestor scope WAS last committed and uses it.
  //
  // Empty Map → no entry → first blur revalidates (matches the
  // pre-fix `null` initial state).
  const pathSnapshots = new Map<PathKey, unknown>()

  // Async-defaults lifecycle. `useAbstractForm` writes these on the
  // first call for this key: `defaultValuesFactory` captures the
  // function-form input, `hydrating` flips true until settle
  // completes. Plain-value forms leave the refs at their zero state.
  const hydrating = ref(false)
  const hydrateError = ref<ValidationError | null>(null)
  const defaultValuesFactory = ref<(() => unknown | Promise<unknown>) | undefined>(undefined)
  // `true` once the form's effective defaults have been applied —
  // either a sync `defaultValues` at construction, or an async
  // factory whose settle completed. Stays `false` for dormant lazy
  // forms until they activate. Read by `useWizard` to decide whether
  // to surface seed status vs. live meta.
  const defaultsResolved = ref(false)
  // Lazy-activation state. `activated` flips `true` the moment the
  // captured async factory has been kicked off (synchronously, before
  // it resolves). `activationPromise` holds the in-flight settle so
  // concurrent callers (cross-component SSR consumers, recursive
  // factory reads) share a single fetch.
  const activated = ref(false)
  const activationPromise = ref<Promise<void> | undefined>(undefined)
  // Initial-validity gate. See `FormStore.firstValidationDone` JSDoc and
  // `initialFirstValidationGate` for why only async-validating strict
  // schemas start gated. The watch flips the gate when
  // `activeValidations` returns to 0 from a positive value (i.e. the
  // construction-time queued validation completes).
  const firstValidationDone = ref(initialFirstValidationGate(schema, strict))
  // `watch(source, cb)` only fires when the source CHANGES (no immediate
  // first-invocation), so `prev` is always the pre-transition value, typed
  // as `number`, never `undefined`.
  watch(activeValidations, (now, prev) => {
    if (prev > 0 && now === 0) {
      firstValidationDone.value = true
    }
  })

  // Per-path async-need cache. Keyed by canonical PathKey;
  // populated lazily so a form whose consumers only ever ask about
  // a few prefixes doesn't pay for a full schema walk. The cache is
  // safe to grow unboundedly across the FormStore's lifetime — paths
  // are bounded by the schema, and the FormStore itself is GC'd
  // when its last consumer disposes.
  const pathAsyncCache = new Map<PathKey, boolean>()

  // Reactive per-path counter for `field.validating`. See JSDoc on
  // `FormStore.fieldValidationCounts` for semantics.
  const fieldValidationCounts: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const fieldValidationState = new Map<PathKey, FieldValidationEntry>()

  // Plain Sets (not reactive) — these fire imperative callbacks; no
  // template should ever depend on "how many listeners are attached".
  const formChangeListeners = new Set<(next: F, meta?: WriteMeta) => void>()
  const submitSuccessListeners = new Set<() => void>()
  const resetListeners = new Set<() => void>()

  // Async register-transform machinery — a near-mirror of the
  // field-validation counters. A `register({ transforms })` chain
  // that returns a thenable defers its write; these counters drive the
  // busy/pending UX for the duration, the per-path run token enforces
  // latest-request-wins, and the waiters back `settleTransforms`. The
  // directive owns the orchestration (`directive.ts`); the
  // `transforming` / `busy` / `transformError` surfaces live in
  // `field-state-api.ts`.
  const fieldTransformCounts: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const fieldTransformingSince: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const transformErrors: Map<PathKey, Error | null> = reactive(new Map<PathKey, Error | null>())
  const activeTransforms = ref(0)
  const transformRuns = new Map<PathKey, TransformRun>()
  // Pending `settleTransforms` callers: `key === null` waits on the
  // whole form (`activeTransforms === 0`); a key waits on its own path.
  const transformWaiters: { key: PathKey | null; resolve: () => void }[] = []

  // Array-bookkeeping factory: relocate per-element field / error /
  // blank / originals state, seed freshly created elements, drop stale
  // schema verdicts at changed indices, abort in-flight validation at
  // vacated indices. Owns no state of its own — every dep is a
  // reference into the surrounding store, so the bookkeeping's
  // lifecycle exactly matches the host.
  const arrayBookkeeping: ArrayBookkeeping = createArrayBookkeeping({
    form,
    fields,
    errorCells,
    originals,
    blankPaths,
    originalBlankPaths,
    authoredPaths,
    fieldValidationCounts,
    fieldValidatingSince,
    fieldValidationState,
    activeValidations,
    arrayIdentity,
    variantMemory,
    touchFieldRecord: (pathKey, path, patch) => touchFieldRecord(st, pathKey, path, patch),
    decFieldValidation: (key) => decFieldValidation(st, key),
  })

  const st: FormState<F, G> = {
    // --- public data (the FormStore contract's state members) ---
    formKey,
    form,
    fields,
    errorCells,
    derivedBlankErrors,
    originals,
    schema,
    ssr,
    getDisplayState: resolvedGetDisplayState,
    submitting,
    activeSubmissions,
    submissionAttempts,
    submitted,
    submitError,
    departAttempts,
    effectiveDisabled,
    externalLock,
    hydrating,
    hydrateError,
    defaultValuesFactory,
    hasSsrPrefetch: ssrPrefetch !== undefined,
    defaultsResolved,
    activated,
    activationPromise,
    submissionGeneration,
    activeValidations,
    firstValidationDone,
    fieldValidationCounts,
    fieldValidatingSince,
    fieldTransformCounts,
    fieldTransformingSince,
    transformErrors,
    activeTransforms,
    displayEngine,
    domBinding,
    modules,
    coerceIndex,
    blankPaths,
    originalBlankPaths,

    // --- kernel-internal state ---
    strict,
    defaultValues,
    ssrPrefetch,
    rememberVariants,
    fieldValidationMode,
    fieldValidationDebounceMs,
    hasDU,
    fieldValidationState,
    formChangeListeners,
    submitSuccessListeners,
    resetListeners,
    cleanupHooks,
    drainHooks,
    authoredPaths,
    arrayIdentity,
    removedSubtrees,
    variantMemory,
    pathOrdinals,
    pathSnapshots,
    pathAsyncCache,
    transformRuns,
    transformWaiters,
    arrayBookkeeping,
    nextOrdinal: 0,
    scheduleEpoch: 0,
    lastCommittedEpoch: 0,
    transformTokenSeq: 0,
    warnedDisabledWrite: false,

    // --- methods: thin per-instance skins over the module kernel ---
    rehydrate: () => rehydrate(st),
    activate: () => activate(st),
    pathHasAsyncValidation: (path) => pathHasAsyncValidation(st, path),
    pathHasAsyncValidationByKey: (key, segments) => pathHasAsyncValidationByKey(st, key, segments),
    applyFormReplacement: (next, meta) => applyFormReplacement(st, next, meta),
    setValueAtPath: (path, value, meta) => setValueAtPath(st, path, value, meta),
    getValueAtPath: (path) => getValueAtPath(st, path),
    arrayElementKey: (path) => arrayElementKey(st, path),
    reset: (nextDefaultValues) => reset(st, nextDefaultValues),
    resetField: (path) => resetField(st, path),
    setSchemaErrorsForPath: (path, entries) =>
      setErrorChannelForKey(
        st,
        canonicalizePath(path).key,
        'schema',
        entries.length === 0 ? NO_ERRORS : [...entries]
      ),
    setAllSchemaErrors: (entries) => replaceErrorChannel(st, 'schema', entries),
    clearSchemaErrors: (path) => clearErrorChannel(st, 'schema', path),
    applySchemaErrorsForSubtree: (path, entries) => applySchemaErrorsForSubtree(st, path, entries),
    setAllUserErrors: (entries) => replaceErrorChannel(st, 'user', entries),
    setUserErrorsForPath: (path, entries) =>
      setErrorChannelForKey(
        st,
        canonicalizePath(path).key,
        'user',
        entries.length === 0 ? NO_ERRORS : [...entries]
      ),
    clearUserErrors: (path) => clearErrorChannel(st, 'user', path),
    restoreErrorCells: (entries) => restoreErrorCells(st, entries),
    getErrorsForPath: (path) => getErrorsForPath(st, path),
    ensurePathOrdinal: (key) => ensurePathOrdinal(st, key),
    noteDomConnected: (path) => noteDomConnected(st, path),
    noteDomDisconnected: (path) => noteDomDisconnected(st, path),
    markFocused: (path, focused, meta) => markFocused(st, path, focused, meta),
    markInteracted: (path) => markInteracted(st, path),
    touchAtPath: (segments) => touchAtPath(st, segments),
    interactAtPath: (segments) => interactAtPath(st, segments),
    markConnectedOptimistically: (path) => markConnectedOptimistically(st, path),
    isPristineAtPath: (path) => isPristineAtPath(st, path),
    isPristineAtPathByKey: (key, segments) => isPristineAtPathByKey(st, key, segments),
    hasStructuralChangeUnder: (path) => hasStructuralChangeUnder(st, path),
    hasRemovedSubtreeUnder: (path) => hasRemovedSubtreeUnder(st, path),
    getFieldRecord: (path) => getFieldRecord(st, path),
    getOriginalAtPath: (path) => getOriginalAtPath(st, path),
    cancelFieldValidation: () => cancelFieldValidation(st),
    beginTransform: (key, holder) => beginTransform(st, key, holder),
    isCurrentTransform: (key, token) => isCurrentTransform(st, key, token),
    endTransform: (key, token) => endTransform(st, key, token),
    setTransformError: (key, err) => setTransformError(st, key, err),
    cancelTransforms: () => cancelTransforms(st),
    cancelTransformsUnder: (prefix) => cancelTransformsUnder(st, prefix),
    settleTransforms: (path) => settleTransforms(st, path),
    scheduleFieldValidation: (path, immediate, override) =>
      scheduleFieldValidation(st, path, immediate, override),
    onFormChange: (listener) => onFormChange(st, listener),
    onSubmitSuccess: (listener) => onSubmitSuccess(st, listener),
    onReset: (listener) => onReset(st, listener),
    emitSubmitSuccess: () => emitSubmitSuccess(st),
    registerCleanup: (fn) => registerCleanup(st, fn),
    registerDrain: (fn) => registerDrain(st, fn),
    awaitPendingWrites: () => awaitPendingWrites(st),
    dispose: () => dispose(st),
  }

  // --- Construction sequence (the reset-shared baseline + the
  // construction-only seeding) ---

  rebuildAuthoredPaths(st, defaultValues, schemaInitialData)

  // Populate originals by diffing from empty-form to schema-initial. This is
  // always the schema's shape regardless of hydration, so pristine/dirty
  // comparisons are against what the form was supposed to start as.
  // The same walk seeds `pathOrdinals` (`ensureOrdinals: true`) —
  // `diffAndApply` visits every leaf in declaration order, so the ordinal
  // map gets schema-declaration order for free with no extra traversal.
  seedOriginalsFromBaseline(st, schemaInitialData, true)

  // Populate fields from either the hydration payload (preserves exact
  // server-side timestamps and flags) or by walking initialData for leaves.
  if (hydration !== undefined) {
    for (const [rawKey, record] of hydration.fields) {
      if (typeof rawKey !== 'string' || !isHydratedFieldRecord(record)) {
        warnMalformedHydration(formKey, 'FieldRecord', String(rawKey))
        continue
      }
      fields.set(rawKey as PathKey, record)
    }
    // Hydration takes precedence over the construction-time seed
    // below: the server already authored whatever error state the
    // client should mirror, including (deliberately) the empty case.
    // Each store replays from its own snapshot so the source-segregation
    // invariant is preserved across SSR round-trip.
    for (const [rawKey, errs] of hydration.schemaErrors) {
      if (typeof rawKey !== 'string' || !isHydratedValidationErrorArray(errs)) {
        warnMalformedHydration(formKey, 'schemaErrors', String(rawKey))
        continue
      }
      setErrorChannelForKey(st, rawKey as PathKey, 'schema', errs)
    }
    for (const [rawKey, errs] of hydration.userErrors) {
      if (typeof rawKey !== 'string' || !isHydratedValidationErrorArray(errs)) {
        warnMalformedHydration(formKey, 'userErrors', String(rawKey))
        continue
      }
      setErrorChannelForKey(st, rawKey as PathKey, 'user', errs)
    }
  } else {
    const initStamp = new Date().toISOString()
    diffAndApply({}, initialData, [], (patch) => {
      if (patch.kind !== 'added') return
      const { key } = canonicalizePath(patch.path)
      fields.set(key, {
        path: patch.path,
        updatedAt: initStamp,
        connected: false,
        focused: null,
        blurred: null,
        touched: false,
        interacted: false,
        blurredAfterInteraction: false,
      })
    })
    // No hydration — seed schemaErrors from the construction-time
    // validation result IF the schema rejected the defaults AND the
    // form was constructed in strict mode. Non-strict mode treats
    // default values as "best-effort," so populating errors there
    // would surprise consumers who explicitly opted out via
    // `strict: false`.
    if (strict && !schemaResponse.success) {
      replaceErrorChannel(st, 'schema', schemaResponse.errors)
    }
  }

  // Async-only verdicts (e.g. zod's `.refine(async (v) => ...)`) can't
  // surface from `getDefaultValues` — that contract is sync, and the
  // adapter degrades to success when the schema's sync parse can't
  // resolve them. Queue the one-shot full-form validation pass so the
  // errors land on a later microtask instead of waiting for a user
  // mutation; see `queueInitialAsyncValidation` for the SSR and strict
  // gates.
  queueInitialAsyncValidation(st)

  return st
}

export type { Path, PathKey, Segment }
