import { afterEach, describe, expect, it } from 'vitest'
import { toRaw } from 'vue'
import { createFormStore } from '../../../src/runtime/core/create-form-store'
import { mergeSparseHydration } from '../../../src/runtime/core/persistence/index'
import { isPlainRecord } from '../../../src/runtime/core/path-walker'
import { fakeSchema } from '../../utils/fake-schema'

/**
 * SEC-2 regression: untrusted persisted-draft / SSR-hydration JSON must
 * never reach `Object.prototype` and pollute every plain object in the
 * process. The persistence hydration merge (`mergeDeep`) accepts paths
 * from `JSON.parse(localStorage)`, which can carry `__proto__` as an
 * own data property by spec; the SSR DU-stub walk (`walkDuStubs`)
 * accepts paths from SSR hydration payloads with the same surface area.
 *
 * The persistence-side defense routes every untrusted-key write through
 * `safeAssign`, which uses `Object.defineProperty` for the `__proto__`
 * key so the write lands as an own data property on a regular
 * `Object.prototype`-backed target. The result still responds to
 * `.hasOwnProperty()` / `in` / serializer walkers (issue #314 is the
 * companion test of this property). Legitimate schema fields named
 * `prototype` / `constructor` / `__proto__` (an architecture firm
 * tracking building prototypes; a construction-management form naming
 * the construction crew; a JS-tooling form that mentions `__proto__`
 * literally) land at the declared path the consumer asked for.
 */

type Bag = { name: string; nested: { a: string } }
const defaults: Bag = { name: '', nested: { a: '' } }

// Read a property off a fresh plain object — undefined unless the global
// `Object.prototype` itself was polluted.
function readGlobalProp(key: string): unknown {
  const probe: Record<string, unknown> = {}
  return probe[key]
}

afterEach(() => {
  // Defensive: if a regression DID reach the global prototype, scrub it
  // so the leak can't cascade into unrelated suites.
  for (const k of ['polluted', 'x']) {
    delete (Object.prototype as unknown as Record<string, unknown>)[k]
  }
})

describe('SEC-2 — persistence hydration merge resists prototype pollution', () => {
  it('mergeSparseHydration keeps Object.prototype clean despite a __proto__ payload key', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"name":"real"}')
    const merged = mergeSparseHydration(defaults, hostile) as Record<string, unknown>

    // Global cleanliness — the SEC-2 invariant.
    expect(readGlobalProp('polluted')).toBeUndefined()

    // Merge target carries `Object.prototype` so consumer-observable
    // surfaces work (`.hasOwnProperty` / `in` / serializer walkers).
    // The `__proto__` own data property shadows the inherited
    // accessor for reads, so `merged.polluted` doesn't traverse into
    // the (now untouched) prototype chain.
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(merged['polluted']).toBeUndefined()
    const protoDescriptor = Object.getOwnPropertyDescriptor(merged, '__proto__')
    expect(protoDescriptor).toBeDefined()
    expect(protoDescriptor?.value).toEqual({ polluted: 1 })

    expect(isPlainRecord(merged)).toBe(true)

    // Legit field still merges.
    expect(merged['name']).toBe('real')
  })

  it('mergeSparseHydration keeps Object.prototype clean despite a constructor/prototype payload', () => {
    const hostile = JSON.parse('{"constructor":{"prototype":{"polluted":1}}}')
    const merged = mergeSparseHydration(defaults, hostile) as Record<string, unknown>

    // Global cleanliness — the SEC-2 invariant.
    expect(readGlobalProp('polluted')).toBeUndefined()

    // Result carries `Object.prototype`. The `constructor` /
    // `prototype` keys land as own data properties that shadow the
    // inherited slots; subsequent reads stop at the own data and
    // never traverse into `Object.prototype.constructor.prototype`.
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(isPlainRecord(merged)).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(true)
  })

  it('SSR DU-stub walk keeps Object.prototype clean despite a __proto__ hydration key', () => {
    // `walkDuStubs` routes every key write through `safeAssign`: a
    // hostile `__proto__` in the SSR hydration payload lands as an
    // own data property on the form-value container, and the global
    // prototype stays untouched. Container carries `Object.prototype`
    // so downstream `.hasOwnProperty()` walkers (issue #314 surface)
    // continue to work.
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"name":"x","nested":{"a":"y"}}')
    const state = createFormStore<Bag>({
      formKey: 'sec2-ssr',
      schema: fakeSchema(defaults),
      hydration: { form: hostile, schemaErrors: [], userErrors: [], fields: [] },
    })
    const raw = toRaw(state.form.value) as Record<string, unknown>

    // The SEC-2 invariant.
    expect(readGlobalProp('polluted')).toBeUndefined()
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype)
    expect(raw['polluted']).toBeUndefined()
    // Defaults still merged through (name + nested came through SSR
    // alongside the special-key smuggle).
    expect(raw['name']).toBe('x')
  })
})
