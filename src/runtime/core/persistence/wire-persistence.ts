import { toRaw } from 'vue'
import type { PersistConfigOptions, ValidationError } from '../../types/types-api'
import type { GenericForm } from '../../types/types-core'
import type { FormStore } from '../create-form-store'
import { DEFAULT_PERSISTENCE_DEBOUNCE_MS, normalizeNumericOption } from '../defaults'
import { __DEV__ } from '../dev'
import { hashStableString } from '../hash'
import { canonicalizePath, type Path, type PathKey } from '../paths'
import { deleteAtPath, getAtPath, isPlainRecord, setAtPath } from '../path-walker'
import {
  buildPersistedPayload,
  cleanupOrphanKeys,
  createDebouncedWriter,
  filterErrorsByPaths,
  getStorageAdapter,
  mergeSparseHydration,
  pluckPaths,
  readPersistedPayload,
  resolveStorageKeyBase,
  stripUnacknowledgedSensitiveLeaves,
  type PersistenceModule,
} from '../persistence'

/**
 * Wire persistence to a fresh FormStore:
 *
 *   1. Resolve the storage adapter (dynamic-imported — `'local'` never
 *      pulls IDB code; tree-shakes cleanly).
 *   2. Async-read any persisted payload and apply it via
 *      `applyFormReplacement`. First render shows schema defaults
 *      (the "flash of default state" — documented tradeoff for
 *      async backends).
 *   3. Subscribe a debounced writer to `onFormChange`; every mutation
 *      schedules a write.
 *   4. Subscribe a `removeItem` on submit-success (when
 *      `clearOnSubmitSuccess` is not explicitly false).
 *   5. Return a disposer that flushes any pending write, cancels
 *      the debounce, and removes subscribers. Called on consumer
 *      teardown.
 */
export function wirePersistence<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  config: PersistConfigOptions
): PersistenceModule {
  // Fingerprint the schema once and bake it into the storage key. Any
  // structural schema change (added/removed/renamed field, type swap)
  // produces a different fingerprint, so the new mount looks up a fresh
  // key — the old draft becomes an orphan, cleaned up in the same mount
  // by `cleanupOrphanKeys` below. No manual version protocol required.
  // Hash the long structural fingerprint into a fixed-size token before
  // baking it into the storage key. The raw fingerprint is the
  // schema's full shape stringified (`object{"address":object{...}}`),
  // which works correctly for invalidation but produces 200+ char
  // storage keys for non-trivial schemas AND leaks the schema's
  // structure into client-side storage. The hash preserves
  // determinism (same schema → same hash) without either downside.
  // Defensive: some schema shapes make an adapter's fingerprint() throw
  // (a v3 `z.nativeEnum` spreads the enum object). The library must never
  // crash a consumer's mount on the persistence path — the multi-tab
  // channel-name site already degrades the same way. Fall back to a
  // stable fingerprint-free token: persistence still works, it just
  // loses automatic schema-change invalidation for this form until the
  // adapter-side fingerprint fix lands.
  let fingerprint: string
  try {
    fingerprint = hashStableString(state.schema.fingerprint())
  } catch (err) {
    if (__DEV__) {
      console.warn(
        `[attaform] Could not fingerprint the schema for form '${state.formKey}': ` +
          `${err instanceof Error ? err.message : String(err)}. Persistence falls back to a ` +
          `fingerprint-free key, so a schema change won't auto-invalidate a saved draft.`
      )
    }
    fingerprint = 'unfingerprinted'
  }
  const base = resolveStorageKeyBase(config, state.formKey)
  const key = `${base}:${fingerprint}`
  // Sanitise the persistence debounce — same rules as field validation:
  // `NaN` would fire synchronously, `Infinity` would stall the event
  // loop for ~24.8 days then wrap. Both fall back to the library default.
  const debounceMs = normalizeNumericOption({
    value: config.debounceMs ?? DEFAULT_PERSISTENCE_DEBOUNCE_MS,
    source: 'useForm.persist.debounceMs',
    allowInfinity: false,
    min: 0,
    defaultValue: DEFAULT_PERSISTENCE_DEBOUNCE_MS,
  })
  const include = config.include ?? 'form'
  const clearOnSubmitSuccess = config.clearOnSubmitSuccess ?? true

  // Single shared adapter promise — both the hydration path and the
  // write/clear paths await it. Avoids a race where an early write
  // (fast debounceMs) would see `adapter === null` and skip silently
  // because the dynamic-import hadn't resolved yet.
  const adapterPromise = getStorageAdapter(config.storage)
  // Routed through `isDisposed()` so each read is a function call,
  // not a direct variable / property access. TS's control-flow
  // analysis would narrow either `let disposed = false` or
  // `isDisposed()` to literal `false` after the first early-
  // return in a closure (every subsequent check in the same closure
  // then trips `no-unnecessary-condition` as "always falsy"), because
  // the flag's only `true` write lives in the `dispose()` finally
  // callback flow analysis can't reach. A function call is opaque to
  // the narrower — the type returns `boolean` at every site, which
  // is the truth (`disposed` flips asynchronously across awaits).
  let disposed = false
  const isDisposed = (): boolean => disposed
  // Tracks the in-flight final flush kicked off by `dispose()`. Returned
  // by `awaitPendingWrites` so the registry can drain pending storage
  // writes before evicting the FormStore — without this, the last
  // debounced keystroke is silently dropped on unmount.
  let inFlightFinalFlush: Promise<void> | null = null
  // Snapshot of opt-in paths captured at SCHEDULE time. Vue's unmount
  // lifecycle runs directive `beforeUnmount` (which clears per-element
  // opt-ins) BEFORE the effect-scope dispose that triggers our drain.
  // Without a snapshot, a write flushed during the drain sees zero
  // opt-ins and wipes the storage entry. The snapshot lets the eventual
  // write reflect the moment-in-time opt-ins as the user typed.
  let pendingOptedInPaths: Set<PathKey> | null = null

  const writer = createDebouncedWriter(async () => {
    // No bail at entry: this closure runs from two paths — the
    // debounce timer firing (which already gated on `disposed` via the
    // schedule call) and the final flush from `dispose()`. The final
    // flush's invocation order (flush BEFORE disposed flips) lets this
    // write complete; the post-await guards below catch the rare case
    // where adapter resolution is slow enough to overlap with the
    // disposed flip.
    //
    // Use the schedule-time snapshot if present (handles the unmount
    // race where beforeUnmount has cleared the live registry). Falls
    // back to the live registry for any non-listener-triggered path.
    const optedInPaths = pendingOptedInPaths ?? new Set<PathKey>(state.persistOptIns.optedInPaths())
    pendingOptedInPaths = null
    const adapter = await adapterPromise
    if (isDisposed()) return
    // Sparse-payload reshape: the persisted form contains only paths
    // that were opted in via `register('foo', { persist: true })`. If
    // every opt-in has been torn down, wipe the entry rather than
    // write a hollow envelope (matches the per-element security model
    // — no opt-ins → nothing to persist).
    if (optedInPaths.size === 0) {
      await adapter.removeItem(key)
      return
    }
    // Unwrap the reactive form to a plain object before handing it to
    // the adapter — IDB's `structuredClone` can't serialise Vue
    // proxies (DATA_CLONE_ERR), and local/session stringify the
    // proxy's own-enumerable keys anyway.
    const rawForm = toRaw(state.form.value)
    // Shed sensitive leaves a container opt-in dragged in that weren't
    // individually acknowledged — they must never reach storage in
    // cleartext (SEC-1). Directly- or container-acknowledged secrets are
    // kept; the opt-in gate guarantees a sensitive opted-in path was
    // acknowledged.
    const filteredForm = stripUnacknowledgedSensitiveLeaves(
      pluckPaths(rawForm, optedInPaths),
      optedInPaths,
      state.isSensitivePath as (path: Path) => boolean
    ) as F
    // Build the envelope with the attaform-internal envelope version baked
    // in by `buildPersistedPayload`. Consumers no longer manage `v` —
    // schema-content invalidation lives at the storage-key level via
    // the fingerprint suffix.
    const filteredSchemaErrors = filterErrorsByPaths(state.schemaErrors, optedInPaths)
    const filteredUserErrors = filterErrorsByPaths(state.userErrors, optedInPaths)
    // Blank paths are part of the restorable UI state, so
    // they ride the same opt-in gate as form values: only persist
    // the entries whose paths are also opted in for persistence.
    const filteredTransientEmpty = new Set<string>()
    for (const tk of state.blankPaths) {
      if (optedInPaths.has(tk as PathKey)) filteredTransientEmpty.add(tk)
    }
    const payload = buildPersistedPayload<F>(
      filteredForm,
      include,
      filteredSchemaErrors,
      filteredUserErrors,
      filteredTransientEmpty
    )
    await adapter.setItem(key, payload)
  }, debounceMs)

  const unsubscribeChange = state.onFormChange((_next, meta) => {
    if (isDisposed() || inFlightFinalFlush !== null) return
    // Cross-tab apply: a sibling tab already wrote this value to its
    // own persistence layer; double-persisting from the receiving
    // tab would be wasted I/O. The multi-tab sync module sets
    // `persist: false` for this reason, which the next check already
    // catches — but adding the explicit `crossTab` early return makes
    // the intent legible at the listener boundary.
    if (meta?.crossTab === true) return
    // Per-element opt-in: only writes whose source declared `persist: true`
    // reach the storage adapter. Programmatic `form.setValue`, history
    // undo without opt-ins, devtools edits to non-opted paths, and
    // `reset()` all bypass this gate by passing no meta (or `persist:
    // false`).
    if (meta?.persist !== true) return
    // Snapshot opt-in paths NOW — Vue's unmount fires directive
    // beforeUnmount (which calls persistOptIns.removeAllFor) BEFORE
    // the scope-dispose that drives our drain. Capturing at schedule
    // time means the eventual write sees the opt-ins as they were
    // when the user typed, not as they were stripped.
    pendingOptedInPaths = new Set<PathKey>(state.persistOptIns.optedInPaths())
    writer.schedule()
  })

  const unsubscribeSuccess = clearOnSubmitSuccess
    ? state.onSubmitSuccess(() => {
        if (isDisposed()) return
        // Flush any pending/in-flight write BEFORE removing — otherwise
        // a timer that fires between submit and removeItem re-persists
        // the now-stale state. `flush()` awaits the in-flight promise
        // if one exists; if there's only a timer, it fires it
        // immediately and awaits. After that, removeItem wins.
        void (async () => {
          await writer.flush()
          if (isDisposed()) return
          const adapter = await adapterPromise
          if (isDisposed()) return
          await adapter.removeItem(key)
        })()
      })
    : () => undefined

  // Tab-close / bfcache-eviction flush (PASS2-13). The debounced
  // writer holds the last ≤debounceMs of edits before commit; without
  // a synchronous trigger, those keystrokes vanish when the user
  // closes the tab inside the debounce window. `pagehide` is the
  // modern recommendation — fires on bfcache eviction (where
  // `beforeunload` doesn't, since the page is preserved) AND on
  // tab-close. Sync-storage adapters (localStorage, sessionStorage)
  // commit inside the same task before the browser kills the JS
  // context; IDB transactions are best-effort.
  //
  // SSR guard: `window` is undefined during server rendering. The
  // listener attaches client-side only; SSR mounts complete their
  // own dispose path before the response flushes.
  const handlePageHide = (): void => {
    if (isDisposed()) return
    void writer.flush()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', handlePageHide)
  }

  // Async setup: resolve the adapter, then read back the persisted
  // payload. If the caller unmounts before this finishes, `disposed`
  // is true — the restore is skipped.
  void (async () => {
    const adapter = await adapterPromise
    if (isDisposed()) return
    // Orphan cleanup: delete any attaform-managed key under the same base
    // whose fingerprint suffix doesn't match the current schema. Runs
    // once per mount, fire-and-forget. Bounded cost: typically 0-1
    // orphans per form.
    void cleanupOrphanKeys(adapter, base, key)
    try {
      const raw = await adapter.getItem(key)
      const payload = readPersistedPayload<F>(raw)
      if (payload === null) {
        // Truly-absent entries are a no-op. A non-null raw that didn't
        // parse is a stale payload — wrong attaform envelope version, or
        // malformed shape — wipe so the next mount reads cleanly.
        if (raw !== null && raw !== undefined) {
          await adapter.removeItem(key)
        }
        return
      }
      if (isDisposed()) return
      // Sparse-aware replacement: the persisted form may contain only
      // a subset of paths (the ones opted into persistence on the
      // previous mount). Merge over the current form (which carries
      // schema defaults at this point — wirePersistence runs before
      // any user mutation could have happened) so non-persisted paths
      // keep their schema defaults.
      const merged = mergeSparseHydration(
        toRaw(state.form.value) as F,
        payload.data.form,
        state.schema as unknown as Parameters<typeof mergeSparseHydration>[2]
      )
      // `hydration: true` tells listeners (notably the history module)
      // that this replacement is the baseline, not a user mutation —
      // history wipes its stacks and reseeds with the post-hydration
      // snapshot so `undo()` can't reach the transient pre-hydration
      // default the form briefly held between mount and hydrate.
      state.applyFormReplacement(merged, { hydration: true })
      // payload. Persistence is per-element opt-in, so the persisted
      // payload only covers paths within the opt-in scope (the leaf
      // paths populated in `payload.data.form`). Construction-time
      // auto-marks for paths OUTSIDE that scope must survive —
      // without this, a non-opted-in numeric field's slim default
      // (`0`) would lose its blank mark on hydrate and surface as
      // `'0'` in its <input> instead of empty.
      //
      // Within the opt-in scope, the persisted state IS the truth: a
      // persisted path that's no longer blank (the user
      // typed) clears the construction-time mark, and a persisted
      // path that IS blank (still slim default) re-asserts.
      const persistedLeafPaths = collectPersistedLeafPaths(payload.data.form)
      for (const k of persistedLeafPaths) {
        state.blankPaths.delete(k)
        state.originalBlankPaths.delete(k)
      }
      for (const k of payload.data.blankPaths ?? []) {
        // v=6 stores blankPaths in the canonical `PathKey` JSON shape,
        // matching the in-memory representation. No conversion needed
        // at the I/O boundary — see the v=6 docblock on
        // `PERSISTED_ENVELOPE_VERSION`.
        state.blankPaths.add(k)
        state.originalBlankPaths.add(k)
      }
      if (include === 'form+errors') {
        // Each store rebuilds independently from its persisted entries.
        // Consumers who bumped `version` already had their payload
        // rejected above.
        if (payload.data.schemaErrors !== undefined) {
          const flat = payload.data.schemaErrors.flatMap(([, errs]) => errs)
          state.setAllSchemaErrors(flat)
        }
        if (payload.data.userErrors !== undefined) {
          const flat = payload.data.userErrors.flatMap(([, errs]) => errs)
          state.setAllUserErrors(flat)
        }
      }
      // Post-hydration revalidation: the construction-time seed ran
      // against the empty default, so its errors describe a stale
      // value. Async-only verdicts additionally never fire at
      // construction (the sync seed contract can't surface them;
      // schemas with async refinements / transforms / pipes degrade
      // to success there). A full async run at the root path wipes
      // `schemaErrors` and re-stamps with the authoritative result
      // for the rehydrated value — sync errors get refreshed, async
      // verdicts fire, the form lands in the state the persisted
      // value actually deserves.
      state.scheduleFieldValidation([], true /* immediate */)
    } catch {
      // Adapter IO errors shouldn't surface; storage adapters are
      // "best-effort" and already log their own warnings.
    }
  })()

  // Note: a "configured but no fields opted in" check used to live here
  // (microtask-deferred warn). Removed — having the persist capability
  // configured without spending it on a register() call is a valid
  // dormant state (scaffolding, A/B'd opt-ins, future-flagged fields).
  // The library shouldn't lecture the consumer for not exercising every
  // configured option. Eager throws only fire on actual contradictions
  // (no-key + persist; register-with-persist + no useForm-persist).

  /**
   * Imperative one-shot write. Read-merge-write strategy: flush any
   * pending debounced write first (so it can't overwrite our update),
   * read the existing payload, set the path's current value, optionally
   * merge in this path's errors, and write back. Preserves untouched
   * paths in storage.
   */
  async function writePathImmediately(path: Path): Promise<void> {
    if (isDisposed()) return
    await writer.flush()
    if (isDisposed()) return
    const adapter = await adapterPromise
    if (isDisposed()) return
    const raw = await adapter.getItem(key)
    const existing = readPersistedPayload<F>(raw)
    const baseForm = existing?.data.form ?? (Object.create(null) as F)
    const value = getAtPath(toRaw(state.form.value), path)
    const nextForm = setAtPath(baseForm, path, value) as F
    // Refresh this path's blank entry — and any descendants
    // — while preserving entries for OTHER paths the previous mount
    // persisted. Non-leaf writes (`writePathImmediately('user')`)
    // overwrite the entire subtree, so any disk entries below the
    // write path are dropped first; the live in-memory set then
    // contributes whatever marks are still active under that subtree.
    const { key: pathKey } = canonicalizePath(path)
    const transientSet = new Set<string>(
      (existing?.data.blankPaths ?? []).filter(
        (k) => k !== pathKey && !isDescendantPathKey(k, pathKey)
      )
    )
    for (const liveKey of state.blankPaths) {
      if (liveKey === pathKey || isDescendantPathKey(liveKey, pathKey)) {
        transientSet.add(liveKey)
      }
    }
    if (include === 'form') {
      await adapter.setItem(
        key,
        buildPersistedPayload<F>(nextForm, 'form', new Map(), new Map(), transientSet)
      )
      return
    }
    // include === 'form+errors': preserve the rest of the persisted
    // error map and refresh the entry for this path's canonical key.
    const schemaMap = new Map<string, ValidationError[]>(existing?.data.schemaErrors ?? [])
    const userMap = new Map<string, ValidationError[]>(existing?.data.userErrors ?? [])
    const currentSchema = state.schemaErrors.get(pathKey)
    const currentUser = state.userErrors.get(pathKey)
    if (currentSchema !== undefined && currentSchema.length > 0) {
      schemaMap.set(pathKey, [...currentSchema])
    } else {
      schemaMap.delete(pathKey)
    }
    if (currentUser !== undefined && currentUser.length > 0) {
      userMap.set(pathKey, [...currentUser])
    } else {
      userMap.delete(pathKey)
    }
    await adapter.setItem(
      key,
      buildPersistedPayload<F>(nextForm, 'form+errors', schemaMap, userMap, transientSet)
    )
  }

  /**
   * Wipe the persisted entry. Without `path`, removes the whole key.
   * With `path`, deletes only that subpath (and any matching error
   * entries) and writes back; the entry is removed entirely if the
   * resulting form value is empty.
   */
  async function clearPersistedDraft(path?: Path): Promise<void> {
    if (isDisposed()) return
    await writer.flush()
    if (isDisposed()) return
    const adapter = await adapterPromise
    if (isDisposed()) return
    if (path === undefined) {
      await adapter.removeItem(key)
      return
    }
    const raw = await adapter.getItem(key)
    const existing = readPersistedPayload<F>(raw)
    if (existing === null) return
    const nextForm = deleteAtPath(existing.data.form, path) as F
    if (isEmptyContainer(nextForm)) {
      await adapter.removeItem(key)
      return
    }
    const { key: pathKey } = canonicalizePath(path)
    // Drop the cleared path AND every descendant from the persisted
    // blank list so a later mount doesn't restore an
    // "empty" UI state for a path that no longer has any value
    // behind it. Non-leaf clears (`clearPersistedDraft('user')`)
    // wipe the whole user.* subtree.
    const transientSet = new Set(
      (existing.data.blankPaths ?? []).filter(
        (k) => k !== pathKey && !isDescendantPathKey(k, pathKey)
      )
    )
    if (include === 'form') {
      await adapter.setItem(
        key,
        buildPersistedPayload<F>(nextForm, 'form', new Map(), new Map(), transientSet)
      )
      return
    }
    const schemaErrors = (existing.data.schemaErrors ?? []).filter(([k]) => k !== pathKey)
    const userErrors = (existing.data.userErrors ?? []).filter(([k]) => k !== pathKey)
    const schemaMap = new Map<string, ValidationError[]>(schemaErrors.map(([k, v]) => [k, [...v]]))
    const userMap = new Map<string, ValidationError[]>(userErrors.map(([k, v]) => [k, [...v]]))
    await adapter.setItem(
      key,
      buildPersistedPayload<F>(nextForm, 'form+errors', schemaMap, userMap, transientSet)
    )
  }

  function awaitPendingWrites(): Promise<void> {
    // If dispose() already kicked off the final flush, return THAT
    // promise so the registry awaits the same drain instead of
    // scheduling a parallel one.
    if (inFlightFinalFlush !== null) return inFlightFinalFlush
    if (isDisposed()) return Promise.resolve()
    return writer.flush().catch(() => undefined)
  }

  function dispose(): void {
    if (isDisposed() || inFlightFinalFlush !== null) return
    unsubscribeChange()
    unsubscribeSuccess()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', handlePageHide)
    }
    // CRITICAL: flush BEFORE flipping `disposed`. The previous order
    // (set disposed=true, then call writer.flush()) caused the writer
    // closure to bail immediately, silently dropping the last
    // keystroke whenever a component unmounted within the debounce
    // window. Now we kick off the flush, then flip `disposed` only
    // after the in-flight write finishes.
    inFlightFinalFlush = writer
      .flush()
      .catch(() => undefined)
      .finally(() => {
        disposed = true
        inFlightFinalFlush = null
      })
    // Fire-and-forget — `awaitPendingWrites` exposes the promise for
    // callers that need to drain (the registry on consumer-eviction;
    // SSR shutdown).
    void inFlightFinalFlush
  }

  return {
    wiredConfig: config,
    writePathImmediately,
    clearPersistedDraft,
    awaitPendingWrites,
    dispose,
  }
}

/**
 * Treat `null`, `undefined`, `[]`, and `{}` as "nothing left to keep."
 * Used by `clearPersistedDraft(path)` to decide whether to wipe the
 * entire entry instead of writing a hollow envelope back.
 */
function isEmptyContainer(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (isPlainRecord(value)) return Object.keys(value).length === 0
  return false
}

/**
 * Walk a sparse persisted form and collect the canonical PathKey of
 * every leaf. "Leaf" = anything that isn't a plain object or array
 * (so primitives, null, deserialized Dates / strings all count). The
 * persisted form's leaves correspond 1:1 with the per-element opt-in
 * scope at the time persistence wrote, which the hydration path uses
 * to bound which blank entries to overwrite.
 */
function collectPersistedLeafPaths(form: unknown): PathKey[] {
  const out: PathKey[] = []
  walk(form, [])
  return out

  function walk(node: unknown, prefix: Path): void {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], [...prefix, i])
      }
      return
    }
    if (isPlainRecord(node)) {
      for (const key of Object.keys(node)) {
        walk((node as Record<string, unknown>)[key], [...prefix, key])
      }
      return
    }
    if (prefix.length === 0) return // root scalar — no path to canonicalize
    out.push(canonicalizePath(prefix).key)
  }
}

/**
 * `true` when `candidate` names a strict descendant of `ancestor` in
 * canonical PathKey form (`JSON.stringify(segments)`).
 *
 * `'["user"]'` is the ancestor; `'["user","age"]'` and
 * `'["user","address","line1"]'` are descendants. A pure prefix match
 * isn't enough — `'["userId"]'` shares the `'["user'` prefix with
 * `'["user"]'` but is not a descendant. The check anchors on the
 * comma that separates the parent's last segment from its first
 * child segment.
 */
function isDescendantPathKey(candidate: string, ancestor: string): boolean {
  if (candidate.length <= ancestor.length) return false
  if (!ancestor.endsWith(']')) return false
  const childPrefix = `${ancestor.slice(0, -1)},`
  return candidate.startsWith(childPrefix)
}
