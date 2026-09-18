import { getCurrentInstance, getCurrentScope, inject, onScopeDispose } from 'vue'
import { __DEV__ } from '../core/dev'
import { captureUserCallSite } from '../core/dev-stack-trace'
import { ensureAttaformInstalled } from '../core/plugin'
import { kAttaformAncestorWizard, useRegistry } from '../core/registry'
import type { UseWizardReturnType } from '../types/types-wizard'
import { ambientWizardProvideHistory } from './use-wizard'

/** Options accepted by `injectWizard` in place of a bare key string. */
export type InjectWizardInput = {
  readonly key?: string | undefined
}

/**
 * Reach an existing wizard from a descendant component without threading
 * it through props. The counterpart to `useWizard`: `useWizard` creates
 * and provides, `injectWizard` looks up.
 *
 * ```ts
 * // The nearest ancestor's useWizard call.
 * const wizard = injectWizard()
 *
 * // A specific wizard by key, from anywhere in the app.
 * const signup = injectWizard('signup-wizard')
 * ```
 *
 * A keyed call is a registry lookup, independent of component-tree
 * position, and reaches any wizard built with `useWizard({ steps, key
 * })`. A no-key call takes the closest ambient ancestor; only an
 * anonymous `useWizard()` fills that slot, so a keyed wizard has to be
 * addressed by its key, exactly as on the form side.
 *
 * Returns `null` when nothing matches, so narrow before use:
 *
 * ```ts
 * const wizard = injectWizard('signup')
 * if (!wizard) return
 * wizard.next()
 * ```
 *
 * A keyed miss warns in dev with the registered keys and the call site.
 * A keyed lookup also pins the handle for this component's lifetime, so
 * it outlives a parent `useWizard` that unmounts first, and the registry
 * evicts the entry a microtask after the last consumer disposes. An
 * ambient lookup does not pin: the parent's scope owns that lifetime.
 */
export function injectWizard(input?: string | InjectWizardInput): UseWizardReturnType | null {
  const key: string | undefined = typeof input === 'string' ? input : input?.key

  // As in `injectForm`: without this, no installed plugin surfaces as a
  // raw `RegistryNotInstalledError` instead of "no wizard registered".
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
    // Keeps the handle alive until every `injectWizard` caller has
    // unmounted, even when the parent `useWizard` tears down first.
    if (getCurrentScope() !== undefined) {
      const release = registry.trackWizardConsumer(key)
      onScopeDispose(release)
    }
    return handle
  }

  // An ambient miss is opportunistic, so it stays silent and descendants
  // narrow on `null`. A keyed miss warns, being a typo signal.
  const ambient = inject(kAttaformAncestorWizard, null)
  if (ambient === null) return null
  warnIfAmbientWizardProviderHadDuplicates()
  return ambient
}

function availableKeysHint(wizards: Map<string, UseWizardReturnType>): string | undefined {
  if (wizards.size === 0) return undefined
  const keys = [...wizards.keys()].map((k) => `"${k}"`).join(', ')
  return `Registered keys: ${keys}.`
}

/**
 * Skipped on SSR, as in `injectForm`: Nuxt's `dev:ssr-logs` hook
 * forwards server warns to the browser console, where the client pass is
 * already warning, so the same miss would print twice.
 */
function warnMiss(detail: string, ssr: boolean, hint?: string): void {
  if (!__DEV__ || ssr) return
  const frame = captureUserCallSite()
  const parts = [`[attaform] injectWizard: ${detail}. Returning null.`]
  if (hint !== undefined) parts.push(hint)
  parts.push(
    `A wizard created by a child or sibling component is not registered until that ` +
      `component's own setup runs, which happens after this point. Lift its ` +
      `useWizard({ key }) call to a common ancestor, or read the wizard after mount.`
  )
  if (frame !== undefined) parts.push(frame)
  console.warn(parts.join(' '))
}

/**
 * Walk up to the nearest ancestor holding an anonymous-wizard ambient
 * provide. An ancestor with more than one anonymous `useWizard()` call
 * only ever hands a descendant the last of them, so warn once per
 * consumer that genuinely collides. Keyed calls never appear, since they
 * do not fill the slot. `warnIfAmbientProviderHadDuplicates` is the form
 * side of the same check.
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
