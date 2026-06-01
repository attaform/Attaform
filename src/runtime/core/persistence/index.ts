import type {
  AbstractSchema,
  FormStorage,
  FormStorageKind,
  PersistConfig,
  PersistConfigOptions,
} from '../../types/types-api'
import { PERSISTENCE_KEY_PREFIX } from '../defaults'
import { isPlainRecord } from '../path-walker'
import { type Path, type Segment } from '../paths'
import { safeAssign, safeOwnHas, safeOwnRead } from '../safe-assign'

/**
 * Public-ish handle returned by `wirePersistence`. Lives on
 * `state.modules.get('persistence')` (inside a `PersistenceHandle`) so
 * `buildFormApi` can plug `form.persist(path)` and
 * `form.clearPersistedDraft(path?)` into the consumer-facing API.
 * Internal — consumers go through the API.
 */
export type PersistenceModule = {
  /**
   * Read-merge-write a single path's current value. Flushes any pending
   * debounced write first so the imperative checkpoint can't be
   * overwritten by a stale-data write that fires immediately after.
   * No-op if the FormStore is disposed.
   */
  writePathImmediately(path: Path): Promise<void>
  /**
   * Wipe the persisted entry. With `path` provided, removes that
   * subpath only (and any matching error entries) and writes back; the
   * entry is removed entirely if the resulting form value is empty.
   * Without `path`, calls the adapter's `removeItem` directly.
   */
  clearPersistedDraft(path?: Path): Promise<void>
  /**
   * Drains any pending debounced or in-flight write. Resolves once
   * storage has the latest opted-in form value. Called by the registry
   * before evicting a FormStore so the last keystroke isn't lost when
   * a component unmounts mid-debounce.
   *
   * Safe to call after `dispose()` — resolves immediately as a no-op.
   */
  awaitPendingWrites(): Promise<void>
  /** Disposer — called from FormStore.dispose. */
  dispose(): void
}

/**
 * What `state.modules.get(PERSISTENCE_MODULE_KEY)` holds for a
 * persist-configured form. Set SYNCHRONOUSLY at mount even though the
 * persistence machinery (`wire-persistence` + `payload`) is dynamically
 * imported, so the always-on `useForm` path never ships it:
 *
 *   - `config` answers the two synchronous reads that can't wait for the
 *     chunk — register-api's "is persist configured?" gate on the render
 *     path, and the cross-instance divergence warn when a second
 *     `useForm({ key })` mounts on the same store.
 *   - `ready` resolves to the live `PersistenceModule` once the chunk
 *     lands (or `undefined` if the form disposed first / the chunk
 *     failed to load). The imperative `form.persist` / `clearPersistedDraft`
 *     APIs await it; they were already async, so no synchronous caller
 *     gains a new await.
 *
 * A non-persisting form never sets this, so `state.modules.has(...)`
 * stays false for it exactly as before.
 */
export type PersistenceHandle = {
  readonly config: PersistConfigOptions
  readonly ready: Promise<PersistenceModule | undefined>
}

/**
 * Cache key for `state.modules.get(...)`. Only the persistence layer
 * itself + buildFormApi read this — exporting keeps the literal in one
 * place rather than scattering 'persistence' across files.
 */
export const PERSISTENCE_MODULE_KEY = 'persistence'

/**
 * Resolve a `FormStorage` adapter for the given storage kind. Built-in
 * kinds are dynamically imported so a consumer who picks `'local'`
 * never pulls the IndexedDB adapter code. Rollup's
 * side-effect-free graph tree-shakes the unused adapters cleanly.
 *
 * Passing a custom `FormStorage` object bypasses the dispatch and is
 * returned as-is — no dynamic import happens. This is the escape hatch
 * for encrypted stores, cookie-backed stores, native-mobile bridges.
 */
export async function getStorageAdapter(
  storage: FormStorageKind | FormStorage
): Promise<FormStorage> {
  if (typeof storage === 'object') return storage
  switch (storage) {
    case 'local': {
      const { createLocalStorageAdapter } = await import('./local-storage')
      return createLocalStorageAdapter()
    }
    case 'session': {
      const { createSessionStorageAdapter } = await import('./session-storage')
      return createSessionStorageAdapter()
    }
    case 'indexeddb': {
      const { createIndexedDbAdapter } = await import('./indexeddb')
      return createIndexedDbAdapter()
    }
  }
}

/**
 * Resolve the per-form storage KEY BASE. Default is
 * `attaform:${formKey}` — consumers who want a different
 * namespace (multi-tenant app, per-user prefix) pass `persist.key`.
 *
 * The full storage key is composed at the wirePersistence call site
 * as `${base}:${fingerprint}` so the writer holds the schema's
 * structural fingerprint directly. The base is exposed separately so
 * the orphan-cleanup pass can `listKeys(base)` and prune any entry
 * under an old fingerprint.
 */
export function resolveStorageKeyBase(config: PersistConfigOptions, formKey: string): string {
  return config.key ?? `${PERSISTENCE_KEY_PREFIX}${formKey}`
}

/**
 * Delete every attaform-managed key under `base` from `adapter`,
 * skipping any key equal to `keepKey`. Sweeps two shapes:
 *   - Unfingerprinted keys (no `:` suffix at all) — defensive cover
 *     for hand-written or migration-written entries that skipped the
 *     fingerprint suffix.
 *   - Fingerprint-suffixed keys whose suffix doesn't match the
 *     current schema.
 *
 * Exact-or-`:`-prefix match prevents collision with sibling forms
 * whose `config.key` shares a string prefix (e.g. `'my-form'` vs
 * `'my-form-2'`). Fire-and-forget; per-key `removeItem` errors are
 * swallowed and a failing `listKeys` returns silently.
 *
 * Pass `keepKey` to retain the current fingerprint entry; leave it
 * undefined for an unconditional sweep (used by the cross-store
 * passes that wipe every attaform-managed key under `base`).
 */
async function removeMatchingKeys(
  adapter: FormStorage,
  base: string,
  keepKey?: string
): Promise<void> {
  let keys: string[]
  try {
    keys = await adapter.listKeys(base)
  } catch {
    return
  }
  for (const key of keys) {
    if (key === keepKey) continue
    if (key === base || key.startsWith(`${base}:`)) {
      void adapter.removeItem(key).catch(() => undefined)
    }
  }
}

/**
 * Delete every attaform-managed key under `base` that's not the
 * current fingerprint key. SSR-guarded by the caller (cleanup runs
 * inside `wirePersistence`, which is itself client-only).
 */
export async function cleanupOrphanKeys(
  adapter: FormStorage,
  base: string,
  currentKey: string
): Promise<void> {
  await removeMatchingKeys(adapter, base, currentKey)
}

/**
 * The canonical list of built-in backends. Used by the cross-store
 * cleanup sweep — any standard backend not matching the configured
 * one gets a `removeItem(key)` at mount.
 */
export const STANDARD_STORAGE_KINDS = ['local', 'session', 'indexeddb'] as const

/**
 * Coerce the consumer-facing `PersistConfig` (which accepts shorthand
 * forms — a string backend name, or a custom `FormStorage` adapter) into
 * the resolved options bag the rest of the persistence layer expects.
 *
 * Discrimination rules (in order):
 *
 *   1. `typeof input === 'string'` — `FormStorageKind` shorthand.
 *   2. `'storage' in input`         — already the full options bag.
 *   3. otherwise                    — custom `FormStorage` adapter.
 *
 * Step 3 trusts the caller's type: a `FormStorage` is a duck-typed
 * `{ getItem, setItem, removeItem }` object, and we don't validate
 * the shape — TypeScript already covers that path on the call site.
 *
 * Returning `PersistConfigOptions` (not `PersistConfig`) means the
 * normalized form is referentially distinct from the input — callers
 * can be confident `result.storage` is always present.
 */
export function normalizePersistConfig(input: PersistConfig): PersistConfigOptions {
  if (typeof input === 'string') return { storage: input }
  if ('storage' in input) return input
  return { storage: input }
}

/**
 * Wipe every attaform-managed key under `base` from every standard
 * backend. Fire-and-forget. Used when no `persist:` is configured on
 * the form: a previous deployment may have written entries under this
 * base (any fingerprint), and the dev removing persistence should
 * mean the on-disk artifact is gone too — for every fingerprint that
 * ever ran.
 */
export async function sweepAllOrphansAcrossStandardStores(base: string): Promise<void> {
  for (const kind of STANDARD_STORAGE_KINDS) {
    try {
      const adapter = await getStorageAdapter(kind)
      await removeMatchingKeys(adapter, base)
    } catch {
      // Backend unavailable (Node, Safari private mode, IDB blocked).
    }
  }
}

/**
 * Cross-store orphan cleanup: wipe every attaform-managed key under
 * `base` from each standard backend that's NOT the configured one.
 * Symmetric with `cleanupOrphanKeys` on the configured store — ensures
 * stale drafts don't survive in stores the dev migrated AWAY from.
 *
 * Why this matters: if a form was persisting to `'local'` and the dev
 * later switches to `'session'` (or a custom encrypted adapter), the
 * stale entry in `'local'` would otherwise sit there indefinitely,
 * potentially holding sensitive data the dev thought they had moved
 * to a safer store. The configured `storage` option is the source of
 * truth for "where the draft lives now"; everything else is hysteresis
 * from past app states and should be wiped.
 *
 * If `configured` is a custom `FormStorage` adapter, all three
 * standard backends are swept (we don't know which built-in the dev
 * migrated away from, and we can't reach custom adapters by
 * enumeration). Fire-and-forget; per-backend errors swallowed.
 */
export async function sweepNonConfiguredStandardStoresForOrphans(
  configured: FormStorageKind | FormStorage,
  base: string
): Promise<void> {
  const configuredKind = typeof configured === 'string' ? configured : null
  for (const kind of STANDARD_STORAGE_KINDS) {
    if (kind === configuredKind) continue
    try {
      const adapter = await getStorageAdapter(kind)
      await removeMatchingKeys(adapter, base)
    } catch {
      // Backend unavailable.
    }
  }
}

/**
 * Merge a sparse persisted form over schema defaults. Returns a new
 * object — neither input is mutated. Used by hydration replay when
 * the persisted payload only contains opted-in paths.
 *
 * Object keys are merged recursively (sparse keys override defaults).
 * Arrays are REPLACED wholesale: if a path resolves to an array in the
 * sparse persisted form, it overrides the schema's array entirely. This
 * is the simpler rule for the common cases (whole-array opt-in via
 * `'contacts'` works; per-leaf opt-in implicitly accepts that schema
 * defaults for sibling leaves at the same array index won't be filled).
 *
 * Primitives in the sparse form override defaults. `null` and explicit
 * primitive values pass through (a persisted `null` is meaningful).
 *
 * **Discriminated unions:** when a path resolves to a DU in the
 * schema AND the sparse value's discriminator differs from the
 * defaults' discriminator (i.e. the persisted draft was written
 * against a different active variant than the schema's first-variant
 * default), the merge REBASES on the matching variant's slim default
 * rather than deep-merging across variants. Without this, deep merge
 * would produce an inconsistent shape carrying BOTH variants' keys
 * (e.g. `{channel: 'sms', number: '...', address: ''}`) — violates
 * the DU's per-variant shape contract and surfaces ghost fields in
 * `form.values`.
 */
export function mergeSparseHydration<F>(
  schemaDefaults: F,
  sparse: unknown,
  schema?: AbstractSchema<unknown, unknown>
): F {
  return mergeDeep(schemaDefaults, sparse, [], schema) as F
}

function mergeDeep(
  target: unknown,
  source: unknown,
  path: readonly Segment[],
  schema: AbstractSchema<unknown, unknown> | undefined
): unknown {
  if (source === undefined) return target
  if (source === null || typeof source !== 'object') return source
  if (Array.isArray(source)) return source
  if (!isPlainRecord(source)) return source
  // DU-aware merge at a discriminated-union path. Three sub-cases the
  // plain deep-merge below can't get right on its own:
  //   1. source's disc selects a different variant than target's →
  //      rebase target onto the matched variant's slim default so the
  //      prior variant's keys don't bleed alongside the new ones.
  //   2. source's disc is unknown to the schema → collapse to a
  //      disc-only stub `{ [discKey]: discValue }` (mirrors the
  //      runtime stub-state contract; validation surfaces the
  //      mismatch on first validateAsync).
  //   3. source carries foreign keys (sibling-variant fields the
  //      active variant doesn't declare) → drop them; the merge only
  //      keeps source keys that exist in the matched variant default.
  // Skipped when no schema is provided (callers without an adapter
  // handle, including older tests) — those fall through to plain
  // deep-merge.
  if (schema !== undefined) {
    const du = schema.getUnionDiscriminatorAtPath(path as Segment[])
    if (du !== undefined) {
      const sourceRecord = source as Record<string, unknown>
      const sourceDisc = sourceRecord[du.discriminatorKey]
      if (sourceDisc !== undefined && !du.isVariantSelected(sourceDisc)) {
        return { [du.discriminatorKey]: sourceDisc }
      }
      if (sourceDisc !== undefined) {
        const variantDefault = du.getVariantDefault(sourceDisc)
        if (isPlainRecord(variantDefault)) {
          // Object spread carries `variantDefault`'s own properties
          // via `CreateDataProperty`, bypassing the inherited
          // `__proto__` setter — so a variant default that legitimately
          // declares `__proto__` is copied through without reassigning
          // the result's prototype chain. Per-key writes route through
          // `safeAssign`: a literal `__proto__` key from a hostile
          // persisted payload (when the variant declares it) lands as
          // an own data property. The variant-filter below
          // (`key in variantDefault`) still excludes prototype-
          // corrupting keys for the DU-variant case unless the schema
          // legitimately declares them.
          const out: Record<string, unknown> = { ...variantDefault }
          for (const key of Object.keys(sourceRecord)) {
            // Own-property check — the variant-filter must treat
            // inherited slots as absent so `'__proto__' in variantDefault`
            // doesn't smuggle a hostile payload key into the merge.
            if (!safeOwnHas(variantDefault, key) && key !== du.discriminatorKey) continue
            safeAssign(
              out,
              key,
              mergeDeep(
                safeOwnRead(out, key),
                safeOwnRead(sourceRecord, key),
                [...path, key],
                schema
              )
            )
          }
          return out
        }
      }
      // No disc in source — empty stub keeps the slot in a "between
      // selections" state so a subsequent disc write reshapes cleanly.
      return {}
    }
  }
  const mergeTarget = target
  // Object spread carries `mergeTarget`'s own properties via
  // `CreateDataProperty`, which bypasses the `__proto__` setter
  // inherited from `Object.prototype`. The per-key `safeAssign` lands
  // a literal `__proto__` key smuggled into the persisted JSON as an
  // own data property here too, with no path to `Object.prototype`.
  // Legitimate `prototype` / `constructor` / `__proto__` fields in
  // a consumer schema persist and restore at their declared path.
  const out: Record<string, unknown> = isPlainRecord(mergeTarget) ? { ...mergeTarget } : {}
  for (const key of Object.keys(source)) {
    safeAssign(
      out,
      key,
      mergeDeep(
        safeOwnRead(out, key),
        safeOwnRead(source as Record<string, unknown>, key),
        [...path, key],
        schema
      )
    )
  }
  return out
}
