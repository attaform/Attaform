import { computed, readonly, type Ref } from 'vue'
import {
  buildCallableReadonlySnapshotProxy,
  type CallableReadonlySnapshotProxy,
} from './callable-readonly-snapshot-proxy'
import { canonicalizePath, type Path } from './paths'
import type { GenericForm } from '../types/types-core'

/**
 * Public shape of `form.values` — a callable proxy that drills via
 * dot/bracket OR call dynamically:
 *
 *   form.values.email                  // string (the value)
 *   form.values.address.city           // string (chained descent)
 *   form.values.address                // { city, … } — object, drillable further
 *   form.values('address.city')        // function-call (dynamic / programmatic)
 *   form.values(['address', 'city'])   // path-array form
 *   form.values()                      // the whole form value (root)
 *
 * Asymmetry against `form.errors` / `form.fields`: containers in
 * `values` ARE useful (they are the structural objects), so they
 * terminate as well as descend. Errors and fields containers are
 * descend-only because their content at a container level is a
 * derivation (e.g. "any descendant dirty") rather than a real datum.
 */
export type ValuesProxy<F> = ((path?: string | Path) => unknown) & Readonly<F>

/**
 * Build the callable readonly Proxy that powers `form.values`.
 *
 * Reactivity contract:
 *
 *   - **Reads track dependencies normally.** The inner
 *     `computed(() => readonly(form.value))` recomputes on every
 *     whole-form swap (Ref reassignment via `reset()` / whole-form
 *     `setValue`) and on every per-key write through Vue's reactive
 *     tracking. Each read on the callable proxy delegates to
 *     `inner.value.<key>`, which lands inside the consumer's active
 *     effect — Vue tracks the dependency at access time.
 *
 *   - **Writes are blocked.** Vue's `readonly()` traps `set` / `delete` /
 *     `defineProperty` on the inner proxy. The callable wrapper
 *     additionally rejects writes at its own boundary. The slim-
 *     primitive write gate stays the only path into storage.
 *
 *   - **Identity-stable on swap.** Vue's `readonly()` maps targets
 *     to proxies by identity. A whole-form swap produces a fresh
 *     readonly proxy; the wrapping computed invalidates and
 *     re-evaluates. Consumers reading `form.values.<x>` always see
 *     the current target's data.
 *
 *   - **JSON.stringify works.** The callable proxy is `typeof ===
 *     'function'`, which JSON.stringify normally omits — `toJSON`
 *     short-circuits that path and returns the inner readonly proxy
 *     so consumers serialise the actual form data, not `undefined`.
 *
 *   - **Symbol passthrough.** Vue's reactivity sigils
 *     (`Symbol(__v_isRef)`, `Symbol(__v_isReadonly)`, etc.) and
 *     iteration symbols resolve against the function target, not
 *     the schema-aware branch.
 *
 * Built atop `buildCallableReadonlySnapshotProxy`: the surface only
 * supplies the path-descent / live-keys hooks; the trap topology
 * (apply / get / has / ownKeys / warn-and-noop writes) is shared with
 * `wizard.statuses`.
 */
export function buildValuesProxy<F extends GenericForm>(form: Ref<F>): ValuesProxy<F> {
  const inner = computed(() => readonly(form.value))

  return buildCallableReadonlySnapshotProxy<F>({
    surface: 'form.values',
    snapshot: () => inner.value as F,
    // Read through the readonly proxy at access time so Vue's
    // dependency tracking lands inside the consumer's active effect
    // — `inner.value[key]` is what triggers per-key tracking.
    resolveKey: (key) => (inner.value as Record<string, unknown>)[key],
    // Dynamic path: walk segments through the readonly proxy. Each
    // step reads through the proxy's own get traps so dependency
    // tracking propagates at every level.
    resolveCall: (arg) => {
      const { segments } = canonicalizePath(arg as string | Path)
      let cursor: unknown = inner.value
      for (const seg of segments) {
        if (cursor === null || cursor === undefined) return undefined
        cursor = (cursor as Record<string | number, unknown>)[seg]
      }
      return cursor
    },
    ownKeys: () => Reflect.ownKeys(inner.value as object) as string[],
    hasKey: (key) => Reflect.has(inner.value as object, key),
    describeKey: (key) => {
      const desc = Reflect.getOwnPropertyDescriptor(inner.value as object, key)
      if (desc !== undefined) desc.configurable = true
      return desc
    },
  }) as ValuesProxy<F> & CallableReadonlySnapshotProxy<F>
}
