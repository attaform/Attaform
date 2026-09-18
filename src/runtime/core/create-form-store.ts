import {
  computed,
  reactive,
  ref,
  shallowReactive,
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
  ErrorCell,
  FormKey,
  SchemaDefaultsResult,
  TransformAbortHolder,
  ValidateOn,
  ValidationError,
  WriteMeta,
} from '../types/types-api'
import { createDynamicPathSweep, type DynamicPathSweep } from './dynamic-path-sweep'
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
import {
  buildErrorPathIndex,
  isSameWindow,
  windowUnder,
  type ErrorPathEntry,
} from './error-path-index'
import { makeBlankRequiredError, NO_ERRORS } from './error-codes'
import {
  consumerKeys,
  consumerSymbolKeys,
  readConsumerIndex,
  readConsumerProp,
} from './consumer-code'
import { groupErrorsByKey } from './errors'
import { runFactoryAndApply } from './form-activation'
import { mergeSparseHydration } from './merge-hydration'
import {
  canonicalizePath,
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
import { resolveCoerceEnabled } from './schema-coerce'
import { isSlimPrimitiveValid } from './slim-primitive-gate'
import { walkAuthoredFromConstraints, walkUnspecified } from './unset-walker'

/**
 * A value that holds descendant leaves: an array or a plain object. The dirty
 * machinery treats anything else (primitive, `undefined`, `null`) as a leaf, so
 * replacing a container with one of those drops a whole subtree at once.
 */
const isContainer = (value: unknown): boolean => Array.isArray(value) || isPlainRecord(value)

// Hydration shape guards. A rolling deploy or a stale cache can hand the
// client an SSR payload whose record shape differs from its own, and the
// hydration loop's casts would admit it; the crash then surfaces at a later
// `.touched` / `.code` read, far from the cause. Skip malformed entries and
// warn once per key in dev so the diagnosis is loud.
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
 * Copy `record` with its interaction history cleared (`touched` /
 * `interacted` / `blurredAfterInteraction` to false) and `updatedAt` stamped
 * to `now`. DOM truth (`focused` / `blurred`) and `connected` survive: a reset
 * does not blur the focused input or disconnect the field, so Attaform must
 * not claim it did. The caller supplies `now` because `reset()` wants one
 * stamp across the whole form and `resetField()` wants a fresh one per call.
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
    // `data` arrived through JSON.parse, so it is structurally JSON already.
    // It rides along untouched.
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

/**
 * The per-form kernel each `useForm` call owns: form value, field records,
 * element references, the error stores and the submission, validation and
 * transform lifecycles, all keyed by `(formKey, path)` so two forms cannot
 * collide over shared DOM state.
 *
 * Not a singleton. Every `useForm` call builds one; the registry supplies SSR
 * hydration, and otherwise the state is per component per form.
 */
export type FormStore<F extends GenericForm, G extends GenericForm = F> = {
  /**
   * The form's single liveness sweep over every per-path cache. It lives on
   * the store, not on `buildFormApi`, because the store's own maps (`fields`,
   * `originals`, `authoredPaths`, `fieldValidationState`) are the largest
   * thing it evicts and they exist whether or not a form API was ever built
   * around them. Read surfaces register their evictions into it, so one
   * subscription and one walk serve all of them. See `dynamic-path-sweep.ts`.
   */
  readonly pathSweep: DynamicPathSweep
  readonly formKey: FormKey
  readonly form: Ref<F>
  readonly fields: Map<PathKey, FieldRecord>
  /**
   * The tagged error store: one cell per error-bearing path, each segregating
   * its two sources. The `schema` side is written only by the validation
   * pipeline (`scheduleFieldValidation`, `handleSubmit`, the construction
   * seed, history restore, hydration) and cleared by `reset` / `resetField`
   * and a successful submit. The `user` side is written only by `setErrors` /
   * `clearErrors` (plus history / hydration replay) and survives both schema
   * revalidation and a successful submit, so the consumer owns its lifetime.
   * A key exists iff a side is non-empty, and cells are replaced rather than
   * mutated so Vue's per-key Map tracking fires for either side. Derived blank
   * entries are not stored here; they synthesize at read
   * (`derivedBlankErrors`).
   */
  readonly errorCells: Map<PathKey, ErrorCell>
  /**
   * Reactively-derived "No value supplied" errors: a pure function of
   * `(blankPaths, schema.isRequiredAtPath)` with no writers and no clears.
   * Membership follows `blankPaths`, so typing into a blank required numeric
   * field makes the error vanish and clearing the input brings it back. The
   * `errors` proxy and `getErrorsForPath` merge this alongside the schema and
   * user sides, so the "this required field is empty" error is true the moment
   * it is true, with no `validate()` / `handleSubmit` call.
   *
   * Most entries are `number` / `bigint` leaves, where the side channel is the
   * only way to tell "user typed 0" from "user supplied nothing". String and
   * boolean leaves land here only when the consumer opts in with the `unset`
   * sentinel. See `docs/validation/blank.md`.
   */
  readonly derivedBlankErrors: ComputedRef<ReadonlyMap<PathKey, ValidationError[]>>
  /**
   * Every path carrying an error at or under `prefix`, sorted by key.
   * `aggregateErrorsAt` takes its candidates from here rather than rescanning
   * all three error stores per call, which is what keeps a table of N rows at
   * O(errors) instead of O(N x errors). See `error-path-index.ts`.
   *
   * Going through this rather than the form-global index is also what isolates
   * containers from each other: the index is one value for the whole form, so
   * any path gaining or losing an error gives it a fresh identity. Each prefix
   * gets a memoised `computed` that hands back its previous array when its own
   * window is unchanged, so the global change stops there. See `errorWindowAt`.
   */
  readonly errorWindowAt: (prefix: Path, prefixKey: PathKey) => readonly ErrorPathEntry[]
  readonly originals: Map<PathKey, OriginalsRecord>
  /**
   * Reactive set of paths whose displayed state should be EMPTY even though
   * storage holds a real, schema-conformant value (the slim default). It
   * records storage / display divergence, the case where storage alone cannot
   * tell "user typed 0" from "user supplied nothing".
   *
   * `number` / `bigint` are the reason it exists: storage holds `0` / `0n`
   * while the DOM input shows `''`, so the directive's input listener marks
   * the path on clear. Strings and booleans need no mark (`''` storage is `''`
   * display, `false` is unchecked), so they are never auto-marked. Consumers
   * can still mark any primitive leaf through the `unset` sentinel
   * (`defaultValues: { x: unset }`, `setValue('x', unset)`,
   * `reset({ x: unset })`), where the mark is declared intent rather than
   * runtime inference.
   *
   * Reads (the `displayValue` computed, `fields.<path>.blank`,
   * `derivedBlankErrors`) track through Vue's reactive Set handlers; writes
   * happen in `setValueAtPath` (`blank: true` meta adds, any other write
   * removes) and `reset`.
   *
   * Storage never reflects this set: reads against `form.value` see the slim
   * default. It is a display / intent channel that `derivedBlankErrors`
   * consults. See `docs/validation/blank.md`.
   */
  readonly blankPaths: Set<PathKey>
  /**
   * Snapshot of `blankPaths` taken at construction and re-taken on
   * `reset(args)`. Dirty calculation compares against it, so a path whose
   * membership diverges is dirty even when storage matches the original.
   * Populated eagerly, so there is no "dirty on first read" window.
   */
  readonly originalBlankPaths: Set<PathKey>
  readonly schema: AbstractSchema<F, G>

  /**
   * Server-side flag, plumbed in from `registry.ssr`.
   * `markConnectedOptimistically()` reads it before flipping
   * `connected: true`; on the client it is a no-op, leaving the directive
   * lifecycle as the source of truth.
   */
  readonly ssr: boolean

  /**
   * Per-form display engine. It owns the clock and the single timer the timed
   * display policy needs, which is what keeps the reducer a pure
   * `(prev, ctx) => next`. Field-state computeds route every `displayState`
   * read through `displayEngine.resolve(...)`, which threads the path's
   * previous machine, persists or evicts the result, and re-arms the
   * nearest-deadline timer. Torn down through `registerCleanup` on eviction.
   */
  readonly displayEngine: DisplayEngine

  // --- submission lifecycle ---
  // Written in exactly one place, `buildProcessForm`'s handleSubmit wrapper;
  // `use-abstract-form.ts` exposes the readonly surface. They live on
  // FormStore so `reset()` can clear them.
  //
  // `activeSubmissions` is the truth for "is anything in flight" and
  // `submitting` mirrors `activeSubmissions > 0`. Keeping the counter
  // separately is what stops overlapping submissions flipping `submitting`
  // false when the first of them completes.
  readonly submitting: Ref<boolean>
  readonly activeSubmissions: Ref<number>
  readonly submissionAttempts: Ref<number>
  /**
   * `true` once a `handleSubmit` callback resolved without throwing.
   * Independent of `submissionAttempts`: a failed submit increments attempts
   * and leaves `submitted` at `false`. Cleared by `reset()`.
   */
  readonly submitted: Ref<boolean>
  readonly submitError: Ref<Error | null>

  // --- wizard navigation lifecycle ---
  // Bumped by `useWizard` each time navigation (`next`, `back`, `goTo`)
  // actually departs this form; cleared by `reset()`. Available to consumer
  // reveal logic but NOT an input to the display heuristic. Kept apart from
  // `submissionAttempts` (which counts `handleSubmit` passes only) so
  // submission accounting stays unambiguous, and from `form.validate()`,
  // which is read-only and bumps no counter.
  readonly departAttempts: Ref<number>

  /**
   * Effective data-freeze state: `true` when either the form's own
   * `disabled` config resolves truthy or `externalLock` is set. Read at
   * the write chokepoint (`setValueAtPath`), the register value's
   * `disabled`, and the field display predicate.
   */
  readonly effectiveDisabled: ComputedRef<boolean>
  /**
   * Wizard-driven freeze channel. `useWizard` sets it `true` for a locked
   * step's member form, and `effectiveDisabled` ORs it in, so a member form
   * cannot escape the lock by passing `disabled: false`. Default `false`.
   */
  readonly externalLock: Ref<boolean>

  /**
   * `true` while a function-form `defaultValues` factory is in flight, and
   * always `false` for plain-value `defaultValues`. Shared across every
   * `useForm({ key })` call resolving to this store, so the second caller
   * sees the first caller's hydration state.
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
   * `true` when this store carries an SSR prefetch queue, the server path
   * where `activate()` must enqueue intent before deciding whether to fire.
   * `buildFormApi` uses it to skip the lazy activation gate for forms with
   * neither a factory nor a prefetch, the common client case where `gated()`
   * is pure overhead on every public method call.
   */
  readonly hasSsrPrefetch: boolean
  /**
   * `true` once the form's effective defaults have been applied, whether from
   * a sync `defaultValues` at construction or an async factory that settled.
   * Stays `false` for a dormant lazy form until it activates. `useWizard`
   * reads it to decide between surfacing seed status and live meta.
   */
  readonly defaultsResolved: Ref<boolean>
  /**
   * `true` once the captured async factory has been kicked off, set
   * synchronously by `activate()` before the factory resolves. Paired with
   * `defaultsResolved` (which flips only on settle) so the API surface can
   * tell "started" from "done".
   */
  readonly activated: Ref<boolean>
  /**
   * In-flight activation promise. Concurrent callers (cross-component SSR
   * consumers, recursive factory reads, parallel `activate()` calls) all
   * receive this one, so the factory runs once under contention.
   */
  readonly activationPromise: Ref<Promise<void> | undefined>
  /**
   * Idempotent activation entrypoint. Fires the captured function-form
   * `defaultValues` factory on the first call and publishes the in-flight
   * promise; later calls return that promise until it settles and
   * `Promise.resolve()` afterwards. A plain-value form always resolves
   * immediately. Every public getter and method except `key` routes through
   * here, so the form activates on first use.
   */
  activate(): Promise<void>
  /**
   * Re-fire the captured function-form `defaultValues` factory. Throws
   * synchronously on a plain-value form, where no factory was captured.
   * Resolves once `hydrating` is back to `false`, so `await form.rehydrate()`
   * can gate UI on the fresh load.
   *
   * Leaves touched / submit state alone; chain `form.reset()` for a clean
   * surface. It does re-seat the defaults (see `adoptResolvedDefaults`), so
   * afterwards dirty means "differs from what the factory just returned" and
   * `form.reset()` lands on the fresh values instead of discarding them.
   */
  rehydrate(): Promise<void>
  /**
   * Adopt a resolved async-defaults value as the form's durable defaults and
   * re-seed the dirty baseline from it. Called by the activate / rehydrate
   * orchestrator once its factory settles. It hangs off the store rather than
   * being imported because `form-activation` imports this module, and a value
   * import back the other way would close a cycle.
   */
  adoptResolvedDefaults(value: unknown): void
  /**
   * Incremented by every `reset()`. The submit wrapper captures it at entry
   * and skips writing `submitError` from a catch that fires after a reset,
   * which is what stops a reset-during-submit clearing `submitError` only for
   * it to reappear when the in-flight promise rejects.
   */
  readonly submissionGeneration: Ref<number>
  /**
   * Counts in-flight validation calls across every `validate()` ref and every
   * committing `parse(...)` / `handleSubmit` pre-check; public `validating`
   * mirrors `> 0`. Separate from the submission counters because a debounced
   * field check overlapping a submit must show the union of both.
   */
  readonly activeValidations: Ref<number>
  /**
   * `true` once the form has completed at least one validation pass, flipping
   * when `activeValidations` returns to 0 from a positive value. Until then
   * `meta.valid` and `field.valid` report `false` even with an empty schema
   * side, because no errors at frame 1 means "not checked yet", not "checked
   * and clean".
   *
   * The window it closes: where the slim default-derivation parse strips
   * refinements (`.refine`, `.superRefine`, async validators) the slim parse
   * passes, no construction errors land, and the queued microtask has not run,
   * so frame 1 would paint the form valid a tick before the real verdict.
   *
   * `reset()` restores it to the same construction-time seed, so the post-reset
   * window gates exactly like the post-mount one.
   */
  readonly firstValidationDone: Ref<boolean>
  /**
   * Async-gate verdict for a path whose canonical key the caller already
   * holds. `key` is required and must correspond to `segments`; skipping the
   * `canonicalizePath` round-trip is what lets a descendant walk, whose Map
   * iteration already yields the key, avoid a canonicalize per leaf.
   */
  pathHasAsyncValidationByKey(key: PathKey, segments: Path): boolean
  /**
   * Per-path counter of in-flight field-level validation runs;
   * `FieldState.validating` mirrors `> 0`. Incremented and decremented in
   * lockstep with `activeValidations` inside `scheduleFieldValidation`'s `run`
   * closure, so the two are co-extensive on the field-scheduled branch.
   * Whole-form `validate()` / `parse()` runs have no single path and touch
   * only `activeValidations`.
   *
   * A counter rather than a Set because two runs at one path can overlap: an
   * aborted run's `.finally` lands after its replacement's increment, and
   * `> 0` keeps the field validating across that boundary.
   *
   * Reactive Map, so `.get()` / `.has()` / `.size` track per key and a
   * FieldState computed re-runs only for its own key.
   */
  readonly fieldValidationCounts: Map<PathKey, number>
  /**
   * Per-path `Date.now()` stamp for the start of the field's latest validation
   * run, re-anchored on every run start and deleted on the edge back to 0. The
   * display reducer reads it as `ctx.validatingSince` and times the anti-flash
   * spinner off `now - validatingSince`.
   *
   * Re-anchoring per run, not per streak, is the point: a burst of keystrokes
   * keeps pushing the stamp forward and the spinner stays suppressed until the
   * user pauses. Anchoring at the streak start would pin it to the first
   * keystroke, because at `debounceMs: 0` an aborted run's decrement lands
   * after the next run's increment and the count never reaches 0 between fast
   * keystrokes. The container walk takes the descendant minimum, so a row
   * spinner anchors at its earliest still-active leaf.
   *
   * Reactive, and that is load-bearing: the display computed reads this stamp
   * but not the `validating` flag, and a long run that settles on an unchanged
   * verdict leaves `errors` / `valid` untouched. Without reactivity a held
   * `pending` spinner would strand after the run ended, waiting on some
   * unrelated change to re-run the computed. Runtime-only, never hydrated.
   */
  readonly fieldValidatingSince: Map<PathKey, number>
  /**
   * Per-path counter of in-flight async-transform runs, the async branch of
   * the `register({ transforms })` pipeline; `> 0` drives
   * `field.transforming` / `field.busy`. A counter for the same overlap reason
   * as `fieldValidationCounts`, except a superseding input releases the prior
   * run synchronously first, so in practice the value is 0 or 1.
   */
  readonly fieldTransformCounts: Map<PathKey, number>
  /**
   * Per-path `ssr ? 0 : Date.now()` stamp for the opening of the path's latest
   * async transform, read by the display reducer as `ctx.transformingSince` to
   * time the gated busy spinner. Mirrors `fieldValidatingSince` exactly, down
   * to why it is reactive.
   */
  readonly fieldTransformingSince: Map<PathKey, number>
  /**
   * Per-path latest async-transform failure, either a rejected transform or a
   * resolved value the write gate refused, surfaced as `field.transformError`.
   * Cleared when a fresh run opens at the path and on `reset()`. A channel of
   * its own, separate from validation `errors`.
   */
  readonly transformErrors: Map<PathKey, Error | null>
  /**
   * Form-wide count of in-flight async-transform runs, behind the
   * `settleTransforms` quiescence guard and the `handleSubmit` drain barrier.
   * Clamped at 0 on release, so a run's own late `endTransform` after a
   * synchronous cancel cannot drive it negative.
   */
  readonly activeTransforms: Ref<number>

  // --- form mutations ---
  /**
   * Replace the form value wholesale. `meta` is forwarded to every
   * `onFormChange` listener so each can decide whether this write is one it
   * cares about, the way history tags a hydration replay.
   */
  applyFormReplacement(next: F, meta?: WriteMeta): void
  /**
   * Set a single path's value. `meta` reaches listeners through
   * `applyFormReplacement`; public `form.setValue` passes none.
   *
   * Returns `false` when the slim-primitive gate rejects the write, meaning
   * the value's primitive shape does not match the schema's slim shape at the
   * path. The store is unchanged in that case.
   */
  setValueAtPath(path: Path, value: unknown, meta?: WriteMeta): boolean
  getValueAtPath(path: Path): unknown
  /**
   * Stable identity for the array element at `path`, the token the array
   * engine maintains across structural mutations. Empty for anything that is
   * not an array element (a record entry, a fixed-object field, a container,
   * the root). Backs `FieldState.key`.
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
   * Replace the schema side under `path` with `errors`, keying each error by
   * its OWN absolute path. The validation pipelines
   * (`scheduleFieldValidation`, the committing parse, `handleSubmit`, `reset`)
   * commit a parse result through here: entries missing from the new pass drop
   * out of the subtree, and surviving keys update in place so insertion order
   * holds. Pass `[]` for whole-form scope.
   */
  applySchemaErrorsForSubtree(path: Path, errors: ValidationError[]): void

  // User-driven writers. Used by build-form-api's setErrors / clearErrors.
  setAllUserErrors(errors: readonly ValidationError[]): void
  setUserErrorsForPath(path: Path, errors: readonly ValidationError[]): void
  clearUserErrors(path?: Path): void

  /**
   * Rebuild the whole tagged store from a snapshot's `[key, cell]` entries,
   * the history ring buffer's restore road. Entry arrays are cloned in so the
   * snapshot stays detached from the live store, and a cell with both sides
   * empty is skipped.
   */
  restoreErrorCells(entries: ReadonlyArray<readonly [PathKey, ErrorCell]>): void

  /**
   * Merged read of the cell at `path`, in schema -> blank -> user order:
   * structural validation first, the synthesized blank entry between, user
   * entries last. Same order as `getFirstErrorElement` and the top-level
   * `errors` proxy iterate in.
   */
  getErrorsForPath(path: Path): ValidationError[]

  /**
   * A stable schema-declaration ordinal for `key`, assigned on first sight.
   * `form.meta.errors` sorts by it, so the aggregate is a function of the SET
   * of errors present rather than of the order their Map keys were last `set`.
   * The construction seed walks every leaf of the schema's slim default;
   * runtime paths (a second DU variant, a dynamic array index, a refine
   * targeting a cross-field path) take first-encounter ordinals and keep them
   * for the form's lifetime.
   */
  ensurePathOrdinal(key: PathKey): number

  // --- DOM ---
  /**
   * The store's DOM slice, `null` until the directive cluster or `useRegister`
   * arms it through `RegisterValue.ensureDomBinding`. Element registration,
   * host anchors and first-error focus resolution live behind it; eager
   * readers treat `null` as an empty registry.
   */
  readonly domBinding: ShallowRef<AttaformDomBinding | null>
  /**
   * Field-record connect transition, driven by the DOM binding on element
   * attach or host connect, and by the SSR-only
   * `markConnectedOptimistically`. Sets `connected: true` and lifts
   * `focused` / `blurred` from `null` to optimistic booleans only while they
   * are null, so a boolean from an early focus event is never clobbered.
   */
  noteDomConnected(path: Path): void
  /**
   * Field-record disconnect transition, driven by the DOM binding when a
   * path's last element detaches or its host disconnects. `connected: false`,
   * and `focused` / `blurred` back to `null`, since those describe an element
   * that no longer exists. Interaction history stays.
   */
  noteDomDisconnected(path: Path): void
  /**
   * `meta.instance` carries per-`useForm()`-instance overrides for
   * `validateOn` / `debounceMs`, so the blur trigger honours the caller's own
   * config when sibling instances share a FormStore.
   */
  markFocused(
    path: Path,
    focused: boolean,
    meta?: { readonly instance?: WriteMeta['instance'] }
  ): void
  /**
   * Flip the sticky `interacted` bit on a leaf. Driven by the directive's
   * input listeners through `RegisterValue.markInteracted`. Idempotent, and
   * never set by a programmatic write.
   */
  markInteracted(path: Path): void
  /**
   * Walk every active-variant leaf under `segments` and flip `touched: true`.
   * Powers `form.touch(path?)`. Idempotent, and touches neither value nor
   * `focused` / `blurred`, nor does it trigger validation.
   */
  touchAtPath(segments: Path): void
  /**
   * Walk every active-variant leaf under `segments` and flip the whole
   * interaction ladder (`touched` / `interacted` / `blurredAfterInteraction`),
   * as though the user had focused, edited and left each one. Powers
   * `form.interact(path?)`. Idempotent, and leaves value / `focused` /
   * `blurred` alone. Returns whether any leaf resolved, so the caller can skip
   * validation and dev-warn on an empty path.
   */
  interactAtPath(segments: Path): boolean
  /**
   * SSR-only optimistic mark: `connected: true` with no DOM element behind it.
   * The `vRegisterHintTransform` compile-time transform calls it through
   * `RegisterValue.markConnectedOptimistically()` for every element rendered
   * with `v-register`. Idempotent, and a no-op on the client, where the
   * directive's `created` hook is authoritative.
   */
  markConnectedOptimistically(path: Path): void

  // --- derived ---
  /**
   * Pristine verdict for a path whose canonical key the caller already holds.
   * `key` is required and must correspond to `segments`; skipping the
   * `canonicalizePath` round-trip is what lets a descendant walk, whose Map
   * iteration already yields the key, avoid a canonicalize per leaf.
   */
  isPristineAtPathByKey(key: PathKey, segments: Path): boolean
  /**
   * Whether any tracked array under `path` has changed shape (a reorder,
   * insert or removal) against its construction / reset baseline. The
   * structural half of `dirty`: per-element baselines travel with their
   * element across a mutation, so a positional value comparison alone cannot
   * see the shape change.
   */
  hasStructuralChangeUnder(path: Path): boolean
  /**
   * Whether a baseline-present container under `path` was replaced wholesale
   * by a non-container (`setValue('profile', undefined)` and the like) and is
   * still absent. The other half of removal-driven `dirty`: every leaf in such
   * a subtree vanishes at once, so neither the present-leaf walk nor the array
   * tracker sees the loss. Self-filters by current liveness, so a refilled
   * path stops counting.
   */
  hasRemovedSubtreeUnder(path: Path): boolean
  getFieldRecord(path: Path): FieldRecord | undefined

  /**
   * Cancel every in-flight field-level validation run: clear the timers of
   * debounced 'change' runs that have not fired, and latch `aborted` on runs
   * whose async parse is in flight. Called by `handleSubmit` at entry, where
   * submit validation is authoritative, and by `reset()`.
   */
  cancelFieldValidation(): void

  /**
   * Open an async-transform run at `key`: bump the run token, increment the
   * in-flight counters, stamp `transformingSince`, clear any prior
   * `transformError` and register `holder` for a later abort. Returns the run
   * token. See `InternalRegisterValue.beginTransform`.
   */
  beginTransform(key: PathKey, holder: TransformAbortHolder): number
  /** `true` while `token` is the live async-transform run at `key`. */
  isCurrentTransform(key: PathKey, token: number): boolean
  /**
   * Close the run `token` at `key`: release the counters, a no-op when a
   * supersede or cancel already released them, and flush settled
   * `settleTransforms` waiters.
   */
  endTransform(key: PathKey, token: number): void
  /** Record a per-field normalization failure at `key` (`field.transformError`). */
  setTransformError(key: PathKey, err: Error): void
  /**
   * Path-scoped counterpart to `cancelTransforms`: abort + release only
   * the runs at-or-under `prefix`, clearing their `transformError`.
   * Called by `resetField`.
   */
  cancelTransformsUnder(prefix: Path): void
  /**
   * Resolve once async transforms are quiescent, either form-wide (`path`
   * omitted) or at and under `path`. Resolves, never rejects. See
   * `UseFormReturnType.settleTransforms`.
   */
  settleTransforms(path?: string | Path): Promise<void>

  /**
   * Kick off, or schedule, a field-level validation run for `path`. Pass `[]`
   * for whole-form scope, where `applySchemaErrorsForSubtree` replaces every
   * schema-side entry with the adapter's full response. That is the road the
   * construction-time async-refine seed takes.
   *
   * `immediate: true` skips the debounce window and calls the adapter on the
   * next microtask; one-shot triggers use it, while the per-keystroke writers
   * pass `false` so rapid mutations coalesce under `debounceMs`.
   *
   * `instance` carries per-`useForm()`-instance overrides for `validateOn` and
   * `debounceMs`, so sibling instances sharing a FormStore each validate on
   * their own cadence.
   */
  scheduleFieldValidation(path: Path, immediate: boolean, instance?: WriteMeta['instance']): void

  /**
   * Subscribe to every `applyFormReplacement`. Fires synchronously once
   * `form.value` holds `next` and all field / originals bookkeeping has run,
   * which is how undo/redo hooks the single mutation funnel. `meta` carries
   * the originating call site's intent and can be ignored. Returns an
   * unsubscribe function.
   */
  onFormChange(listener: (next: F, meta?: WriteMeta) => void): () => void

  /**
   * Subscribe to successful submissions. Fires once the consumer's `onSubmit`
   * callback has resolved, so neither a validation failure nor a callback
   * throw reaches it. The DevTools panel rides it to surface a submit event.
   * Returns an unsubscribe function.
   */
  onSubmitSuccess(listener: () => void): () => void

  /**
   * Subscribe to `reset()`. Fires after reset has replaced the form and
   * cleared errors and lifecycle, so a listener sees the post-reset state.
   * The history module uses it to drop the undo/redo stack. Returns an
   * unsubscribe function.
   */
  onReset(listener: () => void): () => void

  /**
   * Notify submit-success subscribers. `handleSubmit` in `process-form.ts`
   * calls it once the consumer callback has resolved. Not for consumer use.
   */
  emitSubmitSuccess(): void

  /**
   * Register a teardown bound to the FormStore's own lifetime rather than to a
   * consumer's Vue effect scope; `dispose()` runs it when the last consumer
   * unmounts. The history wiring needs this, so its subscribers survive one
   * consumer unmounting while others remain.
   */
  registerCleanup(fn: () => void): void

  /**
   * Cache for per-state modules, chiefly history, that must outlive any single
   * consumer. Later `useForm` / `injectForm` calls for the same key read from
   * here, so the public API shape does not depend on mount order. Keyed by a
   * caller-owned string such as `'history'`.
   */
  readonly modules: Map<string, unknown>

  /**
   * Whether schema-driven coercion runs for this form, `false` only when the
   * consumer passed `useForm({ coerce: false })`. `buildCoerceFn` reads it at
   * `register()` time to bake the per-path closure on `RegisterValue.coerce`.
   */
  readonly coerceEnabled: boolean

  /**
   * Tear down the non-reactive resources this FormStore owns. The registry
   * calls it when the last consumer unmounts: pending field-validation timers
   * are cancelled, every subscriber is dropped, and each `registerCleanup`
   * hook fires.
   */
  dispose(): void
}

/**
 * Hydration payload accepted by `createFormStore`. When present, the initial
 * form value comes from here rather than from `schema.getDefaultValues`, which
 * is how SSR state replays on the client. Originals are rebuilt from the
 * schema, since they are not serialised.
 */
export type FormStoreHydration = {
  readonly form: unknown
  /** Schema-side errors, replayed at construction ahead of the normal seed. */
  readonly schemaErrors: ReadonlyArray<readonly [string, unknown]>
  /**
   * User-side errors, replayed at construction, so server-side `setErrors`
   * calls round-trip through hydration.
   */
  readonly userErrors: ReadonlyArray<readonly [string, unknown]>
  readonly fields: ReadonlyArray<readonly [string, unknown]>
  /**
   * Paths that were in `blankPaths` at SSR time, replayed on the client so
   * "displayed empty" survives the round-trip. Arrives DOTTED, because
   * `serialize.ts` converts at the wire boundary to match public path
   * notation.
   */
  readonly blankPaths?: ReadonlyArray<string>
}

export type CreateFormStoreOptions<F extends GenericForm, G extends GenericForm = F> = {
  readonly formKey: FormKey
  readonly schema: AbstractSchema<F, G>
  readonly defaultValues?: DeepPartial<WriteShape<F>> | undefined
  readonly hydration?: FormStoreHydration | undefined
  /**
   * When per-field validation runs. Default `'change'`. See `ValidateOn`. The
   * `ValidateOnConfig` discriminated union stays at the public `useForm`
   * boundary; the store takes the resolved fields directly.
   */
  readonly validateOn?: ValidateOn | undefined
  /** Per-field debounce under `validateOn: 'change'`. Default `0`, disabled. */
  readonly debounceMs?: number | undefined
  readonly ssr?: boolean | undefined
  /**
   * Canonical path keys to seed `blankPaths` with at construction, produced by
   * `useAbstractForm`'s `unset`-symbol pre-pass. Consulted only when
   * `hydration` is absent, since a hydration payload's own `blankPaths` wins.
   */
  readonly initialBlankPaths?: ReadonlyArray<PathKey> | undefined
  /**
   * Whether to remember per-variant typed state across discriminated-union
   * switches. Default `true`. See `UseFormConfiguration.rememberVariants`.
   */
  readonly rememberVariants?: boolean | undefined
  /**
   * Raw `disabled` config (boolean, ref, computed, getter or undefined),
   * unwrapped live by `toValue` inside `FormStore.effectiveDisabled`. It stays
   * raw rather than resolving at merge time so a reactive source keeps
   * tracking. See `UseFormConfiguration.disabled`.
   */
  readonly disabled?: MaybeRefOrGetter<boolean | undefined> | undefined
  /**
   * Schema-driven coercion switch, resolved once at construction and cached on
   * `FormStore.coerceEnabled`. See `UseFormConfiguration.coerce`.
   */
  readonly coerce?: boolean | undefined
  /**
   * SSR prefetch coordination, bound at `buildFreshState` time and omitted on
   * the client, where the queue is never read.
   *
   * `enqueue()` records this form's key on the registry's prefetch set, so
   * every activation path (an explicit `form.activate()`, a gated read through
   * the public surface, a recursive factory read) signals intent to the SSR
   * drain.
   *
   * `shouldFire()` says whether `activate()` should fire the captured factory
   * on the server. The wizard's `registry.skipPrefetch(key)` for a non-current
   * step flips it to `false` even after `enqueue()`, so the render-efficiency
   * skip survives a stray `form.activate()` or a transform mark on a skipped
   * step. Any form the wizard has not skipped gets `true`, plain-value forms
   * included, where the factory branch is skipped regardless.
   */
  readonly ssrPrefetch?:
    | {
        enqueue: () => void
        shouldFire: () => boolean
      }
    | undefined
}

/**
 * `true` when `existingKey` names a path strictly nested under `parentPath`:
 * every parent segment shared, and at least one more of its own.
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
 * Walk `data` and collapse every object that sits at a discriminated union but
 * carries a `discriminator` value naming no known variant into a stub holding
 * only the discriminator key. First-variant fields that slipped past the
 * parser are dropped, so the form value matches the schema's own view of "no
 * variant selected yet".
 *
 * Pure by design: schema, data, base path and warning policy are all
 * parameters, never closure captures, so construction (over the authored
 * defaults) and the runtime variant transitions can share it without sharing
 * state across calls.
 *
 * Untrusted SSR hydration payloads flow through the same walker, so every key
 * write goes through `safeAssign`, which lands `__proto__` as an own data
 * property and bracket-assigns everything else. A field genuinely named
 * `prototype` / `constructor` / `__proto__` round-trips like any other.
 *
 * `warn: true` opts into a dev-only one-shot warning per
 * `(dotted-path, disc-value)` when a non-blank discriminator falls back to a
 * stub, which catches the typo case (`kind: 'BAD'`). The blank literals
 * `''` / `0` / `0n` / `false` / `null` are `expandUnsetAt`'s deliberate
 * "no variant selected" signal and never warn.
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
  if (Array.isArray(value)) {
    return value.map((item, i) => walkDuStubs(schema, item, [...path, i], warned))
  }
  // Descend into plain records only. A DU variant always is one, and the
  // key-by-key rebuild below reaches own enumerable properties only, so a
  // `File`, `Blob`, `URL` or any other class instance would come back as an
  // empty `{}`. Testing the prototype covers every such type, which an
  // enumerated type list cannot (#542). Same guard as `stripSymbolsDeep`.
  if (!isPlainRecord(value)) return value
  const rec = value as Record<string, unknown>
  const du = schema.getUnionDiscriminatorAtPath(path)
  if (du !== undefined) {
    const discValue = rec[du.discriminatorKey]
    if (discValue !== undefined && !du.isVariantSelected(discValue)) {
      // A kind-blank stub (`''` / `0` / `0n` / `false` / `null`) is
      // `expandUnsetAt`'s deliberate "no variant selected yet" signal, so it
      // never warns. The warning is for the typo case, `kind: 'BAD'`.
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
      // `safeAssign` so a schema using `z.discriminatedUnion('__proto__', …)`
      // lands the disc value as an own data property rather than invoking the
      // inherited setter.
      const stub: Record<string, unknown> = {}
      safeAssign(stub, du.discriminatorKey, discValue)
      return stub
    }
  }
  // `safeAssign` per key lands a literal `__proto__` segment as an own data
  // property and bracket-assigns the rest, so a hostile payload cannot
  // reassign this container's prototype chain.
  const out: Record<string, unknown> = {}
  for (const k of consumerKeys(rec)) {
    safeAssign(out, k, walkDuStubs(schema, readConsumerProp(rec, k), [...path, k], warned))
  }
  return out
}

/**
 * Recursively drop Symbol-keyed properties from a consumer-supplied value.
 * Form values are string-keyed by schema design, and a symbol at any level
 * would break the variant-memory snapshot and JSON serialization, and surface
 * through `Object.getOwnPropertySymbols(values.x)`.
 *
 * Returns the input unchanged when the tree holds no symbols, allocating only
 * along a spine that contains a stripped node, so the common case is free.
 */
function stripSymbolsDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let mutated = false
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      // Read once: an array index can be an accessor too, and a second read
      // would invoke it a second time.
      const original = readConsumerIndex(value, i)
      const cleaned = stripSymbolsDeep(original)
      out[i] = cleaned
      if (cleaned !== original) mutated = true
    }
    return mutated ? out : value
  }
  // Skip non-plain objects (Date, Map, Set, RegExp, class instances): their
  // semantics are not "key: value" and stripping would corrupt them. Symbols
  // on those are the consumer's concern.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  // Enumeration itself is guarded: a Proxy's `ownKeys` trap runs here and can
  // throw before any property is touched, which per-key guarding cannot catch.
  const symKeys = consumerSymbolKeys(value)
  const stringKeys = consumerKeys(value)
  let mutated = symKeys.length > 0
  const out: Record<string, unknown> = {}
  const src = value as Record<string, unknown>
  for (const k of stringKeys) {
    // Same guard and reason as `unset-walker`'s key loop: a throwing accessor
    // on a consumer value must not escape into the host app. Read once and
    // compare against that read, so a getter with side effects fires once.
    const original = readConsumerProp(src, k)
    const cleaned = stripSymbolsDeep(original)
    out[k] = cleaned
    if (cleaned !== original) mutated = true
  }
  return mutated ? out : value
}

/**
 * Diff the schema's with-defaults data against its blank baseline to find
 * every path where the schema author declared a `.default(...)` chain. A path
 * whose value differs between the two is a position where a declared default
 * takes effect, `.default(undefined)` included: the blank baseline falls
 * through to the inner schema's empty value (`''`, `0`) rather than the
 * wrapper's chosen undefined, so the two still differ.
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
 * One in-flight async-transform run at a path: a `token` drawn from the
 * form-wide `transformTokenSeq`, so a superseded run can never collide with a
 * future one even after its entry is deleted and recreated, plus the
 * directive-owned abort `holder`. `released` guards the count, so a
 * synchronous cancel or supersede is not double-counted by the run's own late
 * `endTransform`.
 */
type TransformRun = { token: number; holder: TransformAbortHolder; released: boolean }

/**
 * The `FormStore` contract plus the internal slots the module-level kernel
 * functions operate on. Every kernel function takes this record as its
 * required first argument, so the store allocates data rather than function
 * bodies, and the `FormStore` methods on it are thin per-instance arrows into
 * the shared module functions.
 */
export type FormState<F extends GenericForm, G extends GenericForm = F> = FormStore<F, G> & {
  // --- resolved configuration (fixed at construction, except
  // `defaultValues`, which the form re-seats as it learns them) ---
  /**
   * The form's CURRENT defaults, and the single source both baselines read.
   * Seeded from `useForm({ defaultValues })`, then re-seated by `reset(next)`
   * and by the async-defaults factory. Mutable on purpose: pinned to the
   * construction argument, the reset baseline and the dirty baseline drift
   * apart, and a `reset()` after a `reset(next)` rolls the form back across a
   * save while reporting `dirty: false` over the stale values (#576).
   */
  defaultValues: DeepPartial<WriteShape<F>> | undefined
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
   * Per-form DU capability flag, taken once at construction from
   * `schema.hasDiscriminatedUnions?.()`, where an absent method reads as
   * `true` and the conservative per-write probes stay on. `false` skips the
   * cross-variant ancestor guard, the variant-reshape dispatch and the
   * construction-time stub correction outright.
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
// Both establish a pristine baseline. The steps they genuinely share live in
// the helpers below so the two paths cannot drift; the mode-specific work
// (field-record seeding against history-flag clearing, hydration replay
// against lifecycle teardown) stays at each call site.

/**
 * The effective baseline for `source`: consumer `defaultValues` at
 * construction, `nextDefaultValues ?? defaultValues` at reset. Sparse
 * constraints pre-merge through `mergeStructural` BEFORE `getDefaultValues`,
 * so a partial constraint against a tuple shape (`coords: [42]` for
 * `z.tuple([_, _, _])`) is padded with position defaults before the adapter's
 * validate-then-fix loop sees it, and the adapter's verdict is rendered
 * against the filled form. That is what keeps the construction and reset
 * responses byte-equivalent for one source.
 */
function computeBaselineResponse<F extends GenericForm, G extends GenericForm = F>(
  schema: AbstractSchema<F, G>,
  source: DeepPartial<WriteShape<F>> | undefined
): SchemaDefaultsResult<F> {
  const completed =
    source === undefined
      ? undefined
      : (mergeStructural(schema, [], source) as DeepPartial<WriteShape<F>>)
  return schema.getDefaultValues({
    useDefaultSchemaValues: true,
    constraints: completed,
  })
}

/**
 * Initial value of the `firstValidationDone` gate, shared by the ref's
 * construction seed and `reset()`'s restore so both windows gate container
 * `.valid` the same way. Only async-validating schemas need it; see
 * `FormStore.firstValidationDone`.
 */
function initialFirstValidationGate<F extends GenericForm, G extends GenericForm = F>(
  schema: AbstractSchema<F, G>
): boolean {
  return schema.needsAsyncValidation?.() !== true
}

/**
 * Rebuild `originals` from a fresh baseline value tree. `diffAndApply` visits
 * every leaf in declaration order, so construction's `ensureOrdinals: true`
 * gets `pathOrdinals` in schema-declaration order out of the same walk.
 * `reset()` passes `false`: ordinals never reset, so a path a reset baseline
 * introduces keeps the lazy first-encounter assignment and its slot for the
 * form's lifetime.
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
 * Queue the one-shot full-form pass that surfaces async-only verdicts
 * (`.refine(async (v) => ...)` and the like), which the sync
 * `getDefaultValues` contract cannot produce. Shared by construction and
 * `reset()`.
 *
 * Two gates. SSR skips entirely, because microtasks are not awaited before
 * `renderToString` serialises, so firing would stamp a `validating: true` into
 * the HTML that the client's hydration pass never reproduces. And
 * `queueMicrotask` puts the increment after Vue's synchronous hydration and
 * first render. Restricted to schemas that need async work, since a sync-only
 * schema would pay the microtask and flash `meta.validating: true` while
 * nothing is running.
 */
function queueInitialAsyncValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  if (!st.ssr && st.schema.needsAsyncValidation?.() === true) {
    queueMicrotask(() => scheduleFieldValidation(st, [], true /* immediate */))
  }
}

/**
 * Rebuild `authoredPaths` from a fresh constraints baseline and the schema
 * defaults. Construction and `reset()` both replace the form's pristine
 * reference, so the authoring set has to follow. Idempotent: clear, then
 * repopulate from the constraints argument and from a diff of the schema's
 * with-defaults data against its blank baseline.
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
  // The diff needs only the schema's BLANK baseline value tree, every
  // `.default()` skipped, not a validated parse of it. `getEmptyValueAtPath`
  // is the raw walk, structurally identical here to a slim-mode
  // `getDefaultValues({ useDefaultSchemaValues: false })` because the blank
  // tree round-trips through the slim parse unchanged, and it skips that
  // pass's schema clone and double `safeParse`. Locked by
  // `test/core/authored-baseline-equivalence.test.ts`.
  const slimBaseline = st.schema.getEmptyValueAtPath([])
  walkAuthoredFromSchemaDiff(schemaWithDefaultsData, slimBaseline, [], st.authoredPaths)
}

/**
 * Drop schema verdicts at preprocess / coerce leaves whose storage is
 * undefined and whose path the consumer never authored. Form-level errors
 * (`path.length === 0`) and verdicts at paths with real storage always pass.
 * The mount and field-validation pipelines filter; `handleSubmit` does not,
 * because submit is the moment "you must have supplied all fields" applies and
 * every verdict should be visible.
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

// FieldState.key. An array element carries an allocated identity token that
// travels with it across structural mutations, so a keyed `v-for` survives
// reorders. Every other path is empty: a record entry's stable identity is its
// own key, surfaced through `form.record`.
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

function pathHasAsyncValidationByKey<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  segments: Path
): boolean {
  const cached = st.pathAsyncCache.get(key)
  if (cached !== undefined) return cached
  // `getSchemasAtPath` returns every candidate sub-schema, DU variants and
  // intersections included. Async work in any one of them makes the prefix
  // "could be async", so gate conservatively. An adapter that does not
  // implement `needsAsyncValidation` reads as `false`, per the optional-method
  // contract on AbstractSchema.
  const candidates = st.schema.getSchemasAtPath(segments)
  const hasAsync = candidates.some((sub) => sub.needsAsyncValidation?.() === true)
  st.pathAsyncCache.set(key, hasAsync)
  return hasAsync
}

function incFieldValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey
): void {
  // Stamp `validatingSince` BEFORE bumping the count, so the two signals never
  // disagree mid-flight. The count drives `field.validating`, and so clamps
  // `field.valid` false for the run; `validatingSince` is what the display
  // reducer reads to tell settled from in-flight. With the count leading, a
  // synchronous reader landing between the two writes would see
  // `validating: true, validatingSince: null`, read the run as settled, and
  // return the clamped in-flight verdict, flashing idle at the start of every
  // re-validation. Stamping first makes `validatingSince !== null` an outer
  // bracket around `count > 0`, since `decFieldValidation` clears it only after
  // the count reaches 0.
  //
  // Re-anchored on every run start rather than on the 0 -> 1 edge; see
  // `FormStore.fieldValidatingSince` for why. `ssr` never reaches here in
  // practice, because no field validation is scheduled server-side, and the
  // `0` keeps the stamp clock-free.
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
    // The trailing edge of `incFieldValidation`'s bracket: clear the count
    // first, so `field.valid` is accurate again, and only then drop the
    // anchor. A reducer that sees `validatingSince === null` is therefore
    // always looking at a settled `valid`. Holds across every abort, cancel
    // and migrate path that releases a count.
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
  // Stamp before bump, the same bracket invariant as `incFieldValidation`, so
  // a reader landing between the two writes never sees a run as settled while
  // the field still reads `transforming`.
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

// Resolve every queued `settleTransforms` waiter that has gone idle: a keyed
// waiter when its path count hits 0, a global waiter when `activeTransforms`
// does. Re-checks live state per waiter, so any edge back to 0 can call it.
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
// controller if the chain ever reached for `ctx.signal`, and release the
// counters. Idempotent through `released`, so a supersede or cancel and the
// run's own late `endTransform` cannot double-count. The map entry is the
// caller's to remove.
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
  // Supersede: a new input at the same path aborts and releases the prior run
  // synchronously, keeping `field.transforming` about the live run only and
  // the per-path count at 0 or 1, and then this run opens.
  const prior = st.transformRuns.get(key)
  if (prior !== undefined) releaseTransformRun(st, key, prior)
  const token = ++st.transformTokenSeq
  st.transformRuns.set(key, { token, holder, released: false })
  incFieldTransform(st, key)
  st.activeTransforms.value += 1
  // A fresh run supersedes the prior verdict, so drop any stale error and let
  // a recovered input stop showing the last failure.
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
  // Only the live run releases the counters and clears the entry. A superseded
  // or cancelled run, whose token no longer matches or which is already
  // released, was released at teardown, so its late `endTransform` does
  // nothing but flush waiters.
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
  // A cleared form starts from a clean transform slate, so drop normalization
  // failures that have no in-flight run of their own.
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
    // `focused` / `blurred` need an explicit-undefined guard: a patch
    // legitimately carries `null` to mark a disconnect, and `??` would
    // short-circuit on it and fall through to `current`, losing the intent.
    focused: patch.focused !== undefined ? patch.focused : (current?.focused ?? null),
    blurred: patch.blurred !== undefined ? patch.blurred : (current?.blurred ?? null),
    // `touched` is a plain boolean, so `??` is equivalent to the guard above.
    touched: patch.touched ?? current?.touched ?? false,
    // `interacted` is sticky-true and a merge patch only ever sets it, so `??`
    // preserves the current bit. Only the reset paths clear it, and they
    // reconstruct the record outright.
    interacted: patch.interacted ?? current?.interacted ?? false,
    blurredAfterInteraction:
      patch.blurredAfterInteraction ?? current?.blurredAfterInteraction ?? false,
  })
}

// Shared commit tail for every value mutation: stamp per-leaf field metadata
// from the captured patches, then notify change listeners. A runtime-added
// path (`append('posts', {...})` introducing an array index) takes `undefined`
// as its baseline, because appearing IS a mutation and only `reset()`
// rebaselines the originals map. Listeners fire after the bookkeeping so they
// see a fully updated form, their throws are isolated so one bad subscriber
// cannot block the rest, and `meta` carries the call site's intent.
function commitWritePatches<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  patches: readonly Patch[],
  meta?: WriteMeta
): void {
  const now = new Date().toISOString()
  for (const patch of patches) {
    const { key } = canonicalizePath(patch.path)
    if (!st.originals.has(key)) {
      // No baseline at a path a write just touched means the path was absent
      // at construction, whatever KIND the diff called the patch, so absence
      // is its baseline and its first appearance is a change.
      //
      // Keyed on the missing baseline rather than on `kind === 'added'`
      // because the two disagree for a key named after an `Object.prototype`
      // member: `Object.keys` never lists an inherited member but a plain read
      // resolves one, so a first write to a `__proto__` entry diffs as a
      // change FROM `Object.prototype` instead of as an appearance, and the
      // field reads `dirty: false` the instant it is written.
      st.originals.set(key, { segments: patch.path, value: undefined })
    }
    touchFieldRecord(st, key, patch.path, { updatedAt: now })
    // Offer the path to the liveness sweep. Every value mutation passes
    // through this tail, so it is where a runtime-added path becomes known to
    // the store, and the only place that can make the store's own maps
    // sweepable. The sweep ignores a path the schema shape bounds, and its
    // pass runs in the listener flush below, after this loop, so a path
    // written on this very write is live when it is checked.
    st.pathSweep.track(patch.path, key)
    // And the containers on the way to it. A diff yields LEAF patches, so a
    // container path (`rows.0`) is never a patch of its own and would be
    // tracked by nothing, which is what leaves `authoredPaths` holding an
    // entry per row after the rows are gone. `track` rejects ancestors a fixed
    // object shape bounds, so only the genuinely unbounded ones, through an
    // array index or a record key, cost anything, and re-offering a tracked
    // path is a Set lookup.
    for (let i = 1; i < patch.path.length; i++) {
      const ancestor = patch.path.slice(0, i)
      st.pathSweep.track(ancestor, canonicalizePath(ancestor).key)
    }
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
  // Capture the diff before any mutation lands. `commitWritePatches` needs the
  // per-leaf patches against the OLD shape, and `applyChangedKeys` consumes
  // the same list to pick which keys to reassign, so a replacement pays
  // exactly one content walk.
  const patches: Patch[] = []
  diffAndApply(prev, next, [], (patch) => {
    patches.push(patch)
  })
  // Mutate `form.value` in place, so Vue's deep-reactivity deps fire only for
  // the first-level keys whose subtree changed. A wholesale
  // `form.value = next` fires every deep watch, unchanged subtrees included,
  // which freezes the browser tab when a watcher reacts by writing back to the
  // form: the canonical "same as pickup address" mirror pattern.
  //
  // A top-level shape mismatch (object to array) falls back to wholesale
  // replacement, the one case where in-place merging cannot preserve the
  // existing reactive proxies anyway.
  //
  // The typed array helpers thread the mutated array's path as `arrayOpPath`,
  // and on those writes a changed container-valued key reconciles in place,
  // holding references stable for the mutated array and for every ancestor
  // container on the way to it, at any depth. So a reorder fires only the
  // moved indices and a nested-array append re-renders only that list. Any
  // other replacement (null `arrayOpPath`: explicit setValue, reset,
  // undo / redo, hydration, DU reshape) reassigns changed keys wholesale, so a
  // container target gets a fresh reference.
  if (!applyChangedKeys(prev, next, arrayOpPath, [], patches)) {
    st.form.value = next
  } else if (
    patches.some(
      (p) => p.path.length > 0 && typeof p.path[0] === 'string' && isShadowedKey(p.path[0])
    )
  ) {
    // A root-level prototype-shadowed key (`hasOwnProperty`, `toString`,
    // `valueOf`) changed. Its reactive readers descend through `safeOwnRead`,
    // which uses `Object.getOwnPropertyDescriptor` and so bypasses Vue's
    // get-trap: they registered no per-key dependency and ride on this ref's
    // own dep alone. `applyChangedKeys` mutated the slot in place and kept
    // root identity stable, so `form.value` was never reassigned. Fire the ref
    // to wake them. This is the coarse whole-ref signal the shadowed-descent
    // path documents as its reactivity mechanism, and it fires only for a
    // write touching a root-level shadowed field; every ordinary field keeps
    // its fine-grained per-key dep.
    triggerRef(st.form)
  }
  commitWritePatches(st, patches, meta)
}

// Public whole-value replacement (history restore, reset, hydration, DU
// reshape, devtools, tests). Threads a null array path, so the reconcile
// reassigns changed keys wholesale and a container target gets a fresh
// reference. Only the targeted array-helper write opts into the
// stable-reference container reconcile, through `applyFormReplacementWithPath`.
function applyFormReplacement<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  next: F,
  meta?: WriteMeta
): void {
  applyFormReplacementWithPath(st, next, meta, null)
}

// Fast path for a single `setValue` whose target leaf already exists: mutate
// that leaf's slot in place at O(depth), preserving every ancestor container's
// identity, then commit the exact per-leaf patches a full-tree diff would have
// emitted. A structural write (a missing intermediate, array growth, a new
// key, a container target, a prototype-shadowed segment) falls back to the
// copy-on-write `applyFormReplacement`, which re-references the grown
// container correctly.
//
// The contract: a container's reference changes IFF the write targets it or
// alters its structure, and a descendant-leaf edit preserves every ancestor
// reference.
function applyTargetedWrite<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  completedValue: unknown,
  meta?: WriteMeta
): void {
  const result = tryInPlaceLeafWrite(st.form.value, path, completedValue)
  if (!result.applied) {
    // A structural write: array growth or reorder, a new key, a container
    // target. For a typed array-helper op (`meta.arrayOp` set), `path` IS the
    // mutated array's canonical path, so thread it and the reconcile keeps
    // every ancestor container on the way to it stable. Any other structural
    // write passes null and reassigns changed keys wholesale.
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
 * The single write funnel: every value mutation lands here, whether from a
 * consumer `setValue`, a directive assign, an array op or a DU variant
 * reshape.
 *
 * Kept whole on purpose. It touches nearly the whole state record, and the
 * ORDER of its phases (slim-primitive gate, DU reshape, structural fill,
 * storage write, then blank / error bookkeeping and the change-listener
 * notify) is the correctness. Splitting it into argument-passed helpers would
 * scatter that ordering across a fan-out of partial writers.
 *
 * Characterization suites pin its observable contracts, not unit tests of its
 * internals: variant-memory restore and nested-DU stub correction
 * (`discriminated-union-variant-switch`, `du-variant-persistence`), blank-path
 * insertion-order stability (`blank-paths-order-stability`), and the same-tick
 * value plus schemaErrors commit (`du-variant-error-flicker`).
 */
function setValueAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  value: unknown,
  meta?: WriteMeta
): boolean {
  // Data-freeze gate. While the form is disabled, by its own config or by a
  // wizard lock, every value write no-ops here, the one chokepoint all three
  // write origins funnel through. The first blocked write dev-warns once and
  // the rest are silent; it never throws. `reset()` and hydration go through
  // `applyFormReplacementWithPath` instead, so a frozen form can still be
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
  // Decode a structural array op into its index permutation exactly once,
  // against the PRE-op array still live at `path`. Everything below derives
  // from this one remap: the fresh-slot scoping (symbol strip, slim gate,
  // structural completion, authoring) reads `remap.fresh`, and the post-write
  // bookkeeping replays the whole permutation.
  let arrayOpRemap: IndexRemap | null = null
  if (meta?.arrayOp !== undefined) {
    const preOpValue = getAtPath(st.form.value, path)
    arrayOpRemap = remapForOp(meta.arrayOp, Array.isArray(preOpValue) ? preOpValue.length : 0)
  }
  // Drop Symbol-keyed properties before the value reaches the gate, the DU
  // reshape or storage; see `stripSymbolsDeep` for why. On an array structural
  // op only the fresh elements carry consumer input, since the existing ones
  // were stripped when first written and merely shift position here, so strip
  // the new slots rather than deep-walking all N. The field-array helper owns
  // this fresh array copy, which makes the in-place element strip safe, and
  // the slim gate, `mergeStructural` and the authored walk below scope
  // themselves the same way.
  if (arrayOpRemap !== null && Array.isArray(value)) {
    for (const idx of arrayOpRemap.fresh) {
      value[idx] = stripSymbolsDeep(value[idx])
    }
  } else {
    value = stripSymbolsDeep(value)
  }
  // Slim-primitive write gate: every leaf in the value must match the schema's
  // slim primitive set at its sub-path. Refinement-level constraints
  // (`.email()`, `.min()`, enum membership) are a validation concern and are
  // NOT enforced here. See `./slim-primitive-gate.ts`. The gate short-circuits
  // at `z.preprocess` / `z.coerce` wrappers so storage keeps the consumer's
  // raw input, with the schema-side normalizers firing during `safeParse`
  // rather than at the write boundary.
  let slimOk = true
  if (arrayOpRemap !== null && Array.isArray(value)) {
    // Only the freshly-introduced elements carry new leaf values; the rest
    // were gated when first written and only shift position.
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
  // Cross-variant write guard. Walking the path, an ancestor DU whose ACTIVE
  // disc resolves to a known variant not containing the next segment means the
  // write targets an inactive-variant key: `setValue('notify.number', ...)`
  // while the active channel is 'email'. So does an ancestor in stub state,
  // where the disc names no variant. Reject both, so a foreign sibling
  // variant's fields cannot leak into `form.values`.
  //
  // The DU's own disc key stays reachable, since writing it is how a form
  // recovers from stub state, so the guard skips when the next segment IS the
  // disc.
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

  // Latest write wins over the transform channel. The write has cleared the
  // slim gate and the cross-variant guard, so it WILL commit, here or through
  // the DU reshape below or the normal mutation. A committed synchronous write
  // to this path, or to a container above it, supersedes any in-flight async
  // transform at or under it, whose eventual value is now stale. The deferred
  // orchestrator releases its own run before committing, so a transform
  // landing its own value is not caught here. Guarded on `transformRuns.size`
  // so the common no-transforms write stays allocation-free.
  if (st.transformRuns.size !== 0) cancelTransformsUnder(st, path)

  // Discriminated-union variant transitions. Writing a discriminator changes
  // the schema's effective shape at the union's location: old-variant keys
  // (`address` on the email branch) turn foreign the moment `channel: 'sms'`
  // lands, and the new variant's required keys need slim defaults so the
  // errors-as-state pipeline sees the new shape. Two flavours, both routed
  // through `reshapeUnionVariant`:
  //
  //   Case A, a leaf write to the discriminator key
  //   (`setValue('notify.channel', 'sms')`). The parent path is the union and
  //   the new value names a variant directly.
  //
  //   Case B, a wholesale write of the union itself
  //   (`setValue('notify', { channel: 'sms', number: '...' })`). The path is
  //   the union and the consumer's value carries the discriminator, which
  //   layers on top of the matched variant default so consumer keys win.
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
            // The disc value names no variant, so storage at the union path
            // becomes a stub holding only the disc key: prior variant body
            // dropped, no first-variant-default leak. Zod's own
            // `invalid_union_discriminator` at `parentPath` surfaces it.
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
          // The consumer's disc value names no variant. The stub holds only
          // the disc key, and passing no `consumerOverrides` drops their other
          // keys so foreign fields cannot leak into `form.values`.
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
        // A whole-union write with NO discriminator: the form is between
        // selections, so it takes an empty stub and every consumer key is
        // dropped, with no auto-merge into the first variant's default.
        return reshapeUnionVariant(st, path, oldDiscValue, undefined, {}, undefined, meta)
      }
    }
  }

  // Blank bookkeeping. `blank: true` adds the path, the call site declaring
  // "this write represents an empty intent"; any other write removes the exact
  // key. A container write also drops every descendant blank mark under
  // `path`, because replacing `addr` replaces every leaf beneath it and a
  // prior mark at `addr.zip` is now stale. The arrayOp branch skips that
  // sweep: the structural-op bookkeeping downstream relocates per-element
  // marks across the operation's exact permutation, and sweeping ahead of it
  // would delete the marks it needs to carry forward.
  //
  // Both sit BEFORE the identity short-circuit, so a transition that does not
  // change the stored value (typing 0 over a slim-default 0) still updates the
  // display and blank state.
  //
  // The pre-write value is read once here: `form.value` is untouched until the
  // replacement below, so the same read serves the descendant-sweep gate and
  // the identity short-circuit.
  const currentValue = getAtPath(st.form.value, path)
  const pathKey = canonicalizePath(path).key
  if (meta?.blank === true) {
    st.blankPaths.add(pathKey)
  } else {
    if (st.blankPaths.has(pathKey)) st.blankPaths.delete(pathKey)
    // Only a container can have had descendants, so gate the sweep on the
    // PRE-WRITE value being one. A scalar leaf write, the keystroke hot path,
    // has none, and sweeping there scans the whole blank set for nothing at
    // O(F) per write. Clearing a container with null or undefined still
    // sweeps, since `currentValue` was the container, and a root write drops
    // every mark because `isPathKeyUnder` is true at root for any non-empty
    // key.
    if (
      meta?.arrayOp === undefined &&
      (isPlainRecord(currentValue) || Array.isArray(currentValue))
    ) {
      for (const existingKey of [...st.blankPaths]) {
        if (isPathKeyUnder(existingKey, path)) st.blankPaths.delete(existingKey)
      }
    }
  }

  // Authored bookkeeping. A setValue is the consumer authoring `path`, and
  // every sub-path inside `value` when it is a container. The schema-error
  // filter reads this set to tell "no consumer input at this
  // preprocess / coerce leaf" from "consumer wrote undefined here": the second
  // must surface verdicts, the first is the no-value-yet stub the filter
  // exists to suppress. Marking before the identity short-circuit is what
  // covers `setValue('url', undefined)` over an already-undefined leaf.
  const wasAuthoredBefore = st.authoredPaths.has(pathKey)
  if (arrayOpRemap !== null && Array.isArray(value)) {
    // The array container itself is authored, the consumer having written it
    // through a field-array op. Existing elements keep their marks, relocated
    // with the op by the structural-op bookkeeping, so only the fresh elements
    // need a walk.
    if (path.length > 0) st.authoredPaths.add(pathKey)
    for (const idx of arrayOpRemap.fresh) {
      walkAuthoredFromConstraints(value[idx], [...path, idx], st.authoredPaths)
    }
  } else {
    walkAuthoredFromConstraints(value, path, st.authoredPaths)
  }
  const newlyAuthored = !wasAuthoredBefore && st.authoredPaths.has(pathKey)

  // Structural-completeness invariant: every write must leave the form
  // satisfying the slim schema. Two ingress points to fill.
  //   1. The target value, where a consumer partial gets its missing keys and
  //      array elements from the schema's element default via
  //      `mergeStructural`.
  //   2. Intermediate gaps along the path, a missing object property or an
  //      array shorter than the target index, which
  //      `setAtPathWithSchemaFill` fills by asking the schema at each gap.
  // The common case, a write to an existing slot with a complete value, hits
  // no schema lookups at all: `mergeStructural` short-circuits on ref-equal
  // subtrees and the fill walker only queries at gap sites.
  let completedValue: unknown
  if (arrayOpRemap !== null && Array.isArray(value)) {
    // Complete only the fresh elements against the schema element default;
    // the rest are structurally complete from prior writes. Mutating the
    // caller's fresh array copy in place is safe, since the field-array helper
    // builds and hands it off exactly once.
    for (const idx of arrayOpRemap.fresh) {
      value[idx] = mergeStructural(st.schema, [...path, idx], value[idx])
    }
    completedValue = value
  } else {
    completedValue = mergeStructural(st.schema, path, value)
  }
  // Identity short-circuit. When the path already holds what this write would
  // put there, skip the replacement. Without it, a keystroke producing an
  // unchanged trimmed or cast value (a trailing space into a `.trim` input,
  // which trims to `''` over a form already at `''`) would still hand
  // `form.value` a new identity, Vue would re-render the input, and the
  // `:value` patch (which compares against the live `el.value`, not the
  // previous vnode prop) would overwrite the user's transient whitespace. The
  // spacebar appears broken.
  if (Object.is(currentValue, completedValue)) {
    // One exception to the skip. At a preprocess / coerce leaf, a write that
    // newly authors the path changes what the error filter does with a
    // verdict: earlier passes were suppressed because the path was unauthored,
    // so a fresh pass has to fire for the verdict to surface. Keeping the
    // exception to those leaves preserves the short-circuit for plain
    // primitives, where `setValue('income', 0)` over a mount-time `0` stays a
    // true no-op.
    if (newlyAuthored && st.schema.isPreprocessOrCoerceLeaf(path)) {
      const modeForAuthoringTransition = meta?.instance?.validateOn ?? st.fieldValidationMode
      if (modeForAuthoringTransition === 'change') {
        scheduleFieldValidation(st, path, false /* debounced */, meta?.instance)
      }
    }
    return true
  }
  // For a wholesale array replacement, with no `arrayOp` to follow, anchor the
  // identity baseline at the PRE-write order before `applyTargetedWrite`
  // resizes the array in place. On an array's first track this is the only
  // chance to capture its baseline length: realigning afterwards would anchor
  // the already-resized order, and a shrink on a never-rendered array would
  // read structurally pristine and fail to dirty the form (#420). The
  // post-write realign then advances the current order while the baseline
  // stays put, so the length delta surfaces through
  // `hasStructuralChangeUnder`. Idempotent once the array is tracked, and it
  // mirrors what the `arrayOp` branch gets free from the remap's recorded
  // pre-op length.
  if (arrayOpRemap === null && Array.isArray(value) && Array.isArray(currentValue)) {
    st.arrayIdentity.realign(path)
  }
  applyTargetedWrite(st, path, completedValue, meta)
  // Structural-mutation bookkeeping. The field-array helpers tag each op with
  // an `arrayOp`, and the remap decoded at funnel entry drives one engine
  // pass: per-element state relocation, fresh-element seeding, derived-state
  // eviction (schema verdicts and variant memory), in-flight validation aborts
  // at vacated indices, and the identity replay. It runs after the replacement
  // so it can overwrite the placeholder originals that replacement seeds at
  // shifted destinations with each moved element's true baseline.
  //
  // A raw whole-array setValue clears all memory under the array path instead,
  // because its identity bookkeeping was lost wholesale and memory keyed by
  // absolute index would bleed onto the new occupants of those indices at a
  // future variant switch.
  if (arrayOpRemap !== null) {
    st.arrayBookkeeping.applyStructuralOp(path, arrayOpRemap)
  } else if (Array.isArray(value) && Array.isArray(currentValue)) {
    st.variantMemory.clearUnderPath(path)
    st.arrayIdentity.realign(path)
  } else if (isContainer(currentValue) && !isContainer(value)) {
    // A baseline-present container dropped to a non-container. Record the path
    // so the container dirty check still fires for the vanished subtree; see
    // `removedSubtrees`. Gated on real baseline presence, so an optional
    // section that was empty at construction, then added, then cleared again,
    // lands back at pristine rather than reading dirty.
    if (subtreeHadRealBaseline(st, path, currentValue)) {
      st.removedSubtrees.add(pathKey)
    }
  }
  const effectiveModeAfterWrite = meta?.instance?.validateOn ?? st.fieldValidationMode
  if (effectiveModeAfterWrite === 'change') {
    scheduleFieldValidation(st, path, false /* debounced */, meta?.instance)
  }
  return true
}

/**
 * Replace the union's parent storage with the activated variant's value,
 * atomically. Two flavours fold into one machine.
 *
 *   - `oldDiscValue !== newDiscValue` is a TRUE switch. The outgoing variant's
 *     subtree, deep-cloned, and its blank-path bookkeeping under `parentPath`
 *     snapshot into `variantMemory` keyed by the union's PathKey. Memory is
 *     then consulted for `newDiscValue`: a hit restores the prior typed state,
 *     a miss falls back to `variantDefault`, the adapter's slim default for
 *     the matching `z.object`.
 *   - `oldDiscValue === newDiscValue` is NOT a switch. The reshape was entered
 *     through Case B with a partial whole-union write, so memory is skipped
 *     entirely and `consumerOverrides` merges on top of `variantDefault`.
 *
 * `consumerOverrides` is Case B's whole-union value
 * (`setValue('notify', { channel: 'email', address: 'x' })`). Memory baseline
 * or `variantDefault` first, consumer overrides on top, so a memory-restored
 * `address` survives a partial write that does not name it. Case A passes
 * `undefined`.
 *
 * The resolved value is written directly, because it is already structurally
 * complete, from the adapter's `deriveDefault` or a matching prior snapshot.
 * Routing it through `mergeStructural` would re-add foreign keys from the
 * FIRST variant, since the union's `getDefaultAtPath` falls back to the first
 * option, which is exactly what the reshape exists to clear.
 *
 * Kept whole for the same reason as `setValueAtPath`: committing storage and
 * schema errors in the same tick is the no-flicker mitigation, and no unit
 * test can verify it in isolation. Characterization suites pin it:
 * `du-variant-error-flicker`, `discriminated-union-variant-switch`,
 * `du-variant-persistence`, `blank-paths-order-stability`.
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

  // Snapshot OUTGOING, and deep-clone it. `getAtPath(form.value, parentPath)`
  // hands back a Vue reactive proxy into the live tree, and once the union
  // path is overwritten below that proxy points at an orphaned raw target.
  // `cloneVariantSnapshot` walks the subtree calling `toRaw` at each level and
  // preserves `BigInt`, `Date`, `Map` and `Set` natively, all of which Zod can
  // validate at a leaf. A `JSON.parse(JSON.stringify(...))` cycle crashes on
  // BigInt and silently degrades the rest; `structuredClone` is not a
  // substitute either, since nested reactive children stored as Proxies raise
  // `DataCloneError`. An undefined `oldDiscValue` had no discriminator, so
  // there is nothing to remember.
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
    // Look up INCOMING. The stored value is already a deep clone, so it can be
    // used directly.
    const restored = st.variantMemory.lookupIncoming(parentKey, newDiscValue)
    if (restored !== undefined) {
      baseline = restored.value
      restoredBlanks = [...restored.blankPaths]
    }
  }

  // Layer Case B's consumer overrides on top of the baseline. In Case A the
  // baseline is the final value.
  const layered: unknown =
    consumerOverrides !== undefined
      ? { ...(baseline as Record<string, unknown>), ...consumerOverrides }
      : baseline
  // Stub-correct any nested DU inside `layered` whose disc names no variant. A
  // Case B payload can carry a valid outer disc over a bad inner one
  // (`{ step: 'choose', inner: { kind: 'BAD_INNER', a: 'x' } }`), and without
  // this the inner mixed shape leaks through the reshape. With it, every level
  // ends at either a real variant or a disc-only stub.
  const finalValue: unknown = applyDuStubs(st.schema as AbstractSchema<unknown, unknown>, layered, {
    basePath: parentPath,
  })

  // New blanks, either restored from memory, which keeps the user's explicit
  // blanks and the numeric auto-marks together, or recomputed from the
  // resolved `finalValue` under the mount-time rule. Computed BEFORE the drop
  // loop so the surviving keys are known: `Set.add` on a deleted-then-re-added
  // key re-inserts at the END of insertion order, which would shift
  // `derivedBlankErrors`, and so `form.meta.errors`, on every same-disc
  // reshape even when the post-reshape shape is identical.
  let newBlankPaths: PathKey[]
  if (restoredBlanks !== undefined) {
    newBlankPaths = restoredBlanks
  } else {
    newBlankPaths = []
    walkUnspecified(finalValue, [...parentPath], newBlankPaths)
  }
  const survivingBlankKeys = new Set<PathKey>(newBlankPaths)
  // Drop blank-path bookkeeping under `parentPath`: those paths belong to the
  // OLD variant's leaves and are absent from the new effective shape. Keys in
  // `survivingBlankKeys` are skipped, so the `add` below is a no-op on an
  // existing member and their insertion slots hold.
  for (const existingKey of [...st.blankPaths]) {
    if (isPathKeyUnder(existingKey, parentPath) && !survivingBlankKeys.has(existingKey)) {
      st.blankPaths.delete(existingKey)
    }
  }

  const currentValue = getAtPath(st.form.value, parentPath)
  if (Object.is(currentValue, finalValue)) {
    // Apply the auto-marks even on a no-op: the bookkeeping has to catch up
    // when storage identity matches by coincidence.
    for (const k of newBlankPaths) st.blankPaths.add(k)
    return true
  }
  // `setAtPathWithSchemaFill` rather than plain `setAtPath`, so a write to an
  // array index past the current length pads the positions between with the
  // schema's element default. Otherwise
  // `setValue('events.10', { type: 'text', value: 'far' })` on a length-1
  // array leaves `events[1..9]` as undefined holes, which break downstream
  // iteration and validation.
  const nextForm =
    parentPath.length === 0
      ? (finalValue as F)
      : (setAtPathWithSchemaFill(st.form.value, st.schema, parentPath, finalValue) as F)
  // Sync-validate AHEAD of the form mutation where the schema allows it, so
  // both writes land in one Vue reactive batch and a single render emits the
  // consistent post-reshape state. Otherwise the render queued by
  // `applyFormReplacement` runs before the async validation lands: the
  // active-path filter hides the OLD variant's schema errors, whose leaves
  // have vanished from `form.value`, and the NEW variant's are not written
  // yet, so an empty-errors state flickers between the two meaningful ones.
  //
  // `{ sync: true }` opts into the adapter's sync arm, but the adapter may
  // still return a Promise for schemas where sync is impossible (async
  // refinements, async transforms or pipes). That falls through to the
  // debounced async pipeline.
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
      // Cancel any in-flight async validation here, so a late result cannot
      // clobber the sync write.
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
    scheduleFieldValidation(st, parentPath, false /* debounced */, meta?.instance)
  }
  return true
}

/**
 * Schedule, or immediately kick off, a field-level validation run for `path`.
 * A per-path one-shot `aborted` latch means a new schedule cancels the prior
 * in-flight run at that path, so rapid writes do not pile up concurrent
 * validations.
 *
 * The run reads the value at `path` WHEN THE TIMER FIRES, not at schedule
 * time, which is the right semantics for a debounced change trigger: the
 * latest keystroke is what matters, not whichever value tripped the scheduler.
 */
function scheduleFieldValidation<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  immediate: boolean,
  // The write's per-instance overrides, taken whole. The reads below use `??`,
  // which cannot tell an absent key from an undefined one, so there is no need
  // to rebuild this bag key by key to satisfy `exactOptionalPropertyTypes`.
  instance?: WriteMeta['instance']
): void {
  const effectiveMode = instance?.validateOn ?? st.fieldValidationMode
  if (effectiveMode === 'submit') return
  const effectiveDebounce = instance?.debounceMs ?? st.fieldValidationDebounceMs
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
  // A fresh epoch per schedule, closed over by `run` and re-checked at the
  // commit site, so a later-scheduled run that resolves first keeps its
  // verdict when an earlier-scheduled one resolves after it.
  const myEpoch = ++st.scheduleEpoch

  const run = () => {
    fresh.timer = null
    if (fresh.aborted) return
    // The increments below wake reactive subscribers, including sync watchers
    // on `api.meta.validating` or `api.fields.X.validating`. If one throws,
    // the Promise chain whose `.finally` decrements never starts and the
    // per-path counter leaks: `validating` stays true forever and the mount
    // gate reports a permanently-pending verdict. Roll back whatever
    // succeeded before letting the error propagate.
    let activeIncremented = false
    try {
      st.activeValidations.value += 1
      activeIncremented = true
      incFieldValidation(st, key)
    } catch (err) {
      // `incFieldValidation` is structurally a `Map.set`, so a throw there
      // happened before the entry was written and leaves nothing to undo on
      // the field counter. Only the global increment needs rolling back.
      if (activeIncremented) {
        st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
      }
      throw err
    }
    // Per-keystroke scope. With no container or root refine in the schema,
    // and a schedule at a real path, every verdict the schema can produce
    // lives at the edited subtree or below, so a subtree-scoped pass suffices
    // and each keystroke skips the O(N) whole-form parse. A `true` predicate,
    // or a missing one from an adapter without detection, keeps the
    // conservative whole-form pass so ancestor refines (cross-field equality,
    // sum constraints) re-evaluate against the live value. An empty `path`,
    // from mount, reset or an explicit whole-form call, is whole-form too.
    const subtreeScope = path.length > 0 && st.schema.hasContainerOrRootRefine?.() === false
    const scopePath: Path | undefined = subtreeScope ? path : undefined
    const dataAtScope: unknown = subtreeScope ? getAtPath(st.form.value, path) : st.form.value
    const scopeKey: PathKey = subtreeScope ? canonicalizePath(path).key : ROOT_PATH_KEY
    void Promise.resolve()
      .then(() => st.schema.validateAtPath(dataAtScope, scopePath))
      .then((response) => {
        if (fresh.aborted) return
        // Form-level epoch gate. A later-scheduled run that has already
        // committed wins, so dropping this stale commit is what stops an
        // asymmetric-latency race overwriting the fresher result. `<=` is
        // conservative: counter monotonicity rules equality out in practice,
        // and a re-entrant commit at the same epoch would be a no-op.
        if (myEpoch <= st.lastCommittedEpoch) return
        st.lastCommittedEpoch = myEpoch
        // Record the value this pass validates, so a later blur can recognise
        // an unchanged form and skip. Blur mode only, since the blur guard is
        // the sole reader. It sits in the applied branch, so an aborted run
        // never advances the snapshot and a later blur with nothing committed
        // at this path re-validates rather than skipping against a
        // stale-but-uncommitted anchor.
        //
        // Snapshot scope equals validation scope. Under a subtree-scoped
        // commit only the subtree at `path` takes part in the blur dedup, so
        // cloning the whole form and discarding the unused branches would cost
        // (form size - subtree size) for nothing. The live subtree is read
        // straight from `form.value`, since the post-async write may differ
        // from the `dataAtScope` captured before the await, and only that is
        // cloned. The blur reader subtracts the snapshot's scope segments from
        // the blur path to project back into the stored subtree. Whole-form
        // scope stores the full clone.
        if (effectiveMode === 'blur') {
          const snapshotSource =
            scopePath !== undefined ? getAtPath(st.form.value, scopePath) : st.form.value
          st.pathSnapshots.set(scopeKey, structuralSnapshot(snapshotSource))
        }
        const errors = response.success ? [] : response.errors
        // Drop schema verdicts at preprocess / coerce paths whose storage is
        // undefined and where the consumer authored no starting value. Under
        // the no-write-mutation contract a refine running against the
        // preprocess sentinel for "no value" judges state nobody authored, and
        // suppressing it keeps the construction-time async seed from flickering
        // when the field is first touched. An authored path, whether from
        // `defaultValues` or a schema `.default(...)`, skips the filter: its
        // verdicts are legitimate.
        const filtered = filterAuthoredErrors(st, errors)
        // A subtree-scoped response carries paths relative to the subtree, so
        // restamp them absolute to match the storage convention. A whole-form
        // response is already absolute.
        const restamped: ValidationError[] = subtreeScope
          ? filtered.map((err) => ({
              ...err,
              path: [...path, ...(err.path as Segment[])],
            }))
          : filtered
        applySchemaErrorsForSubtree(st, scopePath ?? [], restamped)
      })
      .catch(() => {
        // The adapter contract forbids throws, so swallow here and keep a
        // misbehaving custom adapter from surfacing as an uncaught rejection.
        // Matches the reactive `validate()` ref's catch branch in
        // `process-form.ts`.
      })
      .finally(() => {
        // Skip the decrements when an external release, such as a path-scoped
        // reset, already did them; otherwise this late `.finally` would
        // double-count against a run rescheduled at the same key. A normal run
        // leaves `released` false and decrements here.
        if (!fresh.released) {
          st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
          decFieldValidation(st, key)
        }
        fresh.settled = true
      })
  }

  // `debounceMs: 0` is the off switch. `setTimeout(fn, 0)` would punt to the
  // next macrotask, and browsers clamp it to about 4 ms besides, which is not
  // what "no debounce" asked for. Run synchronously, like `immediate`.
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
      // The debounce timer has not fired, so `run()` never executed and no
      // counter was incremented. Clear the timer; there is nothing to undo.
      clearTimeout(entry.timer)
    } else if (!entry.settled) {
      // `run()` fired and its chain is in flight. Its own `.finally` will
      // decrement on settle, but the chain can outlive the caller cancelling
      // it (`handleSubmit`, a committing parse). Release the counters here so
      // `meta.validating` reflects the cancel immediately; the late
      // `.finally` clamps its duplicate decrement at zero.
      st.activeValidations.value = Math.max(0, st.activeValidations.value - 1)
      decFieldValidation(st, pkey)
    }
    // A settled entry still in the map, waiting for the next schedule to
    // evict it, already decremented in its own `.finally`.
    entry.aborted = true
  }
  st.fieldValidationState.clear()
}

// Path-scoped counterpart to `cancelFieldValidation`: abort and release only
// the in-flight runs at or under `prefix`, leaving sibling fields alone.
// `resetField` uses it so resetting one field tears down its own validation.
// The count and the streak anchor release in lockstep through
// `decFieldValidation`, preserving the bracket invariant, and each entry is
// marked `released` so a run's late `.finally` cannot double-decrement a run
// rescheduled at the same key. The change-mode restore write that follows
// `resetField`'s call schedules exactly such a run.
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

function dispose<F extends GenericForm, G extends GenericForm = F>(st: FormState<F, G>): void {
  // State-scoped teardowns run BEFORE the listener sets clear, so a module
  // that flushes by emitting one last event from its cleanup does not find an
  // empty set. Each hook is wrapped so one misbehaving module cannot block the
  // others.
  for (const hook of st.cleanupHooks) {
    try {
      hook()
    } catch (err) {
      console.error('[attaform] cleanup threw:', err)
    }
  }
  st.cleanupHooks.length = 0
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
// One tagged store, each path's cell segregating the two sources that can put
// an error there: `schema` is the validation pipeline, `user` is `setErrors`.
// The three channel writers below are the only mutation road. Each replaces
// exactly one side, cells are immutable, and a key exists iff a side is
// non-empty. Derived blank entries stay a read-side synthesis
// (`derivedBlankErrors`), and the merged view is exposed by
// `getErrorsForPath` and the top-level `errors` proxy in
// schema -> blank -> user order.

type ErrorSource = 'schema' | 'user'

const ERROR_SOURCES: readonly ErrorSource[] = ['schema', 'user']

/**
 * Replace one side of the cell at `key` with `entries`, which the caller owns.
 * The other side rides along, and a cell with both sides empty leaves the map.
 * Always sets a FRESH cell object, so Vue's per-key collection dep fires for
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
 * Replace one source's entries wholesale across the form. A cell holding the
 * OTHER source keeps its map slot, since that side must survive and `Map.set`
 * on an existing key updates in place. A cell holding only `src` is deleted
 * first, so a re-written key re-inserts in this pass's entry order.
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
 * Clear one source at `path`, or everywhere when `path` is omitted, which is a
 * whole-channel replace with nothing. A cell whose other side holds entries
 * survives with `src` stripped; one left empty leaves the map.
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
 * Replace the schema side of the subtree rooted at `path` with `entries`,
 * keying each by its OWN absolute path rather than by `path`. Re-validating a
 * container, a DU parent after reshape for instance, then lands every
 * leaf-keyed issue at its canonical store key, so `form.errors.<path>` reads
 * hit and stale entries from a previous variant do not survive.
 *
 * Insertion order is the constraint. `Map.set` on an EXISTING key updates in
 * place and keeps its slot, while a delete followed by a set re-inserts at the
 * END, and `form.meta.errors` iterates in insertion order. So the pass below
 * computes the surviving key set FIRST: only keys that genuinely drop out lose
 * their schema side, and the rest get an in-place swap. Without that, a
 * per-field re-validation would reshuffle the aggregate on every keystroke.
 * User sides ride along untouched.
 */
function applySchemaErrorsForSubtree<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path,
  entries: ValidationError[]
): void {
  // The container being re-validated. A root-scope pass over a schema with a
  // top-level `.refine()` produces an entry at the empty path, which
  // canonicalises to the same key as `parentKey`, so the surviving refine
  // entry and the parent reconcile without rerouting.
  const parentKey = canonicalizePath(path).key
  const grouped = groupErrorsByKey(entries)
  // Drop the parent key's schema side only if not in the new pass.
  if (!grouped.has(parentKey)) setErrorChannelForKey(st, parentKey, 'schema', NO_ERRORS)
  // Drop stale descendants: schema-bearing keys under `path` the new pass does
  // not write, such as DU-variant leaves that disappeared on reshape. A key in
  // `grouped` stays put and the write below updates it in place. The parent
  // key is exempt, handled just above, so a root-scope pass keeps its own
  // refine entry instead of sweeping it into the descendant set.
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
  // Lift `focused` / `blurred` from `null` to optimistic booleans only while
  // they are null, so a reconnect cannot discard DOM truth from an autofocus
  // event that landed before the registration.
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
  // `focused` / `blurred` describe an element, so with none attached they go
  // back to `null`. `touched` is interaction history and survives: a
  // `v-if`'d-away field that was blurred stays touched.
  const { key } = canonicalizePath(path)
  touchFieldRecord(st, key, path, { connected: false, focused: null, blurred: null })
}

function markConnectedOptimistically<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  // On the client the directive's `created` / `beforeUnmount` hooks are
  // authoritative for `connected`, so this is a no-op. SSR is the only place
  // that cannot observe the DOM and needs the upfront hint that the field WILL
  // be wired up after hydration.
  if (!st.ssr) return
  // Idempotent: a second mark for an already-connected path changes nothing,
  // and the lift through `noteDomConnected` never clobbers an existing
  // `focused` / `blurred` boolean, which a `markFocused` landing ahead of the
  // optimistic mark can have set. The server-rendered FieldState then matches
  // the post-hydration optimistic state without flashing from `null` on the
  // first reactive tick, and real focus state lands as soon as the browser
  // fires an event.
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
  // See `markInteracted`: a frozen form records no focus / blur lifecycle, so
  // no stale `blurredAfterInteraction` survives a disable-then-enable toggle.
  // A disabled native input cannot take focus anyway; this covers component
  // hosts and programmatic focus.
  if (st.effectiveDisabled.value) return
  const { key } = canonicalizePath(path)
  const current = st.fields.get(key)
  touchFieldRecord(st, key, path, {
    focused,
    blurred: !focused,
    // `touched` flips true on blur and stays; a focused field keeps whatever
    // it held.
    touched: focused ? (current?.touched ?? false) : true,
    // `blurredAfterInteraction` flips true on the first blur after a value
    // edit and stays. A tab-through blur before any edit leaves it false,
    // since `interacted` is still false, which is what keeps a clean
    // tab-through from arming the gate.
    blurredAfterInteraction:
      !focused && current?.interacted === true ? true : (current?.blurredAfterInteraction ?? false),
  })
  // On blur, `validateOn: 'blur'` fires an immediate validation for this path.
  // Change and submit modes skip it, matching the declared config. Two reasons
  // to run, and otherwise skip.
  //
  //   1. First interactive blur. The user edited the field and is leaving it
  //      for the first time, so its verdict becomes visible now
  //      (`blurredAfterInteraction` flipped above). Run unconditionally: a
  //      snapshot seeded before any interaction, such as the construction pass
  //      over an unauthored initial value whose verdict was filtered out, must
  //      not suppress this first real verdict, even when the value
  //      round-tripped back to where it started.
  //   2. The value changed since the last pass. Skipping an unchanged form
  //      keeps a settled error from flickering through 'pending' on every
  //      refocus, and comparing the value rather than a write count keeps
  //      editing away and back to the last-validated value quiet too.
  const focusMode = meta?.instance?.validateOn ?? st.fieldValidationMode
  if (!focused && focusMode === 'blur') {
    const firstInteractiveBlur =
      current?.interacted === true && current.blurredAfterInteraction !== true
    // Walk from the blurred path up to the root and take the first ancestor
    // scope anything has committed at. The dedup then compares that
    // snapshot's subtree-at-path against the live one, so a sibling-only edit
    // between blurs leaves this path's subtree unchanged and the dedup skips.
    // Under whole-form scope every commit lands at `ROOT_PATH_KEY` and the
    // walk falls through to that one entry; under subtree scope the closest
    // ancestor entry is the scope this leaf was actually validated under.
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
      // Extract the subtree-at-path on both sides. `diffAndApply`'s `prefix`
      // only labels the patch paths it emits, it does not scope the walk, and
      // the extraction is what makes a sibling-only edit between blurs read as
      // unchanged. The snapshot is already scoped to its commit's `scopePath`,
      // whose length is tracked above, so the blur path needs that prefix
      // subtracted before descending into the stored subtree.
      const relPath = path.slice(snapshotScopeLength)
      const snapshotSubtree = getAtPath(snapshot, relPath)
      const liveSubtree = getAtPath(st.form.value, path)
      changed = false
      diffAndApply(snapshotSubtree, liveSubtree, path, () => {
        changed = true
      })
    }
    if (changed) {
      scheduleFieldValidation(st, path, true /* immediate */, meta?.instance)
    }
  }
}

function markInteracted<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  path: Path
): void {
  // A frozen form records no interaction lifecycle. Value writes no-op, so a
  // stray host emit (`setValueFromHost` marks interacted ahead of its gated
  // write) or a direct `rv.markInteracted()` must not arm blur-validation or
  // the reward-early display. Interaction state then survives a
  // disable-then-enable toggle clean.
  if (st.effectiveDisabled.value) return
  const { key } = canonicalizePath(path)
  // Fired per keystroke from the directive's input listeners, so skip the
  // reactive write once the bit is set and only the first edit notifies.
  if (st.fields.get(key)?.interacted === true) return
  touchFieldRecord(st, key, path, { interacted: true })
}

/**
 * Walk every active-variant leaf under `segments` and flip `touched` to
 * `true`. Powers `form.touch(path?)`: a leaf path reaches that leaf, a
 * container path every descendant leaf, and `[]` every leaf in the form.
 *
 * Idempotent, so an already-touched leaf is skipped and notifies nothing.
 * Enumerates `originals`, the schema's leaf set, rather than `fields`, so it
 * reaches leaves that were never mounted, and filters inactive DU-variant
 * leaves through `hasAtPath` against the live form value, the same gate the
 * field-state aggregation walk uses. Touch never marks a leaf the consumer
 * cannot see.
 *
 * Dev-warns when nothing resolves under the path: a typo, an empty container,
 * a dead variant. Writes no value, no `focused` / `blurred`, and triggers no
 * validation.
 */
function touchAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  segments: Path
): void {
  const formValue = st.form.value
  let touchedAny = false
  // `originals` is keyed by the canonical key of each entry's own segments, so
  // the iteration already yields what a `canonicalizePath` here would
  // recompute once per leaf.
  for (const [leafKey, entry] of st.originals) {
    if (!isPathPrefix(segments, entry.segments)) continue
    if (!hasAtPath(formValue, entry.segments)) continue
    touchedAny = true
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
 * interaction ladder (`touched`, `interacted`, `blurredAfterInteraction`) as
 * though the user had focused, edited and left each one. Powers
 * `form.interact(path?)`, whose job is to open the default display gate
 * (`submissionAttempts > 0 || blurredAfterInteraction`) for a subtree without
 * a form-wide submit.
 *
 * `interacted` is the load-bearing bit. Writing only `touched` / `blurred`
 * reproduces the tab-through no-op the gate deliberately ignores, because
 * `markFocused` flips `blurredAfterInteraction` solely on a blur that follows
 * an edit. Setting the ladder outright is what opens the gate through its
 * front door.
 *
 * It writes no `focused` / `blurred`: those are DOM-owned, and `null` is their
 * "no element connected" value. Fabricating a blur on an unmounted leaf would
 * lie about DOM history, and forcing `focused: false` on a leaf the user is
 * typing in would desync the store from the live document. The display gate
 * reads neither, so nothing is lost.
 *
 * Walks `originals` rather than `fields`, so it reaches schema leaves that
 * were never mounted or are `v-if`'d away; the flags are sticky, so such a
 * subtree stays revealed when it remounts. Inactive DU-variant leaves are
 * filtered through `hasAtPath`, matching `touchAtPath`.
 *
 * Returns whether any leaf resolved. Validation is the caller's job, since the
 * store has no awaitable validation handle and `form.interact()` resolves only
 * once the subtree's errors are committed.
 */
function interactAtPath<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  segments: Path
): boolean {
  // A frozen form records no interaction lifecycle, the same guard as
  // `markFocused` / `markInteracted`. Arming the ladder here would survive a
  // disable-then-enable toggle and reveal errors on a subtree the consumer had
  // deliberately taken out of play.
  if (st.effectiveDisabled.value) return false
  const formValue = st.form.value
  let interactedAny = false
  // As in `touchAtPath`, the map key is already this leaf's canonical key.
  for (const [leafKey, entry] of st.originals) {
    if (!isPathPrefix(segments, entry.segments)) continue
    if (!hasAtPath(formValue, entry.segments)) continue
    interactedAny = true
    const current = st.fields.get(leafKey)
    // Skip the reactive write once the whole ladder is set: records are
    // replaced wholesale, so an unconditional `fields.set` notifies for
    // nothing.
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
// Imperative re-fire of the captured function-form `defaultValues` factory. It
// lives on the store so every consumer of the shared key sees one source of
// truth for `hydrating`, and it mirrors the construction-time settle path: the
// factory result merges over the current values through
// `mergeSparseHydration`, applies through
// `applyFormReplacement({ hydration: true })` so the history module can see
// it, and triggers a post-hydration validation sweep. Clears no
// dirty / touched / submit state; chain `form.reset()` for that.

function rehydrate<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): Promise<void> {
  const factory = st.defaultValuesFactory.value
  if (factory === undefined) {
    // Throw synchronously, so the misuse surfaces at the call site rather
    // than at await time.
    throw new Error(
      __DEV__
        ? '[attaform] form.rehydrate(): no defaultValues factory was captured. Configure useForm({ defaultValues: () => ... }) to enable rehydrate.'
        : '[attaform] AF10 attaform.dev/e/af10'
    )
  }
  return fireFactory(st, factory)
}

// Shared kickoff for `activate` and `rehydrate`. Both fire the captured
// factory, mark the form `activated`, and publish the in-flight promise so
// concurrent `activate()` calls join rather than double-fire. The promise
// self-clears on settle, so a later refetch can publish a fresh one. The
// gating flips (`activated`, `hydrating`) publish synchronously before the
// orchestrator runs, so gated readers and `onServerPrefetch`, which awaits the
// composed promise, see a consistent in-flight state.
//
// Splitting the orchestrator into a lazy chunk was measured and declined: the
// cross-chunk overhead outweighed the bytes it moved.
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

// Idempotent activation, and the only road to the captured function-form
// `defaultValues` factory: forms are lazy by default, and the public getters
// and methods call through here so the first reactive interaction fires it.
// Concurrent callers share the in-flight promise, so two SSR consumers reading
// one store await the same fetch. A rejected attempt leaves `activated` true
// and `defaultsResolved` false, and later `activate()` calls are no-ops, so
// reading `form.hydrateError` does not replay the failure. `form.rehydrate()`
// is the explicit replay primitive.
function activate<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): Promise<void> {
  // SSR coordination. Enqueue intent first, so the diff against any wizard
  // skip or transform mark is consistent across resolved, dormant and
  // mid-activation states, and only then consult `shouldFire`: a wizard skip
  // on this key wins even over an explicit consumer `form.activate()`. The
  // closure binds to the registry at construction and is absent on the client,
  // where the queue is never read.
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

// --- Async-defaults adoption ---

// A function-form `defaultValues` IS the consumer's defaults; it just arrives
// late. So the resolved value has to reach `st.defaultValues` and not only the
// form, or `form.reset()` discards the fetched resource for schema-slim values
// (the documented `rehydrate()` then `reset()` chain destroying exactly what
// `rehydrate()` loaded) and `dirty` reads true the instant the factory
// resolves, the fetched values being compared against a baseline that never
// heard of them. Same root cause as #576 on the sync path.
//
// The baseline is seeded from the DEFAULTS, never from the post-merge form
// value. On first activation the two agree and the form settles pristine. On a
// `rehydrate()` over unsaved edits they deliberately diverge: the edits survive
// in the form value, because `mergeSparseHydration` folds the factory result
// over the live form, while the baseline holds the server's version, so `dirty`
// stays true at exactly the paths the consumer has unsaved. Seeding from the
// merged form value would bake those edits into the baseline and report
// `dirty: false` over them, which is the #576 failure itself.
function adoptResolvedDefaults<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  value: unknown
): void {
  st.defaultValues = structuralSnapshot(
    mergeSparseHydration(
      st.defaultValues,
      value,
      st.schema as unknown as Parameters<typeof mergeSparseHydration>[2]
    )
  ) as DeepPartial<WriteShape<F>>
  seedOriginalsFromBaseline(st, computeBaselineResponse(st.schema, st.defaultValues).data, false)
}

// --- Reset ---

function reset<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  nextDefaultValues?: DeepPartial<WriteShape<F>>
): void {
  // `nextDefaultValues` is sparse: it names the paths the caller wants
  // re-seated and says nothing about the rest, so it folds OVER the defaults
  // already in force rather than replacing them. `mergeSparseHydration` is the
  // primitive the activate / rehydrate path uses for the same shape, which
  // keeps both ways of re-seating defaults agreeing on arrays (replaced
  // wholesale) and on discriminated unions (rebased on the incoming variant,
  // not deep-merged into a both-variants ghost). With no argument the current
  // defaults are the source, so a bare `reset()` restores whatever the last
  // `reset(next)` or factory settled on.
  //
  // `computeBaselineResponse` is what construction runs, so the two responses
  // stay byte-equivalent for one source.
  const resetSource =
    nextDefaultValues === undefined
      ? st.defaultValues
      : (mergeSparseHydration(
          st.defaultValues,
          nextDefaultValues,
          st.schema as unknown as Parameters<typeof mergeSparseHydration>[2]
        ) as DeepPartial<WriteShape<F>>)
  // Durable adoption. Left out, the reset baseline stays pinned to the
  // construction argument while the dirty baseline (`originals`, re-seeded
  // below), `resetField` and the blank set all follow `next`, so `reset()` and
  // `resetField(path)` disagree about what "initial" means on the same form in
  // the same instant, and a Discard button rolls the form back across a save it
  // had already made (#576).
  //
  // Snapshotted, so the stored defaults share no structure with what lands in
  // form storage below: `computeBaselineResponse` hands back the source by
  // reference when it is already structurally complete, and `setValue` writes
  // leaves IN PLACE. Without the copy, the first edit to an array or nested
  // object after a reset would mutate the very baseline the next `reset()`
  // restores from.
  st.defaultValues = structuralSnapshot(resetSource)
  const resetResponse = computeBaselineResponse(st.schema, resetSource)
  const next = resetResponse.data
  // Rebuild `authoredPaths` against the post-reset baseline. Reset is a fresh
  // start, so the prior set is wiped and re-derived from the reset's
  // constraints argument and from the schema-default diff.
  rebuildAuthoredPaths(st, resetSource, next)
  // Replace the form in one shot; history still sees it through
  // `formChangeListeners`.
  applyFormReplacement(st, next)
  // Re-anchor array identity baselines to the post-reset shape, so a reorder
  // or removal made before the reset stops reading as a structural change.
  st.arrayIdentity.rebaselineAll()
  // The post-reset value is the new baseline, so any subtree dropped before
  // this reset is no longer a removal to flag.
  st.removedSubtrees.clear()
  // Rebuild originals from the new baseline: it becomes the post-reset
  // pristine reference, so dirty reads false until the consumer mutates again.
  // `ensureOrdinals` stays false, since ordinals never reset.
  seedOriginalsFromBaseline(st, next, false)
  // Blank follows the same merge rule the values do. `originalBlankPaths` is
  // the durable record of which paths the consumer declared blank and
  // `blankPaths` is its live mirror. A path the reset argument NAMES has its
  // membership re-decided by that argument, so it drops out here and the
  // public `reset` wrapper re-adds it if the caller marked it `unset`. A path
  // the argument says nothing about keeps the membership it had. Clearing both
  // sets wholesale instead would drop construction-time blank membership
  // permanently, leaving a later bare `reset()` restoring the values but not
  // the blanks (#576).
  if (nextDefaultValues !== undefined) {
    const mentioned = new Set<PathKey>()
    walkAuthoredFromConstraints(nextDefaultValues, [], mentioned)
    for (const key of mentioned) st.originalBlankPaths.delete(key)
  }
  st.blankPaths.clear()
  for (const key of st.originalBlankPaths) {
    st.blankPaths.add(key)
  }
  // Drop every recorded error, both sides. Reset is a fresh start, so
  // user-injected errors do not survive it, unlike a successful submit.
  st.errorCells.clear()
  // Re-derive the schema side from the post-reset state, mirroring the
  // construction seed. Otherwise reset clears the error store and never re-runs
  // validation, so a form mounted with invalid defaults (empty required
  // strings, say) reads `valid: true` right after a reset that landed it back
  // on those same invalid defaults, and `field.valid`, aggregating over an
  // empty schema side, flips every leaf green.
  if (!resetResponse.success) {
    replaceErrorChannel(st, 'schema', resetResponse.errors)
  }
  // `getDefaultValues` strips refinements before parsing, because it produces
  // usable starting data rather than refinement-level verdicts, so a `.min(1)`
  // or `.email()` failure on the post-reset defaults does NOT surface through
  // the re-derive above. A synchronous full-schema parse against the post-reset
  // value populates those immediately, with no window where step titles flip
  // green between `reset()` returning and the async pass landing. An async-only
  // verdict cannot surface this way, since the adapter returns a Promise; the
  // `queueMicrotask` below covers it.
  //
  // Construction has the same gap, but its flash is invisible: the form mounts
  // before the user is looking and errors land within a microtask.
  const syncResult = st.schema.validateAtPath(st.form.value, undefined, { sync: true })
  if (!(syncResult instanceof Promise) && !syncResult.success) {
    applySchemaErrorsForSubtree(st, [], syncResult.errors)
  }
  // Restore the `firstValidationDone` gate to its construction-time value,
  // through the same primitive that seeds the ref. An async-validating schema
  // starts gated, and the watch on `activeValidations` flips it true after the
  // construction pass. Leaving it true across a reset removes the gate while
  // the errors are cleared and the re-derive above cannot fill them, so every
  // container reads `valid: true` in the window between `reset()` returning and
  // the re-queued async pass landing. That window is long enough to see: the
  // docs-site wizard demo's step titles turn green for well over half a
  // second.
  st.firstValidationDone.value = initialFirstValidationGate(st.schema)
  // Re-queue the async pass through the primitive construction uses, picking
  // up the async-only verdicts the sync pass above cannot reach.
  queueInitialAsyncValidation(st)
  // Clear every field's interaction history under one `now`; see
  // `withClearedHistoryFlags` for which flags clear and which survive.
  const now = new Date().toISOString()
  for (const [pathKey, record] of st.fields) {
    st.fields.set(pathKey, withClearedHistoryFlags(record, now))
  }
  // Clear the submission lifecycle, so the reset surface reports "nothing
  // submitted yet" rather than the prior run's count. The generation counter
  // bumps first, so an in-flight submission's catch block can tell its error
  // write would land on post-reset state and skip it. `activeSubmissions`
  // zeroes unconditionally: the finally block clamps its decrement at zero, so
  // `submitting` stays false afterwards.
  st.submissionGeneration.value += 1
  st.submitting.value = false
  st.activeSubmissions.value = 0
  st.submissionAttempts.value = 0
  st.submitted.value = false
  st.submitError.value = null
  st.departAttempts.value = 0
  // Drop pending field-validation timers and in-flight runs. A write that
  // reached the aborted branch resolves to a no-op, so the error store stays
  // clean after the clear above.
  cancelFieldValidation(st)
  // Abort and release in-flight async transforms too, so a deferred commit
  // from before the reset cannot land on the cleared form: its token goes
  // stale and the resolve discards. Clears `transformErrors` as well.
  cancelTransforms(st)
  // Drop held spinner state, so an in-flight min-visible hold cannot outlive
  // the reset, and clear the streak anchors to match. The cancel above already
  // released the counts; this wipes the parallel map.
  st.displayEngine.clear()
  st.fieldValidatingSince.clear()
  // Reset the per-path blur-dedup snapshots and the epoch counters. After
  // `cancelFieldValidation` no in-flight run can commit, so a late commit
  // cannot race this and re-populate the map. A surviving snapshot would
  // otherwise match a post-reset value that happens to mirror a pre-reset
  // state and skip a revalidation the cleared error stores need.
  st.pathSnapshots.clear()
  st.scheduleEpoch = 0
  st.lastCommittedEpoch = 0
  // Variant memory is UX state, so a fresh start drops it too; otherwise a
  // post-reset switch surfaces variant values from before the reset.
  st.variantMemory.clear()
  // Notify subscribers; the history module clears its stack here. Throws are
  // isolated so one bad subscriber cannot block the others.
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

  // Drop union memory at or under `targetSegments`: it is the user's prior
  // typed state at a discriminator that no longer corresponds to anything
  // live, and keeping it would surface stale variants on a future switch.
  // Memory ABOVE the reset subtree, a union at `notify` for
  // `resetField('notify.address')`, is deliberately kept; its snapshot
  // self-corrects on the next switch-out.
  st.variantMemory.clearUnderPath(targetSegments)

  // Tear down in-flight validation for this subtree BEFORE the restore.
  // Otherwise the run validating the pre-reset value outlives the reset:
  // `validating` stays true on the field and its verdict commits back over the
  // errors cleared below. In change mode the restore write reschedules a fresh
  // run, and the cancel's `released` flag keeps the orphan's late `.finally`
  // off its counters; in blur or submit mode nothing follows and the field
  // rests clean. The subtree's blur-dedup snapshots go too, so a post-reset
  // blur re-validates instead of skipping against a pre-reset anchor.
  cancelFieldValidationUnder(st, targetSegments)
  // Same teardown for async transforms under the reset subtree, so a
  // deferred commit can't land on the just-reset field.
  cancelTransformsUnder(st, targetSegments)
  for (const [snapKey] of [...st.pathSnapshots]) {
    const segs = segmentsForPathKey(snapKey)
    if (segs === null) continue
    if (isPathPrefix(targetSegments, segs)) st.pathSnapshots.delete(snapKey)
  }

  // Storage restore, in order: leaf, then container, then nothing. A direct
  // originals hit means one `setValueAtPath` does it; a miss falls through to
  // the container case, which assembles a subtree from every original under
  // the prefix. When neither matches, as with `resetField('')` (the form-level
  // error path, never a storage slot) or an unknown path, storage is untouched
  // and only the cleanup below runs.
  const leafEntry = st.originals.get(targetKey)
  if (leafEntry !== undefined) {
    const wrote = setValueAtPath(st, targetSegments, leafEntry.value)
    if (!wrote) {
      // Originals come from the construction pipeline, which guarantees
      // primitive-correctness, so a rejected reset write means an upstream
      // invariant broke.
      console.error(
        __DEV__
          ? `[attaform] resetField: leaf write rejected for path '${targetKey}'. ` +
              `Originals contain a value that doesn't satisfy the slim primitive shape. ` +
              `This is a bug in the construction pipeline.`
          : `[attaform] AF11 attaform.dev/e/af11 '${targetKey}'`
      )
    }
  } else {
    // Container case: rebuild the subtree from every original under
    // `targetSegments`, assembling it first and applying it in one
    // `setValueAtPath` so the diff sees a single coherent replacement rather
    // than N mutations. The loop reads `entry.segments` directly, since
    // parsing the Map key would allocate and cost a parse per entry.
    let subtree: unknown = undefined
    let anyMatch = false
    for (const [, entry] of st.originals) {
      const leafSegments = entry.segments
      if (!isPathPrefix(targetSegments, leafSegments)) continue
      if (leafSegments.length === targetSegments.length) continue // would have hit the leaf shortcut
      anyMatch = true
      const relative = leafSegments.slice(targetSegments.length)
      if (subtree === undefined) {
        // Seed the root container type from the first relative segment: a
        // numeric index makes an array, a string key a plain object.
        // `setAtPath` holds to that choice for the rest of the walk.
        subtree = typeof relative[0] === 'number' ? [] : {}
      }
      subtree = setAtPath(subtree, relative, entry.value)
    }
    if (anyMatch) {
      const wroteSubtree = setValueAtPath(st, targetSegments, subtree)
      if (!wroteSubtree) {
        console.error(
          __DEV__
            ? `[attaform] resetField: subtree write rejected at path '${targetKey}'. ` +
                `Originals contain values that don't satisfy the slim primitive shape. ` +
                `This is a bug in the construction pipeline.`
            : `[attaform] AF12 attaform.dev/e/af12 '${targetKey}'`
        )
      }
    }
  }

  // Cleanup runs whether or not storage was restored, clearing errors and
  // field-record flags at the target path AND every descendant. The prefix
  // covers the exact path too, an array being a prefix of itself, so a leaf
  // reset clears its single entry and a container reset sweeps the subtree.
  // That is also what makes `resetField('')` a usable form-level-error wipe:
  // there is no storage at the root error path, but errors live there and a
  // consumer calling `resetField` on it expects them cleared. The same holds
  // for consumer-set errors at any path the schema does not model.
  deleteErrorCellsUnderPrefix(st, targetSegments)
  for (const [fieldKey, record] of Array.from(st.fields.entries())) {
    if (isPathPrefix(targetSegments, record.path)) clearFieldRecordFlags(st, fieldKey)
  }
}

function deleteErrorCellsUnderPrefix<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  prefix: readonly Segment[]
): void {
  // Judge each side by its first entry's embedded path, since entries at a key
  // share that key's path: a side whose entries sit under `prefix` is
  // stripped, the other rides along, and a cell left empty leaves the map.
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
  // Only the interaction-history flags clear, as in `reset()`'s field loop,
  // but with a fresh `now` per path rather than one stamp across the form.
  st.fields.set(pathKey, withClearedHistoryFlags(record, new Date().toISOString()))
}

// --- Derived ---

function isPristineAtPathByKey<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  key: PathKey,
  segments: Path
): boolean {
  // A storage match is necessary but not sufficient: a primitive leaf toggled
  // between "displayed empty" (blank plus slim default) and "explicitly the
  // slim default" holds the same storage value and differs visually. Compare
  // both surfaces against the originals snapshot, so the blank contract
  // dirties when membership diverges.
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

// Did the subtree at `prefix`, whose pre-write value is `removedValue`, hold
// any leaf from the construction / reset baseline: a real recorded value,
// rather than the absence baseline seeded for a runtime-added path? Bounded to
// the subtree being dropped by enumerating its own leaves, so it walks only
// what `setValue` is removing, on the rare container-to-non-container write.
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
    // Skip a recorded path a later write refilled with a container: the
    // present-leaf walk judges that one instead, an identical refill reading
    // pristine and a changed one dirtying, so only a still-absent subtree
    // counts as removed here. Read raw, since the accompanying write already
    // fired the dirty walk's own dep on this path.
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

export function createFormStore<F extends GenericForm, G extends GenericForm = F>(
  options: CreateFormStoreOptions<F, G>
): FormStore<F, G> {
  const { formKey, schema, defaultValues, hydration } = options
  const ssr = options.ssr === true
  const ssrPrefetch = options.ssrPrefetch
  const rememberVariants: boolean = options.rememberVariants !== false
  const fieldValidationMode: ValidateOn = options.validateOn ?? 'change'
  // Sanitise the debounce before it reaches `setTimeout`. `NaN` fires
  // synchronously and defeats the debounce, a negative clamps to 0 as the
  // consumer asking for none, and `Infinity` stalls for about 24.8 days then
  // wraps, so it falls back to the default.
  const fieldValidationDebounceMs = normalizeNumericOption({
    value: options.debounceMs ?? DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS,
    source: 'useForm.debounceMs',
    min: 0,
    defaultValue: DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS,
  })

  // Resolved once per form; `register()` reads it through
  // `state.coerceEnabled` to bake path-scoped coerce closures on each
  // `RegisterValue`.
  const coerceEnabled = resolveCoerceEnabled(options.coerce)

  // State-scoped teardown hooks. History, and any other per-state module,
  // registers its disposer here so cleanup binds to the FormStore's own
  // lifetime, the `dispose()` at registry eviction, not to the first
  // consumer's effect scope.
  const cleanupHooks: (() => void)[] = []
  const modules = new Map<string, unknown>()

  // The anti-flash display engine and its episode-timing companion. The engine
  // owns the clock and the single timer the timed reducer needs, and is
  // disposed with the store so a held spinner cannot outlive eviction. See
  // `FormStore.fieldValidatingSince` for what the stamp map holds and why it
  // is reactive.
  const fieldValidatingSince: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const displayEngine = createDisplayEngine(ssr)
  cleanupHooks.push(() => displayEngine.dispose())

  // The schema is ALWAYS consulted, because the schema-derived originals are
  // what carry pristine / dirty across an SSR round-trip. Only the starting
  // value prefers hydration data.
  const schemaResponse: SchemaDefaultsResult<F> = computeBaselineResponse(schema, defaultValues)
  const schemaInitialData = schemaResponse.data

  // Paths where the consumer or the schema author declared a starting value.
  // The schema-error filter reads it to tell "missing user input" from
  // "consumer chose this starting state". Populated by `rebuildAuthoredPaths`
  // once the state record exists below.
  const authoredPaths = new Set<PathKey>()

  // Cloned per instance, so two forms sharing a schema, or one remounted from
  // the same schema cache, do not alias one initial-data object. Without it
  // the in-place merge `applyFormReplacement` runs on every setValue would
  // reach across the alias and mutate a sibling form's state.
  const initialData: F =
    hydration !== undefined ? (hydration.form as F) : (structuralSnapshot(schemaInitialData) as F)

  // Construction-time DU stub walk: every DU path whose disc names no variant
  // collapses to a stub holding only the discriminator key, dropping the
  // first-variant fields `mergeStructural` / `getDefaultValues` let in when the
  // consumer's `defaultValues` or the hydration payload carried a bad
  // discriminator. Mirrors the runtime stub-state contract `setValueAtPath`
  // applies to a bad-disc write, and dev-warns once per bad path.
  //
  // One clone walk total: on a DU-carrying schema the stub rebuild is itself a
  // fresh tree, so the snapshot above stays the pre-stub view that field
  // records seed from and the stub pass produces the storage tree. Without
  // discriminated unions the snapshot IS the storage tree.
  const hasDU = schema.hasDiscriminatedUnions?.() !== false
  const stubbedInitialData = hasDU
    ? (applyDuStubs(schema as AbstractSchema<unknown, unknown>, initialData, {
        warn: true,
      }) as F)
    : initialData

  const form = ref(stubbedInitialData) as Ref<F>

  // Operation-maintained per-element identity. It reads the live array length
  // to seed and realign token lists by position for writes it cannot follow,
  // while a structural mutation replays its permutation onto the tokens
  // through `applyOp`.
  const arrayIdentity = createArrayIdentity((arraySegs) => {
    // Read the length off the RAW form value, so this lookup registers no
    // reactive dependency. The identity-token read runs inside every array
    // element's FieldState computed, so tracking the length here would couple
    // all N element rollups to it and make one append or remove re-walk
    // O(N x M). An element's state depends only on its own subtree: a
    // structural op that changes which element sits at a slot also changes that
    // slot's value reference, since the field-array helpers relocate element
    // references in place, which fires the element's own value dep and re-runs
    // exactly its rollup. The length only seeds and bounds-checks the token
    // list.
    const v = getAtPath(toRaw(form.value), arraySegs)
    return Array.isArray(v) ? v.length : 0
  })

  // Per-path state. Vue's collection handlers make a read of one key track
  // that key only, so a change to one field does not invalidate computeds
  // watching another.
  //
  // `shallowReactive`, not `reactive`: the deep variant also wraps every value
  // a read HANDS BACK, minting a proxy per record per pass over the map. A
  // `FieldRecord` is `readonly` in every field and every writer REPLACES it
  // through `.set()`, so nothing can observe a mutation inside one. On a
  // 200-field read-swept form that wrapping was a third of the form's heap.
  // `test/core/store-collection-reactivity.test.ts` pins the tracking this
  // keeps.
  const fields = shallowReactive(new Map<PathKey, FieldRecord>()) as Map<PathKey, FieldRecord>

  // The DOM slice (element registry, no-latch host anchors, DOM-order sort
  // cache, focus listeners, first-error focus resolution) lives in
  // `dom-binding.ts` inside the directive cluster's lazy graph, and arms into
  // this slot through `RegisterValue.ensureDomBinding` on first element use.
  // `shallowRef`, so eager readers (field-state's `element` / `elements`, the
  // invalid-submit focus walk) re-run when it arms. `null` means nothing in
  // this app ever registered an element, and every reader treats it as the
  // empty registry it is.
  const domBinding = shallowRef<AttaformDomBinding | null>(null)

  // The tagged error store; see the Errors section above for the two-source
  // contract.
  //
  // `shallowReactive`, not `reactive`, and the difference is not small. Deep
  // `reactive` wraps every value a collection read HANDS BACK, so iterating
  // this map minted a fresh proxy per cell per pass: a 400-row table reading
  // `form.list()` after a keystroke spent most of its time in
  // `createReactiveObject`, for cells nothing can mutate. An `ErrorCell` is
  // `readonly` on both sides and every writer REPLACES it through `.set()`, so
  // the key-level tracking `shallowReactive` keeps in full is the whole of
  // what the readers need.
  const errorCells = shallowReactive(new Map<PathKey, ErrorCell>()) as Map<PathKey, ErrorCell>

  // Originals are captured at init and on a path's first appearance, and never
  // reassigned.
  //
  // Reactive because the dirty computed iterates this map AND reads
  // `form.value` per entry. Since `applyFormReplacement` mutates `form.value`
  // in place, so deep watches fire only for genuinely changed paths, the form
  // Ref's value-setter dep no longer fires on every write, and a plain Map
  // would leave the dirty computed on stale deps whenever new originals are
  // added (an `append` introducing an array index seeds one). Collection
  // reactivity makes the map's iteration, set and delete fire Vue's deps,
  // picking up exactly the change that prompted the mutation.
  //
  // `shallowReactive` for the same reason as `fields`: an `OriginalsRecord` is
  // `readonly` in both fields and is replaced rather than mutated, and the
  // collection-level tracking this is about is the half `shallowReactive`
  // keeps.
  const originals = shallowReactive(new Map<PathKey, OriginalsRecord>()) as Map<
    PathKey,
    OriginalsRecord
  >

  // Paths where a baseline-present container was replaced wholesale by a
  // non-container, as in `setValue('profile', undefined)`. Every leaf under
  // such a path vanishes at once, so the present-leaf dirty walk cannot see
  // the loss and the array identity tracker, which follows only array-to-array
  // writes, does not apply. This set is how a container removal still dirties
  // the form (#420, the non-array sibling of an array shrink).
  //
  // A plain Set is enough: reactivity rides on the form-value mutation that
  // always accompanies such a write, and the membership read self-filters by
  // current liveness. Cleared on `reset()`.
  const removedSubtrees = new Set<PathKey>()

  // Blank bookkeeping. The reactive Set holds paths whose display should be
  // EMPTY over a real slim default, and the snapshot mirrors construction-time
  // membership so dirty calculation can see the user's clear and un-clear
  // actions. A hydration payload wins over `initialBlankPaths`, matching how
  // the hydrated `form` value overrides the schema's `getDefaultValues`.
  //
  // Branch on the source rather than sniffing each entry: a hydration payload
  // arrives DOTTED and the construction-time unset walker emits canonical
  // keys, both known here. Sniffing (trying `JSON.parse` on anything starting
  // with `[`) misreads a literal key spelled like JSON.
  const blankPaths = reactive(new Set<PathKey>()) as Set<PathKey>
  const originalBlankPaths = new Set<PathKey>()
  const seededBlankPaths: readonly PathKey[] =
    hydration !== undefined
      ? (hydration.blankPaths ?? []).map((dotted) => canonicalizePath(dotted).key)
      : (options.initialBlankPaths ?? [])
  for (const key of seededBlankPaths) {
    blankPaths.add(key)
    originalBlankPaths.add(key)
  }

  // Per-form variant memory. On a discriminated-union switch the outgoing
  // variant's subtree, deep-cloned, and its blank-path bookkeeping are stashed
  // under `(unionPath, oldDiscValue)`, and switching in restores the incoming
  // discriminator's entry. It never reaches `form.value` and is never
  // persisted, and it clears on `reset()`, a whole-form replace, or a
  // `resetField` of an ancestor of the union path. Off entirely when
  // `rememberVariants` is `false`.
  const variantMemory = createVariantMemory()

  // Schema-declaration ordinals, which `form.meta.errors` sorts by.
  //
  // A plain Map on purpose: it is extended lazily from inside the `metaErrors`
  // computed when an unseen path appears, and a reactive Map would retrigger
  // that computed on every assignment. A plain `Map.set` is invisible to Vue,
  // so the computed re-runs only when an error store changes, not when the
  // ordinal book grows during the same pass.
  //
  // It lives as long as the FormStore and never shrinks: an ordinal is
  // assigned once per path and survives `reset()`, undo/redo and hydration
  // replay, so clearing an error and re-introducing it at the same path
  // returns to the SAME slot and `meta.errors` does not shuffle when the user
  // fixes a field and breaks it again.
  const pathOrdinals = new Map<PathKey, number>()

  // Recomputes whenever `blankPaths` mutates, through Vue's reactive Set
  // handlers. `isRequiredAtPath` is referentially stable for a form, the
  // schema being fixed at construction, so membership alone drives
  // invalidation.
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

  // Rebuilt whenever a cell is added, replaced or removed, or a blank path
  // joins or leaves. Vue's collection tracking makes that exact: a keystroke
  // rewriting one path's errors invalidates this once, not once per reader.
  //
  // Store-local on purpose. Every reader goes through `errorWindowAt` below,
  // which is what keeps one path's error off every other container's
  // dependency list; handing a reader the index itself would put the
  // form-global dep straight back.
  const errorPathIndex = computed<readonly ErrorPathEntry[]>(() =>
    buildErrorPathIndex(errorCells, derivedBlankErrors.value)
  )

  // Submission lifecycle. The initial values are "nothing submitted yet": not
  // in flight, zero attempts, no captured error. `activeSubmissions` counts
  // concurrent submissions, so the LAST completion flips `submitting` false
  // rather than the first.
  const submitting = ref(false)
  const activeSubmissions = ref(0)
  const submissionAttempts = ref(0)
  const submitted = ref(false)
  const submitError = ref<Error | null>(null)
  // Wizard departures from this form, bumped by `useWizard` when
  // `next` / `back` / `goTo` actually leaves and zeroed by `reset()`.
  // Introspection only: the display heuristic reveals through
  // `submissionAttempts`.
  const departAttempts = ref(0)
  // Data-freeze channel. `useWizard` writes `externalLock` to freeze a locked
  // step's form, the form's own config contributes through
  // `toValue(options.disabled)`, and `effectiveDisabled` ORs the two toward
  // frozen so a member form cannot pass `disabled: false` to escape a wizard
  // lock. A throwing consumer getter falls back to the config side reading
  // not-frozen, with a one-time dev warning, and the wizard lock stays
  // authoritative either way.
  const externalLock = ref(false)
  let warnedDisabledThrow = false
  const effectiveDisabled = computed<boolean>(() => {
    let own = false
    try {
      own = Boolean(toValue(options.disabled))
    } catch (err) {
      // `own` stays `false`: the try either reassigns it or throws before
      // touching it, so the config side reads not-frozen.
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

  // Snapshots of `form.value`, keyed by the canonical PathKey of the SCOPE
  // each blur-mode run commits at. The dedup at path P walks from P up to the
  // root, reads the closest ancestor entry, and compares that snapshot's
  // subtree-at-P against the live subtree-at-P, so a sibling-only edit between
  // blurs leaves P's subtree unchanged and P's re-blur skips, without
  // depending on whether a sibling's commit happened to advance a shared
  // anchor.
  //
  // Under whole-form validation scope every commit lands at the root key and
  // all blurs share one entry; under subtree scope a commit at B advances B's
  // entry only and a blur at A walks up to whatever ancestor scope was last
  // committed. An empty map means no entry, so the first blur revalidates.
  const pathSnapshots = new Map<PathKey, unknown>()

  // Async-defaults lifecycle, written by `useAbstractForm` on the first call
  // for this key: `defaultValuesFactory` captures the function-form input and
  // `hydrating` stays true until settle. A plain-value form leaves them at
  // their zero state.
  const hydrating = ref(false)
  const hydrateError = ref<ValidationError | null>(null)
  const defaultValuesFactory = ref<(() => unknown | Promise<unknown>) | undefined>(undefined)
  const defaultsResolved = ref(false)
  // Lazy-activation state. `activated` flips true the moment the captured
  // factory is kicked off, synchronously and before it resolves, while
  // `activationPromise` holds the in-flight settle so concurrent callers share
  // one fetch.
  const activated = ref(false)
  const activationPromise = ref<Promise<void> | undefined>(undefined)
  // Initial-validity gate; see `FormStore.firstValidationDone` and
  // `initialFirstValidationGate` for why only async-validating schemas start
  // gated. The watch opens it when `activeValidations` returns to 0 from a
  // positive value, which is the construction-time queued validation
  // completing.
  const firstValidationDone = ref(initialFirstValidationGate(schema))
  // `watch(source, cb)` fires only on a CHANGE, with no immediate first
  // invocation, so `prev` is always the pre-transition `number`.
  watch(activeValidations, (now, prev) => {
    if (prev > 0 && now === 0) {
      firstValidationDone.value = true
    }
  })

  // Per-path async-need cache, filled lazily so a form whose consumers ask
  // about a few prefixes never pays for a full schema walk. It can grow
  // unbounded across the FormStore's lifetime safely: the schema bounds the
  // paths, and the FormStore is collected when its last consumer disposes.
  const pathAsyncCache = new Map<PathKey, boolean>()

  // Reactive per-path counter for `field.validating`; see
  // `FormStore.fieldValidationCounts`.
  const fieldValidationCounts: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const fieldValidationState = new Map<PathKey, FieldValidationEntry>()

  // Plain Sets: these fire imperative callbacks, and no template should depend
  // on how many listeners are attached.
  const formChangeListeners = new Set<(next: F, meta?: WriteMeta) => void>()
  const submitSuccessListeners = new Set<() => void>()
  const resetListeners = new Set<() => void>()

  // Async register-transform machinery, a near-mirror of the field-validation
  // counters. A `register({ transforms })` chain returning a thenable defers
  // its write: these counters drive the busy / pending UX for the duration,
  // the per-path run token enforces latest-request-wins, and the waiters back
  // `settleTransforms`. `directive.ts` owns the orchestration, and the
  // `transforming` / `busy` / `transformError` surfaces live in
  // `field-state-api.ts`.
  const fieldTransformCounts: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const fieldTransformingSince: Map<PathKey, number> = reactive(new Map<PathKey, number>())
  const transformErrors: Map<PathKey, Error | null> = reactive(new Map<PathKey, Error | null>())
  const activeTransforms = ref(0)
  const transformRuns = new Map<PathKey, TransformRun>()
  // Pending `settleTransforms` callers: `key === null` waits on the whole
  // form, a key waits on its own path.
  const transformWaiters: { key: PathKey | null; resolve: () => void }[] = []

  // One `computed` per prefix anyone aggregates errors at, holding that
  // prefix's slice of the index.
  //
  // The index is one value for the whole form, rebuilt whole on every error
  // change, so it takes a fresh identity every time. A container reading it
  // directly therefore woke whenever ANY path in the form gained or lost an
  // error, and a form mounting with errors paid one render per unrelated
  // container on its first write, linear in container count.
  //
  // The window `computed` is the barrier. It re-evaluates on every index
  // change, a binary search and a key compare over its own slice, but hands
  // back the array it returned last time when its own window is unchanged, and
  // Vue stops propagating a `computed` whose value is identical. So an
  // unrelated path's error reaches this far and no further. Contents are
  // deliberately NOT part of the comparison: `aggregateErrorsAt` reads each
  // path's errors through the per-key `errorCells` / `blankPaths` tracking,
  // which is already precise, and folding contents in here would re-add the
  // form-global dep this exists to remove.
  const errorWindows = new Map<PathKey, ComputedRef<readonly ErrorPathEntry[]>>()

  // The form's single liveness sweep, built here so the store's own per-path
  // maps are swept alongside the read surfaces'. Without them in it, a form
  // that grew a container and shrank it again keeps a `fields` record and an
  // originals entry for every path it ever held, and emptying a 200-row array
  // releases nothing.
  const pathSweep = createDynamicPathSweep({
    onFormChange: (listener) => {
      formChangeListeners.add(listener as (next: F, meta?: WriteMeta) => void)
    },
    isFixedObjectAtPath: (path) => schema.isFixedObjectAtPath(path),
  })
  pathSweep.onEvict((key) => {
    fields.delete(key)
    fieldValidationState.delete(key)
    authoredPaths.delete(key)
    // Originals are the form's memory of what it STARTED as, so an entry
    // recording a real value outlives the path going away: a removed row
    // restored by undo compares against the value it had, not against absence.
    // An entry holding `undefined` is the absence baseline
    // `commitWritePatches` seeds the first time a runtime-added path appears,
    // and it re-seeds identically on re-appearance, so dropping it costs
    // nothing and it is the half that grows without bound.
    if (originals.get(key)?.value === undefined) originals.delete(key)
    // Bounded like every other per-path cache (#617): a prefix the form no
    // longer has loses its window on the next write.
    errorWindows.delete(key)
  })

  const errorWindowAt = (prefix: Path, prefixKey: PathKey): readonly ErrorPathEntry[] => {
    let cached = errorWindows.get(prefixKey)
    if (cached === undefined) {
      const frozen = [...prefix]
      cached = computed<readonly ErrorPathEntry[]>((prev) => {
        const next = windowUnder(errorPathIndex.value, frozen)
        return prev !== undefined && isSameWindow(prev, next) ? prev : next
      })
      errorWindows.set(prefixKey, cached)
      pathSweep.track(frozen, prefixKey)
    }
    return cached.value
  }

  // Relocates per-element field / error / blank / originals state, seeds
  // freshly created elements, drops stale schema verdicts at changed indices
  // and aborts in-flight validation at vacated ones. It owns no state: every
  // dependency is a reference into the surrounding store, so its lifecycle
  // matches the host's exactly.
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

  // Bind the module kernel's `st`-first functions into the per-instance skin
  // table below.
  const bind =
    <A extends unknown[], R>(fn: (state: FormState<F, G>, ...args: A) => R) =>
    (...args: A): R =>
      fn(st, ...args)

  const st: FormState<F, G> = {
    // --- public data (the FormStore contract's state members) ---
    formKey,
    form,
    fields,
    errorCells,
    derivedBlankErrors,
    errorWindowAt,
    originals,
    pathSweep,
    schema,
    ssr,
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
    coerceEnabled,
    blankPaths,
    originalBlankPaths,

    // --- kernel-internal state ---
    // A defensive copy. `getDefaultValues` building a fresh tree is an adapter
    // implementation detail, not a contract, and this field is durable state
    // that every `reset()` reads, so it must not depend on one. The copy also
    // stops a consumer holding a reference to the literal they passed from
    // mutating the form's defaults from outside. `reset()` snapshots for a
    // harder reason, where an alias IS reachable.
    defaultValues: structuralSnapshot(defaultValues),
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
    rehydrate: bind(rehydrate),
    activate: bind(activate),
    adoptResolvedDefaults: bind(adoptResolvedDefaults),
    pathHasAsyncValidationByKey: bind(pathHasAsyncValidationByKey),
    applyFormReplacement: bind(applyFormReplacement),
    setValueAtPath: bind(setValueAtPath),
    getValueAtPath: bind(getValueAtPath),
    arrayElementKey: bind(arrayElementKey),
    reset: bind(reset),
    resetField: bind(resetField),
    // The schema/user pair below reads as a fold waiting to happen. Folding
    // them into a `setErrorsForPathIn(channel)` factory measures 10 B LARGER:
    // gzip has already collected the rent on two adjacent copies, and the
    // helper adds a name the original does not need.
    setSchemaErrorsForPath: (path, entries) =>
      setErrorChannelForKey(
        st,
        canonicalizePath(path).key,
        'schema',
        entries.length === 0 ? NO_ERRORS : [...entries]
      ),
    setAllSchemaErrors: (entries) => replaceErrorChannel(st, 'schema', entries),
    clearSchemaErrors: (path) => clearErrorChannel(st, 'schema', path),
    applySchemaErrorsForSubtree: bind(applySchemaErrorsForSubtree),
    setAllUserErrors: (entries) => replaceErrorChannel(st, 'user', entries),
    setUserErrorsForPath: (path, entries) =>
      setErrorChannelForKey(
        st,
        canonicalizePath(path).key,
        'user',
        entries.length === 0 ? NO_ERRORS : [...entries]
      ),
    clearUserErrors: (path) => clearErrorChannel(st, 'user', path),
    restoreErrorCells: bind(restoreErrorCells),
    getErrorsForPath: bind(getErrorsForPath),
    ensurePathOrdinal: bind(ensurePathOrdinal),
    noteDomConnected: bind(noteDomConnected),
    noteDomDisconnected: bind(noteDomDisconnected),
    markFocused: bind(markFocused),
    markInteracted: bind(markInteracted),
    touchAtPath: bind(touchAtPath),
    interactAtPath: bind(interactAtPath),
    markConnectedOptimistically: bind(markConnectedOptimistically),
    isPristineAtPathByKey: bind(isPristineAtPathByKey),
    hasStructuralChangeUnder: bind(hasStructuralChangeUnder),
    hasRemovedSubtreeUnder: bind(hasRemovedSubtreeUnder),
    getFieldRecord: bind(getFieldRecord),
    cancelFieldValidation: bind(cancelFieldValidation),
    beginTransform: bind(beginTransform),
    isCurrentTransform: bind(isCurrentTransform),
    endTransform: bind(endTransform),
    setTransformError: bind(setTransformError),
    cancelTransformsUnder: bind(cancelTransformsUnder),
    settleTransforms: bind(settleTransforms),
    scheduleFieldValidation: bind(scheduleFieldValidation),
    onFormChange: bind(onFormChange),
    onSubmitSuccess: bind(onSubmitSuccess),
    onReset: bind(onReset),
    emitSubmitSuccess: bind(emitSubmitSuccess),
    registerCleanup: bind(registerCleanup),
    dispose: bind(dispose),
  }

  // --- Construction sequence: the reset-shared baseline, then the
  // construction-only seeding ---

  rebuildAuthoredPaths(st, defaultValues, schemaInitialData)

  // Populate originals by diffing empty-form to schema-initial. That shape is
  // the schema's regardless of hydration, so pristine / dirty compares against
  // what the form was supposed to start as. The same walk seeds `pathOrdinals`
  // in schema-declaration order, since `diffAndApply` visits every leaf in it.
  seedOriginalsFromBaseline(st, schemaInitialData, true)

  // Populate fields from the hydration payload, which preserves the exact
  // server-side timestamps and flags, or by walking `initialData` for leaves.
  if (hydration !== undefined) {
    for (const [rawKey, record] of hydration.fields) {
      if (typeof rawKey !== 'string' || !isHydratedFieldRecord(record)) {
        warnMalformedHydration(formKey, 'FieldRecord', String(rawKey))
        continue
      }
      fields.set(rawKey as PathKey, record)
    }
    // Hydration takes precedence over the construction seed below: the server
    // already authored whatever error state the client should mirror, the
    // empty case included. Each side replays from its own snapshot, so source
    // segregation survives the SSR round-trip.
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
    // No hydration, so seed the schema side from the construction-time
    // validation result, and only when the schema rejected the defaults.
    if (!schemaResponse.success) {
      replaceErrorChannel(st, 'schema', schemaResponse.errors)
    }
  }

  // An async-only verdict cannot surface from `getDefaultValues`, whose
  // contract is sync and whose adapter degrades to success when the schema's
  // sync parse cannot resolve one. Queue the one-shot full-form pass so those
  // errors land on a later microtask rather than waiting for a user mutation.
  // See `queueInitialAsyncValidation` for the SSR and async gates.
  queueInitialAsyncValidation(st)

  return st
}

export type { Path, PathKey, Segment }
