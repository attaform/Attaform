import {
  getCurrentInstance,
  getCurrentScope,
  onScopeDispose,
  onServerPrefetch,
  provide,
  useId,
} from 'vue'
import { buildFormApi } from '../core/build-form-api'
import { createFormStore, type FormStore } from '../core/create-form-store'
import {
  ANONYMOUS_FORM_KEY_PREFIX,
  DEFAULT_MAX_RECURSION_DEPTH,
  normalizeNumericOption,
  PERSISTENCE_KEY_PREFIX,
  RESERVED_KEY_PREFIX,
} from '../core/defaults'
import { __DEV__ } from '../core/dev'
import { captureUserCallSite } from '../core/dev-stack-trace'
import { AnonPersistError, InvalidUseFormConfigError, ReservedFormKeyError } from '../core/errors'
import { extractSchemaFields } from '../core/extract-schema-fields'
import type { FieldState } from '../core/field-state-api'
import { getComputedSchema } from '../core/get-computed-schema'
import { createHistoryModule, type HistoryModule } from '../core/history'
import {
  getStorageAdapter,
  normalizePersistConfig,
  PERSISTENCE_MODULE_KEY,
  resolveStorageKeyBase,
  sweepAllOrphansAcrossStandardStores,
  sweepNonConfiguredStandardStoresForOrphans,
  type PersistenceHandle,
  type PersistenceModule,
} from '../core/persistence'
import { createIsSensitivePath } from '../core/persistence/sensitive-names'
import { hashStableString } from '../core/hash'
import { isSecureContext, warnOnceInsecureContext } from '../core/insecure-context-warn'
import { ensureAttaformInstalled } from '../core/plugin'
import { kFormContext, kFormInstanceId, useRegistry, type AttaformRegistry } from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { walkUnsetSentinels } from '../core/unset-walker'
import type {
  AbstractSchema,
  AttaformDefaults,
  FormKey,
  OnChangeErrorHandler,
  OnChangeHandler,
  OnChangeOptions,
  UseFormReturnType,
  UseFormConfiguration,
} from '../types/types-api'
import type { DeepPartial, DefaultValuesInput, GenericForm, WriteShape } from '../types/types-core'

/**
 * Schema-agnostic `useForm`. Accepts any object that implements
 * `AbstractSchema` — useful when integrating a custom schema
 * adapter or a third-party validation library.
 *
 * ```ts
 * import { useForm } from 'attaform'
 *
 * const form = useForm({
 *   schema: myCustomAdapter,
 *   defaultValues: { name: '' },
 * })
 * ```
 *
 * Most consumers prefer a typed entry point that wraps the underlying
 * library's schema with the matching adapter automatically; see the
 * subpath documentation for the available adapters.
 *
 * Returns the same form API as the typed entry points; see
 * `UseFormReturnType` for the full surface.
 */

export function useAbstractForm<
  Form extends GenericForm,
  GetValueFormType extends GenericForm = Form,
  ReadForm extends GenericForm = Form,
  K extends FormKey = FormKey,
>(
  configuration: UseFormConfiguration<
    Form,
    GetValueFormType,
    AbstractSchema<Form, GetValueFormType>,
    DefaultValuesInput<Form>,
    K
  >,
  /**
   * Internal escape hatch for callers that already hold a registry
   * reference and need to construct a form outside Vue's setup context
   * (e.g. the wizard's lazy noop builder, which runs inside a
   * `computed` re-eval). Passing this skips the strict `useRegistry()`
   * call; everything else (FormStore allocation, registry presence,
   * consumer ref-counting via `onScopeDispose`) goes through the same
   * path eager calls follow. Not part of the public surface.
   */
  options?: { readonly registry?: AttaformRegistry }
): UseFormReturnType<Form, GetValueFormType, ReadForm, K> {
  // Foot-gun guard: catches `useForm()` (no args), `useForm(null)`,
  // `useForm(rawSchema)` (any schema-like object passed as the first
  // argument — its `.schema` field is undefined), and the explicit
  // `useForm({ schema: undefined })` case. Throws synchronously
  // before any downstream code reads `configuration.schema`.
  if (
    configuration === undefined ||
    configuration === null ||
    (configuration as { schema?: unknown }).schema === undefined
  ) {
    throw new InvalidUseFormConfigError()
  }

  const key = resolveFormKey(configuration.key)

  // One FormStore per (app, formKey). Multiple useForm calls with the same
  // key resolve to the same instance — that's the shared-store semantic
  // for forms that explicitly opt in to a stable key.
  //
  // Lazy-install: if the consumer hasn't called `createAttaform()`,
  // attach the registry now. Idempotent — explicit installs (Nuxt
  // module, manual `app.use(createAttaform({ defaults }))`) win when
  // they ran first. The strict `useRegistry()` below still throws
  // `OutsideSetupError` when called outside setup; the lazy install
  // only ever fires when an instance is available.
  const instance = getCurrentInstance()
  if (instance !== null) ensureAttaformInstalled(instance.appContext.app)
  const registry = options?.registry ?? useRegistry()

  // Materialise the `defaultValues` trichotomy (`T | (() => T) |
  // (() => Promise<T>)`) before the merge — downstream consumers
  // (`mergeWithDefaults`, `walkUnsetSentinels` inside `buildFreshState`)
  // expect a plain `DeepPartial<...>`, not a function. Sync inputs use
  // their value as-is; function inputs swap to `undefined` so the form
  // constructs against the schema's slim defaults, and the factory
  // settles into `state.applyFormReplacement` once it resolves (wired
  // below).
  const resolvedDefaults = resolveTrichotomy<
    | DefaultValuesInput<Form>
    | undefined
    | (() => DefaultValuesInput<Form> | Promise<DefaultValuesInput<Form>>)
  >(configuration.defaultValues)
  // Build the materialised override conditionally — exactOptionalPropertyTypes
  // refuses explicit `undefined` on the optional field, so we omit it
  // when the resolved value is undefined.
  const materialisedDefaults: DefaultValuesInput<Form> | undefined =
    resolvedDefaults.kind === 'sync'
      ? (resolvedDefaults.value as DefaultValuesInput<Form> | undefined)
      : undefined
  const { defaultValues: _droppedDefaults, ...configWithoutDefaults } = configuration
  void _droppedDefaults
  const trichotomyOverride: UseFormConfiguration<
    Form,
    GetValueFormType,
    AbstractSchema<Form, GetValueFormType>,
    DefaultValuesInput<Form>
  > = materialisedDefaults === undefined
    ? (configWithoutDefaults as UseFormConfiguration<
        Form,
        GetValueFormType,
        AbstractSchema<Form, GetValueFormType>,
        DefaultValuesInput<Form>
      >)
    : ({ ...configWithoutDefaults, defaultValues: materialisedDefaults } as UseFormConfiguration<
        Form,
        GetValueFormType,
        AbstractSchema<Form, GetValueFormType>,
        DefaultValuesInput<Form>
      >)

  // Merge app-level defaults from the registry over per-form options.
  // Per-form values always win for scalars; `validateOn` and `debounceMs`
  // resolve independently so consumers can set `debounceMs` globally
  // and override `validateOn` per-form. Every downstream read uses
  // `merged` so the merge happens exactly once. Runs BEFORE schema
  // resolution so the merged `maxRecursionDepth` can thread into the
  // adapter factory.
  const merged = mergeWithDefaults(registry.defaults, trichotomyOverride)

  // Resolve the schema (accepts either an AbstractSchema or a factory).
  // Preserve both generics — dropping `GetValueFormType` here would make
  // `state.schema.getSchemasAtPath(...)` return `AbstractSchema<_, Form>[]`
  // for consumers whose schema intentionally produces a different runtime
  // shape (e.g. an adapter that narrows via a transform). The factory
  // receives the resolved per-form options (`maxRecursionDepth`) so the
  // adapter can bake them into its walk closures.
  //
  // Sanitise the consumer-supplied value: `NaN` / `-Infinity` /
  // non-numbers fall back to the library default with a dev-warn;
  // negatives clamp to 0; non-integers floor; `Infinity` is allowed
  // (disables the cap). The adapter's `>=` comparisons assume integer
  // depth, so the normalisation prevents footguns at the boundary.
  const maxRecursionDepth = normalizeNumericOption({
    value: merged.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH,
    source: 'useForm.maxRecursionDepth',
    allowInfinity: true,
    min: 0,
    defaultValue: DEFAULT_MAX_RECURSION_DEPTH,
  })
  const resolvedSchema = getComputedSchema(key, configuration.schema, { maxRecursionDepth })

  // Eager throw: persistence configured without an explicit `key:`. An
  // anonymous synthetic key (`__atta:anon:*`) drifts across mounts (HMR /
  // route changes / SSR↔CSR) and can collide between unrelated forms —
  // refusing here keeps the namespace stable and forecloses on the
  // future encrypted-backend case where collision becomes a key-derivation
  // overlap. Throws in dev and prod alike. The error body carries the
  // schema's top-level fields and a captured call-site so the offender
  // is identifiable from the message alone.
  if (configuration.persist !== undefined && configuration.key === undefined) {
    throw new AnonPersistError({
      cause: 'no-key',
      schemaFields: extractSchemaFields(resolvedSchema),
      callSite: captureUserCallSite(),
    })
  }

  const existing = registry.forms.get(key) as FormStore<Form, GetValueFormType> | undefined
  if (__DEV__ && existing !== undefined) {
    // Two `useForm({ key })` calls resolve to one FormStore by design;
    // the second call's schema and `persist:` config are then dropped in
    // favour of the first's wiring. That's a silent footgun when the two
    // call sites are unrelated and only happen to agree on a key, so a
    // dev build surfaces the divergence. The diagnostics live in a
    // dev-only module imported behind this `__DEV__` gate: a production
    // build folds the gate away and drops the whole module, so none of
    // the warning code ships (see `dev-key-collision-warnings.ts`).
    void import('../core/dev-key-collision-warnings').then((m) => {
      void m.warnOnSchemaFingerprintMismatch(key, existing.schema, resolvedSchema)
      m.warnOnPersistDivergence(key, existing, configuration.persist)
    })
  }
  // Capture whether a hydration payload is waiting for this key BEFORE
  // `buildFreshState` consumes it. We use this flag to skip re-firing
  // an async-defaults factory on the client: the server already
  // resolved it and the resolved values rode the payload, so the
  // factory call would just double-fetch.
  const hadPendingHydration = registry.pendingHydration.has(key)

  const state: FormStore<Form, GetValueFormType> =
    existing ?? buildFreshState<Form, GetValueFormType>(key, resolvedSchema, merged, registry)

  // Wire function-form `defaultValues` once per FormStore. Sync inputs
  // already applied at construction; async inputs stay dormant until
  // the first reactive interaction calls `state.activate()` through
  // the public API surface. Subsequent `useForm({ key })` calls that
  // resolve to the same store observe the in-flight state via
  // `state.hydrating` rather than re-firing.
  if (existing !== undefined) {
    // Reusing a live store — its `defaultsResolved` already reflects
    // the first caller's effective state. Don't overwrite it.
  } else if (resolvedDefaults.kind === 'sync') {
    // Sync defaults applied during `buildFreshState`; the form is
    // immediately usable.
    state.defaultsResolved.value = true
  }
  if (existing === undefined && resolvedDefaults.kind === 'async') {
    const factory = resolvedDefaults.factory as () =>
      | DefaultValuesInput<Form>
      | Promise<DefaultValuesInput<Form>>
    state.defaultValuesFactory.value = factory
    if (hadPendingHydration) {
      // Server already resolved the factory; client just consumed the
      // payload at `buildFreshState`. Skip the re-fetch — and the
      // resolved payload IS the effective default state.
      state.hydrating.value = false
      state.defaultsResolved.value = true
    } else if (registry.ssr) {
      // Server side: factory dispatch is coordinated through the
      // registry's SSR prefetch queue. `onServerPrefetch` is registered
      // unconditionally; it drains the queue by calling
      // `state.activate()` only when this form's key is enqueued (and
      // not skipped). The positive triggers that enqueue: explicit
      // `form.activate()` in setup, the wizard's current-step
      // auto-mark, the Phase 3 compile-time `__ssrAccessed` injection,
      // or any gated reactive read during setup (which routes through
      // `state.activate()`). A form that nobody touched stays dormant
      // — the factory does not run, and the payload serialises the
      // schema's slim defaults.
      if (configuration.__ssrAccessed === true) {
        registry.enqueuePrefetch(key)
      }
      onServerPrefetch(() => {
        if (!registry.shouldPrefetch(key)) return
        return state.activate()
      })
    }
    // CSR: factory stays dormant until the first reactive interaction
    // calls `state.activate()` through the public API surface. The
    // microtask defer that used to fire here is gone — lazy-by-default
    // is the new contract.
  }

  // Ref-count this consumer. When the component's effect scope tears down,
  // release the count; the registry evicts the FormStore once the last
  // consumer disposes. Guarded on `getCurrentScope()` so callers without an
  // effect-scope context (defensive — setup() always provides one) don't
  // leak a pinned consumer. See registry.trackConsumer for the counter.
  if (getCurrentScope() !== undefined) {
    const releaseConsumer = registry.trackConsumer(key)
    onScopeDispose(releaseConsumer)
  }

  // Wire persistence (opt-in) — only on fresh state creation, skipped
  // on SSR. `existing` means a prior useForm() already mounted and
  // wired persistence; we don't double-subscribe. The handle is cached
  // on `state.modules` so `buildFormApi` can plug `form.persist` /
  // `form.clearPersistedDraft` into the consumer-facing API. The
  // disposer is registered on the FormStore (not on this consumer's
  // scope) so persistence survives any single consumer unmounting — it
  // tears down only when the last consumer releases and the registry
  // evicts the state.
  //
  // The shorthand input (`persist: 'local'`, `persist: customAdapter`)
  // is normalised to the resolved options bag once at this boundary —
  // Anonymous + persist enforcement. Dev throws (catches the bug at
  // the offending useForm() call); prod returns `true` so the wiring
  // block below skips entirely AND cleans up any prior persisted
  // entries — we'd rather pretend persist wasn't configured than
  // silently mis-route data between forms that happened to share an
  // anon id. Runs regardless of SSR / first-mount-vs-rehook so the
  // dev-mode throw fires on the SSR pass too (without a server-side
  // throw, the SSR pass would succeed silently and the client would
  // throw on hydration — that surfaces as a confusing hydration
  // mismatch instead of pointing at the actual config bug).
  const persistDisabledByAnonRule =
    merged.persist !== undefined && enforceAnonPersistRule(state.formKey, registry.ssr)
  // everything below operates on the resolved shape.
  if (existing === undefined && !registry.ssr) {
    if (merged.persist !== undefined && !persistDisabledByAnonRule) {
      const resolvedPersist = normalizePersistConfig(merged.persist)
      // Secure-context gate for BUILT-IN storage adapters. Plain HTTP
      // on a real hostname leaves localStorage / sessionStorage open
      // to MITM injection. The gate noops the persistence wiring
      // entirely with a one-shot dev warning. Custom storage adapters
      // (consumer-supplied
      // objects) bypass the gate — the consumer owns that storage
      // layer's security posture (could be encrypted, server-side,
      // behind a tunnel, etc.).
      const storageKind = resolvedPersist.storage
      const isBuiltinStorage = typeof storageKind === 'string'
      const secureContextOk = !isBuiltinStorage || isSecureContext()
      if (!secureContextOk) {
        const feature: 'persist:local' | 'persist:session' =
          storageKind === 'session' ? 'persist:session' : 'persist:local'
        warnOnceInsecureContext(feature)
        void sweepAllOrphansAcrossStandardStores(`${PERSISTENCE_KEY_PREFIX}${state.formKey}`)
      } else {
        const persistenceBase = resolveStorageKeyBase(resolvedPersist, state.formKey)
        // Cross-store orphan cleanup: any standard backend not matching
        // the configured one gets every attaform-managed key under the
        // base wiped (unfingerprinted AND stale-fingerprint alike).
        // Ensures stale drafts can't survive in stores the dev migrated
        // AWAY from. Fire-and-forget; backend unavailability is silent.
        void sweepNonConfiguredStandardStoresForOrphans(resolvedPersist.storage, persistenceBase)
        // Persistence's wiring + payload machinery is dynamically
        // imported so the always-on `useForm` path never ships it. Start
        // the adapter's own dynamic import NOW, in parallel with the
        // chunk import below: the chunk load then hides behind the
        // adapter load the hydration read already waits for, so a
        // persist-configured form's flash-of-defaults window is unchanged
        // and no synchronous caller gains a new await.
        const adapterPromise = getStorageAdapter(resolvedPersist.storage)
        // Disposal race: a fast mount->unmount can dispose the store
        // before the chunk lands. registerCleanup runs disposers once
        // then drops the list, so a disposer registered late never fires.
        // An eagerly-registered cleanup flips `persistDisposed`, which the
        // resolver checks before wiring onto a dead store.
        let persistDisposed = false
        state.registerCleanup(() => {
          persistDisposed = true
        })
        const ready: Promise<PersistenceModule | undefined> = (async () => {
          try {
            // Resolve the fingerprint token in parallel with the chunk
            // import: `schema.fingerprint()` itself dynamic-imports the
            // fingerprint walker, so kicking both off together keeps the
            // storage key ready by the time the wiring runs, with no serial
            // round-trip behind the chunk load.
            const [{ wirePersistence }, fingerprintToken] = await Promise.all([
              import('../core/persistence/wire-persistence'),
              resolvePersistFingerprintToken(state),
            ])
            if (persistDisposed) return undefined
            const persistenceModule = wirePersistence(
              state,
              resolvedPersist,
              adapterPromise,
              fingerprintToken
            )
            // Drain BEFORE the synchronous teardown: the registry awaits
            // `awaitPendingWrites` before calling `dispose`, so the last
            // debounced keystroke gets to disk before the FormStore is
            // evicted from the registry's `forms` map.
            state.registerDrain(() => persistenceModule.awaitPendingWrites())
            state.registerCleanup(() => persistenceModule.dispose())
            return persistenceModule
          } catch {
            // The chunk failed to load (offline, chunk eviction).
            // Persistence stays silently unavailable rather than throwing
            // into the consumer's form lifecycle.
            return undefined
          }
        })()
        // Handle set SYNCHRONOUSLY so the render-path reads that can't
        // wait for the chunk still get the right answer: `config` powers
        // register-api's "is persist configured?" gate and the
        // cross-instance divergence warn; `ready` is the promise the
        // imperative `form.persist` / `clearPersistedDraft` APIs await. A
        // second useForm({ key }) on the same store shares this handle.
        const persistenceHandle: PersistenceHandle = { config: resolvedPersist, ready }
        state.modules.set(PERSISTENCE_MODULE_KEY, persistenceHandle)
      }
    } else {
      // Either the dev didn't configure `persist:` OR we just disabled
      // it via the anon-persist rule. Either way, sweep every
      // attaform-managed key under this form's base across all standard
      // backends so dropping (or refusing to wire) persistence
      // actually leaves storage clean.
      void sweepAllOrphansAcrossStandardStores(`${PERSISTENCE_KEY_PREFIX}${state.formKey}`)
    }
  }

  // Wire history (opt-in). Fresh-state-only — the module subscribes
  // to FormStore events, so subscribing twice would double-push
  // snapshots. Cache the module on the FormStore so subsequent
  // `useForm` / `injectForm` calls for the same key retrieve the
  // SAME instance, keeping `canUndo` / `canRedo` / `historySize` /
  // `undo` / `redo` consistent across mount order.
  if (existing === undefined && merged.history !== undefined) {
    const historyModule = createHistoryModule(state, merged.history)
    state.modules.set(HISTORY_MODULE_KEY, historyModule)
    state.registerCleanup(() => historyModule.dispose())
  }

  // Provide the FormStore to descendants via `kFormContext` so
  // `injectForm()` can resolve it without prop-threading.
  //
  // ONLY anonymous `useForm()` calls fill the ambient slot. Keyed forms
  // are explicitly addressable via `injectForm<F>(key)` and don't
  // pollute the ambient context — keeping the two resolution modes
  // semantically distinct. A descendant of a keyed-only parent that
  // calls `injectForm<F>()` (no key) gets the "no ambient form"
  // throw, which is the right error: the form has a name; address it.
  //
  // Ambient mode is still "last-provide wins" among siblings: if two
  // anonymous `useForm()` calls run in the same component, the second
  // overwrites the first and descendants only see the second. We record
  // the per-instance history of ANONYMOUS provides here (silently) so
  // that a descendant's `injectForm<F>()` call can walk up, detect
  // the collision, and warn lazily. Recording is skipped on SSR so the
  // client-side warn fires once, not once-per-render-pass.
  if (configuration.key === undefined) {
    recordAmbientProvide(registry.ssr)
    provide(kFormContext, state as FormStore<GenericForm>)
  }

  // Per-`useForm()`-call instance ID. Distinct from `state.formKey`:
  // the key identifies a SHARED FormStore (so two `useForm({ key:
  // 'signup' })` calls return the same store), while `formInstanceId`
  // identifies THIS specific callsite — important for `focusFirstError`
  // / `scrollToFirstError` to scope to the elements THIS caller's
  // `v-register` directives bound to. SSR-safe via Vue 3.5+'s
  // `useId()`. Outside Vue setup (tests, ad-hoc composable use) we
  // fall back to a module-local counter — uniqueness is what matters,
  // and tests don't share form-instance state across mounts anyway.
  const formInstanceId =
    getCurrentInstance() !== null ? useId() : `atta:form-instance:${formInstanceCounter++}`
  // Provided so descendants reaching via `injectForm()` inherit this ID
  // and their locally-registered elements tag against the same instance.
  // Sibling `useForm()` calls (different tree positions) provide their
  // own IDs and stay isolated.
  if (getCurrentInstance() !== null) {
    provide(kFormInstanceId, formInstanceId)
  }

  const apiOptions: Parameters<typeof buildFormApi<Form, GetValueFormType>>[2] = {}
  if (merged.onInvalidSubmit !== undefined) {
    apiOptions.onInvalidSubmit = merged.onInvalidSubmit
  }
  const history = state.modules.get(HISTORY_MODULE_KEY) as HistoryModule | undefined
  if (history !== undefined) {
    apiOptions.history = history
  }
  // Per-instance config lifts: each `useForm()` callsite carries its
  // own `validateOn` / `debounceMs` / `getDisplayState` / `coerce` /
  // `rememberVariants`. These thread through `buildFormApi` into
  // register's coerce closure, the field-state predicate, and store
  // writes' WriteMeta — so two `useForm({ key })` calls (modal + main)
  // can validate on different cadences and surface errors with
  // different visibility rules even though they share a FormStore.
  if (merged.validateOn !== undefined) {
    apiOptions.validateOn = merged.validateOn
  }
  const mergedDebounceMs = (merged as { debounceMs?: number }).debounceMs
  if (mergedDebounceMs !== undefined) {
    apiOptions.debounceMs = mergedDebounceMs
  }
  if (merged.getDisplayState !== undefined) {
    apiOptions.getDisplayState = merged.getDisplayState
  }
  if (merged.coerce !== undefined) {
    apiOptions.coerce = merged.coerce
  }
  if (merged.rememberVariants !== undefined) {
    apiOptions.rememberVariants = merged.rememberVariants
  }
  if (merged.autoAria !== undefined) {
    apiOptions.autoAria = merged.autoAria
  }
  // `buildFormApi` returns the schema-agnostic shape (`ReadForm = Form`);
  // adapter callers compute the richer `ReadForm` (zod-v4's
  // `StorageShape<Schema>`) and assert it through the public return
  // type — at runtime the same proxies serve both views.
  const api = buildFormApi<Form, GetValueFormType>(state, formInstanceId, apiOptions)

  // `useForm({ onChange })`: a whole-form side-channel handler bound to this
  // form. Route it through the same store registry `form.onChange(...)` uses,
  // scoped to the calling component so it stops on unmount (a no-op on SSR).
  // `getForm` resolves the public handle for `ctx.form`.
  const onChangeConfig = configuration.onChange
  if (onChangeConfig !== undefined) {
    const handler = (
      typeof onChangeConfig === 'function' ? onChangeConfig : onChangeConfig.handler
    ) as OnChangeHandler
    const onError = typeof onChangeConfig === 'function' ? undefined : onChangeConfig.onError
    const options: OnChangeOptions | undefined =
      onError === undefined ? undefined : { onError: onError as OnChangeErrorHandler }
    const stop = state.registerOnChange(undefined, handler, options, () => api)
    if (getCurrentScope() !== undefined) onScopeDispose(stop)
  }

  return api as unknown as UseFormReturnType<Form, GetValueFormType, ReadForm, K>
}

/**
 * Merge app-level defaults from the registry over a per-form
 * configuration. Per-form values always win for scalars; `validateOn`
 * and `debounceMs` resolve independently so a default like
 * `{ debounceMs: 100 }` carries through even when the per-form call
 * passes `{ validateOn: 'blur' }`. See `AttaformDefaults` for the
 * full merge contract.
 */
function mergeWithDefaults<
  Form extends GenericForm,
  GetValueFormType extends GenericForm,
  Schema extends AbstractSchema<Form, GetValueFormType>,
  Defaults extends DefaultValuesInput<Form>,
>(
  defaults: AttaformDefaults,
  configuration: UseFormConfiguration<Form, GetValueFormType, Schema, Defaults>
): UseFormConfiguration<Form, GetValueFormType, Schema, Defaults> {
  // exactOptionalPropertyTypes rejects explicit `undefined` on optional
  // properties (different from omitting), so conditionally spread each
  // resolved value rather than assigning undefined into the field.
  const strict = configuration.strict ?? defaults.strict
  const onInvalidSubmit = configuration.onInvalidSubmit ?? defaults.onInvalidSubmit
  const history = configuration.history ?? defaults.history
  const rememberVariants = configuration.rememberVariants ?? defaults.rememberVariants
  const coerce = configuration.coerce ?? defaults.coerce
  const validateOn = configuration.validateOn ?? defaults.validateOn
  // `debounceMs` is type-narrowed in the public discriminated union to
  // disallow non-`'change'` mode + debounce; here at the resolution
  // boundary we only see the unwrapped fields, so the access is
  // unconditional. The runtime check in `create-form-store.ts` ignores
  // the value under non-`'change'` modes regardless.
  const debounceMs = (configuration as { debounceMs?: number }).debounceMs ?? defaults.debounceMs
  const getDisplayState = configuration.getDisplayState ?? defaults.getDisplayState
  const maxRecursionDepth = configuration.maxRecursionDepth ?? defaults.maxRecursionDepth
  // sensitiveNames REPLACES (doesn't extend) — consumers compose
  // additive lists themselves via `[...DEFAULT_SENSITIVE_NAMES, ...]`.
  // Per-form value wins; falls back to global default. Empty array
  // `[]` is the explicit opt-out and is preserved through the merge.
  const sensitiveNames = configuration.sensitiveNames ?? defaults.sensitiveNames
  const autoAria = configuration.autoAria ?? defaults.autoAria
  return {
    ...configuration,
    ...(strict === undefined ? {} : { strict }),
    ...(onInvalidSubmit === undefined ? {} : { onInvalidSubmit }),
    ...(history === undefined ? {} : { history }),
    ...(rememberVariants === undefined ? {} : { rememberVariants }),
    ...(coerce === undefined ? {} : { coerce }),
    ...(validateOn === undefined ? {} : { validateOn }),
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(getDisplayState === undefined ? {} : { getDisplayState }),
    ...(maxRecursionDepth === undefined ? {} : { maxRecursionDepth }),
    ...(sensitiveNames === undefined ? {} : { sensitiveNames }),
    ...(autoAria === undefined ? {} : { autoAria }),
  } as UseFormConfiguration<Form, GetValueFormType, Schema, Defaults>
}

/**
 * Shared key for the per-state history module cache. Exported would be
 * over-sharing — the only callers are this file and `injectForm`.
 */
const HISTORY_MODULE_KEY = 'history'

function buildFreshState<F extends GenericForm, G extends GenericForm = F>(
  key: FormKey,
  schema: AbstractSchema<F, G>,
  configuration: UseFormConfiguration<F, G, AbstractSchema<F, G>, DefaultValuesInput<F>>,
  registry: ReturnType<typeof useRegistry>
): FormStore<F, G> {
  const pending = registry.pendingHydration.get(key)
  if (pending !== undefined) registry.pendingHydration.delete(key)
  // Pre-pass: replace every `unset` sentinel in defaultValues with the
  // schema's slim default and collect the corresponding path keys.
  // Also auto-marks every primitive leaf the consumer did NOT cover —
  // a freshly opened form has no user input yet, so unspecified leaves
  // are logically blank. Devs opt a leaf out by supplying a non-`unset`
  // value for it. The walker mirrors `DefaultValuesShape<T>`'s
  // recursion; runtime landing of `unset` at a non-primitive leaf
  // produces a dev-warn (TS catches this at compile time but plain-JS
  // consumers bypass).
  const walked = walkUnsetSentinels(
    configuration.defaultValues,
    schema as unknown as AbstractSchema<GenericForm, GenericForm>
  )
  // Hydration precedence: when a hydration payload is present its
  // `blankPaths` field is the authoritative truth. We still
  // run the walker to scrub `unset` symbols out of `defaultValues` (so
  // they never reach storage), but discard the discovered paths in
  // favour of the hydrated set. Without this, a server-rendered form
  // with no blank paths would gain ones the client's
  // construction-time defaults invented.
  //
  // The walker emits opaque `PathKey` strings (canonicalised JSON
  // segment arrays). The rest of the runtime — `setValueAtPath`, DU
  // reshape, hydration apply, persistence payloads, history snapshots —
  // keys `blankPaths` by the same PathKey form, so we pass
  // `walked.paths` straight through to `createFormStore` without
  // reformatting at this boundary.
  let initialBlankPaths: ReadonlyArray<string> | undefined
  if (pending === undefined) {
    initialBlankPaths = walked.paths
  }
  // `configuration` has already passed through `mergeWithDefaults`, so
  // `sensitiveNames` here is the cascade-resolved value (per-form >
  // global > undefined-falls-to-library-default). An empty array `[]`
  // is the explicit opt-out ("nothing is sensitive on this form") and
  // the factory honors it. The resulting closures are frozen onto the
  // FormStore so persistence and DevTools share one source of truth.
  const resolvedSensitiveNames = configuration.sensitiveNames
  const resolvedIsSensitivePath =
    resolvedSensitiveNames === undefined ? undefined : createIsSensitivePath(resolvedSensitiveNames)
  const createOptions: Parameters<typeof createFormStore<F, G>>[0] = {
    formKey: key,
    schema,
    defaultValues: walked.cleanedValues as DeepPartial<WriteShape<F>> | undefined,
    ...(configuration.strict !== undefined ? { strict: configuration.strict } : {}),
    hydration: pending,
    ...(configuration.validateOn !== undefined ? { validateOn: configuration.validateOn } : {}),
    ...((configuration as { debounceMs?: number }).debounceMs !== undefined
      ? { debounceMs: (configuration as { debounceMs?: number }).debounceMs }
      : {}),
    ssr: registry.ssr,
    // Server-only: bind the SSR prefetch coordination handles. `enqueue`
    // records intent on every `state.activate()` so a wizard skip-list
    // override or a future transform mark has a consistent set to diff
    // against; `shouldFire` lets the activate path bail when the
    // wizard explicitly skipped this key — even an explicit
    // `form.activate()` defers to the wizard's render-efficiency
    // skip-list on the server.
    ...(registry.ssr
      ? {
          ssrPrefetch: {
            enqueue: (): void => {
              registry.enqueuePrefetch(key)
            },
            shouldFire: (): boolean => registry.shouldPrefetch(key),
          },
        }
      : {}),
    ...(configuration.rememberVariants !== undefined
      ? { rememberVariants: configuration.rememberVariants }
      : {}),
    ...(configuration.coerce !== undefined ? { coerce: configuration.coerce } : {}),
    ...(configuration.getDisplayState !== undefined
      ? { getDisplayState: configuration.getDisplayState }
      : {}),
    ...(initialBlankPaths !== undefined ? { initialBlankPaths } : {}),
    ...(resolvedIsSensitivePath !== undefined ? { isSensitivePath: resolvedIsSensitivePath } : {}),
  }
  const state = createFormStore<F, G>(createOptions)
  // Storage type is FormStore<GenericForm>; the lookup above narrows
  // back to the caller's (F, G) via the `existing as FormStore<Form,
  // GetValueFormType>` cast. The registry Map is intentionally
  // generic-erased — the alternative (parameterising the Map) would
  // force every internal caller to carry both generics.
  ;(registry.forms as Map<FormKey, FormStore<GenericForm>>).set(
    key,
    state as unknown as FormStore<GenericForm>
  )
  return state
}

/**
 * Module-local counter for the "no Vue instance in scope" fallback
 * (tests, raw composable calls outside setup). Collisions with
 * user-supplied keys are avoided by the reserved `__atta:anon:` prefix
 * (consumer keys starting with `__atta:` are rejected at construction).
 * Inside
 * setup — the common path — `useId()` produces a tree-position-stable
 * id that matches across SSR hydration, so two mounts of the same
 * component tree resolve to the same anonymous key and hydration
 * works without user bookkeeping.
 */
let anonCounter = 0

/**
 * Module-local counter for `formInstanceId` allocation outside Vue
 * setup (tests, ad-hoc composable usage). The setup-context path uses
 * `useId()` for SSR-stable IDs; this counter is the test-only fallback.
 */
let formInstanceCounter = 0

/**
 * One entry per ANONYMOUS `useForm()` call that landed in a
 * component's ambient provide slot. Keyed forms aren't recorded —
 * they don't fill the ambient slot in the first place. `source` is
 * the best-effort user call site (first non-attaform frame off
 * `new Error().stack`) — printed in the collision warning so the
 * author can navigate to each offending call site.
 */
export type AmbientProvideEntry = {
  readonly source: string | undefined
}

/**
 * Tracks which Vue component instances have already run
 * `provide(kFormContext, ...)` via `useAbstractForm`. Dev-only —
 * `null` in production so the WeakMap allocation tree-shakes out.
 * A `WeakMap` keyed by the instance object lets Vue GC each
 * component's entry when it unmounts without us tracking
 * lifecycle.
 *
 * Exported so `injectForm<F>()` (no key) can walk the parent
 * chain and emit a collision warning only when a descendant
 * actually consumes the ambient slot — eager warning in
 * `useForm()` misfired on components that call useForm multiple
 * times intentionally but have no keyless consumer.
 */
export const ambientProvideHistory: WeakMap<object, AmbientProvideEntry[]> | null = __DEV__
  ? new WeakMap<object, AmbientProvideEntry[]>()
  : null

function recordAmbientProvide(ssr: boolean): void {
  if (!__DEV__ || ssr || ambientProvideHistory === null) return
  const instance = getCurrentInstance()
  if (instance === null) return
  const instanceKey = instance as unknown as object
  // Caller already gated on `configuration.key === undefined`, so every
  // recorded entry corresponds to an anonymous useForm() call. No need
  // to carry a key — synthetic `__atta:anon:<id>` keys aren't addressable
  // by the author and would only add noise to the warning.
  const entry: AmbientProvideEntry = {
    source: captureUserCallSite(),
  }
  const existing = ambientProvideHistory.get(instanceKey)
  if (existing === undefined) {
    ambientProvideHistory.set(instanceKey, [entry])
    return
  }
  existing.push(entry)
}

/**
 * Normalise `configuration.key` into a concrete FormKey. Explicit keys
 * pass through after a reserved-namespace check (anything starting
 * with `__atta:` is rejected with `ReservedFormKeyError`); empty /
 * nullish keys are treated as anonymous and allocated a unique id
 * under the `__atta:anon:` prefix. The reserved-prefix reject + the
 * synthetic-prefix reservation together guarantee zero collision
 * between consumer-chosen keys and library-allocated synthetic ones.
 *
 * Anonymous semantics: each `useForm({ schema })` call without a key
 * resolves to a distinct FormStore. Descendant components reach it via
 * ambient `injectForm<F>()`; cross-component lookup by key is not
 * possible (and not meaningful — the key is synthetic). Callers that
 * need shared state, distant lookup, persistence defaults, or a
 * recognisable DevTools label should pass an explicit `key`.
 */
function resolveFormKey(key: FormKey | undefined): FormKey {
  if (key !== undefined && key !== null && key !== '') {
    // Reject any consumer-supplied key in the reserved `__atta:`
    // namespace. Without this, a consumer key like `__atta:anon:0`
    // could silently collide with the synthetic anonymous-key
    // allocation below — both would land on the same FormStore in
    // the registry, and the dev-mode schema-fingerprint warning
    // only catches collisions when schemas differ. Throwing here
    // makes the collision impossible by construction.
    if (key.startsWith(RESERVED_KEY_PREFIX)) {
      throw new ReservedFormKeyError(key)
    }
    return key
  }
  // In setup context, `useId()` threads through Vue's SSR id-allocator
  // so server-rendered and client-hydrated trees agree on the same
  // synthetic key.
  if (getCurrentInstance() !== null) {
    return `${ANONYMOUS_FORM_KEY_PREFIX}${useId()}`
  }
  // Outside setup (tests, ad-hoc composable use) there's no Vue
  // instance to draw from; fall back to a module-local counter.
  return `${ANONYMOUS_FORM_KEY_PREFIX}${anonCounter++}`
}

/**
 * Resolve the hashed schema fingerprint that keys a form's persisted
 * draft. `schema.fingerprint()` dynamic-imports the fingerprint walker
 * and may reject (some shapes make an adapter throw, e.g. a v3
 * `z.nativeEnum` that spreads the enum object). Persistence must never
 * crash a consumer's mount, so a rejection degrades to a stable
 * fingerprint-free token: persistence still works, it just loses
 * automatic schema-change invalidation for this form. Resolved in the
 * persist wiring's async IIFE, in parallel with the chunk import, so no
 * synchronous caller waits on it.
 */
async function resolvePersistFingerprintToken<F extends GenericForm>(
  state: FormStore<F, GenericForm>
): Promise<string> {
  try {
    return hashStableString(await state.schema.fingerprint())
  } catch (err) {
    if (__DEV__) {
      console.warn(
        `[attaform] Could not fingerprint the schema for form '${state.formKey}': ` +
          `${err instanceof Error ? err.message : String(err)}. Persistence falls back to a ` +
          `fingerprint-free key, so a schema change won't auto-invalidate a saved draft.`
      )
    }
    return 'unfingerprinted'
  }
}

/**
 * Tracks the FormStore identities the anon-persist warn already
 * fired for in production. Dev-mode throws (via AnonPersistError)
 * don't need a dedupe set — the throw aborts the call before
 * subsequent identical calls can land.
 */
const warnedAnonPersistKeys: Set<string> = new Set<string>()

/**
 * Anonymous + `persist:` is unsafe by construction: the synthetic
 * `__atta:anon:<id>` identity drifts on every remount (Vue's `useId()`
 * allocator is per-app and per-tree-position; HMR rebuilds the
 * instance) AND can collide between two unrelated anon forms that
 * happen to land on the same id. With matching schemas + backend,
 * the second form would read the first's draft and write back over
 * it — actual cross-form data leakage, not just stale entries.
 *
 * Two-tier handling:
 *   - **Dev** (`__DEV__` true): throw `AnonPersistError`. Hard-fails
 *     the call at the offending useForm() site.
 *   - **Prod**: one-shot `console.warn` + return `true` so the
 *     caller skips persistence wiring entirely. A deployed app
 *     shipping the anti-pattern shouldn't hard-crash, but it also
 *     shouldn't silently mis-route data — disabling the mechanism
 *     is the safe failure.
 *
 * Returns `true` when persistence MUST be skipped (anon + persist).
 */
function enforceAnonPersistRule(formKey: string, ssr: boolean): boolean {
  if (!formKey.startsWith(ANONYMOUS_FORM_KEY_PREFIX)) return false
  if (__DEV__)
    throw new AnonPersistError({
      cause: 'no-key',
      callSite: captureUserCallSite(),
    })
  // Production: warn + tell the caller to skip wiring. Client-only
  // warn (skip server logs to avoid spamming SSR per-request output).
  // Persist is still skipped on the SSR pass — same disabling
  // outcome — just without the log noise.
  if (!ssr && !warnedAnonPersistKeys.has(formKey)) {
    warnedAnonPersistKeys.add(formKey)
    console.warn(
      "[attaform] persist: ignored — anonymous useForm() can't safely persist " +
        '(key drift + cross-form collision risk).\n' +
        '  Persistence is disabled for this form; the app keeps working.\n' +
        "  Fix: useForm({ schema, key: 'login', persist: '...' })"
    )
  }
  return true
}

export type { FieldState }
