/**
 * The error stores, indexed by path prefix.
 *
 * `aggregateErrorsAt(state, prefix)` answers "every active error at or
 * under this path". Scanning all three stores per call makes a table's
 * reads O(rows x errors) where the answer is O(errors), so keys are
 * collected once per change, resolved to segments once and sorted, and
 * a query binary-searches its own window.
 *
 * A `PathKey` is `JSON.stringify(segments)`, which is what makes a
 * sorted array enough. Every key under `["rows",0]` begins
 * `["rows",0,`: the parent's key minus its closing bracket, plus a
 * comma. Call that the marker. Every descendant is >= the marker, and
 * every descendant is <= the parent's own key, because the two agree
 * up to the last character and `,` (0x2C) sorts before `]` (0x5D). So
 * `[marker, parentKey]` is a contiguous window holding every
 * descendant and the parent itself.
 *
 * The window is a SUPERSET: callers still apply `isPathPrefix`, so this
 * encoding argument cannot quietly become the definition of a prefix.
 * The root has no marker (`[,` begins nothing) and matches everything,
 * so it is answered with the whole index.
 */
import type { ValidationError } from '../types/types-api'
import { keyForSegments, segmentsForPathKey, type Path, type PathKey } from './paths'

/** One indexed path: its key, and the segments that key decodes to. */
export type ErrorPathEntry = {
  readonly key: PathKey
  readonly segments: Path
}

/**
 * Every path carrying at least one error, sorted by key.
 *
 * Keys are collected from the three stores and deduplicated: a path
 * with both a schema error and a `setErrors` entry appears once, and
 * the caller reads all three lists off it.
 */
export function buildErrorPathIndex(
  cells: ReadonlyMap<
    PathKey,
    { readonly schema: readonly unknown[]; readonly user: readonly unknown[] }
  >,
  blank: ReadonlyMap<PathKey, readonly ValidationError[]>
): readonly ErrorPathEntry[] {
  const keys = new Set<PathKey>()
  for (const [key, cell] of cells) {
    if (cell.schema.length > 0 || cell.user.length > 0) keys.add(key)
  }
  for (const [key, list] of blank) {
    if (list.length > 0) keys.add(key)
  }
  if (keys.size === 0) return EMPTY_INDEX
  const entries: ErrorPathEntry[] = []
  for (const key of keys) {
    // A key that does not decode is not addressable, so it can never
    // satisfy a prefix test; dropping it here saves the caller the
    // same check per query.
    const segments = segmentsForPathKey(key)
    if (segments !== null) entries.push({ key, segments })
  }
  entries.sort(compareByKey)
  return entries
}

const EMPTY_INDEX: readonly ErrorPathEntry[] = Object.freeze([])

function compareByKey(a: ErrorPathEntry, b: ErrorPathEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * The slice of `index` that can contain paths at or under `prefix`.
 *
 * A superset: see the module docblock. Callers apply their own
 * membership test to the result.
 */
export function windowUnder(
  index: readonly ErrorPathEntry[],
  prefix: Path
): readonly ErrorPathEntry[] {
  if (prefix.length === 0 || index.length === 0) return index
  const prefixKey = keyForSegments(prefix).key
  const marker = `${prefixKey.slice(0, -1)},`
  const start = lowerBound(index, marker)
  if (start >= index.length) return EMPTY_INDEX
  let end = start
  for (; end < index.length; end += 1) {
    const entry = index[end]
    if (entry === undefined || entry.key > prefixKey) break
  }
  return start === 0 && end === index.length ? index : index.slice(start, end)
}

/**
 * Do two windows cover the same set of paths?
 *
 * Both are slices of the same key-sorted index, so a positional key
 * comparison is exact. Keys are compared rather than whole entries
 * because an entry's `segments` are decoded FROM its key: two entries
 * agreeing on the key agree on everything.
 *
 * This is what lets a per-prefix window hold its previous array when
 * an unrelated path's error changes. The index is rebuilt in full on
 * every error change and so always has a fresh identity; a window that
 * compares equal hands back the identity it already had, and a
 * `computed` wrapping it stops the change there instead of passing it
 * on to every container in the form.
 */
export function isSameWindow(a: readonly ErrorPathEntry[], b: readonly ErrorPathEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.key !== b[i]?.key) return false
  }
  return true
}

/** First position whose key is not less than `target`. */
function lowerBound(index: readonly ErrorPathEntry[], target: string): number {
  let lo = 0
  let hi = index.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((index[mid]?.key ?? target) < target) lo = mid + 1
    else hi = mid
  }
  return lo
}
