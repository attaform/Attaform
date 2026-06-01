import type { ValidationError } from '../../types/types-api'
import { __DEV__ } from '../dev'
import { isPathPrefix, segmentsForPathKey, type Path, type PathKey } from '../paths'
import { getAtPath, isPlainRecord, setAtPath } from '../path-walker'
import { safeAssign } from '../safe-assign'

/**
 * Persisted payload envelope.
 *
 * `v` is a attaform-INTERNAL storage-format version — bumped only when the
 * library's persisted payload schema itself changes (e.g. adding a new
 * field, restructuring `data`). It is NOT consumer-controlled.
 * Schema-driven invalidation uses the storage key's `:${fingerprint}`
 * suffix instead, so consumers don't need to manage versioning at all.
 *
 * `data` mirrors the SSR `SerializedFormData` shape so one deserialiser
 * handles both.
 *
 * Errors are stored source-segregated (matching FormStore's split):
 *   - `schemaErrors` is validation-owned; cleared by reset / submit-success.
 *   - `userErrors` is consumer-owned (written via setFieldErrors* APIs);
 *     persists across schema revalidation and successful submits.
 */
export type PersistedPayload<Form> = {
  readonly v: number
  readonly data: {
    readonly form: Form
    readonly schemaErrors?: ReadonlyArray<readonly [string, ValidationError[]]>
    readonly userErrors?: ReadonlyArray<readonly [string, ValidationError[]]>
    /**
     * Canonical `PathKey` JSON entries (`'["profile","bio"]'`) for the
     * paths that were in the form's `blankPaths` set at serialisation
     * time. Optional — forms with no blank paths skip the field.
     * Replayed into the reactive Set on the next mount so an accidental
     * refresh preserves the user's "displayed empty" state across
     * sessions. Introduced in envelope v=3.
     *
     * The encoding restored the JSON-array shape at v=6 (after a v=5
     * dotted-string detour) so literal-dot record keys
     * (`record["foo.bar"]` vs `record.foo.bar`) and integer-looking
     * record keys (`record["1"]` vs `record[1]`) survive the round-trip
     * unambiguously — the PathKey carries segment kind, dotted
     * notation does not.
     */
    readonly blankPaths?: ReadonlyArray<PathKey>
  }
}

/**
 * Current attaform-internal envelope version. Bumped only when the library
 * changes the persisted payload's structural shape — readers reject
 * envelopes with a different `v`. Schema-content invalidation is
 * handled at the storage key level (the `:${fingerprint}` suffix), so
 * consumers shouldn't see this number.
 *
 * v=3: adds `data.blankPaths` for round-tripping the
 * blank UI state across persistence + SSR. v=2 envelopes
 * are dropped with a one-time dev-warn (commit 6 of the unset feature).
 *
 * v=4: `ValidationError` gained a required `code` field. Persisted
 * `schemaErrors` / `userErrors` now include `code`; v=3 payloads are
 * dropped with a one-time dev-warn.
 *
 * v=5: `data.blankPaths` switched from canonical `PathKey` JSON
 * strings (`'["profile","bio"]'`) to dotted public-path strings
 * (`'profile.bio'`), matching the path notation everywhere else in
 * the public API. v=4 payloads are dropped with a one-time dev-warn.
 *
 * v=6: `data.blankPaths` switched BACK to the canonical `PathKey` JSON
 * shape (`'["profile","bio"]'`). The dotted notation collapses literal-
 * dot record keys (`record["foo.bar"]` vs. `record.foo.bar`) and
 * integer-looking record keys (`record["1"]` vs. `record[1]`) onto
 * the same wire shape, silently flipping the blank-mark onto a sibling
 * slot on hydrate. The JSON-array carries segment kind, so the
 * distinction round-trips losslessly. v=5 payloads are dropped with a
 * one-time dev-warn.
 */
export const PERSISTED_ENVELOPE_VERSION = 6

/**
 * `value` is expected to be a raw `PersistedPayload` (parsed JSON or
 * structured-cloned object). Returns `null` if the shape doesn't match
 * — the caller falls back to schema defaults.
 *
 * The attaform-internal envelope `v` must match `PERSISTED_ENVELOPE_VERSION`;
 * mismatches (older library versions' payloads) are dropped. Schema
 * change detection lives at the storage-key level via the fingerprint
 * suffix.
 */
export function readPersistedPayload<Form>(value: unknown): PersistedPayload<Form> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const envelope = value as Partial<PersistedPayload<Form>>
  if (typeof envelope.v !== 'number') return null
  if (envelope.v !== PERSISTED_ENVELOPE_VERSION) {
    warnVersionMismatch(envelope.v)
    return null
  }
  if (envelope.data === undefined || typeof envelope.data !== 'object') return null
  return envelope as PersistedPayload<Form>
}

/**
 * Tracks envelope versions we've already warned about during this
 * session. The reader hits this for every form mount that finds
 * stale persisted state, so a page with N saved drafts at an old
 * version would otherwise produce N warnings of the same content.
 * Module-scoped Set survives the test-suite hot-reload cycle but
 * resets on each fresh page load — exactly the dedup window we want.
 *
 * `null` in production so the Set allocation tree-shakes out.
 */
const warnedVersions: Set<number> | null = __DEV__ ? new Set<number>() : null

function warnVersionMismatch(observedVersion: number): void {
  if (warnedVersions === null) return
  if (warnedVersions.has(observedVersion)) return
  warnedVersions.add(observedVersion)
  console.warn(
    `[attaform] Dropping persisted draft — envelope v=${observedVersion}, ` +
      `but this version of the library expects v=${PERSISTED_ENVELOPE_VERSION}. ` +
      `The persisted shape changed across releases; older drafts can't be restored. ` +
      `New drafts saved this session will use the current envelope.`
  )
}

export function buildPersistedPayload<Form>(
  form: Form,
  include: 'form' | 'form+errors',
  schemaErrors: ReadonlyMap<string, ValidationError[]>,
  userErrors: ReadonlyMap<string, ValidationError[]>,
  blankPaths?: ReadonlySet<string>
): PersistedPayload<Form> {
  // The blank list is part of the form's restorable UI state — its
  // visibility doesn't depend on the `include` mode (which only governs
  // whether errors come along for the ride). Skip the field when the
  // set is empty so v=6 round-trips with unchanged minimal payload
  // size for forms that never go empty. The PathKey JSON shape (a
  // JSON-array string) goes through to disk verbatim so segment kind
  // survives the round-trip — see [[PASS2-8]] and the v=6 docblock
  // on `PERSISTED_ENVELOPE_VERSION`.
  let transientList: ReadonlyArray<PathKey> | undefined
  if (blankPaths !== undefined && blankPaths.size > 0) {
    transientList = [...blankPaths] as PathKey[]
  }

  if (include === 'form') {
    if (transientList === undefined) return { v: PERSISTED_ENVELOPE_VERSION, data: { form } }
    return {
      v: PERSISTED_ENVELOPE_VERSION,
      data: { form, blankPaths: transientList },
    }
  }
  return {
    v: PERSISTED_ENVELOPE_VERSION,
    data: {
      form,
      schemaErrors: [...schemaErrors.entries()].map(([k, v]) => [k, [...v]] as const),
      userErrors: [...userErrors.entries()].map(([k, v]) => [k, [...v]] as const),
      ...(transientList !== undefined ? { blankPaths: transientList } : {}),
    },
  }
}

/**
 * Tiny debounce utility. Returns a `{ schedule, flush, cancel }`
 * triple — `schedule` delays a single pending write, `flush` runs it
 * immediately, `cancel` drops it. Unlike a library `debounce`, this
 * one awaits the underlying async write inside `flush` so callers
 * can await full completion on consumer teardown.
 *
 * `debounceMs: 0` is the off switch — `schedule()` fires the write
 * synchronously rather than queueing through `setTimeout(fn, 0)`
 * (which is a macrotask the browser clamps to ~4 ms anyway).
 */
export function createDebouncedWriter(
  write: () => Promise<void>,
  debounceMs: number
): {
  schedule(): void
  flush(): Promise<void>
  cancel(): void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: Promise<void> | null = null
  // Per-write generation counter (PASS2-S2). Each `runWrite` call
  // captures its generation; the inline `.finally` only nulls the
  // shared `pending` when its capture still matches the live counter.
  // Without this guard, an older write's settle silently nullified
  // `pending` even when a newer write had replaced it, and any
  // `flush()` awaiting the OLD pending then resolved before the
  // newer write settled — an early drain signal even though no
  // bytes were lost (each write is a full idempotent snapshot).
  let writeGeneration = 0

  function runWrite(): void {
    const gen = ++writeGeneration
    pending = write().finally(() => {
      if (writeGeneration === gen) pending = null
    })
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer)
    // `debounceMs: 0` is the off switch — fire the write synchronously
    // rather than punting through `setTimeout(fn, 0)` (which queues a
    // macrotask and the browser clamps to ~4 ms anyway).
    if (debounceMs === 0) {
      runWrite()
      return
    }
    timer = setTimeout(() => {
      timer = null
      runWrite()
    }, debounceMs)
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
      runWrite()
    }
    // Drain-loop: if a new `schedule()` lands while we're awaiting an
    // older `pending`, the latest pending might be a different promise
    // by the time the older one settles. Re-read `pending` after the
    // await and keep looping until it goes null (or stabilises on the
    // same promise across an await tick — guards against an infinite
    // loop if a sync arm immediately re-schedules during the await).
    while (pending !== null) {
      const awaited = pending
      await awaited
      if (pending === awaited) break
    }
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { schedule, flush, cancel }
}

/**
 * Build a sparse object containing only the values at `pathKeys` from
 * `form`. Each PathKey is the canonical JSON-array form
 * (`'["profile","name"]'`) emitted by `canonicalizePath`. Paths whose
 * value is `undefined` in the source (e.g. an optional schema field
 * the user never touched) are skipped — the caller's
 * `mergeSparseHydration` re-fills from schema defaults on read.
 *
 * The returned object structurally-shares with the source: a path that
 * names a container (e.g. `'contacts'` resolving to a whole array) is
 * copied by reference into the sparse output. Per-leaf opt-ins
 * (`'contacts.0.name'`) construct intermediate containers via
 * `setAtPath`.
 */
export function pluckPaths(form: unknown, pathKeys: Iterable<PathKey>): unknown {
  let sparse: unknown = undefined
  for (const pathKey of pathKeys) {
    // PathKeys arrive from the opt-in registry (canonical) — cache hit
    // every iteration. The null branch covers persistence payloads
    // round-tripped from disk that were corrupted before reaching the
    // restoration code.
    const segments = segmentsForPathKey(pathKey)
    if (segments === null) continue
    const value = getAtPath(form, segments)
    if (value === undefined) continue
    sparse = setAtPath(sparse ?? {}, segments, value)
  }
  return sparse ?? {}
}

/**
 * Strip sensitive-named leaves from an already-plucked persisted form
 * unless their sensitivity was acknowledged, then return a new object
 * (the input is not mutated). A container opt-in
 * (`register('payment', { persist: true })`) copies its whole subtree
 * via `pluckPaths`, so nested `cvv` / `card_number` leaves would
 * otherwise reach storage in cleartext even though they were never
 * individually acknowledged.
 *
 * A sensitive path is kept only when an opted-in path that COVERS it
 * (the leaf itself, or an ancestor container) is itself sensitive.
 * Because the persist opt-in gate (`allowSensitivePersist`) only admits
 * a sensitive path when `acknowledgeSensitive: true` was set, an opted-in
 * sensitive path is, by construction, an acknowledged one — so this
 * keeps a directly-acknowledged leaf AND the subtree of an acknowledged
 * sensitive container, while shedding the unacknowledged secrets a
 * non-sensitive container opt-in dragged along.
 *
 * Mirrors multi-tab's `stripSensitivePathsDeep`, but keyed off the
 * persist opt-in set rather than stripping every sensitive path.
 */
export function stripUnacknowledgedSensitiveLeaves(
  form: unknown,
  optedInPaths: ReadonlySet<PathKey>,
  isSensitivePath: (path: Path) => boolean
): unknown {
  // Opted-in paths that are themselves sensitive could only reach the
  // set by being acknowledged; a sensitive value survives the scrub iff
  // one of these covers it.
  const acknowledgedSensitive: Path[] = []
  for (const key of optedInPaths) {
    const segs = segmentsForPathKey(key)
    if (segs !== null && isSensitivePath(segs as Path)) acknowledgedSensitive.push(segs as Path)
  }
  const coveredByAcknowledged = (path: Path): boolean =>
    acknowledgedSensitive.some((prefix) => isPathPrefix(prefix, path))

  const walk = (path: Path, value: unknown): unknown => {
    if (path.length > 0 && isSensitivePath(path) && !coveredByAcknowledged(path)) {
      return undefined // strip this leaf / subtree
    }
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item, i) => walk([...path, i], item))
    if (!isPlainRecord(value)) return value
    // Scrub container carries `Object.prototype` plus `safeAssign`
    // for the per-key write so a hostile persisted payload landing a
    // literal `__proto__` key is written as an own data property, not
    // through the inherited setter. The sensitive-leaf scrub feeds
    // back into the persisted payload; shape stays consistent with
    // what `mergeDeep` produces on the way back in.
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const walked = walk([...path, key], (value as Record<string, unknown>)[key])
      if (walked !== undefined) safeAssign(out, key, walked)
    }
    return out
  }
  return walk([], form)
}

/**
 * Restrict a `(PathKey → ValidationError[])` map to entries whose key
 * appears in `pathKeys`. Used by the persistence writer to drop errors
 * on non-opted-in paths from the persisted envelope — a persisted
 * error without a persisted value would dangle on rehydration (the
 * form would resurrect with no value but a complaint about it).
 */
export function filterErrorsByPaths(
  errors: ReadonlyMap<string, ValidationError[]>,
  pathKeys: ReadonlySet<PathKey>
): Map<string, ValidationError[]> {
  const out = new Map<string, ValidationError[]>()
  for (const [key, value] of errors) {
    if (pathKeys.has(key as PathKey)) out.set(key, value)
  }
  return out
}
