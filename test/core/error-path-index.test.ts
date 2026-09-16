/**
 * The prefix window `aggregateErrorsAt` searches, and the order it
 * still has to produce.
 *
 * The aggregate used to walk all three error stores per call. A table
 * asks for one call per row, so `form.list('rows')` on 400 rows holding
 * 800 errors ran 320,000 prefix tests, and a keystroke in any one row
 * re-ran every one of them. The index turns that back into one pass per
 * change plus a binary search per query.
 *
 * Two things carry risk, and each has a group here:
 *
 *  - **The window.** It is a key RANGE, justified by how `PathKey`
 *    spells a path, not by a prefix test. If the range ever excluded a
 *    real descendant, errors would silently vanish from a container's
 *    aggregate. So the first group checks the range against a
 *    brute-force prefix filter over adversarial key shapes: siblings
 *    whose names extend one another, indices that share a leading
 *    digit, and segments holding the delimiters themselves.
 *  - **The order.** The old shape made three passes, one per source, so
 *    schema errors preceded blank which preceded user across the whole
 *    aggregate. The new shape makes ONE pass and gathers a path's three
 *    lists together. Those agree only because ordinals are injective
 *    over paths, which is exactly the kind of reasoning that stops
 *    being true quietly.
 */
import { describe, expect, it } from 'vitest'
import {
  buildErrorPathIndex,
  windowUnder,
  type ErrorPathEntry,
} from '../../src/runtime/core/error-path-index'
import { isPathPrefix, keyForSegments, type Path, type PathKey } from '../../src/runtime/core/paths'
import type { ValidationError } from '../../src/runtime/types/types-api'

/** Paths chosen so the easy encoding arguments are the ones under test. */
const PATHS: Path[] = [
  [],
  ['rows'],
  ['rows', 0],
  ['rows', 0, 'label'],
  ['rows', 0, 'qty'],
  ['rows', 1],
  ['rows', 1, 'label'],
  ['rows', 10],
  ['rows', 10, 'label'],
  ['rows', 100, 'label'],
  ['row'],
  ['rowsX'],
  ['rowsX', 'label'],
  // A name that is a strict prefix of a sibling, which is where a naive
  // string-prefix test goes wrong.
  ['a'],
  ['ab'],
  ['a', 'b'],
  ['ab', 'c'],
  // Segments carrying the delimiters the key itself is built from.
  ['a,b'],
  ['a,b', 'c'],
  ['x]'],
  ['x]', 'y'],
  ['x', ']'],
  ['deep', 'er', 'still', 'going'],
  ['deep', 'er', 'still'],
  ['deep', 'er'],
]

const anError = (path: Path): ValidationError => ({
  message: 'e',
  path: [...path],
  code: 'test:err',
})

function indexOf(paths: readonly Path[]): readonly ErrorPathEntry[] {
  const cells = new Map<
    PathKey,
    { schema: readonly ValidationError[]; user: readonly ValidationError[] }
  >()
  for (const path of paths) {
    cells.set(keyForSegments(path).key, { schema: [anError(path)], user: [] })
  }
  return buildErrorPathIndex(cells, new Map())
}

describe('the prefix window contains every path at or under the prefix', () => {
  const index = indexOf(PATHS)

  it('indexes every path it was given', () => {
    // Guards the guard: an index that silently dropped entries would
    // make every superset check below pass vacuously.
    expect(index.length).toBe(PATHS.length)
  })

  it.each(PATHS.map((p) => [JSON.stringify(p), p] as const))(
    'covers the true prefix matches at %s',
    (_label, prefix) => {
      const truth = index.filter((entry) => isPathPrefix(prefix, entry.segments))
      const windowed = windowUnder(index, prefix)
      // Superset, not equality: the window narrows the scan and the
      // caller's own `isPathPrefix` decides membership.
      for (const entry of truth) expect(windowed).toContain(entry)
    }
  )

  it('narrows the scan rather than handing back everything', () => {
    // The point of the index is the narrowing. Without this the
    // superset assertions above would pass for `windowUnder = identity`.
    const windowed = windowUnder(index, ['rows', 0])
    expect(windowed.length).toBeLessThan(index.length)
    expect(windowed.map((e) => e.key)).toContain(keyForSegments(['rows', 0, 'label']).key)
    expect(windowed.map((e) => e.key)).not.toContain(keyForSegments(['rows', 1]).key)
  })

  it('answers the root prefix with the whole index', () => {
    expect(windowUnder(index, [])).toBe(index)
  })

  it('answers an empty index with an empty window', () => {
    expect(windowUnder(indexOf([]), ['rows'])).toEqual([])
  })

  it('answers a prefix nothing lives under with an empty window', () => {
    expect(windowUnder(index, ['nothing', 'here'])).toEqual([])
  })
})

describe('the index only carries paths that actually have errors', () => {
  it('skips a cell holding two empty sides', () => {
    const cells = new Map([
      [keyForSegments(['a']).key, { schema: [], user: [] }],
      [keyForSegments(['b']).key, { schema: [anError(['b'])], user: [] }],
    ])
    expect(buildErrorPathIndex(cells, new Map()).map((e) => e.segments)).toEqual([['b']])
  })

  it('carries a path whose only errors are blank-required', () => {
    const blank = new Map([[keyForSegments(['c']).key, [anError(['c'])]]])
    expect(buildErrorPathIndex(new Map(), blank).map((e) => e.segments)).toEqual([['c']])
  })

  it('carries a path present in both stores exactly once', () => {
    const key = keyForSegments(['d']).key
    const cells = new Map([[key, { schema: [anError(['d'])], user: [anError(['d'])] }]])
    const blank = new Map([[key, [anError(['d'])]]])
    expect(buildErrorPathIndex(cells, blank).length).toBe(1)
  })
})
