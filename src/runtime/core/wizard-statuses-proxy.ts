import { computed, type ComputedRef } from 'vue'
import {
  buildCallableReadonlySnapshotProxy,
  type CallableReadonlySnapshotProxy,
} from './callable-readonly-snapshot-proxy'
import type { FormStatus, WizardStatusesProxy } from '../types/types-wizard'

/**
 * Build the callable readonly Proxy that powers `wizard.statuses`.
 *
 * Reactivity contract:
 *
 *   - **Reads track dependencies.** Each per-key entry is supplied
 *     as a `ComputedRef<FormStatus>` whose source-of-truth is the
 *     participating form's `meta`. Property access unwraps the
 *     computed (`.value`) so consumers don't deal with `.value` —
 *     Vue's tracking still fires through the unwrap.
 *
 *   - **Writes are blocked.** Status entries are derived; writing
 *     them would corrupt the model. The proxy warns in dev and
 *     silently no-ops, matching `form.values`' contract.
 *
 *   - **Callable single-key + no-arg.** `wizard.statuses('cargo')`
 *     returns the same `FormStatus` as `wizard.statuses.cargo`.
 *     `wizard.statuses()` returns the full record. Both call
 *     surfaces unwrap the computeds for a snapshot read.
 *
 *   - **JSON.stringify works.** `toJSON` returns the snapshot
 *     record so `JSON.stringify(wizard.statuses)` serializes the
 *     active status set.
 *
 * Topology note: one level deep (no nested chaining), so this surface
 * is roughly half the bespoke logic of `form.values`' proxy — no
 * path-walking, no canonicalisation, no recursive descent. The
 * shared trap layer lives in `buildCallableReadonlySnapshotProxy`.
 */
export function buildWizardStatusesProxy<S extends Record<string, FormStatus>>(
  statuses: Record<keyof S, ComputedRef<FormStatus>>
): WizardStatusesProxy<S> {
  const snapshot = computed(() => {
    const result: Record<string, FormStatus> = {}
    for (const key of Object.keys(statuses)) {
      result[key] = (statuses[key as keyof S] as ComputedRef<FormStatus>).value
    }
    return result as S
  })

  return buildCallableReadonlySnapshotProxy<S>({
    surface: 'wizard.statuses',
    snapshot: () => snapshot.value,
    resolveKey: (key) => (statuses[key as keyof S] as ComputedRef<FormStatus> | undefined)?.value,
    // Single-key callable form. Strings stringify naturally; non-
    // string args coerce via `String(arg)` and miss the lookup, which
    // resolves to `undefined` (consistent with property-access).
    resolveCall: (arg) =>
      (statuses[String(arg) as keyof S] as ComputedRef<FormStatus> | undefined)?.value,
    ownKeys: () => Object.keys(statuses),
    hasKey: (key) => Object.hasOwn(statuses, key),
  }) as WizardStatusesProxy<S> & CallableReadonlySnapshotProxy<S>
}
