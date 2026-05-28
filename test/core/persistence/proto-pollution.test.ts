import { afterEach, describe, expect, it } from 'vitest'
import { toRaw } from 'vue'
import { createFormStore } from '../../../src/runtime/core/create-form-store'
import { mergeSparseHydration } from '../../../src/runtime/core/persistence/index'
import { isPlainRecord } from '../../../src/runtime/core/path-walker'
import { fakeSchema } from '../../utils/fake-schema'

/**
 * SEC-2 regression: untrusted persisted-draft / SSR-hydration JSON must
 * never reassign the merged object's prototype chain. `multi-tab-sync`
 * already rejects `__proto__` / `constructor` / `prototype` segments;
 * the persistence hydration merge (`mergeDeep`) and the SSR DU-stub walk
 * (`walkDuStubs`) did not. A `__proto__` key in the payload trips the
 * inherited `__proto__` setter on plain bracket-assign, silently
 * rewriting `getPrototypeOf(result)` to the attacker's object so
 * inherited keys leak into reads and `isPlainRecord` (which gates the
 * downstream persistence + scrub walks) returns false.
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
  it('mergeSparseHydration ignores a __proto__ payload key', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"name":"real"}')
    const merged = mergeSparseHydration(defaults, hostile) as Record<string, unknown>
    expect(readGlobalProp('polluted')).toBeUndefined() // global clean
    expect(merged['polluted']).toBeUndefined() // no inherited leak on the result
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(isPlainRecord(merged)).toBe(true)
    expect(merged['name']).toBe('real') // legit keys still merge
  })

  it('mergeSparseHydration ignores constructor / prototype payload keys', () => {
    const hostile = JSON.parse('{"constructor":{"prototype":{"polluted":1}}}')
    const merged = mergeSparseHydration(defaults, hostile) as Record<string, unknown>
    expect(readGlobalProp('polluted')).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
  })

  it('SSR DU-stub walk ignores a __proto__ hydration key', () => {
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
