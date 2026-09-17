import { toRaw, type Ref } from 'vue'
import type { ErrorCell, WriteMeta } from '../types/types-api'
import { consumerKeys, readConsumerProp } from './consumer-code'
import { NO_ERRORS } from './error-codes'
import { diffAndApply } from './diff-apply'
import { getAtPath, isPlainRecord } from './path-walker'
import {
  canonicalizePath,
  isPathPrefix,
  segmentsForPathKey,
  type Path,
  type PathKey,
  type Segment,
} from './paths'
import { safeAssign } from './safe-assign'
import type { FieldRecord, OriginalsRecord } from './store-records'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'

type ArrayOp = NonNullable<WriteMeta['arrayOp']>

/**
 * The arrays engine: everything keeping per-element state truthful across a
 * structural array mutation, in one module around one permutation core.
 *
 * A structural mutation, which the typed helpers below tag with an `arrayOp`,
 * is decoded exactly once into an {@link IndexRemap}, and `remapForOp` is the
 * single source of permutation truth. Every consumer derives from that remap:
 *
 *  - the identity tracker replays it onto its token lists (`permuteList`);
 *  - per-element state relocation walks it (`migrateMapSubtree` /
 *    `migrateSetSubtree`);
 *  - derived-state eviction, schema verdicts and variant memory, drops at its
 *    `changedIndices`;
 *  - the write funnel scopes its per-element work to `remap.fresh`.
 *
 * One decode and many readers, so the permutation cannot drift between the
 * consumer-facing `:key` token and the state that must travel with it.
 */

/**
 * The exact index permutation an array operation produced, recovered from
 * its `arrayOp` hint. Three disjoint facts drive every downstream rewrite:
 *
 *  - `moved`: an old element index and the new index it now sits at.
 *    Identity entries (`i -> i`) are omitted, so an unmoved element's state
 *    is left untouched in place.
 *  - `vacated`: old indices whose element no longer exists (a `remove`
 *    target, or the outgoing occupant of a `replace-at`). Their non-derived
 *    state is dropped, not relocated.
 *  - `fresh`: new indices holding a brand-new element (an `insert` slot, or
 *    a `replace-at` target). They start with no carried-over state.
 *
 * `oldLen` / `newLen` carry the array's pre- and post-op lengths so a
 * consumer replaying the permutation (the identity tracker's token
 * lists) never re-derives them from the op kind.
 */
export type IndexRemap = {
  readonly moved: ReadonlyMap<number, number>
  readonly vacated: ReadonlySet<number>
  readonly fresh: ReadonlySet<number>
  readonly oldLen: number
  readonly newLen: number
}

/**
 * Build the index permutation for `op` against an array of length `oldLen`. The
 * one place operation kinds are interpreted; everything downstream consumes the
 * remap.
 */
export function remapForOp(op: ArrayOp, oldLen: number): IndexRemap {
  const moved = new Map<number, number>()
  const vacated = new Set<number>()
  const fresh = new Set<number>()
  let newLen = oldLen
  switch (op.kind) {
    case 'insert':
      // Everything at or past the slot shifts up one; the slot is new.
      for (let i = op.index; i < oldLen; i++) moved.set(i, i + 1)
      fresh.add(op.index)
      newLen = oldLen + 1
      break
    case 'remove':
      // The slot's element is gone; everything past it shifts down one.
      vacated.add(op.index)
      for (let i = op.index + 1; i < oldLen; i++) moved.set(i, i - 1)
      newLen = Math.max(0, oldLen - 1)
      break
    case 'move':
      // Pull `from` out and reinsert at `to`; the span between them slides
      // one step the other way to fill the gap.
      if (op.from !== op.to) {
        moved.set(op.from, op.to)
        if (op.from < op.to) {
          for (let i = op.from + 1; i <= op.to; i++) moved.set(i, i - 1)
        } else {
          for (let i = op.to; i < op.from; i++) moved.set(i, i + 1)
        }
      }
      break
    case 'swap':
      if (op.a !== op.b) {
        moved.set(op.a, op.b)
        moved.set(op.b, op.a)
      }
      break
    case 'replace-at':
      // The occupant is wholly replaced: drop the old state, start fresh.
      vacated.add(op.index)
      fresh.add(op.index)
      break
  }
  return { moved, vacated, fresh, oldLen, newLen }
}

/**
 * Every index position whose occupant differs between the pre- and post-op
 * arrays: a source that left, a destination that gained a different element,
 * or a freshly created slot. Derived per-element state (schema verdicts,
 * variant memory) at these positions is stale and must be dropped, since it
 * described the prior occupant.
 */
export function changedIndices(remap: IndexRemap): ReadonlySet<number> {
  const changed = new Set<number>(remap.vacated)
  for (const [from, to] of remap.moved) {
    changed.add(from)
    changed.add(to)
  }
  for (const index of remap.fresh) changed.add(index)
  return changed
}

/**
 * Replay `remap` onto a list that parallels the array by position: each
 * surviving entry lands at its destination index, a vacated entry drops, and
 * every slot no survivor claimed, the fresh ones plus a grown tail, is filled
 * by `fill()`. The list-shaped counterpart of the path-keyed migrations below,
 * so a token follows its element exactly the way the element's keyed state
 * does.
 */
function permuteList<T>(list: ReadonlyArray<T>, remap: IndexRemap, fill: () => T): T[] {
  const claimed: Array<T | undefined> = new Array<T | undefined>(remap.newLen)
  for (let i = 0; i < remap.oldLen; i++) {
    if (remap.vacated.has(i)) continue
    const to = remap.moved.get(i) ?? i
    if (to < remap.newLen) claimed[to] = list[i]
  }
  const next: T[] = []
  for (let i = 0; i < remap.newLen; i++) {
    // `undefined` marks an unclaimed slot (a fresh index). Every
    // caller's T is non-nullish (identity tokens), so ?? can't
    // mistake a survivor for a hole.
    next.push(claimed[i] ?? fill())
  }
  return next
}

// --- The shared key walk ---
//
// Every path-keyed store (field records, errors, blank sets, identity tokens,
// variant memory) is interrogated the same way on a structural mutation: decode
// each key, keep the ones under the mutated array carrying a numeric element
// segment at the array's depth, and act on the element index found there. One
// walk serves them all.

type KeyAtIndex = {
  readonly key: PathKey
  readonly segments: Segment[]
  readonly index: number
}

// Decode `key` and, if it sits under `arrayPath` with a numeric element
// segment at the array's depth, return that index. Non-matching keys (a
// different subtree, a non-element segment) return null.
function elementIndexUnder(arrayPath: Path, key: PathKey, idxPos: number): number | null {
  const segments = segmentsForPathKey(key)
  if (segments === null) return null
  if (!isPathPrefix(arrayPath, segments)) return null
  if (segments.length <= idxPos) return null
  const index = segments[idxPos]
  return typeof index === 'number' ? index : null
}

/**
 * Snapshot every key in `keys` whose element index under `arrayPath`
 * satisfies `member`. Snapshot-then-act is the contract that keeps a
 * two-sided relocation (a swap) from clobbering a not-yet-visited
 * source, so callers always collect first and mutate after.
 */
function collectKeysAtIndices(
  keys: Iterable<PathKey>,
  arrayPath: Path,
  member: (index: number) => boolean
): KeyAtIndex[] {
  const idxPos = arrayPath.length
  const hits: KeyAtIndex[] = []
  for (const key of keys) {
    const index = elementIndexUnder(arrayPath, key, idxPos)
    if (index === null || !member(index)) continue
    const segments = segmentsForPathKey(key)
    if (segments === null) continue
    hits.push({ key, segments: [...segments], index })
  }
  return hits
}

function remapAffects(remap: IndexRemap): (index: number) => boolean {
  return (index) => remap.moved.has(index) || remap.vacated.has(index) || remap.fresh.has(index)
}

/**
 * Relocate the entries of a PathKey-keyed Map to follow `remap`, rewriting
 * only the element index segment at the array's depth so deeper segments
 * (and any nested array's own identity) survive. Snapshots every affected
 * entry first, deletes all sources, then re-sets survivors at their
 * destinations, so a destination write never clobbers a not-yet-snapshotted
 * source (a swap relocates both sides cleanly). Vacated sources are dropped.
 *
 * `rewriteValue` rebuilds the stored value at its new path: an entry that
 * embeds its own path (a field record, an original, an error list) must
 * carry the relocated segments, not the stale ones it was snapshotted with.
 */
export function migrateMapSubtree<V>(
  map: Map<PathKey, V>,
  arrayPath: Path,
  remap: IndexRemap,
  rewriteValue: (value: V, relocatedSegments: Path) => V
): void {
  const hits = collectKeysAtIndices(map.keys(), arrayPath, remapAffects(remap))
  if (hits.length === 0) return
  const idxPos = arrayPath.length
  const snapshots: Array<KeyAtIndex & { value: V }> = []
  for (const hit of hits) {
    const value = map.get(hit.key)
    if (value !== undefined) snapshots.push({ ...hit, value })
  }
  for (const snap of snapshots) map.delete(snap.key)
  for (const snap of snapshots) {
    const target = remap.moved.get(snap.index)
    if (target === undefined) continue // vacated / replaced: gone, not relocated
    const relocated = snap.segments.slice()
    relocated[idxPos] = target
    map.set(canonicalizePath(relocated).key, rewriteValue(snap.value, relocated))
  }
}

/**
 * The Set counterpart to {@link migrateMapSubtree}: relocate membership for a
 * PathKey-keyed Set (blank-path bookkeeping) along `remap`, dropping vacated
 * sources. No value to rewrite, so only the keys move.
 */
export function migrateSetSubtree(set: Set<PathKey>, arrayPath: Path, remap: IndexRemap): void {
  const hits = collectKeysAtIndices(set, arrayPath, remapAffects(remap))
  if (hits.length === 0) return
  const idxPos = arrayPath.length
  for (const hit of hits) set.delete(hit.key)
  for (const hit of hits) {
    const target = remap.moved.get(hit.index)
    if (target === undefined) continue
    const relocated = hit.segments.slice()
    relocated[idxPos] = target
    set.add(canonicalizePath(relocated).key)
  }
}

/**
 * Drop the SCHEMA side of every cell whose element index is in `indices`, those
 * verdicts describing a prior occupant. User sides survive, already relocated
 * by the cell migration in `migrateElementState`, and a cell left empty leaves
 * the map, including the empty husk a relocated schema-only cell leaves at its
 * destination, every relocation destination being a changed index.
 */
function evictSchemaVerdictsAtIndices(
  errorCells: Map<PathKey, ErrorCell>,
  arrayPath: Path,
  indices: ReadonlySet<number>
): void {
  for (const hit of collectKeysAtIndices([...errorCells.keys()], arrayPath, (index) =>
    indices.has(index)
  )) {
    const cell = errorCells.get(hit.key)
    if (cell === undefined) continue
    if (cell.user.length === 0) errorCells.delete(hit.key)
    else if (cell.schema.length > 0) errorCells.set(hit.key, { schema: NO_ERRORS, user: cell.user })
  }
}

// Drop every entry of a path-keyed store whose element index is in `indices`:
// the eviction half of the walk, for derived state that is recomputed rather
// than relocated.
function deleteKeysAtIndices(
  keys: Iterable<PathKey>,
  del: (key: PathKey) => void,
  arrayPath: Path,
  indices: ReadonlySet<number>
): void {
  for (const hit of collectKeysAtIndices(keys, arrayPath, (index) => indices.has(index))) {
    del(hit.key)
  }
}

// ─── Element identity ───────────────────────────────────────────────

/**
 * Operation-maintained per-element identity for arrays. Each tracked
 * array path keeps a list of opaque tokens parallel to its elements;
 * a structural mutation replays its exact index permutation onto that
 * list, so a token follows its element across inserts, removals, moves,
 * and swaps. Tokens are allocated, never derived from content, so
 * duplicate values and in-place edits keep distinct, stable identities.
 *
 * Identity is bookkept, not inferred. A write that carries an `arrayOp`
 * hint (the typed helpers) is replayed precisely via its remap. A write
 * with no hint to follow (a wholesale `setValue(arrayPath, [...])`)
 * realigns by position: tokens stay put for indices that still exist,
 * fresh tokens fill a grown tail, a shrunk tail is dropped. The locked
 * contract is that a wholesale replacement cannot be followed, so its
 * identity is best-effort by position.
 */
export type ArrayIdentity = {
  /**
   * Identity token for the element at `index` of the array at
   * `arraySegs`. Out-of-range indices return `''`. Reading seeds the
   * token list by position if the array was populated outside a tracked
   * write (the schema default, hydration), so a token is stable from the
   * first read onward.
   */
  tokenAt(arraySegs: Path, index: number): string
  /** Replay a structural mutation's exact permutation onto the token list. */
  applyOp(arraySegs: Path, remap: IndexRemap): void
  /**
   * Relocate every tracked array entry sitting under `arrayPath`'s nested
   * elements along `remap`. Mirrors the path-keyed Map / Set migrations
   * above so a nested-array's own identity tokens follow its parent row
   * across an outer-array structural mutation. Without this, the inner
   * `tokens` / `baselines` entries at `items.<old>.…` would either leak
   * (the source slot is gone but its entry survives) or collide (the new
   * occupant at the source slot reads stale tokens belonging to the
   * departed row).
   */
  applyRemap(arrayPath: Path, remap: IndexRemap): void
  /** Realign a tracked array's tokens to its current length by position. */
  realign(arraySegs: Path): void
  /**
   * Whether any tracked array under `prefix` differs from its baseline element
   * order, by length or by a reordered identity sequence. It backs the
   * structural component of `dirty`: once per-element state follows its
   * element, a positional value comparison can no longer see a reorder or a
   * removal, so the dirty verdict consults this.
   */
  hasStructuralChangeUnder(prefix: Path): boolean
  /**
   * Re-anchor every tracked array's baseline order to its current order.
   * Called on `reset()` so a form reads structurally pristine afterward.
   */
  rebaselineAll(): void
}

export function createArrayIdentity(getArrayLength: (arraySegs: Path) => number): ArrayIdentity {
  // Token lists keyed by array PathKey, each parallel to its array.
  const tokens = new Map<PathKey, string[]>()
  // Baseline token order per array, captured on first track and re-anchored
  // on reset. A live order that diverges from its baseline is a structural
  // change (reorder, insert, or removal).
  const baselines = new Map<PathKey, string[]>()
  // One form-wide monotonic counter, so every token is unique across
  // every array in the form (safe as a Map key, not just a v-for key).
  let counter = 0
  const allocate = (): string => `k${(counter++).toString(36)}`

  // Bring the token list for `arrayKey` in line with `expectedLen`,
  // by position: seed fresh when untracked, grow the tail with fresh
  // tokens, or drop a shrunk tail. Returns the live list.
  function ensure(arrayKey: PathKey, expectedLen: number): string[] {
    let ids = tokens.get(arrayKey)
    const firstTrack = ids === undefined
    if (ids === undefined) {
      ids = []
      tokens.set(arrayKey, ids)
    }
    while (ids.length < expectedLen) ids.push(allocate())
    if (ids.length > expectedLen) ids.length = expectedLen
    // Anchor the baseline the first time the array is seen, before any
    // operation permutes it: that snapshot is its construction-time order.
    if (firstTrack) baselines.set(arrayKey, [...ids])
    return ids
  }

  function orderPristineForKey(arrayKey: PathKey): boolean {
    const baseline = baselines.get(arrayKey)
    const current = tokens.get(arrayKey)
    if (baseline === undefined || current === undefined) return true
    if (baseline.length !== current.length) return false
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== baseline[i]) return false
    }
    return true
  }

  return {
    tokenAt(arraySegs, index) {
      const len = getArrayLength(arraySegs)
      if (index < 0 || index >= len) return ''
      const ids = ensure(canonicalizePath(arraySegs).key, len)
      return ids[index] ?? ''
    },

    applyOp(arraySegs, remap) {
      // Anchor the list at the pre-op length the remap was built against,
      // then replay the permutation: survivors land at their destinations
      // with their tokens, fresh slots allocate.
      const arrayKey = canonicalizePath(arraySegs).key
      const ids = ensure(arrayKey, remap.oldLen)
      tokens.set(arrayKey, permuteList(ids, remap, allocate))
    },

    applyRemap(arrayPath, remap) {
      if (remap.moved.size === 0 && remap.vacated.size === 0 && remap.fresh.size === 0) return
      // Both stores relocate the same way; the token lists themselves
      // don't embed their path, so the value passes through unchanged.
      migrateMapSubtree(tokens, arrayPath, remap, (value) => value)
      migrateMapSubtree(baselines, arrayPath, remap, (value) => value)
    },

    realign(arraySegs) {
      ensure(canonicalizePath(arraySegs).key, getArrayLength(arraySegs))
    },

    hasStructuralChangeUnder(prefix) {
      for (const arrayKey of tokens.keys()) {
        if (orderPristineForKey(arrayKey)) continue
        const segs = segmentsForPathKey(arrayKey)
        if (segs === null) continue
        if (isPathPrefix(prefix, segs)) return true
      }
      return false
    },

    rebaselineAll() {
      // Reset replaces the form wholesale with no `arrayOp`, so realign each
      // tracked array to its post-reset length by position first and anchor
      // that order as the new baseline. Otherwise a reset that changes a length
      // reads structurally dirty on the next access.
      for (const arrayKey of [...tokens.keys()]) {
        const segs = segmentsForPathKey(arrayKey)
        if (segs === null) continue
        const ids = ensure(arrayKey, getArrayLength(segs))
        baselines.set(arrayKey, [...ids])
      }
    },
  }
}

// ─── Variant memory ─────────────────────────────────────────────────

/**
 * Per-(union-path, outgoing-disc-value) snapshot stashed on a
 * discriminated-union switch. `value` is the deep-cloned outgoing subtree,
 * detached from Vue's reactive graph, and `blankPaths` is the subset of the
 * form's blank set living under the union path at the moment of the switch.
 *
 * It is in-memory only, never persisted and never on `form.value`, and is
 * consulted on the next switch to the same disc value to restore the prior
 * typed state.
 */
export type VariantSnapshot = {
  readonly value: unknown
  readonly blankPaths: ReadonlyArray<PathKey>
}

/**
 * Per-form variant-memory factory, owning one
 * `Map<unionPathKey, Map<discValue, VariantSnapshot>>` plus the API keeping it
 * in sync with structural form mutations: array reshapes, resets, whole-form
 * replacements. Self-contained bookkeeping, so it need not live in the store's
 * closure.
 *
 * It takes no parameters, the map being the only state it owns; callers feed it
 * raw paths and the remaps flowing from `WriteMeta.arrayOp`.
 */
export interface VariantMemory {
  /** Empty all snapshots. Called on `reset()` / whole-form replace. */
  clear(): void
  /**
   * Drop snapshots whose union key sits at or under `parentPath`. Used
   * by `resetField` and after structural array mutations to forget the
   * outgoing-variant cache for paths that no longer exist (or whose
   * indices have shifted).
   */
  clearUnderPath(parentPath: Path): void
  /**
   * Drop snapshots whose element index under `arrayPath` is in `indices`, the
   * structural-mutation eviction. Memory keyed by absolute index would bleed
   * onto the new occupants of those indices at a future variant switch. The
   * caller passes the op's `changedIndices(remap)`, so every slot whose
   * occupant differs, shifted, swapped, replaced or fresh, forgets its cache.
   */
  dropAtIndices(arrayPath: Path, indices: ReadonlySet<number>): void
  /** Stash the outgoing-variant snapshot for a future switch-in. */
  recordOutgoing(unionKey: PathKey, discValue: unknown, snapshot: VariantSnapshot): void
  /** Look up the incoming-variant snapshot, or `undefined`. */
  lookupIncoming(unionKey: PathKey, discValue: unknown): VariantSnapshot | undefined
}

export function createVariantMemory(): VariantMemory {
  const memory = new Map<PathKey, Map<unknown, VariantSnapshot>>()

  return {
    clear(): void {
      memory.clear()
    },
    clearUnderPath(parentPath: Path): void {
      for (const memKey of [...memory.keys()]) {
        const segs = segmentsForPathKey(memKey)
        if (segs === null) continue
        if (isPathPrefix(parentPath, segs)) memory.delete(memKey)
      }
    },
    dropAtIndices(arrayPath: Path, indices: ReadonlySet<number>): void {
      deleteKeysAtIndices([...memory.keys()], (key) => memory.delete(key), arrayPath, indices)
    },
    recordOutgoing(unionKey: PathKey, discValue: unknown, snapshot: VariantSnapshot): void {
      let perUnion = memory.get(unionKey)
      if (perUnion === undefined) {
        perUnion = new Map<unknown, VariantSnapshot>()
        memory.set(unionKey, perUnion)
      }
      perUnion.set(discValue, snapshot)
    },
    lookupIncoming(unionKey: PathKey, discValue: unknown): VariantSnapshot | undefined {
      return memory.get(unionKey)?.get(discValue)
    },
  }
}

/**
 * Deep-clone a value read out of the live reactive form tree, for the
 * variant-memory snapshot. It calls `toRaw` at every level to bypass Vue's
 * on-demand wrapping, preserves `BigInt`, `Date`, `Map` and `Set` natively,
 * all of which Zod can validate at a leaf, and recurses through plain arrays
 * and objects. Detached from the reactive graph, so a later whole-form write
 * does not mutate the snapshot.
 *
 * Anything that is not a plain object or array is carried by REFERENCE. The
 * key-by-key rebuild below reaches own enumerable properties only, while a
 * `File`, `Blob`, `URL`, typed array or class instance keeps its state behind
 * prototype accessors or internal slots, so cloning one yields an empty `{}`
 * and silently destroys the value on a variant switch (#542). Holding the
 * reference is safe because the form never reaches into an opaque value: a
 * write replaces the whole leaf. Structural rather than a list of named types,
 * so a class nobody here thought of is covered the same way.
 */
export function cloneVariantSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const raw = toRaw(value as object)
  if (raw instanceof Date) return new Date(raw.getTime())
  if (raw instanceof Map) {
    const out = new Map<unknown, unknown>()
    for (const [k, v] of raw.entries()) out.set(cloneVariantSnapshot(k), cloneVariantSnapshot(v))
    return out
  }
  if (raw instanceof Set) {
    const out = new Set<unknown>()
    for (const v of raw) out.add(cloneVariantSnapshot(v))
    return out
  }
  if (raw instanceof RegExp) return new RegExp(raw.source, raw.flags)
  if (Array.isArray(raw)) {
    const out: unknown[] = new Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = cloneVariantSnapshot(raw[i])
    return out
  }
  if (!isPlainRecord(raw)) return raw
  const src = raw as Record<string, unknown>
  // A variant snapshot restores back into `form.values` on a union-switch
  // reshape, so the container carries `Object.prototype` and the round-trip
  // matches the rest of the value-write pipeline, with `safeAssign` landing a
  // `__proto__` key as an own data property. Reads are guarded because a
  // snapshot holds whatever the consumer wrote, and a throwing accessor would
  // escape out of a discriminated-union switch.
  const out: Record<string, unknown> = {}
  for (const k of consumerKeys(src)) {
    safeAssign(out, k, cloneVariantSnapshot(readConsumerProp(src, k)))
  }
  return out
}

// ─── Structural-op bookkeeping ──────────────────────────────────────

/**
 * Per-path async validation entry, tracking the in-flight or scheduled run: a
 * one-shot `aborted` latch, the pending debounce `timer`, a `settled` flag that
 * stops the parent counters double-decrementing once a chain's `.finally` has
 * run while its entry still sits in the state map awaiting the next schedule,
 * and a `released` flag.
 *
 * `aborted` is a plain boolean rather than an AbortController. The validation
 * path hands no signal to a consumer and attaches no listeners, so cancellation
 * needs only a monotonic flag the run reads through its own captured entry, and
 * skipping a per-keystroke `new AbortController()` removes the scheduler's
 * dominant allocation.
 *
 * Exported so the host form-store, which owns the state map and writes new
 * entries, and the structural-op bookkeeping, which aborts entries at vacated
 * indices, share one structural type.
 */
export type FieldValidationEntry = {
  // Latched true to cancel this run: a supersede on the next schedule, a
  // cancel-all / path-scoped reset, a DU variant-reshape, or an array index
  // vacated under it. The run reads it through its own captured entry
  // (pre-parse and post-resolve), so it survives the entry's map deletion.
  aborted: boolean
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
  // Set true when an external caller (a path-scoped reset) has already released
  // this run's counters synchronously. The run's own `.finally` then skips its
  // decrements, so it can't double-count against a run rescheduled at the same
  // key in the meantime.
  released: boolean
}

/**
 * The state surface the structural-op bookkeeping keeps in sync with array
 * mutations. Every entry is a reference to one of the form-store's own maps or
 * refs: the factory holds them and owns none, so its lifecycle matches the
 * host store's exactly.
 */
export type ArrayBookkeepingDeps = {
  readonly form: Ref<unknown>
  readonly fields: Map<PathKey, FieldRecord>
  readonly errorCells: Map<PathKey, ErrorCell>
  readonly originals: Map<PathKey, OriginalsRecord>
  readonly blankPaths: Set<PathKey>
  readonly originalBlankPaths: Set<PathKey>
  readonly authoredPaths: Set<PathKey>
  readonly fieldValidationCounts: Map<PathKey, number>
  readonly fieldValidatingSince: Map<PathKey, number>
  readonly fieldValidationState: Map<PathKey, FieldValidationEntry>
  readonly activeValidations: Ref<number>
  readonly arrayIdentity: ArrayIdentity
  readonly variantMemory: VariantMemory
  readonly touchFieldRecord: (
    pathKey: PathKey,
    path: Path,
    patch: Partial<Omit<FieldRecord, 'path'>>
  ) => void
  readonly decFieldValidation: (key: PathKey) => void
}

export type ArrayBookkeeping = {
  /**
   * Apply every state consequence of one structural array mutation, in
   * one pass over the remap the write funnel decoded. Runs after the
   * form value itself has been written. In order:
   *
   *  1. **Relocate** non-derived per-element state so it follows its
   *     element rather than bleeding onto the new occupant of the
   *     element's old index: `fields` (touched / focused / blurred /
   *     connection bookkeeping, plus the record's embedded `path`),
   *     `userErrors` (consumer-set errors, plus each error's embedded
   *     `path`), `blankPaths`, the `originals` / `originalBlankPaths`
   *     dirty baseline (a moved element keeps its OWN dirty verdict; a
   *     structural change still dirties the form through the identity
   *     tracker's order comparison), `authoredPaths` (the "consumer
   *     wrote here" mark), and the validation streak anchors + counts
   *     (`fieldValidatingSince` leads `fieldValidationCounts`, keeping
   *     `validatingSince !== null` an outer bracket around `count > 0`
   *     for synchronous readers). Nested arrays' own identity tokens
   *     relocate through `arrayIdentity.applyRemap`.
   *  2. **Seed** each freshly created element (an insert slot, a
   *     replace-at target) the way an appended one is registered: walk
   *     its leaves and seed an absence baseline in `originals` (so the
   *     new element reads dirty, like an append) plus a field record.
   *     Migration has already relocated the prior occupant's state off
   *     this slot's keys; without this the new element would be
   *     invisible to `touch` and read pristine.
   *  3. **Evict** derived state at changed indices: schema verdicts, which
   *     revalidation recomputes and which drop synchronously so a stale one
   *     cannot show for a frame or linger under a `validateOn` that will not
   *     revalidate this write, and variant memory, which is keyed by absolute
   *     index and would bleed onto the new occupants.
   *  4. **Abort** any field validation still in flight for leaves of
   *     removed elements so a late async resolution can't write a
   *     verdict at a dead index, and release the pending counters so
   *     `meta.validating` reflects the removal at once.
   *  5. **Replay** the permutation onto the mutated array's own
   *     identity tokens.
   */
  readonly applyStructuralOp: (arrayPath: Path, remap: IndexRemap) => void
}

export function createArrayBookkeeping(deps: ArrayBookkeepingDeps): ArrayBookkeeping {
  const {
    form,
    fields,
    errorCells,
    originals,
    blankPaths,
    originalBlankPaths,
    authoredPaths,
    fieldValidationCounts,
    fieldValidatingSince,
    fieldValidationState,
    activeValidations,
    arrayIdentity,
    variantMemory,
    touchFieldRecord,
    decFieldValidation,
  } = deps

  function migrateElementState(arrayPath: Path, remap: IndexRemap): void {
    if (remap.moved.size === 0 && remap.vacated.size === 0) return
    migrateMapSubtree(fields, arrayPath, remap, (record, segments) => ({
      ...record,
      path: segments,
    }))
    // A cell's USER side follows its element (paths re-stamped); the
    // SCHEMA side is derived state describing the prior occupant, so a
    // relocated cell lands schema-empty and the eviction pass below
    // clears stale verdicts (and any empty husk) at every changed index.
    migrateMapSubtree(errorCells, arrayPath, remap, (cell, segments) => ({
      schema: NO_ERRORS,
      user: cell.user.map((error) => ({ ...error, path: [...segments] })),
    }))
    migrateMapSubtree(originals, arrayPath, remap, (record, segments) => ({
      segments,
      value: record.value,
    }))
    migrateSetSubtree(blankPaths, arrayPath, remap)
    migrateSetSubtree(originalBlankPaths, arrayPath, remap)
    migrateSetSubtree(authoredPaths, arrayPath, remap)
    // The validation-streak anchor leads its count, mirroring
    // `incFieldValidation`: relocating `fieldValidatingSince` before
    // `fieldValidationCounts` keeps `validatingSince !== null` an outer bracket
    // around `count > 0` at the destination key, so a synchronous reader
    // catching the gap between the two relocations never sees `validating: true,
    // validatingSince: null` (which would flash idle).
    migrateMapSubtree(fieldValidatingSince, arrayPath, remap, (since) => since)
    migrateMapSubtree(fieldValidationCounts, arrayPath, remap, (count) => count)
    // Nested-array identity: relocate every tracked array sitting under
    // `arrayPath`'s element slots so a nested `v-for :key` stays stable
    // across an outer-array mutation (no token leak, no collision on the
    // new occupant of a vacated slot).
    arrayIdentity.applyRemap(arrayPath, remap)
  }

  function seedFreshElement(arrayPath: Path, freshIndex: number): void {
    const elementPath: Path = [...arrayPath, freshIndex]
    const now = new Date().toISOString()
    diffAndApply(undefined, getAtPath(form.value, elementPath), elementPath, (patch) => {
      if (patch.kind !== 'added') return
      const { key } = canonicalizePath(patch.path)
      if (!originals.has(key)) originals.set(key, { segments: patch.path, value: undefined })
      touchFieldRecord(key, patch.path, { updatedAt: now })
    })
  }

  function abortValidationAtVacatedIndices(arrayPath: Path, remap: IndexRemap): void {
    if (remap.vacated.size === 0) return
    const hits = collectKeysAtIndices([...fieldValidationState.keys()], arrayPath, (index) =>
      remap.vacated.has(index)
    )
    for (const hit of hits) {
      const entry = fieldValidationState.get(hit.key)
      if (entry === undefined) continue
      if (entry.timer !== null) {
        clearTimeout(entry.timer)
      } else if (!entry.settled) {
        activeValidations.value = Math.max(0, activeValidations.value - 1)
        decFieldValidation(hit.key)
      }
      entry.aborted = true
      fieldValidationState.delete(hit.key)
    }
  }

  return {
    applyStructuralOp(arrayPath, remap) {
      migrateElementState(arrayPath, remap)
      for (const freshIndex of remap.fresh) seedFreshElement(arrayPath, freshIndex)
      const changed = changedIndices(remap)
      evictSchemaVerdictsAtIndices(errorCells, arrayPath, changed)
      abortValidationAtVacatedIndices(arrayPath, remap)
      variantMemory.dropAtIndices(arrayPath, changed)
      arrayIdentity.applyOp(arrayPath, remap)
    },
  }
}

// ─── The typed array helpers ────────────────────────────────────────

/**
 * Typed array helpers on top of FormStore. Each reads the current array at the
 * path, produces a new copy so the `form` ref's reactive notification goes out,
 * and writes it back through `setValueAtPath`, where the whole downstream
 * bookkeeping comes free: diff patches, field-record `updatedAt` stamps, error
 * store preservation.
 *
 * Out-of-range index semantics:
 *   - `remove`, `swap` and `replace` no-op on an invalid index and never grow
 *     the array.
 *   - `insert` clamps its target through `Array.prototype.splice`, so a value
 *     past `length` is treated as `length`.
 *   - `move` no-ops on an invalid `from` and clamps `to` to `[0, length]`.
 *
 * None of them mutate the existing array: every write is a fresh literal, so
 * Vue's identity-based change detection fires. A caller composing several
 * mutations should batch at the schema level instead, building the replacement
 * shape and calling `setValue(path, shape)` once.
 */

export type FieldArrayApi = {
  append(path: string, value: unknown): boolean
  prepend(path: string, value: unknown): boolean
  insert(path: string, index: number, value: unknown): boolean
  remove(path: string, index: number): boolean
  swap(path: string, a: number, b: number): boolean
  move(path: string, from: number, to: number): boolean
  replace(path: string, index: number, value: unknown): boolean
}

export function buildFieldArrayApi<F extends GenericForm>(
  state: FormStore<F, GenericForm>
): FieldArrayApi {
  function readArray(path: string): unknown[] {
    const segments = canonicalizePath(path).segments
    const current = state.getValueAtPath(segments)
    // A missing path, or one holding a non-array because the schema default was
    // undefined, reads as an empty array, which lets `append` work on an array
    // the schema never initialised. Throwing instead would surface a
    // programmer error earlier and block a common consumer pattern.
    return Array.isArray(current) ? current.slice() : []
  }

  function writeArray(path: string, next: unknown[], arrayOp?: WriteMeta['arrayOp']): boolean {
    const { segments } = canonicalizePath(path)
    const meta: WriteMeta = {
      ...(arrayOp !== undefined ? { arrayOp } : {}),
    }
    return state.setValueAtPath(segments, next, meta)
  }

  return {
    append(path, value) {
      // A pure length-grow at the tail, recorded as an insert there so the
      // write funnel scopes its per-element work, the slim gate, structural
      // completion, authoring and bookkeeping, to the one fresh element rather
      // than re-walking all N. Existing indices keep their identities, an
      // insert-at-tail remap shifting nothing.
      const next = readArray(path)
      next.push(value)
      return writeArray(path, next, { kind: 'insert', index: next.length - 1 })
    },
    prepend(path, value) {
      const next = readArray(path)
      next.unshift(value)
      // Prepend is an insert at the head: every existing element shifts up
      // by one. The `insert` op records that exact permutation.
      return writeArray(path, next, { kind: 'insert', index: 0 })
    },
    insert(path, index, value) {
      const next = readArray(path)
      // Resolve the actual insertion index under `splice` semantics BEFORE the
      // splice runs: a negative value counts from the end against the PRE-splice
      // length, a positive one clamps to `[0, preLen]`. Pass that same index to
      // both `splice` and the recorded `arrayOp`, so variant-memory eviction,
      // identity-token replay and per-element migration all act on the slot the
      // element landed in. Clamping the recorded index against the POST-splice
      // length instead yields 0 for a negative input even where splice placed
      // the element later in the array.
      const preLen = next.length
      const insertIndex = index < 0 ? Math.max(0, preLen + index) : Math.min(index, preLen)
      next.splice(insertIndex, 0, value)
      return writeArray(path, next, { kind: 'insert', index: insertIndex })
    },
    remove(path, index) {
      const next = readArray(path)
      if (index < 0 || index >= next.length) return false
      next.splice(index, 1)
      return writeArray(path, next, { kind: 'remove', index })
    },
    swap(path, a, b) {
      const next = readArray(path)
      if (a < 0 || a >= next.length) return false
      if (b < 0 || b >= next.length) return false
      if (a === b) return false
      const tmp = next[a]
      next[a] = next[b]
      next[b] = tmp
      return writeArray(path, next, { kind: 'swap', a, b })
    },
    move(path, from, to) {
      const next = readArray(path)
      if (from < 0 || from >= next.length) return false
      const [item] = next.splice(from, 1)
      const clampedTo = Math.max(0, Math.min(to, next.length))
      next.splice(clampedTo, 0, item)
      // The element leaves `from` and lands at `clampedTo`; everything
      // between shifts by one. `to` carries the clamped destination so
      // the permutation matches the array we just wrote.
      return writeArray(path, next, { kind: 'move', from, to: clampedTo })
    },
    replace(path, index, value) {
      const next = readArray(path)
      if (index < 0 || index >= next.length) return false
      next[index] = value
      return writeArray(path, next, { kind: 'replace-at', index })
    },
  }
}
