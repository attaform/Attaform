import { getCurrentInstance, getCurrentScope, inject, onScopeDispose } from 'vue'
import { __DEV__ } from '../core/dev'
import { captureUserCallSite } from '../core/dev-stack-trace'
import { ensureAttaformInstalled } from '../core/plugin'
import { kAttaformAncestorWizard, useRegistry } from '../core/registry'
import type { UseWizardReturnType } from '../types/types-wizard'
import { ambientWizardProvideHistory } from './use-wizard'

/**
 * Options accepted by `injectWizard` when passing an object instead of
 * a bare key string. Mirrors `injectForm`'s `InjectFormInput` shape so
 * the two composables present an identical call surface.
 */
export type InjectWizardInput = {
  readonly key?: string | undefined
}

/**
 * Access an existing wizard handle from a descendant component without
 * passing it through props. Counterpart to `useWizard` — `useWizard`
 * creates and provides; `injectWizard` looks up via Vue's inject
 * mechanism or the per-app registry.
 *
 * Three ways to call it:
 *
 * ```ts
 * // Reach the nearest ancestor's useWizard call (ambient).
 * const wizard = injectWizard()
 *
 * // Reach a specific wizard by its key — works from anywhere in the app.
 * const signup = injectWizard('signup-wizard')
 *
 * // Object form (equivalent; convenient for spread).
 * const signup = injectWizard({ key: 'signup-wizard' })
 * ```
 *
 * Resolution rules (no-key form):
 *  - Closest ambient ancestor wins via `provide(kAttaformAncestorWizard)`.
 *  - Only anonymous (no-`key`) `useWizard()` calls fill the ambient
 *    slot. Descendants of a keyed wizard must address it explicitly
 *    via `injectWizard('the-key')`. Mirrors `useForm`'s ambient gate.
 *
 * Resolution rules (keyed form): registry lookup by string key,
 * independent of component-tree position. The wizard must have been
 * constructed with `useWizard({ steps, key })` to be reachable.
 *
 * Returns `null` when no matching wizard exists (no ambient ancestor,
 * or the named key isn't registered). A dev-mode warning points at the
 * call site to help diagnose typos. Always narrow before using:
 *
 * ```ts
 * const wizard = injectWizard('signup')
 * if (!wizard) return
 * wizard.next()
 * ```
 *
 * Consumer ref-counting: keyed lookups pin the wizard handle in the
 * registry for this component's lifetime, so the handle survives even
 * if the parent `useWizard` component unmounts before the child does.
 * Once every consumer disposes, the registry evicts the entry on the
 * next microtask. Ambient lookups don't ref-count — the parent
 * `useWizard`'s scope owns the lifetime.
 */
export function injectWizard(input?: string | InjectWizardInput): UseWizardReturnType | null {
  const key: string | undefined = typeof input === 'string' ? input : input?.key

  // Lazy-install mirrors `injectForm`: if no plugin was installed,
  // surface the friendlier "no wizard registered" warn instead of the
  // raw `RegistryNotInstalledError`.
  const instance = getCurrentInstance()
  if (instance !== null) ensureAttaformInstalled(instance.appContext.app)
  const registry = useRegistry()

  if (key !== undefined) {
    const handle = registry.wizards.get(key)
    if (handle === undefined) {
      warnMiss(
        `no wizard registered for key '${key}'`,
        registry.ssr,
        availableKeysHint(registry.wizards)
      )
      return null
    }
    // Ref-count this consumer so the handle survives until every
    // injectWizard caller has unmounted, even if the parent useWizard
    // tears down first. Mirrors the form's trackConsumer pattern.
    if (getCurrentScope() !== undefined) {
      const release = registry.trackWizardConsumer(key)
      onScopeDispose(release)
    }
    return handle
  }

  const ambient = inject(kAttaformAncestorWizard, null)
  if (ambient === null) {
    warnMiss('no ambient wizard context', registry.ssr)
    return null
  }
  warnIfAmbientWizardProviderHadDuplicates()
  return ambient
}

function availableKeysHint(wizards: Map<string, UseWizardReturnType>): string | undefined {
  if (wizards.size === 0) return undefined
  const keys = [...wizards.keys()].map((k) => `"${k}"`).join(', ')
  return `Registered keys: ${keys}.`
}

/**
 * SSR-suppressed dev warn — matches `injectForm`'s `warnMiss` so the
 * same miss isn't logged twice when Nuxt's `dev:ssr-logs` hook forwards
 * server warnings to the browser console alongside the client-side
 * warn.
 */
function warnMiss(detail: string, ssr: boolean, hint?: string): void {
  if (!__DEV__ || ssr) return
  const frame = captureUserCallSite()
  const parts = [`[attaform] injectWizard: ${detail}. Returning null.`]
  if (hint !== undefined) parts.push(hint)
  if (frame !== undefined) parts.push(frame)
  console.warn(parts.join(' '))
}

/**
 * Walk up from the current component to the nearest ancestor that
 * registered an anonymous-wizard ambient provide. If that ancestor
 * recorded more than one anonymous `useWizard()` call, a descendant
 * reaching for the ambient slot only sees the last one, so warn once
 * per consumer that genuinely collides. Mirrors
 * `warnIfAmbientProviderHadDuplicates` on the form side. Keyed
 * `useWizard()` calls do not appear here, since they do not fill the
 * ambient slot.
 */
function warnIfAmbientWizardProviderHadDuplicates(): void {
  if (!__DEV__ || ambientWizardProvideHistory === null) return
  let ancestor = getCurrentInstance()?.parent ?? null
  while (ancestor !== null) {
    const history = ambientWizardProvideHistory.get(ancestor as unknown as object)
    if (history !== undefined) {
      if (history.length > 1) {
        const lines = history.map((entry) => `  - ${entry.source ?? '<unknown location>'}`)
        console.warn(
          '[attaform] injectWizard() (no key) resolved against ' +
            'an ancestor with multiple anonymous useWizard() calls; descendants ' +
            'only see the last-provided wizard. Anonymous useWizard() calls were:\n' +
            lines.join('\n') +
            '\nFix: pass a key to each call (e.g. useWizard({ steps, key: "x" })) ' +
            'and reach them via injectWizard("x"), or split the wizards ' +
            'across separate components.'
        )
      }
      return
    }
    ancestor = ancestor.parent
  }
}
