import { describe, it, expect } from 'vitest'
import { createArrayIdentity, remapForOp } from '../../src/runtime/core/array-engine'
import type { Path } from '../../src/runtime/core/paths'

// A self-contained world of arrays the tracker reads lengths from. The
// real store writes the array first, then notifies the tracker; these
// helpers mirror that order: `setArr` then `applyOp`/`realign`.
function harness() {
  const arrays = new Map<string, unknown[]>()
  const worldKey = (segs: Path) => segs.join('|')
  const id = createArrayIdentity((segs) => {
    const a = arrays.get(worldKey(segs))
    return Array.isArray(a) ? a.length : 0
  })
  const setArr = (segs: Path, next: unknown[]) => arrays.set(worldKey(segs), next.slice())
  const tokens = (segs: Path) =>
    (arrays.get(worldKey(segs)) ?? []).map((_, i) => id.tokenAt(segs, i))
  return { id, setArr, tokens }
}

const ITEMS: Path = ['items']

describe('createArrayIdentity', () => {
  it('seeds tokens by position and returns them stably across reads', () => {
    const { setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c'])
    const first = tokens(ITEMS)
    expect(first).toHaveLength(3)
    expect(new Set(first).size).toBe(3)
    expect(tokens(ITEMS)).toEqual(first)
  })

  it('gives distinct, stable tokens even when element values are duplicates', () => {
    const { setArr, tokens } = harness()
    setArr(ITEMS, ['dup', 'dup', 'dup'])
    const t = tokens(ITEMS)
    expect(new Set(t).size).toBe(3)
    expect(tokens(ITEMS)).toEqual(t)
  })

  it('returns "" for an out-of-range index', () => {
    const { id, setArr } = harness()
    setArr(ITEMS, ['a', 'b'])
    expect(id.tokenAt(ITEMS, 2)).toBe('')
    expect(id.tokenAt(ITEMS, -1)).toBe('')
  })

  it('insert: new token at the slot, existing tokens shift but persist', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c'])
    const before = tokens(ITEMS)
    setArr(ITEMS, ['a', 'x', 'b', 'c'])
    id.applyOp(ITEMS, remapForOp({ kind: 'insert', index: 1 }, 3))
    const after = tokens(ITEMS)
    expect(after[0]).toBe(before[0]) // a
    expect(after[2]).toBe(before[1]) // b shifted right, same token
    expect(after[3]).toBe(before[2]) // c shifted right, same token
    expect(after[1]).not.toBe(before[1]) // x is freshly allocated
    expect(new Set(after).size).toBe(4)
  })

  it('remove: drops the slot token, survivors keep their identity', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c'])
    const before = tokens(ITEMS)
    setArr(ITEMS, ['a', 'c'])
    id.applyOp(ITEMS, remapForOp({ kind: 'remove', index: 1 }, 3))
    const after = tokens(ITEMS)
    expect(after[0]).toBe(before[0]) // a
    expect(after[1]).toBe(before[2]) // c keeps its token after the shift
    expect(after).not.toContain(before[1]) // b's token is gone
  })

  it('move: the token travels with the element (forward)', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c', 'd'])
    const before = tokens(ITEMS)
    // move index 0 -> 2: ['b','c','a','d']
    setArr(ITEMS, ['b', 'c', 'a', 'd'])
    id.applyOp(ITEMS, remapForOp({ kind: 'move', from: 0, to: 2 }, 4))
    const after = tokens(ITEMS)
    expect(after[2]).toBe(before[0]) // a's token followed it to index 2
    expect(after[0]).toBe(before[1]) // b
    expect(after[1]).toBe(before[2]) // c
    expect(after[3]).toBe(before[3]) // d untouched
  })

  it('move: the token travels with the element (backward)', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c', 'd'])
    const before = tokens(ITEMS)
    // move index 3 -> 1: ['a','d','b','c']
    setArr(ITEMS, ['a', 'd', 'b', 'c'])
    id.applyOp(ITEMS, remapForOp({ kind: 'move', from: 3, to: 1 }, 4))
    const after = tokens(ITEMS)
    expect(after[1]).toBe(before[3]) // d's token followed it to index 1
    expect(after[0]).toBe(before[0]) // a
    expect(after[2]).toBe(before[1]) // b
    expect(after[3]).toBe(before[2]) // c
  })

  it('swap: the two slots exchange tokens, the rest stay put', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c'])
    const before = tokens(ITEMS)
    setArr(ITEMS, ['c', 'b', 'a'])
    id.applyOp(ITEMS, remapForOp({ kind: 'swap', a: 0, b: 2 }, 3))
    const after = tokens(ITEMS)
    expect(after[0]).toBe(before[2])
    expect(after[2]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  it('replace-at: resets identity at the slot, leaves the rest', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c'])
    const before = tokens(ITEMS)
    setArr(ITEMS, ['a', 'X', 'c'])
    id.applyOp(ITEMS, remapForOp({ kind: 'replace-at', index: 1 }, 3))
    const after = tokens(ITEMS)
    expect(after[1]).not.toBe(before[1]) // new element, new identity
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
  })

  it('realign (append): keeps aligned tokens, allocates for the grown tail', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b'])
    const before = tokens(ITEMS)
    setArr(ITEMS, ['a', 'b', 'c'])
    id.realign(ITEMS)
    const after = tokens(ITEMS)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[2]).not.toBe(before[1])
    expect(new Set(after).size).toBe(3)
  })

  it('realign (shrink): drops the shrunk tail by position', () => {
    const { id, setArr, tokens } = harness()
    setArr(ITEMS, ['a', 'b', 'c'])
    const before = tokens(ITEMS)
    setArr(ITEMS, ['a', 'b'])
    id.realign(ITEMS)
    const after = tokens(ITEMS)
    expect(after).toEqual([before[0], before[1]])
  })

  it('allocates tokens unique across distinct arrays in one form', () => {
    const { id, setArr } = harness()
    const A: Path = ['a']
    const B: Path = ['b']
    setArr(A, ['x', 'y'])
    setArr(B, ['x', 'y'])
    const ta = [id.tokenAt(A, 0), id.tokenAt(A, 1)]
    const tb = [id.tokenAt(B, 0), id.tokenAt(B, 1)]
    expect(new Set([...ta, ...tb]).size).toBe(4)
  })
})
