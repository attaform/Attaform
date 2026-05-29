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
 * The persistence-side defense is now structural: `mergeDeep` allocates
 * its merge target via `Object.create(null)`, so any `out['__proto__']
 * = …` write that the iteration produces is a plain own-property
 * write with no path to `Object.prototype`. Legitimate schema fields
 * named `prototype` / `constructor` / `__proto__` (an architecture
 * firm tracking building prototypes; a construction-management form
 * naming the construction crew; a JS-tooling form that mentions
 * `__proto__` literally) land at the declared path the consumer
 * asked for.
 *
 * The SSR DU-stub walk still uses the SEC-2-era input-rejection guard
 * (`isDangerousSegment`) — the same proto-less treatment is queued
 * as a follow-up PR alongside the rest of the broader sweep. The
 * test below pins the current du-stubs contract until then.
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

    // Prototype-less merge target — the structural fix that makes
    // `out['__proto__'] = …` a plain own-property write. The probe-
    // probe (`merged['polluted']`) is undefined because the tree's
    // `__proto__` slot is an own property, not an accessor that walks
    // into Object.prototype.
    expect(Object.getPrototypeOf(merged)).toBeNull()
    expect(merged['polluted']).toBeUndefined()

    // `isPlainRecord` accepts both `proto === null` (Object.create(null))
    // and `proto === Object.prototype`, so downstream consumers
    // continue to treat the result as a plain record.
    expect(isPlainRecord(merged)).toBe(true)

    // Legit field still merges.
    expect(merged['name']).toBe('real')
  })

  it('mergeSparseHydration keeps Object.prototype clean despite a constructor/prototype payload', () => {
    const hostile = JSON.parse('{"constructor":{"prototype":{"polluted":1}}}')
    const merged = mergeSparseHydration(defaults, hostile) as Record<string, unknown>

    // Global cleanliness — the SEC-2 invariant.
    expect(readGlobalProp('polluted')).toBeUndefined()

    // The merge target is prototype-less, so `constructor` lands as
    // an ordinary own-property pair instead of being silently dropped.
    // The structural defense still holds because the descended
    // container is also prototype-less — there is no accessor walk
    // that reaches Object.prototype.prototype regardless of how deep
    // the payload nests these key names.
    expect(Object.getPrototypeOf(merged)).toBeNull()
    expect(isPlainRecord(merged)).toBe(true)
  })

  it('SSR DU-stub walk ignores a __proto__ hydration key', () => {
    // `walkDuStubs` still uses the SEC-2-era input-rejection guard;
    // a follow-up PR will apply the proto-less storage treatment here
    // alongside the rest of the sweep. This case pins the current
    // behavior until then.
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"name":"x","nested":{"a":"y"}}')
    const state = createFormStore<Bag>({
      formKey: 'sec2-ssr',
      schema: fakeSchema(defaults),
      hydration: { form: hostile, schemaErrors: [], userErrors: [], fields: [] },
    })
    const raw = toRaw(state.form.value) as Record<string, unknown>
    expect(raw['polluted']).toBeUndefined()
    expect(readGlobalProp('polluted')).toBeUndefined()
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype)
  })
})
