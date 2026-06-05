import { computed, readonly, toRaw, type Ref } from 'vue'
import {
  buildCallableReadonlySnapshotProxy,
  type CallableReadonlySnapshotProxy,
} from './callable-readonly-snapshot-proxy'
import { canonicalizePath, type Path } from './paths'
import { getAtPath, isPlainRecord } from './path-walker'
import { isShadowedKey, safeAssign, safeOwnRead } from './safe-assign'
import type { GenericForm } from '../types/types-core'

/**
 * Materialise the reactive form value into a plain (proxy-free) tree
 * for faithful serialisation (`JSON.stringify(form.values)` /
 * `String(form.values)`). Two things this fixes over handing
 * `JSON.stringify` the readonly proxy directly:
 *
 * - **Shadowed keys.** Vue shims `hasOwnProperty` on every reactive
 *   proxy, so a data field literally named `hasOwnProperty` would
 *   serialise as Vue's function shim (and `JSON.stringify` would then
 *   drop it). The per-key `safeOwnRead` takes an own-descriptor read for
 *   prototype-shadowed names, recovering the stored datum.
 * - **Pollution.** The output is rebuilt with `safeAssign`, so a literal
 *   `__proto__` key in the data lands as own data on the clone rather
 *   than reassigning its prototype.
 *
 * Reactivity is preserved: every descent reads THROUGH the reactive
 * proxy (`Object.keys` tracks the key set, `safeOwnRead` of an ordinary
 * key is a tracked `get`), so the serialising effect re-runs on writes.
 */
function materializeFormValue(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    const out: unknown[] = new Array(node.length)
    for (let i = 0; i < node.length; i++) out[i] = materializeFormValue(node[i])
    return out
  }
  // Non-plain objects (Date, RegExp, Map, Set, File, class instances)
  // are leaves: unwrap any reactive wrapper and hand them on so
  // JSON.stringify applies their own `toJSON` (e.g. Date → ISO string).
  if (!isPlainRecord(node)) return toRaw(node)
  const rec = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rec)) {
    safeAssign(out, key, materializeFormValue(safeOwnRead(rec, key)))
  }
  return out
}

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
    // Faithful, reactivity-preserving serialisation: walk the reactive
    // proxy with own-safe reads so `JSON.stringify(form.values)` /
    // `String(form.values)` reflect the stored data — including a field
    // literally named `hasOwnProperty` that Vue would otherwise shim —
    // while still tracking the per-key reads that drive re-render.
    coercionSnapshot: () => materializeFormValue(inner.value) as F,
    // Read through the readonly proxy at access time so Vue's
    // dependency tracking lands inside the consumer's active effect
    // — `inner.value[key]` is what triggers per-key tracking.
    //
    // Prototype-shadowed names (`hasOwnProperty`, `constructor`, …) read
    // off the RAW target instead: own-shadows-inherited semantics still
    // hold (a data field by that name returns its stored value), but
    // when there's no such field the inherited member resolves — so
    // `form.values.hasOwnProperty('x')` keeps working as the real
    // method. The raw read dodges Vue's `hasOwnProperty` proxy shim,
    // which would otherwise mask a data field of that name. (`toString`
    // / `valueOf` / `toJSON` never reach here — the base get trap
    // intercepts them as coercion handlers first.)
    resolveKey: (key) =>
      isShadowedKey(key)
        ? (toRaw(inner.value) as Record<string, unknown>)[key]
        : (inner.value as Record<string, unknown>)[key],
    // Dynamic path: walk segments through the readonly proxy with the
    // same own-property-safe descent the rest of the runtime uses
    // (`getAtPath`), so `form.values('a.hasOwnProperty')` resolves the
    // stored value. Per-level reads still propagate Vue's tracking for
    // ordinary keys.
    resolveCall: (arg) => getAtPath(inner.value, canonicalizePath(arg as string | Path).segments),
    ownKeys: () => Reflect.ownKeys(inner.value as object) as string[],
    hasKey: (key) => Reflect.has(inner.value as object, key),
    describeKey: (key) => {
      const desc = Reflect.getOwnPropertyDescriptor(inner.value as object, key)
      if (desc !== undefined) desc.configurable = true
      return desc
    },
  }) as ValuesProxy<F> & CallableReadonlySnapshotProxy<F>
}
