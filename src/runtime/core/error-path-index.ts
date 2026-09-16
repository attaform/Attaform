/**
 * The error stores, indexed by path prefix.
 *
 * `aggregateErrorsAt(state, prefix)` answers "every active error at or
 * under this path", and it used to answer it by walking every entry in
 * all three error stores, resolving each key back to segments and
 * testing the prefix. That is fine for one call. A table asks for one
 * per row: `form.list('rows')` on 400 rows with 800 errors did 320,000
 * of those tests, and a keystroke in any single row re-did all of them,
 * costing a quarter of a second per character typed.
 *
 * The cost is structural, not incidental: the work is O(rows x errors)
 * where the answer is O(errors). So the keys are collected ONCE per
 * change to the stores, resolved to segments once, and sorted, and a
 * query binary-searches its own window instead of scanning.
 *
 * ## Why a sorted key array is the right index
 *
 * A `PathKey` is `JSON.stringify(segments)`, so a path's descendants
 * all begin with the parent's key minus its closing bracket, plus a
 * comma: every key under `["rows",0]` begins `["rows",0,`. Call that
 * the marker. Two facts make a sorted array enough:
 *
 *  - every descendant key is >= the marker, since it begins with it;
 *  - every descendant key is <= the parent's own key, since the two
 *    agree up to the last character, where `,` (0x2C) sorts before
 *    `]` (0x5D).
 *
 * So `[marker, parentKey]` is a contiguous window containing every
 * descendant and the parent itself. It is a SUPERSET, not an exact
 * answer, and the caller still applies `isPathPrefix` to what comes
 * back: the window narrows the scan, it does not decide membership.
 * That split is deliberate. Membership stays where it already was, so
 * the encoding argument above cannot quietly become the definition of
 * a prefix.
 *
 * The root prefix has no marker (`[]` minus its bracket plus a comma is
 * `[,`, which nothing begins with), and the root matches everything
 * anyway, so it is answered by handing back the whole index.
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
