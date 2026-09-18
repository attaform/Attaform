/**
 * Per-Vue-app container for every form state instance. Each
 * `app.use(createAttaform())` call gets its own registry, so Attaform runs
 * under bare Vue 3, SSR through `@vue/server-renderer`, and Nuxt on one
 * code path.
 *
 * Forms are stored as `Map<FormKey, FormStore<GenericForm>>`. The generic
 * has to relax at storage time because two forms in one app have different
 * `Form` generics; a caller recovers the specific type through `useForm`'s
 * overloads.
 */
import type { App, InjectionKey } from 'vue'
import { getCurrentInstance, inject, shallowReactive } from 'vue'
import type { FormKey } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { UseWizardReturnType } from '../types/types-wizard'
import type { FormStore } from './create-form-store'
import { OutsideSetupError, RegistryNotInstalledError } from './errors'
import { detectSSR, type SSRDetectOptions } from './ssr'

/**
 * Serialised snapshot of one form's state, captured by
 * `renderAttaformState` for SSR and replayed by
 * `hydrateAttaformState` on the client. Round-trips through
 * JSON-safe tuples; field references are intentionally omitted
 * (DOM nodes don't survive serialisation).
 */
export type SerializedFormData = {
  /** The form's value at snapshot time. */
  readonly form: unknown
  /**
   * Errors produced by the schema at snapshot time. Replayed into
   * the client form's error state at hydration; cleared on
   * successful re-validation client-side.
   */
  readonly schemaErrors: ReadonlyArray<readonly [string, unknown]>
  /**
   * Errors set explicitly via `setErrors` (typically a server
   * response) at snapshot time. Replayed at hydration; persists across
   * client-side re-validation.
   */
  readonly userErrors: ReadonlyArray<readonly [string, unknown]>
  /** Per-field metadata (timestamps, raw values, connection flags) captured at snapshot time. */
  readonly fields: ReadonlyArray<readonly [string, unknown]>
  /**
   * Path keys that were in the form's `blankPaths` set at snapshot time,
   * carrying the "displayed empty" UI state across the SSR boundary.
   * Without it the client briefly renders `String(slim-default)` (`'0'`,
   * say) for a field the server rendered blank. Optional in the wire
   * format, so an older payload shape still deserialises.
   */
  readonly blankPaths?: ReadonlyArray<string>
}

export type PendingHydration = Map<FormKey, SerializedFormData>

/**
 * Attaform's per-Vue-app container, one per `app.use(createAttaform())`
 * call.
 *
 * Most consumers never touch it: `useForm` and `injectForm` reach the
 * registry for you. Access it explicitly only when wiring SSR or a custom
 * plugin integration.
 */
export type AttaformRegistry = {
  /**
   * Live forms keyed by `FormKey`.
   * @internal
   */
  readonly forms: Map<FormKey, FormStore<GenericForm>>
  /**
   * Live wizards keyed by the consumer-supplied `key` option. Populated by
   * `useWizard(entryForm, { key })` and read by `injectWizard(key)` to
   * resolve a cross-component wizard handle. An anonymous wizard does NOT
   * register here, and is reachable only through ambient provide/inject.
   * @internal
   */
  readonly wizards: Map<string, UseWizardReturnType>
  /**
   * Snapshots staged by `hydrateAttaformState` waiting to be consumed by the next `useForm` call.
   * @internal
   */
  readonly pendingHydration: PendingHydration
  /** `true` while running on the server during SSR; `false` on the client. */
  readonly ssr: boolean
  /**
   * Track a consumer of `key`, returning a dispose function to call when
   * that consumer unmounts. The form is evicted once the last consumer
   * disposes, so a long-running SPA does not leak detached state across
   * navigations.
   * @internal
   */
  readonly trackConsumer: (key: FormKey) => () => void
  /**
   * Track a consumer of wizard `key`, returning a dispose function to call
   * when that consumer unmounts. The handle leaves `wizards` once the last
   * consumer disposes, mirroring the form consumer counting. An anonymous
   * wizard never enters this counter, having no key to count under.
   * @internal
   */
  readonly trackWizardConsumer: (key: string) => () => void
  /**
   * Mark a form as eligible for SSR prefetch. The form's
   * `onServerPrefetch` hook reads `shouldPrefetch(key)` and runs the
   * captured `defaultValues` factory only when this set holds the key and
   * the skip set does not. Set by `form.activate()` and by `useWizard`'s
   * current-step auto-mark.
   * @internal
   */
  readonly enqueuePrefetch: (key: FormKey) => void
  /**
   * Mark a form as ineligible for SSR prefetch, overriding
   * `enqueuePrefetch`. `useWizard` uses it to keep a non-current step
   * dormant on the server even when a stray `activate()` enqueued it: the
   * wizard's "the user is not on this step" signal wins.
   * @internal
   */
  readonly skipPrefetch: (key: FormKey) => void
  /**
   * Whether `key`'s SSR prefetch should run. Returns `true` iff the key
   * is enqueued AND not skipped.
   * @internal
   */
  readonly shouldPrefetch: (key: FormKey) => boolean
}

/**
 * The Vue `InjectionKey` the registry is provided under on the app. Most
 * consumers never need it: `useForm` and `injectForm` resolve the registry
 * automatically.
 */
// `Symbol.for` so the key survives module duplication. When Vite's dep
// optimizer serves Attaform as two copies, one live-ESM and one
// pre-bundled (the standard hazard for a linked-source install that opts
// into `optimizeDeps.include`), each copy still resolves the same global
// symbol from the well-known string. Plugin install's
// `app.provide(kAttaformRegistry, ...)` and the page's
// `inject(kAttaformRegistry, null)` therefore agree, and `useForm` finds
// its registry whichever copy did the provide. The `attaform:` prefix
// namespaces it. Same for `kFormContext` and `kFormInstanceId` below.
export const kAttaformRegistry: InjectionKey<AttaformRegistry> = Symbol.for('attaform:registry')

/**
 * Provides the nearest-ancestor wizard handle to descendants. Installed
 * by `useWizard` after the handle is built, so any nested component can
 * call `injectWizard()` (no key) to reach the closest wizard without
 * threading the handle through props.
 *
 * Shaped like `kFormContext`, `Symbol.for` included for
 * module-duplication safety, and consumers never read the key directly. A
 * keyed wizard stays reachable through `injectWizard(key)` from any tree
 * position; this ambient slot is the convenience path for a component
 * that wants whatever wizard is above it.
 */
export const kAttaformAncestorWizard: InjectionKey<UseWizardReturnType> = Symbol.for(
  'attaform:ancestor-wizard'
)

/**
 * Optional framework-aware resolver for the wizard's active step. The
 * `attaform/nuxt` runtime plugin provides this so `useWizard` can read
 * the current step from `useRoute().query[<param>]` without the wizard
 * core importing any framework router. Bare-Vue consumers wire
 * `options.restore` explicitly instead, or let the default `?step=<key>`
 * restore in `useWizard` handle the deep-link case.
 *
 * It takes the wizard's URL param name (default `'step'`) and returns the
 * matching query value or `undefined`. Called once during `useWizard()`
 * construction, after any explicit `options.restore` is consulted.
 */
export type WizardActiveStepResolver = (param: string) => string | undefined

export const kAttaformWizardActiveStepResolver: InjectionKey<WizardActiveStepResolver> = Symbol.for(
  'attaform:wizard-active-step-resolver'
)

/**
 * Provides the current form's FormStore to descendants. Installed by
 * `useAbstractForm` after it resolves the state, so any nested component
 * can call `injectForm()` without prop-threading the form API.
 *
 * Typed as `FormStore<GenericForm>`: Vue's InjectionKey erases the generic
 * at the provide/inject boundary, so the descendant that re-emerges the
 * shape supplies its own `Form`.
 */
export const kFormContext: InjectionKey<FormStore<GenericForm>> =
  Symbol.for('attaform:form-context')

/**
 * Provide / inject key for the per-`useForm()`-call instance ID, provided
 * alongside `kFormContext` so a descendant reaching in through
 * `injectForm()` inherits the ancestor's `formInstanceId` and tags its
 * locally-registered elements against the SAME instance. That is what
 * keeps parent-submit-focus working for an input a deep child registered.
 *
 * Sibling `useForm({ key })` calls (a sidebar and a main form rendering
 * the same form) sit at distinct tree positions, so each provides its own
 * ID and each branch's descendants inherit that branch's. The two ID
 * spaces stay isolated even while the FormStore underneath is shared.
 */
export const kFormInstanceId: InjectionKey<string> = Symbol.for('attaform:form-instance-id')

declare module 'vue' {
  interface App {
    /** @internal */
    _attaform?: AttaformRegistry
  }
}

/** Options for `createRegistry`. */
export type CreateRegistryOptions = SSRDetectOptions

/**
 * Create a fresh `AttaformRegistry`. `createAttaform()` calls it
 * internally, so reach for it directly only when building a custom plugin
 * that does not want `createAttaform`'s auto-install behaviour: a test
 * harness, or an embedded app.
 */
export function createRegistry(options: CreateRegistryOptions = {}): AttaformRegistry {
  const ssr = detectSSR(options)
  // The outer object is plain, holding references nothing rebinds. The
  // inner Maps are reactive through Vue's collection handlers so a per-key
  // read tracks per key, and `shallowReactive` keeps Vue's deep
  // Ref-unwrapping from mangling `FormStore.form`'s `Ref<F>` into `F`.
  const forms = shallowReactive(new Map<FormKey, FormStore<GenericForm>>())
  // Wizards live alongside forms on a simpler lifecycle: no IO to drain on
  // eviction, the handle being an object closing over per-form state. The
  // container is reactive so a template (a dev panel) can observe
  // registration.
  const wizards = shallowReactive(new Map<string, UseWizardReturnType>())
  const pendingHydration = shallowReactive(new Map<FormKey, SerializedFormData>())
  // Consumer counts are bookkeeping, not reactive. No template should
  // depend on how many useForm calls are live, and a plain Map keeps the
  // per-mount increment from triggering watchers.
  const consumers = new Map<FormKey, number>()

  // Eviction defers to the next microtask when the consumer count hits
  // zero, so a new consumer claiming the same key inside the tick cancels
  // the schedule and reuses the live FormStore. That covers Vue's HMR
  // re-mount, a `<KeepAlive>` swap, and any synchronous
  // unmount-then-remount. Tokens are per schedule, so a churn cycle
  // flipping zero → one → zero makes a fresh schedule and the older
  // token's microtask no-ops on the cancellation flag.
  type EvictionToken = { cancelled: boolean }
  const pendingEvictions = new Map<FormKey, EvictionToken>()

  function cancelPendingEviction(key: FormKey): void {
    const pending = pendingEvictions.get(key)
    if (pending === undefined) return
    pending.cancelled = true
    pendingEvictions.delete(key)
  }

  function trackConsumer(key: FormKey): () => void {
    // A new consumer claiming the key while an eviction is pending is
    // a re-mount, not a termination. Cancel before bumping the count.
    cancelPendingEviction(key)
    consumers.set(key, (consumers.get(key) ?? 0) + 1)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const remaining = (consumers.get(key) ?? 1) - 1
      if (remaining > 0) {
        consumers.set(key, remaining)
        return
      }
      // Last consumer disposed. Schedule eviction on the next microtask,
      // cancelled if a new consumer claims the key first. `consumers`
      // clears immediately so a re-mount's count starts at one, as a cold
      // mount's does, while `forms` stays populated so the re-mount's
      // `useForm({ key })` lookup finds the live FormStore and does not
      // re-fire the factory.
      consumers.delete(key)
      const token: EvictionToken = { cancelled: false }
      pendingEvictions.set(key, token)
      queueMicrotask(() => {
        if (token.cancelled) return
        // Defensive: a newer schedule replacing this token without
        // cancelling it cannot happen on the current path, and the guard
        // states that invariant.
        if (pendingEvictions.get(key) !== token) return
        pendingEvictions.delete(key)
        const state = forms.get(key)
        forms.delete(key)
        if (state === undefined) return
        state.dispose()
      })
    }
  }

  // Wizard ref-counting and deferred eviction, mirroring the form
  // mechanics above minus the drain step, wizards having no IO. The
  // cancel-on-reclaim covers the wizard HMR / KeepAlive remount: a fresh
  // consumer claiming the key inside the tick cancels the schedule and
  // reuses the live handle, so a child on `injectWizard(key)` is not
  // handed a stale reference after its parent re-mounts.
  const wizardConsumers = new Map<string, number>()
  const pendingWizardEvictions = new Map<string, EvictionToken>()

  function cancelPendingWizardEviction(key: string): void {
    const pending = pendingWizardEvictions.get(key)
    if (pending === undefined) return
    pending.cancelled = true
    pendingWizardEvictions.delete(key)
  }

  function trackWizardConsumer(key: string): () => void {
    cancelPendingWizardEviction(key)
    wizardConsumers.set(key, (wizardConsumers.get(key) ?? 0) + 1)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const remaining = (wizardConsumers.get(key) ?? 1) - 1
      if (remaining > 0) {
        wizardConsumers.set(key, remaining)
        return
      }
      wizardConsumers.delete(key)
      const token: EvictionToken = { cancelled: false }
      pendingWizardEvictions.set(key, token)
      queueMicrotask(() => {
        if (token.cancelled) return
        if (pendingWizardEvictions.get(key) !== token) return
        pendingWizardEvictions.delete(key)
        wizards.delete(key)
      })
    }
  }

  // SSR prefetch coordination. Plain, non-reactive Sets: the read path is
  // `onServerPrefetch` callbacks, which fire imperatively after setup
  // rather than from inside a reactive effect. Each SSR request builds its
  // own registry, so cross-request state cannot leak.
  const prefetchEnqueued = new Set<FormKey>()
  const prefetchSkipped = new Set<FormKey>()
  function enqueuePrefetch(key: FormKey): void {
    prefetchEnqueued.add(key)
  }
  function skipPrefetch(key: FormKey): void {
    prefetchSkipped.add(key)
  }
  function shouldPrefetch(key: FormKey): boolean {
    return prefetchEnqueued.has(key) && !prefetchSkipped.has(key)
  }

  return {
    forms,
    wizards,
    pendingHydration,
    ssr,
    trackConsumer,
    trackWizardConsumer,
    enqueuePrefetch,
    skipPrefetch,
    shouldPrefetch,
  }
}

/**
 * Look up the current app's registry from inside a component's `setup()`,
 * or any synchronous code on the setup call stack.
 *
 * Most consumers do not need it, since `useForm` and `injectForm` call it
 * for you. Reach for it when building a custom integration that needs the
 * raw registry.
 *
 * Throws:
 * - `OutsideSetupError` when called outside a Vue setup context, from an
 *   event handler or an async callback. Move the call into setup, or
 *   trigger it from a child component.
 * - `RegistryNotInstalledError` when called inside setup with the plugin
 *   not installed. Add `app.use(createAttaform())` to your app entry.
 */
export function useRegistry(): AttaformRegistry {
  const instance = getCurrentInstance()
  if (instance === null) {
    throw new OutsideSetupError()
  }
  const registry = inject(kAttaformRegistry, null)
  if (registry === null) {
    throw new RegistryNotInstalledError()
  }
  return registry
}

/**
 * Look up a Vue app's registry by `App` reference, for the SSR helpers
 * (`renderAttaformState`, `hydrateAttaformState`) that run outside a
 * component setup context.
 *
 * Throws `RegistryNotInstalledError` when the app was never wired with
 * `createAttaform()`.
 */
export function getRegistryFromApp(app: App): AttaformRegistry {
  const registry = app._attaform
  if (registry === undefined) {
    throw new RegistryNotInstalledError()
  }
  return registry
}

export function attachRegistryToApp(app: App, registry: AttaformRegistry): void {
  app.provide(kAttaformRegistry, registry)
  app._attaform = registry
}
