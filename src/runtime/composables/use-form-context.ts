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
import { ensureAttaformInstalled } from '../core/plugin'
import { kFormContext, kFormInstanceId, useRegistry, type AttaformRegistry } from '../core/registry'
import type { FormKey, HistoryModule, UseFormReturnType } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import { ambientProvideHistory } from './use-abstract-form'

/**
 * Feeds the fallback id used when neither an ambient `kFormInstanceId`
 * provide nor a Vue instance is available. Uniqueness is all it has to
 * deliver: such a consumer shares its `instanceId` with nothing.
 */
let injectedInstanceCounter = 0

/** Options accepted by `injectForm` in place of a bare key string. */
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
 * Reach an existing form from a descendant component without threading
 * it through props. The counterpart to `useForm`: `useForm` creates and
 * provides, `injectForm` looks up.
 *
 * ```ts
 * // The nearest ancestor's anonymous useForm() call.
 * const form = injectForm<SignupShape>()
 *
 * // A specific form by key, from anywhere in the app.
 * const cart = injectForm<CartShape>('cart')
 * ```
 *
 * A keyed call is a registry lookup, so it is independent of
 * component-tree position. A no-key call takes the closest ambient
 * ancestor and inherits its `formInstanceId`; only an anonymous
 * `useForm()` fills that ambient slot, so a keyed form is reachable
 * only by its key.
 *
 * Returns `null` when nothing matches, so narrow before use:
 *
 * ```ts
 * const form = injectForm<Shape>('signup')
 * if (!form) return
 * form.register('email')
 * ```
 *
 * A keyed miss warns in dev with the registered keys and the call site.
 * Pass the `Form` generic explicitly, since Vue's provide/inject erases
 * generics. The form stays alive for this component's lifetime and is
 * cleaned up once every consumer has unmounted.
 */
export function injectForm<Form extends GenericForm, GetValueFormType extends GenericForm = Form>(
  input?: FormKey | InjectFormInput
): UseFormReturnType<Form, GetValueFormType> | null {
  // `injectForm('cart')` is the documented shortcut; the object form is
  // what the Vite transform emits. Both reach the same lookup.
  const key: FormKey | undefined = typeof input === 'string' ? input : input?.key
  const ssrAccessed: boolean =
    typeof input === 'object' && input !== null ? input.__ssrAccessed === true : false

  // With no `useForm` ancestor and no `createAttaform()` there is no
  // registry, and without this install the miss would surface as a
  // misleading `RegistryNotInstalledError` instead of the null return
  // and dev warning the caller expects. `useRegistry()` below still
  // raises `OutsideSetupError` for a call outside setup.
  const instance = getCurrentInstance()
  if (instance !== null) ensureAttaformInstalled(instance.appContext.app)
  const registry = useRegistry()

  const state = resolveState<Form>(key, registry)
  if (state === null) return null

  // Ref-count this consumer so the FormStore outlives every nested
  // component that reached it. Same as `useAbstractForm`; the counter
  // semantics live on `registry.trackConsumer`.
  if (getCurrentScope() !== undefined) {
    const releaseConsumer = registry.trackConsumer(state.formKey)
    onScopeDispose(releaseConsumer)
  }

  // Server only, and only once something signalled that this descendant
  // reads the form's reactive state. Enqueuing plus the descendant's own
  // `onServerPrefetch` is what makes Vue await activation before this
  // render serialises. `state.activate()` shares one in-flight promise
  // across every descendant holding the same key.
  if (registry.ssr && ssrAccessed) {
    registry.enqueuePrefetch(state.formKey)
    onServerPrefetch(() => state.activate())
  }

  // Without this, a consumer reached through the context would get inert
  // `form.history` stubs even on a form that has history enabled.
  const apiOptions: Parameters<typeof buildFormApi<Form, GetValueFormType>>[2] = {}
  const history = state.modules.get('history') as HistoryModule | undefined
  if (history !== undefined) {
    apiOptions.history = history
  }
  // Inheriting the ancestor's instanceId is what keeps a parent's
  // submit-focus reaching inputs that a deep child registered through
  // its own `register()` calls: both tag against the SAME instance.
  //
  // A fresh id is the fallback for a cross-tree keyed reach with no
  // ambient provide chain, and for having no Vue instance at all. Local
  // registrations are then isolated: the original `useForm()` call
  // site's `focusFirstError` cannot see them, though the consumer's own
  // focus calls still work.
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
 * Resolve the FormStore for `key`, or the ambient slot when no key was
 * passed. `null` on a miss, which the caller hands straight back.
 *
 * A keyed miss warns; an ambient miss stays silent, because ambient
 * lookup is opportunistic and a component library built on `injectForm`
 * should not fill a consumer's console when no parent provided a form.
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
 * Format the registry's addressable keys for a keyed-miss warning, so a
 * typo reads against the real list. Synthetic keys under the reserved
 * `__atta:` prefix are filtered out, since `injectForm(key)` cannot
 * address them. `undefined` drops the hint from the message.
 */
function availableKeysHint(forms: Map<FormKey, FormStore<GenericForm>>): string | undefined {
  const addressable = [...forms.keys()].filter((key) => !key.startsWith(RESERVED_KEY_PREFIX))
  if (addressable.length === 0) return undefined
  return `Registered keys: ${addressable.map((key) => `'${key}'`).join(', ')}.`
}

/**
 * Skipped on SSR: Nuxt's `dev:ssr-logs` hook forwards server warns to
 * the browser console, where the client pass is already warning, so the
 * same miss would print twice per page load. Registry state is
 * deterministic across the two passes, so dropping the server one is
 * lossless. The hint computation sits inside the `__DEV__` guard so it
 * and its literals tree-shake out of production.
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
 * Walk up to the nearest ancestor holding an ambient provide, tracked in
 * `ambientProvideHistory`. An ancestor with more than one ANONYMOUS
 * `useForm()` call only ever hands a descendant the last of them, so
 * warn and let the author choose between adding keys and splitting the
 * component.
 *
 * Checking here rather than at the `useForm()` call site is what keeps
 * it quiet: it fires once per `injectForm()` consumer that genuinely
 * collides, not once per extra form whether or not anything reads the
 * ambient slot. Keyed calls never appear, since they do not fill that
 * slot and so cannot collide on this axis at all.
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
