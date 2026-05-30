/**
 * Prototype-pollution gate for `setAtPath` (path-walker.ts).
 *
 * `setAtPath` is the copy-on-write walker behind every value mutation
 * the runtime performs: `form.setValue(path, value)`, multi-tab patch
 * apply (`applyPatchesForward` / `Inverse`), and history undo/redo.
 * Every consumer-controlled path eventually reaches it. Without
 * protection, a `__proto__` segment lands at `rec[head] = …` on a
 * plain `{}` intermediate and the inherited `[[Set]]` accessor
 * reassigns the prototype chain.
 *
 * The fix is the same shape as the errors-proxy and persistence
 * fixes: allocate intermediate containers via `Object.create(null)`
 * so `rec['__proto__'] = …` is a plain own-property write with no
 * path to `Object.prototype`. Legitimate fields literally named
 * `prototype` / `constructor` / `__proto__` round-trip the same way
 * every other key does, without a guard silently dropping them.
 *
 * Two invariants per case:
 *   1. No pollution — a fresh plain `{}` does NOT inherit any
 *      property the special-key write tried to plant.
 *   2. Positive roundtrip — `getAtPath` reads back the value at the
 *      declared path on the prototype-less result.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAtPath, setAtPath } from '../../src/runtime/core/path-walker'

const SENTINEL = 'attaformSetAtPathProtoPollutionCanary'

describe('setAtPath proto-less intermediates', () => {
  beforeEach(() => {
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it("path ['__proto__', X] writes own property and leaves Object.prototype clean", () => {
    const root = setAtPath({}, ['__proto__', SENTINEL], 'attempted-pollution')

    // Negative invariant — Object.prototype is unchanged.
    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    // Positive roundtrip — the value lands at the declared path. The
    // result's `__proto__` is an own property on a prototype-less
    // container, so reading walks the own property (NOT the inherited
    // accessor that would return Object.prototype).
    expect(getAtPath(root, ['__proto__', SENTINEL])).toBe('attempted-pollution')
  })

  it("path ['constructor', X] writes own property and leaves Object.prototype clean", () => {
    const root = setAtPath({}, ['constructor', SENTINEL], 'legit-value')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    expect(getAtPath(root, ['constructor', SENTINEL])).toBe('legit-value')
  })

  it("path ['prototype', X] writes own property and leaves Object.prototype clean", () => {
    const root = setAtPath({}, ['prototype', SENTINEL], 'building-A')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    expect(getAtPath(root, ['prototype', SENTINEL])).toBe('building-A')
  })

  it('intermediate copy-on-write preserves a prior __proto__ own property through a sibling write', () => {
    // Sequence: write tree['__proto__']['a'] = 'first', then write
    // tree['__proto__']['b'] = 'second'. Without the spread carrying
    // the prior `__proto__` own property through (CopyDataProperties
    // bypasses the prototype setter), the second write would land in
    // a fresh container and lose the first value.
    const step1 = setAtPath({}, ['__proto__', 'a'], 'first')
    const step2 = setAtPath(step1, ['__proto__', 'b'], 'second')

    expect(getAtPath(step2, ['__proto__', 'a'])).toBe('first')
    expect(getAtPath(step2, ['__proto__', 'b'])).toBe('second')

    const probe: Record<string, unknown> = {}
    expect(probe['a']).toBeUndefined()
    expect(probe['b']).toBeUndefined()
  })

  it('the resulting tree is prototype-less at every object node', () => {
    const root = setAtPath({}, ['x', 'y', 'z'], 1) as Record<string, unknown>

    expect(Object.getPrototypeOf(root)).toBeNull()
    const xNode = root['x'] as Record<string, unknown>
    expect(Object.getPrototypeOf(xNode)).toBeNull()
    const yNode = xNode['y'] as Record<string, unknown>
    expect(Object.getPrototypeOf(yNode)).toBeNull()
  })

  it('array intermediates stay as Array instances (unchanged behavior)', () => {
    const root = setAtPath({}, ['items', 0, 'name'], 'first') as Record<string, unknown>

    // Array branch isn't part of the proto-less swap — arrays already
    // didn't carry a pollution surface.
    const items = root['items']
    expect(Array.isArray(items)).toBe(true)
    const first = (items as Array<Record<string, unknown>>)[0]
    expect(first).toBeDefined()
    expect(Object.getPrototypeOf(first)).toBeNull()
    expect(first?.['name']).toBe('first')
  })
})
