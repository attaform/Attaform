import { describe, expect, it } from 'vitest'
import {
  changedIndices,
  migrateMapSubtree,
  migrateSetSubtree,
  remapForOp,
} from '../../src/runtime/core/array-state-migrate'
import { canonicalizePath } from '../../src/runtime/core/paths'
import type { Path, PathKey } from '../../src/runtime/core/paths'

const keyFor = (segments: Path): PathKey => canonicalizePath(segments).key

type Cell = { path: Path; tag: string }
const cell = (segments: Path, tag: string): Cell => ({ path: segments, tag })
const relocate = (value: Cell, segments: Path): Cell => ({ path: segments, tag: value.tag })

// Snapshot a PathKey-keyed Map as `dotted -> tag`, recovering the dotted
// path so the assertions read in element terms rather than JSON keys.
function snapshotTags(map: Map<PathKey, Cell>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const value of map.values()) out[value.path.join('.')] = value.tag
  return out
}

describe('remapForOp', () => {
  it('insert shifts the tail up and marks the slot fresh', () => {
    const remap = remapForOp({ kind: 'insert', index: 1 }, 3)
    expect([...remap.moved]).toEqual([
      [1, 2],
      [2, 3],
    ])
    expect([...remap.vacated]).toEqual([])
    expect([...remap.fresh]).toEqual([1])
  })

  it('remove vacates the slot and shifts the tail down', () => {
    const remap = remapForOp({ kind: 'remove', index: 1 }, 4)
    expect([...remap.moved]).toEqual([
      [2, 1],
      [3, 2],
    ])
    expect([...remap.vacated]).toEqual([1])
    expect([...remap.fresh]).toEqual([])
  })

  it('move forward slides the spanned elements back by one', () => {
    const remap = remapForOp({ kind: 'move', from: 1, to: 3 }, 5)
    expect(new Map(remap.moved)).toEqual(
      new Map([
        [1, 3],
        [2, 1],
        [3, 2],
      ])
    )
    expect([...remap.vacated]).toEqual([])
    expect([...remap.fresh]).toEqual([])
  })

  it('move backward slides the spanned elements forward by one', () => {
    const remap = remapForOp({ kind: 'move', from: 3, to: 1 }, 5)
    expect(new Map(remap.moved)).toEqual(
      new Map([
        [3, 1],
        [1, 2],
        [2, 3],
      ])
    )
  })

  it('a no-op move produces an empty permutation', () => {
    const remap = remapForOp({ kind: 'move', from: 2, to: 2 }, 4)
    expect(remap.moved.size).toBe(0)
    expect(remap.vacated.size).toBe(0)
    expect(remap.fresh.size).toBe(0)
  })

  it('swap exchanges the two indices', () => {
    const remap = remapForOp({ kind: 'swap', a: 0, b: 2 }, 3)
    expect(new Map(remap.moved)).toEqual(
      new Map([
        [0, 2],
        [2, 0],
      ])
    )
  })

  it('replace-at both vacates and freshens the same slot', () => {
    const remap = remapForOp({ kind: 'replace-at', index: 1 }, 3)
    expect(remap.moved.size).toBe(0)
    expect([...remap.vacated]).toEqual([1])
    expect([...remap.fresh]).toEqual([1])
  })
})

describe('changedIndices', () => {
  it('unions sources, destinations, vacated, and fresh slots', () => {
    expect([...changedIndices(remapForOp({ kind: 'insert', index: 1 }, 3))].sort()).toEqual([
      1, 2, 3,
    ])
    expect([...changedIndices(remapForOp({ kind: 'remove', index: 1 }, 4))].sort()).toEqual([
      1, 2, 3,
    ])
    expect([...changedIndices(remapForOp({ kind: 'swap', a: 0, b: 2 }, 3))].sort()).toEqual([0, 2])
  })
})

describe('migrateMapSubtree', () => {
  it('relocates moved entries and rewrites their embedded path', () => {
    const map = new Map<PathKey, Cell>([
      [keyFor(['roster', 0, 'name']), cell(['roster', 0, 'name'], 'ada')],
      [keyFor(['roster', 1, 'name']), cell(['roster', 1, 'name'], 'grace')],
      [keyFor(['roster', 2, 'name']), cell(['roster', 2, 'name'], 'katherine')],
    ])
    migrateMapSubtree(map, ['roster'], remapForOp({ kind: 'move', from: 0, to: 2 }, 3), relocate)
    expect(snapshotTags(map)).toEqual({
      'roster.0.name': 'grace',
      'roster.1.name': 'katherine',
      'roster.2.name': 'ada',
    })
    expect(map.get(keyFor(['roster', 2, 'name']))?.path).toEqual(['roster', 2, 'name'])
  })

  it('drops the vacated entry on a remove and shifts the rest down', () => {
    const map = new Map<PathKey, Cell>([
      [keyFor(['roster', 0]), cell(['roster', 0], 'a')],
      [keyFor(['roster', 1]), cell(['roster', 1], 'b')],
      [keyFor(['roster', 2]), cell(['roster', 2], 'c')],
    ])
    migrateMapSubtree(map, ['roster'], remapForOp({ kind: 'remove', index: 1 }, 3), relocate)
    expect(snapshotTags(map)).toEqual({ 'roster.0': 'a', 'roster.1': 'c' })
    expect(map.has(keyFor(['roster', 2]))).toBe(false)
  })

  it('swaps both sides without a source clobbering the other', () => {
    const map = new Map<PathKey, Cell>([
      [keyFor(['roster', 0]), cell(['roster', 0], 'a')],
      [keyFor(['roster', 1]), cell(['roster', 1], 'b')],
    ])
    migrateMapSubtree(map, ['roster'], remapForOp({ kind: 'swap', a: 0, b: 1 }, 2), relocate)
    expect(snapshotTags(map)).toEqual({ 'roster.0': 'b', 'roster.1': 'a' })
  })

  it('rewrites only the element segment, preserving deeper nested segments', () => {
    const map = new Map<PathKey, Cell>([
      [keyFor(['teams', 0, 'players', 1]), cell(['teams', 0, 'players', 1], 'x')],
      [keyFor(['teams', 1, 'players', 0]), cell(['teams', 1, 'players', 0], 'y')],
    ])
    migrateMapSubtree(map, ['teams'], remapForOp({ kind: 'swap', a: 0, b: 1 }, 2), relocate)
    expect(snapshotTags(map)).toEqual({
      'teams.1.players.1': 'x',
      'teams.0.players.0': 'y',
    })
  })

  it('leaves entries outside the touched indices untouched', () => {
    const map = new Map<PathKey, Cell>([
      [keyFor(['roster', 0]), cell(['roster', 0], 'a')],
      [keyFor(['other', 0]), cell(['other', 0], 'z')],
    ])
    migrateMapSubtree(map, ['roster'], remapForOp({ kind: 'remove', index: 0 }, 1), relocate)
    expect(map.get(keyFor(['other', 0]))?.tag).toBe('z')
    expect(map.has(keyFor(['roster', 0]))).toBe(false)
  })
})

describe('migrateSetSubtree', () => {
  it('relocates membership and drops vacated entries', () => {
    const set = new Set<PathKey>([
      keyFor(['roster', 0]),
      keyFor(['roster', 1]),
      keyFor(['roster', 2]),
    ])
    migrateSetSubtree(set, ['roster'], remapForOp({ kind: 'remove', index: 0 }, 3))
    expect(set.has(keyFor(['roster', 0]))).toBe(true) // was index 1
    expect(set.has(keyFor(['roster', 1]))).toBe(true) // was index 2
    expect(set.has(keyFor(['roster', 2]))).toBe(false)
    expect(set.size).toBe(2)
  })
})
