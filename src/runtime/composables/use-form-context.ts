import {
  getCurrentInstance,
  getCurrentScope,
  inject,
  onScopeDispose,
  onServerPrefetch,
  useId,
} from 'vue'
import { buildFormApi } from '../core/build-form-api'
import type { FormStore } from '../core/create-form-store'
import { RESERVED_KEY_PREFIX } from '../core/defaults'
import { __DEV__ } from '../core/dev'
import { captureUserCallSite } from '../core/dev-stack-trace'
import type { HistoryModule } from '../core/history'
import { ensureAttaformInstalled } from '../core/plugin'
import { kFormContext, kFormInstanceId, useRegistry, type AttaformRegistry } from '../core/registry'
import type { FormKey, UseFormReturnType } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import { ambientProvideHistory } from './use-abstract-form'

/**
 * Module-local counter for the test/ad-hoc fallback when neither an
 * ambient `kFormInstanceId` provide nor a Vue instance is available.
 * Uniqueness is sufficient — these consumers don't share an
 * `instanceId` with anything else in the tree by definition.
 */
let injectedInstanceCounter = 0

/**
 * Options accepted by `injectForm` when passing an object instead of
 * a bare key string. `__ssrAccessed: true` is set by the Phase 3
 * `attaform-vite` transform on descendant calls whose template reads
 * the injected form's reactive state — it tells the runtime to
 * enqueue the form for SSR prefetch and register the descendant's
 * `onServerPrefetch` hook. Consumers may set it manually as the
 * escape hatch when the transform isn't installed or doesn't see
 * the reference.
 */
export type InjectFormInput = {
  readonly key?: FormKey
  /**
   * Set by the Vite transform when this `injectForm` call site sits in
   * a component whose template / script reads the form's reactive
   * state. On the server, this enqueues the form for SSR prefetch and
   * wires `onServerPrefetch` so the descendant awaits the activation
   * promise before its render emits HTML.
   *
   * @internal Transform-emitted. Manual use is the documented escape
   * hatch when the transform can't reach the reference (dynamic
   * property access, untransformed bundlers).
   */
  readonly __ssrAccessed?: boolean
}

/**
 * Access an existing form from a descendant component without passing
 * it through props. Counterpart to `useForm` — `useForm` creates and
 * provides; `injectForm` looks up via Vue's inject mechanism.
 *
 * Three ways to call it:
 *
 * ```ts
 * // Reach the nearest ancestor's anonymous useForm() call.
 * const form = injectForm<SignupShape>()
 *
 * // Reach a specific form by its key — works from anywhere in the app.
 * const cart = injectForm<CartShape>('cart')
 *
 * // Options form. The Vite transform emits this with `__ssrAccessed: true`
 * // when the descendant's template / script reads the form's reactive
 * // state, so the descendant participates in SSR prefetch coordination.
 * const cart = injectForm<CartShape>({ key: 'cart', __ssrAccessed: true })
 * ```
 *
 * Resolution rules (no-key form):
 * - Closest ambient ancestor wins.
 * - Only anonymous `useForm()` (no `key`) fills the ambient slot;
 *   keyed forms are reachable only via `injectForm(key)`.
 * - Inherits the resolved ancestor's `formInstanceId`.
 *
 * Resolution rules (keyed form): registry lookup by string key,
 * independent of component-tree position.
 *
 * Returns `null` when no matching form exists (no ambient ancestor, or
 * the named key isn't registered yet). A dev-mode warning points at the
 * call site, lists the registered keys, and flags the mount-timing case
 * (a form created by a child or sibling isn't registered until its own
 * setup runs). Always narrow before using:
 *
 * ```ts
 * const form = injectForm<Shape>('signup')
 * if (!form) return
 * form.register('email')
 * ```
 *
 * Pass the `Form` generic explicitly — Vue's provide/inject erases
 * generics, so the library can't recover the shape automatically.
 *
 * The form is kept alive for this component's lifetime; once every
 * consumer unmounts, the form is cleaned up automatically.
 */
export function injectForm<Form extends GenericForm, GetValueFormType extends GenericForm = Form>(
  input?: FormKey | InjectFormInput
): UseFormReturnType<Form, GetValueFormType> | null {
  // Normalise the call shape. The string-form (`injectForm('cart')`)
  // is the dominant pattern and stays the documented shortcut; the
  // object form is the surface the Phase 3 Vite transform emits when
  // the descendant's reactive state reads the form. Both shapes
  // resolve to the same downstream lookup.
  const key: FormKey | undefined = typeof input === 'string' ? input : input?.key
  const ssrAccessed: boolean =
    typeof input === 'object' && input !== null ? input.__ssrAccessed === true : false

  // Lazy-install: if no `useForm` ancestor and no explicit
  // `createAttaform()`, the registry is missing. Auto-install here so
  // `injectForm` collapses to its existing "no form for that key" /
  // "no ambient form context" null-return + dev-warning paths instead
  // of throwing the misleading `RegistryNotInstalledError`. The strict
  // `useRegistry()` below still surfaces `OutsideSetupError` when
  // called outside setup.
  const instance = getCurrentInstance()
  if (instance !== null) ensureAttaformInstalled(instance.appContext.app)
  const registry = useRegistry()

  const state = resolveState<Form>(key, registry)
  if (state === null) return null

  // Ref-count this consumer so the FormStore survives until every nested
  // component that reached it has torn down. Mirrors the behaviour in
  // useAbstractForm — see registry.trackConsumer for the counter semantics.
  if (getCurrentScope() !== undefined) {
    const releaseConsumer = registry.trackConsumer(state.formKey)
    onScopeDispose(releaseConsumer)
  }

  // SSR coordination — only on the server, only when the transform (or
  // a manual consumer) signalled that this descendant reads the form's
  // reactive state. The descendant enqueues the key on the registry's
  // prefetch set and registers its own `onServerPrefetch` hook so Vue
  // awaits the activation promise before the descendant's render
  // serialises. Multiple descendants with the same key share the
  // single in-flight promise courtesy of `state.activate()`.
  if (registry.ssr && ssrAccessed) {
    registry.enqueuePrefetch(state.formKey)
    onServerPrefetch(() => state.activate())
  }

  // Pull the cached history module (if the owning `useForm` wired it)
  // so every consumer's API surface includes a live `form.history`
  // namespace. Without this, consumers reached via the context would
  // receive inert stubs even when history is enabled on the form.
  const apiOptions: Parameters<typeof buildFormApi<Form, GetValueFormType>>[2] = {}
  const history = state.modules.get('history') as HistoryModule | undefined
  if (history !== undefined) {
    apiOptions.history = history
  }
  // Inherit the ancestor `useForm()`'s instanceId when one is provided.
  // Keeps parent-submit-focus working for inputs registered by deep
  // children using `injectForm()` + their own local `register()` calls
  // — both sides tag against the SAME instance.
  //
  // Falls back to a fresh ID when:
  //   - `injectForm('cart')` reaches a form by key from a tree branch
  //     that has no ambient provide chain to it (cross-tree access);
  //   - or no Vue instance is available (test / ad-hoc usage).
  // In those cases the consumer's local registrations are isolated —
  // the original `useForm()` callsite's `focusFirstError` won't see
  // them, but the consumer's own focus calls work locally.
  const ambientInstanceId = getCurrentInstance() !== null ? inject(kFormInstanceId, null) : null
  const formInstanceId =
    ambientInstanceId ??
    (getCurrentInstance() !== null
      ? useId()
      : `atta:form-instance-injected:${injectedInstanceCounter++}`)
  return buildFormApi<Form, GetValueFormType>(
    state as FormStore<Form, GetValueFormType>,
    formInstanceId,
    apiOptions
  )
}

/**
 * Resolves the FormStore for the requested key (or the ambient slot
 * when no key was passed). Returns `null` on miss; the caller propagates
 * that null straight out to the consumer.
 *
 * Keyed misses log a dev-mode warning carrying three diagnostic parts:
 * the registry's addressable keys (so a typo reads against the real
 * list), a mount-timing note (a child or sibling form is not registered
 * until its own setup runs, so it is not yet resolvable from an earlier
 * caller), and the user's call-site frame. Ambient misses stay silent:
 * ambient lookup is opportunistic (a component library built on
 * `injectForm()` shouldn't spam consumers' consoles when no parent has
 * provided one), so descendants narrow on `null` and degrade.
 */
function resolveState<Form extends GenericForm>(
  key: FormKey | undefined,
  registry: AttaformRegistry
): FormStore<Form> | null {
  if (key !== undefined) {
    const stored = registry.forms.get(key) as FormStore<Form> | undefined
    if (stored === undefined) {
      warnMiss(`no form registered for key '${key}'`, registry.ssr, registry.forms)
      return null
    }
    return stored
  }
  const ambient = inject(kFormContext, null) as FormStore<Form> | null
  if (ambient === null) return null
  warnIfAmbientProviderHadDuplicates()
  return ambient
}

/**
 * Formats the registry's addressable form keys for a keyed-miss warning,
 * so the miss distinguishes a typo (the intended key sits right there in
 * the list) from a form that simply has not registered yet. Synthetic
 * keys (anonymous forms under the reserved `__atta:` prefix) are filtered
 * out: they are not addressable by `injectForm(key)`, so surfacing them
 * would only add noise. Returns `undefined` when nothing addressable is
 * registered, which drops the hint from the message entirely.
 */
function availableKeysHint(forms: Map<FormKey, FormStore<GenericForm>>): string | undefined {
  const addressable = [...forms.keys()].filter((key) => !key.startsWith(RESERVED_KEY_PREFIX))
  if (addressable.length === 0) return undefined
  return `Registered keys: ${addressable.map((key) => `'${key}'`).join(', ')}.`
}

/**
 * Skipped on SSR — Nuxt's `dev:ssr-logs` hook forwards server warns to
 * the browser console alongside the client-side warn that fires from
 * the hydration setup, so the same miss would surface twice per page
 * load. The signal is identical on both passes (registry state is
 * deterministic across SSR/client), so emitting only on the client is
 * lossless and halves dev-mode noise. Production stays silent on both.
 *
 * Assembles the headline plus three diagnostic parts: the addressable
 * keys (typo signal), the mount-timing note (a child or sibling form is
 * not registered until its own setup runs, so it is not yet resolvable
 * from an earlier caller), and the user's call-site frame. The hint
 * computation lives inside the `__DEV__` guard so it, and the literals
 * it carries, tree-shake out of production.
 */
function warnMiss(detail: string, ssr: boolean, forms: Map<FormKey, FormStore<GenericForm>>): void {
  if (!__DEV__ || ssr) return
  const frame = captureUserCallSite()
  const parts = [`[attaform] injectForm: ${detail}. Returning null.`]
  const keys = availableKeysHint(forms)
  if (keys !== undefined) parts.push(keys)
  parts.push(
    `A form created by a child or sibling component is not registered until that ` +
      `component's own setup runs, which happens after this point. Lift its ` +
      `useForm({ key }) call to a common ancestor, or read the form after mount.`
  )
  if (frame !== undefined) parts.push(frame)
  console.warn(parts.join(' '))
}

/**
 * Walk up from the current component to the nearest ancestor that
 * registered an ambient provide (tracked in `ambientProvideHistory`).
 * If that ancestor recorded more than one ANONYMOUS `useForm()` call,
 * a descendant reaching for the ambient slot only sees the last one
 * — warn so the author picks between adding a key and splitting the
 * component.
 *
 * The eager version of this check lived at the `useForm()` call site
 * and fired once per extra form regardless of whether any descendant
 * actually used the ambient slot. That made spike / test pages wall-
 * warn for a non-problem; this version fires at most once per
 * `injectForm()` consumer that genuinely collides.
 *
 * Keyed `useForm()` calls don't appear here — they don't fill the
 * ambient slot at all (they're addressable explicitly via
 * `injectForm<F>(key)`), so they can't collide with each other
 * or with anonymous siblings on this axis.
 */
function warnIfAmbientProviderHadDuplicates(): void {
  if (!__DEV__ || ambientProvideHistory === null) return
  let ancestor = getCurrentInstance()?.parent ?? null
  while (ancestor !== null) {
    const history = ambientProvideHistory.get(ancestor as unknown as object)
    if (history !== undefined) {
      if (history.length > 1) {
        const lines = history.map((entry) => `  - ${entry.source ?? '<unknown location>'}`)
        console.warn(
          '[attaform] injectForm<F>() (no key) resolved against ' +
            'an ancestor with multiple anonymous useForm() calls; descendants ' +
            'only see the last-provided form. Anonymous useForm() calls were:\n' +
            lines.join('\n') +
            '\nFix: pass a key to each call (e.g. useForm({ schema, key: "x" })) ' +
            'and reach them via injectForm<F>("x"), or split the forms ' +
            'across separate components.'
        )
      }
      return
    }
    ancestor = ancestor.parent
  }
}
