import type { WriteMeta } from '../types/types-api'
import type { IndexRemap } from './array-state-migrate'
import { canonicalizePath, isPathPrefix, segmentsForPathKey } from './paths'
import type { Path, PathKey, Segment } from './paths'

type ArrayOp = NonNullable<WriteMeta['arrayOp']>

/**
 * Operation-maintained per-element identity for arrays. Each tracked
 * array path keeps a list of opaque tokens parallel to its elements;
 * a structural mutation replays its exact index permutation onto that
 * list, so a token follows its element across inserts, removals, moves,
 * and swaps. Tokens are allocated, never derived from content, so
 * duplicate values and in-place edits keep distinct, stable identities.
 *
 * Identity is bookkept, not inferred. A write that carries an `arrayOp`
 * hint (the `field-arrays.ts` helpers) is replayed precisely. A write
 * with no hint to follow (`append`, or a wholesale `setValue(arrayPath,
 * [...])`) realigns by position: tokens stay put for indices that still
 * exist, fresh tokens fill a grown tail, a shrunk tail is dropped. The
 * locked contract is that a wholesale replacement cannot be followed, so
 * its identity is best-effort by position.
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
  applyOp(arraySegs: Path, op: ArrayOp): void
  /**
   * Relocate every tracked array entry sitting under `arrayPath`'s nested
   * elements along `remap`. Mirrors the path-keyed Map / Set migrations in
   * `array-state-migrate.ts` so a nested-array's own identity tokens follow
   * its parent row across an outer-array structural mutation. Without this,
   * the inner `tokens` / `baselines` entries at `items.<old>.…` would either
   * leak (the source slot is gone but its entry survives) or collide (the
   * new occupant at the source slot reads stale tokens belonging to the
   * departed row).
   */
  applyRemap(arrayPath: Path, remap: IndexRemap): void
  /** Realign a tracked array's tokens to its current length by position. */
  realign(arraySegs: Path): void
  /**
   * Whether any tracked array under `prefix` differs from its baseline
   * element order — a different length, or a reordered identity sequence.
   * Backs the structural component of `dirty`: once per-element state
   * follows its element, a positional value comparison can no longer see a
   * reorder or removal, so the dirty verdict consults this instead.
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
    // operation permutes it — that snapshot is its construction-time order.
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

    applyOp(arraySegs, op) {
      const arrayKey = canonicalizePath(arraySegs).key
      const postLen = getArrayLength(arraySegs)
      // Reconstruct the pre-op length so the list reflects the array the
      // operation acted on before replaying the permutation.
      const preLen =
        op.kind === 'insert' ? postLen - 1 : op.kind === 'remove' ? postLen + 1 : postLen
      const ids = ensure(arrayKey, Math.max(0, preLen))
      switch (op.kind) {
        case 'insert':
          ids.splice(op.index, 0, allocate())
          return
        case 'remove':
          ids.splice(op.index, 1)
          return
        case 'move': {
          const [moved] = ids.splice(op.from, 1)
          ids.splice(op.to, 0, moved ?? allocate())
          return
        }
        case 'swap': {
          const tmp = ids[op.a] ?? allocate()
          ids[op.a] = ids[op.b] ?? allocate()
          ids[op.b] = tmp
          return
        }
        case 'replace-at':
          // A replaced element is a new element: reset its identity.
          ids[op.index] = allocate()
          return
      }
    },

    applyRemap(arrayPath, remap) {
      if (remap.moved.size === 0 && remap.vacated.size === 0 && remap.fresh.size === 0) return
      // Snapshot then mutate, mirroring `migrateMapSubtree`: a destination
      // write can't clobber a not-yet-snapshotted source. Walk both maps the
      // same way; the index segment to rewrite sits at depth `arrayPath.length`.
      const relocate = (store: Map<PathKey, string[]>): void => {
        const idxPos = arrayPath.length
        const snapshots: Array<{ segments: Segment[]; index: number; value: string[] }> = []
        for (const [key, value] of store) {
          const segments = segmentsForPathKey(key)
          if (segments === null) continue
          if (!isPathPrefix(arrayPath, segments)) continue
          if (segments.length <= idxPos) continue
          const idxSeg = segments[idxPos]
          if (typeof idxSeg !== 'number') continue
          if (!remap.moved.has(idxSeg) && !remap.vacated.has(idxSeg) && !remap.fresh.has(idxSeg)) {
            continue
          }
          snapshots.push({ segments: [...segments], index: idxSeg, value })
        }
        if (snapshots.length === 0) return
        for (const snap of snapshots) store.delete(canonicalizePath(snap.segments).key)
        for (const snap of snapshots) {
          const target = remap.moved.get(snap.index)
          if (target === undefined) continue // vacated / replaced — already source-deleted; drop
          const relocated = snap.segments.slice()
          relocated[idxPos] = target
          store.set(canonicalizePath(relocated).key, snap.value)
        }
      }
      relocate(tokens)
      relocate(baselines)
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
      // Reset replaces the form wholesale without an `arrayOp`, so realign
      // each tracked array to its post-reset length by position first, then
      // anchor that order as the new baseline — otherwise a reset that
      // changes a length would read structurally dirty on the next access.
      for (const arrayKey of [...tokens.keys()]) {
        const segs = segmentsForPathKey(arrayKey)
        if (segs === null) continue
        const ids = ensure(arrayKey, getArrayLength(segs))
        baselines.set(arrayKey, [...ids])
      }
    },
  }
}
