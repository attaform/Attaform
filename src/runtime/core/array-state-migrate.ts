import type { WriteMeta } from '../types/types-api'
import { canonicalizePath, isPathPrefix, segmentsForPathKey } from './paths'
import type { Path, PathKey, Segment } from './paths'

type ArrayOp = NonNullable<WriteMeta['arrayOp']>

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
 */
export type IndexRemap = {
  readonly moved: ReadonlyMap<number, number>
  readonly vacated: ReadonlySet<number>
  readonly fresh: ReadonlySet<number>
}

/**
 * Build the index permutation for `op` against an array of length `oldLen`.
 * Mirrors the token appliers in `array-identity.ts` exactly, so element
 * state and the consumer-facing identity token relocate in lockstep.
 */
export function remapForOp(op: ArrayOp, oldLen: number): IndexRemap {
  const moved = new Map<number, number>()
  const vacated = new Set<number>()
  const fresh = new Set<number>()
  switch (op.kind) {
    case 'insert':
      // Everything at or past the slot shifts up one; the slot is new.
      for (let i = op.index; i < oldLen; i++) moved.set(i, i + 1)
      fresh.add(op.index)
      return { moved, vacated, fresh }
    case 'remove':
      // The slot's element is gone; everything past it shifts down one.
      vacated.add(op.index)
      for (let i = op.index + 1; i < oldLen; i++) moved.set(i, i - 1)
      return { moved, vacated, fresh }
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
      return { moved, vacated, fresh }
    case 'swap':
      if (op.a !== op.b) {
        moved.set(op.a, op.b)
        moved.set(op.b, op.a)
      }
      return { moved, vacated, fresh }
    case 'replace-at':
      // The occupant is wholly replaced: drop the old state, start fresh.
      vacated.add(op.index)
      fresh.add(op.index)
      return { moved, vacated, fresh }
  }
}

/**
 * Every index position whose occupant differs between the pre- and post-op
 * arrays: a source that left, a destination that gained a different element,
 * or a freshly created slot. Derived per-element state (schema verdicts) at
 * these positions is stale and must be dropped, since it described the prior
 * occupant.
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
  const idxPos = arrayPath.length
  const snapshots: Array<{ segments: Segment[]; index: number; value: V }> = []
  for (const [key, value] of map) {
    const index = elementIndexUnder(arrayPath, key, idxPos)
    if (index === null) continue
    if (!remap.moved.has(index) && !remap.vacated.has(index)) continue
    snapshots.push({ segments: [...(segmentsForPathKey(key) as Segment[])], index, value })
  }
  if (snapshots.length === 0) return
  for (const snap of snapshots) map.delete(canonicalizePath(snap.segments).key)
  for (const snap of snapshots) {
    const target = remap.moved.get(snap.index)
    if (target === undefined) continue // vacated: gone, not relocated
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
  const idxPos = arrayPath.length
  const snapshots: Array<{ segments: Segment[]; index: number }> = []
  for (const key of set) {
    const index = elementIndexUnder(arrayPath, key, idxPos)
    if (index === null) continue
    if (!remap.moved.has(index) && !remap.vacated.has(index)) continue
    snapshots.push({ segments: [...(segmentsForPathKey(key) as Segment[])], index })
  }
  if (snapshots.length === 0) return
  for (const snap of snapshots) set.delete(canonicalizePath(snap.segments).key)
  for (const snap of snapshots) {
    const target = remap.moved.get(snap.index)
    if (target === undefined) continue
    const relocated = snap.segments.slice()
    relocated[idxPos] = target
    set.add(canonicalizePath(relocated).key)
  }
}
