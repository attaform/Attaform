/**
 * Prototype-pollution gate for `structuralSnapshot` (diff-apply.ts).
 *
 * `structuralSnapshot` is the deep-clone helper that produces the
 * `prev` argument for `form.setValue((prev) => next)` callbacks. The
 * input is the live form value, which — after the proto-less
 * `setAtPath` swap — can legitimately carry `__proto__` /
 * `constructor` / `prototype` as own properties on prototype-less
 * containers. Pre-fix the snapshot copied into a plain `{}`, and a
 * `__proto__` own property at the source would route through the
 * destination's inherited `[[Set]]` accessor instead of landing as
 * an own property — pollution.
 *
 * Allocating the snapshot containers via `Object.create(null)`
 * mirrors `setAtPath`'s allocator and keeps the shape parity: the
 * snapshot a consumer reads as `prev` matches what they'd read off
 * `form.value` directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { structuralSnapshot } from '../../src/runtime/core/diff-apply'

const SENTINEL = 'attaformStructuralSnapshotProtoPollutionCanary'

describe('structuralSnapshot proto-less containers', () => {
  beforeEach(() => {
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it('snapshots a live `__proto__` own property without polluting Object.prototype', () => {
    // The source object mirrors what `form.value` would carry after a
    // `setValue('__proto__.name', …)` call lands through the
    // proto-less `setAtPath` path: `__proto__` is an OWN property on
    // a prototype-less container, with a real value at it.
    const source: Record<string, unknown> = Object.create(null)
    const nested: Record<string, unknown> = Object.create(null)
    nested[SENTINEL] = 'legit-value'
    source['__proto__'] = nested

    const snap = structuralSnapshot(source) as Record<string, unknown>

    // Negative invariant — Object.prototype is unchanged.
    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    // Positive roundtrip — the snapshot carries the own-property
    // value through verbatim.
    const snapProtoSlot = snap['__proto__'] as Record<string, unknown>
    expect(snapProtoSlot).toBeDefined()
    expect(snapProtoSlot[SENTINEL]).toBe('legit-value')
  })

  it('snapshots a `constructor` own property as an ordinary key', () => {
    const source: Record<string, unknown> = Object.create(null)
    source['constructor'] = { who: 'east-wing-crew' }

    const snap = structuralSnapshot(source) as Record<string, unknown>

    expect((snap['constructor'] as { who: string }).who).toBe('east-wing-crew')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it('every snapshot container carries Object.prototype and responds to `.hasOwnProperty()`', () => {
    const source = { a: { b: { c: 1 } } }
    const snap = structuralSnapshot(source) as Record<string, unknown>

    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype)
    // Direct `.hasOwnProperty(...)` is the consumer pattern this test
    // guards against; routing through `Object.prototype.hasOwnProperty.call`
    // would erase the regression.
    // eslint-disable-next-line no-prototype-builtins
    expect(snap.hasOwnProperty('a')).toBe(true)
    const a = snap['a'] as Record<string, unknown>
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype)
    // eslint-disable-next-line no-prototype-builtins
    expect(a.hasOwnProperty('b')).toBe(true)
    const b = a['b'] as Record<string, unknown>
    expect(Object.getPrototypeOf(b)).toBe(Object.prototype)
    // eslint-disable-next-line no-prototype-builtins
    expect(b.hasOwnProperty('c')).toBe(true)
  })

  it('reference identity changes (deep clone is still deep)', () => {
    const source = { nested: { value: 42 } }
    const snap = structuralSnapshot(source) as Record<string, unknown>

    expect(snap).not.toBe(source)
    expect(snap['nested']).not.toBe(source.nested)
    expect((snap['nested'] as { value: number }).value).toBe(42)
  })

  it('arrays remain Array instances inside the snapshot', () => {
    const source = { items: [{ name: 'a' }, { name: 'b' }] }
    const snap = structuralSnapshot(source) as Record<string, unknown>

    expect(Array.isArray(snap['items'])).toBe(true)
    const items = snap['items'] as Array<{ name: string }>
    expect(items[0]?.name).toBe('a')
  })
})
