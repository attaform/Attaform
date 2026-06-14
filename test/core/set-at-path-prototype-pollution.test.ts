/**
 * Prototype-pollution gate for `setAtPath` (path-walker.ts).
 *
 * `setAtPath` is the copy-on-write walker behind every value mutation
 * the runtime performs: `form.setValue(path, value)`, history undo/redo
 * patch apply (`applyPatchesForward` / `Inverse`), and hydration.
 * Every consumer-controlled path eventually reaches it. Without
 * protection, a `__proto__` segment lands at `rec[head] = …` on a
 * plain `{}` intermediate and the inherited `[[Set]]` accessor
 * reassigns the prototype chain.
 *
 * The fix routes every untrusted-key write through `safeAssign`,
 * which lands the `__proto__` key via `Object.defineProperty`
 * (own data property, no chain mutation). Intermediate containers
 * carry `Object.prototype` so the resulting tree responds to
 * `.hasOwnProperty(...)`, `in`, and devalue / pinia-style payload
 * walkers; the spread (`{ ...root }`) at each copy-on-write step
 * uses `CreateDataProperty` per the spec, which bypasses the
 * inherited `__proto__` setter. Legitimate fields literally named
 * `prototype` / `constructor` / `__proto__` round-trip the same way
 * every other key does.
 *
 * Two invariants per case:
 *   1. No pollution — a fresh plain `{}` does NOT inherit any
 *      property the special-key write tried to plant.
 *   2. Positive roundtrip — `getAtPath` reads back the value at the
 *      declared path on the result.
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
    // tree['__proto__']['b'] = 'second'. The spread at each copy-on-
    // write step uses `CreateDataProperty`, so the prior `__proto__`
    // own data property carries through without invoking the inherited
    // accessor on the new container.
    const step1 = setAtPath({}, ['__proto__', 'a'], 'first')
    const step2 = setAtPath(step1, ['__proto__', 'b'], 'second')

    expect(getAtPath(step2, ['__proto__', 'a'])).toBe('first')
    expect(getAtPath(step2, ['__proto__', 'b'])).toBe('second')

    const probe: Record<string, unknown> = {}
    expect(probe['a']).toBeUndefined()
    expect(probe['b']).toBeUndefined()
  })

  it("the resulting tree's `__proto__` slot is an own data property (shadows the inherited accessor)", () => {
    // Containers now carry `Object.prototype` so `.hasOwnProperty()` /
    // `in` / serializer walkers work. The defense lives in the
    // descriptor at `__proto__`: `safeAssign` installs an own data
    // property with `configurable: true` so the inherited setter never
    // fires. Reading `root.__proto__` returns the own value
    // (`{ y: … }`), not `Object.prototype`.
    const root = setAtPath({}, ['__proto__', 'y'], { z: 1 }) as Record<string, unknown>

    const descriptor = Object.getOwnPropertyDescriptor(root, '__proto__')
    expect(descriptor).toBeDefined()
    expect(descriptor?.value).toBeDefined()
    expect(descriptor?.enumerable).toBe(true)
    // Container is a normal `Object.prototype`-backed record — the
    // own `__proto__` data property shadows the accessor for reads,
    // but `getPrototypeOf` reports the real chain.
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
  })

  it('object intermediates carry Object.prototype and respond to `.hasOwnProperty()` / `in`', () => {
    const root = setAtPath({}, ['x', 'y', 'z'], 1) as Record<string, unknown>

    expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
    // Direct `.hasOwnProperty(...)` calls below are the consumer
    // pattern this test guards against; routing through
    // `Object.prototype.hasOwnProperty.call` would erase the regression.
    // eslint-disable-next-line no-prototype-builtins
    expect(root.hasOwnProperty('x')).toBe(true)
    expect('x' in root).toBe(true)

    const xNode = root['x'] as Record<string, unknown>
    expect(Object.getPrototypeOf(xNode)).toBe(Object.prototype)
    // eslint-disable-next-line no-prototype-builtins
    expect(xNode.hasOwnProperty('y')).toBe(true)

    const yNode = xNode['y'] as Record<string, unknown>
    expect(Object.getPrototypeOf(yNode)).toBe(Object.prototype)
    // eslint-disable-next-line no-prototype-builtins
    expect(yNode.hasOwnProperty('z')).toBe(true)
  })

  it('array intermediates stay as Array instances (unchanged behavior)', () => {
    const root = setAtPath({}, ['items', 0, 'name'], 'first') as Record<string, unknown>

    const items = root['items']
    expect(Array.isArray(items)).toBe(true)
    const first = (items as Array<Record<string, unknown>>)[0]
    expect(first).toBeDefined()
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype)
    expect(first?.['name']).toBe('first')
  })
})
