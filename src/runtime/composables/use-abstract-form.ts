import {
  getCurrentInstance,
  getCurrentScope,
  onScopeDispose,
  onServerPrefetch,
  provide,
  toRaw,
  useId,
} from 'vue'
import { buildFormApi } from '../core/build-form-api'
import { createFormStore, type FormStore } from '../core/create-form-store'
import {
  ANONYMOUS_FORM_KEY_PREFIX,
  DEFAULT_MAX_RECURSION_DEPTH,
  pickDefined,
  RESERVED_KEY_PREFIX,
} from '../core/defaults'
import { __DEV__ } from '../core/dev'
import { captureUserCallSite } from '../core/dev-stack-trace'
import { InvalidUseFormConfigError, ReservedFormKeyError } from '../core/errors'
import type { FieldState } from '../core/field-state-api'
import { getComputedSchema } from '../core/get-computed-schema'
import type { PathKey } from '../core/paths'
import { ensureAttaformInstalled } from '../core/plugin'
import { kFormContext, kFormInstanceId, useRegistry, type AttaformRegistry } from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { walkUnsetSentinels } from '../core/unset-walker'
import type {
  AbstractSchema,
  FormKey,
  HistoryModule,
  UseFormReturnType,
  UseFormConfiguration,
} from '../types/types-api'
import type { DeepPartial, DefaultValuesInput, GenericForm, WriteShape } from '../types/types-core'

/**
 * Schema-agnostic `useForm`, accepting anything that implements
 * `AbstractSchema`. Reach for it when integrating a custom adapter or a
 * validation library Attaform ships no adapter for.
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
 * The return is the same form the typed entry points hand back; see
 * `UseFormReturnType`. Most consumers want one of those instead, since
 * they attach the matching adapter for you.
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
   * Internal escape hatch for a caller that already holds a registry and
   * has to build a form outside Vue's setup context, such as the
   * wizard's lazy noop builder running inside a `computed` re-eval. It
   * skips the strict `useRegistry()` call and nothing else. Not public.
   */
  options?: { readonly registry?: AttaformRegistry }
): UseFormReturnType<Form, GetValueFormType, ReadForm, K> {
  // Catches `useForm()`, `useForm(null)`, `useForm(rawSchema)` (a schema
  // passed directly, so `.schema` is undefined) and an explicit
  // `useForm({ schema: undefined })`, all before anything downstream
  // reads `configuration.schema`.
  if (
    configuration === undefined ||
    configuration === null ||
    (configuration as { schema?: unknown }).schema === undefined
  ) {
    throw new InvalidUseFormConfigError()
  }

  const key = resolveFormKey(configuration.key)

  // One FormStore per (app, formKey), so every `useForm` call sharing a
  // key shares the store. That is the whole point of opting into one.
  //
  // Attach the registry if the consumer never called `createAttaform()`.
  // Idempotent, and an explicit install (Nuxt module, manual
  // `app.use(...)`) that ran first wins. `useRegistry()` below still
  // throws `OutsideSetupError` outside setup.
  const instance = getCurrentInstance()
  if (instance !== null) ensureAttaformInstalled(instance.appContext.app)
  const registry = options?.registry ?? useRegistry()

  // `walkUnsetSentinels` inside `buildFreshState` wants a plain
  // `DeepPartial<...>`, so collapse the `T | (() => T) | (() =>
  // Promise<T>)` trichotomy first. A sync input is used as-is; a
  // function swaps to `undefined` so the form constructs against the
  // schema's slim defaults, and the factory settles into
  // `state.applyFormReplacement` once it resolves (wired below).
  const resolvedDefaults = resolveTrichotomy<
    | DefaultValuesInput<Form>
    | undefined
    | (() => DefaultValuesInput<Form> | Promise<DefaultValuesInput<Form>>)
  >(configuration.defaultValues)
  // `exactOptionalPropertyTypes` refuses an explicit `undefined` on the
  // optional field, so omit the key rather than set it undefined.
  const materialisedDefaults: DefaultValuesInput<Form> | undefined =
    resolvedDefaults.kind === 'sync'
      ? (resolvedDefaults.value as DefaultValuesInput<Form> | undefined)
      : undefined
  const { defaultValues: _droppedDefaults, ...configWithoutDefaults } = configuration
  void _droppedDefaults
  const materialisedConfiguration: UseFormConfiguration<
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

  // Accepts an AbstractSchema or a factory, and MUST preserve both
  // generics: dropping `GetValueFormType` would make
  // `state.schema.getSchemasAtPath(...)` hand back
  // `AbstractSchema<_, Form>[]` for any schema whose runtime shape
  // deliberately differs, such as an adapter that narrows via a
  // transform.
  const existing = registry.forms.get(key) as FormStore<Form, GetValueFormType> | undefined
  // A second `useForm({ key })` on a live store drops its own schema in
  // favour of the first caller's wiring, so resolving one is pure
  // garbage in a production build. A dev build still resolves it,
  // because the key-collision warning below needs this call site's own
  // answer to compare against.
  const resolvedSchema =
    existing === undefined || __DEV__
      ? getComputedSchema(key, configuration.schema, {
          maxRecursionDepth: DEFAULT_MAX_RECURSION_DEPTH,
        })
      : existing.schema
  if (__DEV__ && existing !== undefined) {
    // Sharing one store means the second call's schema is dropped for
    // the first's wiring, which is silent and wrong when the two call
    // sites are unrelated and only happen to agree on a key. The
    // diagnostics sit in `core/dev-key-collision-warnings.ts` behind
    // this gate, so a production build folds the gate away and drops the
    // whole module.
    void import('../core/dev-key-collision-warnings').then((m) => {
      void m.warnOnSchemaFingerprintMismatch(key, existing.schema, resolvedSchema)
    })
  }
  // Read BEFORE `buildFreshState` consumes it. It is what lets the
  // client skip re-firing an async-defaults factory: the server already
  // resolved it and the values rode the payload, so firing again would
  // double-fetch.
  const hadPendingHydration = registry.pendingHydration.has(key)

  const state: FormStore<Form, GetValueFormType> =
    existing ??
    buildFreshState<Form, GetValueFormType>(
      key,
      resolvedSchema,
      materialisedConfiguration,
      registry
    )

  // Once per FormStore. Sync inputs applied at construction; async ones
  // stay dormant until the first reactive interaction reaches
  // `state.activate()`. A later `useForm({ key })` landing on the same
  // store watches `state.hydrating` instead of re-firing.
  if (existing !== undefined) {
    // A live store's `defaultsResolved` already carries the first
    // caller's effective state. Leave it alone.
  } else if (resolvedDefaults.kind === 'sync') {
    state.defaultsResolved.value = true
  }
  if (existing === undefined && resolvedDefaults.kind === 'async') {
    const factory = resolvedDefaults.factory as () =>
      DefaultValuesInput<Form> | Promise<DefaultValuesInput<Form>>
    state.defaultValuesFactory.value = factory
    if (hadPendingHydration) {
      // The payload IS the effective default state, and the store has to
      // be told so. Without it the client half of an SSR'd async form
      // behaves as though its defaults never arrived: `dirty` reads true
      // the moment the page hydrates, and `form.reset()` throws away the
      // server-fetched resource for schema-slim values (#576). Same
      // `adoptResolvedDefaults` call the factory path makes, except the
      // payload already sits in form storage, so it is read back rather
      // than re-derived.
      state.adoptResolvedDefaults(toRaw(state.form.value))
      state.hydrating.value = false
      state.defaultsResolved.value = true
    } else if (registry.ssr) {
      // Server side, dispatch is coordinated through the registry's
      // prefetch queue. `onServerPrefetch` registers unconditionally and
      // calls `state.activate()` only for a key that is enqueued and not
      // skipped. Four things enqueue: an explicit `form.activate()` in
      // setup, the wizard's current-step auto-mark, the compile-time
      // `__ssrAccessed` injection, and any gated reactive read during
      // setup. A form nobody touched stays dormant, so the factory never
      // runs and the payload serialises the schema's slim defaults.
      if (configuration.__ssrAccessed === true) {
        registry.enqueuePrefetch(key)
      }
      onServerPrefetch(() => {
        if (!registry.shouldPrefetch(key)) return
        return state.activate()
      })
    }
    // On the client the factory stays dormant until the first reactive
    // interaction reaches `state.activate()`. Lazy by default.
  }

  // The registry evicts the FormStore once the last consumer disposes.
  // Guarded on `getCurrentScope()` so a caller with no effect scope
  // cannot leak a pinned consumer; `setup()` always provides one, so
  // this is defence in depth. Counter semantics on
  // `registry.trackConsumer`.
  if (getCurrentScope() !== undefined) {
    const releaseConsumer = registry.trackConsumer(key)
    onScopeDispose(releaseConsumer)
  }

  // The plugin object carries the runtime: `historyPlugin()` rides the
  // consumer's own `attaform/history` import, so the core never links
  // the history internals. `attach` subscribes synchronously, before any
  // mutation can slip past unrecorded. Fresh state only, since attaching
  // twice would double-push snapshots. Caching on the FormStore is what
  // keeps `canUndo` / `canRedo` / `historySize` / `undo` / `redo`
  // agreeing across mount order for every consumer of the same key.
  if (existing === undefined && materialisedConfiguration.history !== undefined) {
    const historyModule = materialisedConfiguration.history.attach(state)
    state.modules.set(HISTORY_MODULE_KEY, historyModule)
    state.registerCleanup(() => historyModule.dispose())
  }

  // ONLY an anonymous `useForm()` fills the ambient slot. A keyed form
  // is addressable as `injectForm<F>(key)` and stays out of the ambient
  // context, which keeps the two resolution modes distinct: a descendant
  // of a keyed-only parent calling `injectForm<F>()` gets "no ambient
  // form", and that is the right answer, since the form has a name.
  //
  // Among siblings the last provide wins, so two anonymous calls in one
  // component leave descendants seeing only the second. Recording the
  // per-instance history here (silently) is what lets a descendant's
  // `injectForm<F>()` walk up and warn lazily. Skipped on SSR so the
  // warn fires once rather than once per render pass.
  if (configuration.key === undefined) {
    recordAmbientProvide(registry.ssr)
    provide(kFormContext, state as FormStore<GenericForm>)
  }

  // Distinct from `state.formKey`: the key names a SHARED store, while
  // this names THIS call site, which is what scopes `focusFirstError`
  // and `scrollToFirstError` to the elements this caller's `v-register`
  // directives bound. `useId()` keeps it SSR-stable; outside setup a
  // module-local counter is enough, since uniqueness is all that is
  // being asked of it.
  const formInstanceId =
    getCurrentInstance() !== null ? useId() : `atta:form-instance:${formInstanceCounter++}`
  // Descendants reaching in through `injectForm()` inherit this id, so
  // their locally-registered elements tag against the same instance.
  // Sibling `useForm()` calls provide their own and stay isolated.
  if (getCurrentInstance() !== null) {
    provide(kFormInstanceId, formInstanceId)
  }

  // Each call site carries its own `validateOn` / `debounceMs` /
  // `coerce` / `rememberVariants`, threaded through `buildFormApi` into
  // register's coerce closure, the field-state predicate and the
  // WriteMeta on store writes. So a modal and a main form sharing one
  // FormStore can still validate on different cadences and reveal errors
  // under different rules.
  const apiOptions: Parameters<typeof buildFormApi<Form, GetValueFormType>>[2] = pickDefined({
    focusOnInvalidSubmit: materialisedConfiguration.focusOnInvalidSubmit,
    history: state.modules.get(HISTORY_MODULE_KEY) as HistoryModule | undefined,
    validateOn: materialisedConfiguration.validateOn,
    debounceMs: (materialisedConfiguration as { debounceMs?: number }).debounceMs,
    coerce: materialisedConfiguration.coerce,
    rememberVariants: materialisedConfiguration.rememberVariants,
  })
  // `buildFormApi` returns the schema-agnostic shape (`ReadForm =
  // Form`); an adapter caller computes the richer `ReadForm`, such as
  // zod-v4's `StorageShape<Schema>`, and asserts it through the public
  // return type. The same proxies serve both views at runtime.
  const api = buildFormApi<Form, GetValueFormType>(state, formInstanceId, apiOptions)

  return api as unknown as UseFormReturnType<Form, GetValueFormType, ReadForm, K>
}

/** Key for the per-state history module cache, shared with `injectForm`. */
const HISTORY_MODULE_KEY = 'history'

function buildFreshState<F extends GenericForm, G extends GenericForm = F>(
  key: FormKey,
  schema: AbstractSchema<F, G>,
  configuration: UseFormConfiguration<F, G, AbstractSchema<F, G>, DefaultValuesInput<F>>,
  registry: ReturnType<typeof useRegistry>
): FormStore<F, G> {
  const pending = registry.pendingHydration.get(key)
  if (pending !== undefined) registry.pendingHydration.delete(key)
  // Replaces every `unset` sentinel with the schema's slim default and
  // collects the path keys. It also auto-marks every primitive leaf the
  // consumer did NOT cover, because a freshly opened form has had no
  // user input, so an unspecified leaf is logically blank; supplying any
  // non-`unset` value opts a leaf out. TypeScript rejects `unset` at a
  // non-primitive leaf, and a plain-JS consumer who gets there anyway
  // gets a dev warn.
  const walked = walkUnsetSentinels(
    configuration.defaultValues,
    schema as unknown as AbstractSchema<GenericForm, GenericForm>
  )
  // A hydration payload's `blankPaths` is authoritative. The walker
  // still runs, to scrub `unset` symbols before they can reach storage,
  // but its discovered paths are dropped in favour of the hydrated set.
  // Otherwise a server-rendered form with no blank paths would acquire
  // the ones the client's construction-time defaults invented.
  //
  // `walked.paths` passes through unreformatted because the walker emits
  // the same opaque `PathKey` strings that `setValueAtPath`, DU reshape,
  // hydration apply and history snapshots all key `blankPaths` by.
  let initialBlankPaths: ReadonlyArray<PathKey> | undefined
  if (pending === undefined) {
    initialBlankPaths = walked.paths
  }
  const createOptions: Parameters<typeof createFormStore<F, G>>[0] = {
    formKey: key,
    schema,
    defaultValues: walked.cleanedValues as DeepPartial<WriteShape<F>> | undefined,
    hydration: pending,
    ssr: registry.ssr,
    ...pickDefined({
      validateOn: configuration.validateOn,
      debounceMs: (configuration as { debounceMs?: number }).debounceMs,
      rememberVariants: configuration.rememberVariants,
      disabled: configuration.disabled,
      coerce: configuration.coerce,
      initialBlankPaths,
    }),
    // Server only. `enqueue` records intent on every `state.activate()`
    // so a wizard skip-list override has a consistent set to diff
    // against; `shouldFire` lets the activate path bail on a key the
    // wizard skipped. Even an explicit `form.activate()` defers to that
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
  }
  const state = createFormStore<F, G>(createOptions)
  // The registry Map is deliberately generic-erased; parameterising it
  // would force every internal caller to carry both generics. The lookup
  // above narrows back to the caller's (F, G).
  ;(registry.forms as Map<FormKey, FormStore<GenericForm>>).set(
    key,
    state as unknown as FormStore<GenericForm>
  )
  return state
}

/**
 * Feeds the anonymous key when there is no Vue instance in scope, which
 * means tests and raw composable calls. It cannot collide with a
 * consumer key, since those are rejected under the reserved `__atta:`
 * prefix. In setup, the common path, `useId()` supplies a
 * tree-position-stable id that matches across SSR hydration, so two
 * mounts of one component tree land on the same anonymous key.
 */
let anonCounter = 0

/** Allocates `formInstanceId` outside setup; in setup, `useId()` does. */
let formInstanceCounter = 0

/**
 * One entry per ANONYMOUS `useForm()` call that landed in a component's
 * ambient provide slot; a keyed form never fills that slot, so it is
 * never recorded. `source` is the best-effort user call site, the first
 * non-attaform frame off `new Error().stack`, printed in the collision
 * warning so the author can navigate to each one.
 */
export type AmbientProvideEntry = {
  readonly source: string | undefined
}

/**
 * Which component instances have already run `provide(kFormContext,
 * ...)` through `useAbstractForm`. Dev only, `null` in production so the
 * allocation tree-shakes out. Keying the `WeakMap` by the instance
 * object lets Vue collect each entry on unmount with no lifecycle
 * bookkeeping here.
 *
 * Exported so a no-key `injectForm<F>()` can walk the parent chain and
 * warn about a collision only when a descendant actually consumes the
 * ambient slot.
 */
export const ambientProvideHistory: WeakMap<object, AmbientProvideEntry[]> | null = __DEV__
  ? new WeakMap<object, AmbientProvideEntry[]>()
  : null

function recordAmbientProvide(ssr: boolean): void {
  if (!__DEV__ || ssr || ambientProvideHistory === null) return
  const instance = getCurrentInstance()
  if (instance === null) return
  const instanceKey = instance as unknown as object
  // The caller gated on `configuration.key === undefined`, so every
  // entry is an anonymous call. Carrying the synthetic
  // `__atta:anon:<id>` key would only add noise: no author can address
  // it.
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
 * Normalise `configuration.key` into a concrete FormKey. An explicit key
 * passes through after a reserved-namespace check; an empty or nullish
 * one is anonymous and gets a unique id under `__atta:anon:`. Rejecting
 * the reserved prefix and allocating synthetics under it is what makes
 * a collision between the two impossible rather than unlikely.
 *
 * Every keyless `useForm({ schema })` call resolves to its own
 * FormStore, reachable from descendants through ambient
 * `injectForm<F>()` but not by key, the key being synthetic. Pass an
 * explicit `key` for shared state, lookup from a distance, or a
 * readable DevTools label.
 */
function resolveFormKey(key: FormKey | undefined): FormKey {
  if (key !== undefined && key !== null && key !== '') {
    // A consumer key like `__atta:anon:0` would otherwise collide with
    // the synthetic allocation below, landing both on one FormStore, and
    // the dev-mode schema-mismatch warning only catches a collision when
    // the schemas differ. Throwing makes it impossible by construction.
    if (key.startsWith(RESERVED_KEY_PREFIX)) {
      throw new ReservedFormKeyError(key)
    }
    return key
  }
  // `useId()` threads through Vue's SSR id-allocator, so the
  // server-rendered and client-hydrated trees agree on the key.
  if (getCurrentInstance() !== null) {
    return `${ANONYMOUS_FORM_KEY_PREFIX}${useId()}`
  }
  // Outside setup there is no instance to draw from.
  return `${ANONYMOUS_FORM_KEY_PREFIX}${anonCounter++}`
}

export type { FieldState }
