/**
 * Phase 5.1 baseline perf comparison for the paths module.
 *
 * Gated old/new pairs (scripts/check-bench.mjs asserts new ≥ 3× old):
 *
 *   - canonicalizePath: repeated-input cost before vs after the LRU cache
 *     — a cache hit vs a full parse + normalize + stringify.
 *   - isDirty recovery: recovering each tracked entry's `Path` during the
 *     dirty walk — `JSON.parse(pathKey)` per entry (pre-5.1) vs reading
 *     the stored `segments` off the `{ segments, value }` record (post-5.1).
 *
 * The recovery pair isolates ONLY the segment-recovery step. Both dirty
 * walks call `getAtPath(form, segments)` identically once segments are in
 * hand, so folding that shared cost into both arms makes the ratio
 * `1 + parse/walk` — which decays toward 1 as the walk grows. That is how
 * the previous end-to-end form let the prototype-shadow guard added to
 * `descendStep` (a cost both arms pay equally) drag the ratio under the
 * 3× floor, with the recovery optimization itself fully intact. The thing
 * under guard is the recovery, not the walk; isolating it keeps the pair a
 * multiplicative class difference (parse + allocate vs an O(1) property
 * load, ~100×+) so the floor stays a real tripwire with wide headroom.
 * The walk's own end-to-end cost is tracked by the ungated `isDirty walk`
 * bench below.
 *
 * The "old" implementations are kept verbatim inside this file so each
 * gated pair stays a stable check against the pre-5.1 baseline.
 */

import { bench, describe } from 'vitest'
import { getAtPath } from '../src/runtime/core/path-walker'
import {
  canonicalizePath,
  parseDottedPath,
  type Path,
  type PathKey,
  type Segment,
} from '../src/runtime/core/paths'

// ---------- Pre-5.1 canonicalizePath (uncached, redundant normalize pass) ----------

const INTEGER_SEGMENT = /^(?:0|[1-9]\d*)$/

function normalizeSegmentLegacy(raw: Segment): Segment {
  if (typeof raw === 'number') return raw
  if (INTEGER_SEGMENT.test(raw)) return Number(raw)
  return raw
}

function oldCanonicalizePath(input: string | Path): {
  segments: readonly Segment[]
  key: PathKey
} {
  const rawSegments: Segment[] =
    typeof input === 'string' ? parseDottedPath(input) : Array.from(input)
  const segments = rawSegments.map(normalizeSegmentLegacy)
  const key = JSON.stringify(segments) as PathKey
  return { segments, key }
}

// ---------- Fixture: 100-leaf form + originals in both shapes ----------

function makeForm100(): Record<string, unknown> {
  const form: Record<string, unknown> = {}
  for (let i = 0; i < 100; i++) {
    const g = `group${Math.floor(i / 10)}`
    const f = `field${i % 10}`
    const group = (form[g] as Record<string, unknown> | undefined) ?? {}
    group[f] = `v${i}`
    form[g] = group
  }
  return form
}

function makeOriginalsOld(): Map<PathKey, unknown> {
  const m = new Map<PathKey, unknown>()
  for (let i = 0; i < 100; i++) {
    const segments: readonly Segment[] = [`group${Math.floor(i / 10)}`, `field${i % 10}`]
    const key = JSON.stringify(segments) as PathKey
    m.set(key, `v${i}`)
  }
  return m
}

function makeOriginalsNew(): Map<PathKey, { segments: readonly Segment[]; value: unknown }> {
  const m = new Map<PathKey, { segments: readonly Segment[]; value: unknown }>()
  for (let i = 0; i < 100; i++) {
    const segments: readonly Segment[] = [`group${Math.floor(i / 10)}`, `field${i % 10}`]
    const key = JSON.stringify(segments) as PathKey
    m.set(key, { segments, value: `v${i}` })
  }
  return m
}

// ---------- Group 1: canonicalizePath on a repeated dotted-string input ----------
//
// Real forms re-canonicalise the same small working-set of dotted paths
// thousands of times per session (every keystroke on a registered field).
// The LRU makes repeat calls O(Map hit) instead of parse + normalize +
// stringify. A deeper path (8 segments, representative of nested
// arrays-of-objects forms like `items.0.variants.0.pricing.regions.0.amount`)
// widens the gap between the cached and uncached paths — parse + stringify
// grow linearly with segment count, while the LRU remains O(1).

const HOT_PATH = 'items.0.variants.0.pricing.regions.0.amount'

describe('canonicalizePath: repeated dotted input', () => {
  bench('old: parse + normalize + stringify, no cache', () => {
    oldCanonicalizePath(HOT_PATH)
  })
  bench('new: LRU-cached on string inputs', () => {
    canonicalizePath(HOT_PATH)
  })
})

// ---------- Group 2 (gated): isDirty segment recovery ----------
//
// The dirty walk iterates `originals` and, per entry, recovers the
// entry's `Path`, then compares the live form value against the tracked
// original. Pre-5.1, recovery meant `JSON.parse(pathKey)` per entry;
// post-5.1, the segments are stored alongside the value and read
// directly off the `{ segments, value }` record.
//
// This pair isolates EXACTLY that recovery step and nothing else. The
// downstream `getAtPath(form, segments)` is identical in both walks, so
// seating it in both arms would pin a large shared cost under the ratio
// and pull it toward 1 as the walk grows — which is precisely how the
// prototype-shadow guard in `descendStep` (paid equally by both arms)
// dragged the old end-to-end ratio under the 3× floor. Recovery is a
// class difference (parse + allocate vs an O(1) property load), so the
// gate keeps wide, stable headroom. End-to-end walk cost is the ungated
// bench below.

describe('isDirty recovery: 100-entry originals', () => {
  const originalsOld = makeOriginalsOld()
  const originalsNew = makeOriginalsNew()

  bench('old: JSON.parse(pathKey) per entry', () => {
    let total = 0
    for (const [pathKey] of originalsOld) {
      const segments = JSON.parse(pathKey) as Segment[]
      total += segments.length
    }
    // Observe the result so the parse can't be optimized away.
    if (total !== 200) throw new Error('fixture invariant: 100 entries × 2 segments')
  })

  bench('new: read stored segments', () => {
    let total = 0
    for (const [, { segments }] of originalsNew) {
      total += segments.length
    }
    if (total !== 200) throw new Error('fixture invariant: 100 entries × 2 segments')
  })
})

// ---------- Group 3 (ungated): end-to-end dirty walk ----------
//
// Not an old/new pair, so check-bench skips it. This tracks the FULL
// dirty walk on the current stored-segments shape — recover segments,
// `getAtPath`, `Object.is` — so the walk's absolute cost (including the
// prototype-shadow guard in `descendStep`) stays visible over time
// without gating a fragile ratio against it.

describe('isDirty walk: 100-leaf pristine form (current shape)', () => {
  const form = makeForm100()
  const originalsNew = makeOriginalsNew()

  bench('stored-segments dirty walk', () => {
    let dirty = false
    for (const [, { segments, value: original }] of originalsNew) {
      if (!Object.is(getAtPath(form, segments), original)) {
        dirty = true
        break
      }
    }
    if (dirty) throw new Error('fixture invariant: 100-leaf pristine form should read clean')
  })
})
