/**
 * Prototype-pollution gate for `mergeDeep` (merge-deep.ts).
 *
 * `mergeDeep` is the default-value derivation merge used by the v3
 * and v4 zod adapters when merging intersection / constraint defaults
 * into the schema's prescribed shape. The base is the schema-side
 * default; the override carries the consumer's authored layer. Both
 * can flow through to the form's initial values.
 *
 * Before the proto-less swap, `mergeDeep` allocated the result as
 * `{ ...base }` — a plain `{}` carrying `__proto__`'s inherited
 * `[[Set]]` accessor. A `result['__proto__'] = …` write would
 * reassign the result's prototype chain instead of landing as an
 * own property, silently dropping the consumer's value.
 *
 * The fix matches the rest of the sweep: allocate the result via
 * `Object.assign(Object.create(null), base)` so the bracket-assign
 * below is a plain own-property write at every step.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeDeep } from '../../src/runtime/core/merge-deep'

const SENTINEL = 'attaformMergeDeepProtoPollutionCanary'

describe('mergeDeep proto-less default-value derivation', () => {
  beforeEach(() => {
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it('keeps Object.prototype clean despite a __proto__ override own property', () => {
    const base = { name: 'base' }
    // JSON.parse promotes `__proto__` to an own data property — the
    // shape an adapter-side default carries when the constraint
    // layer rounds through serialised form.
    const override = JSON.parse(`{"__proto__":{"${SENTINEL}":"polluted"},"name":"override"}`)
    const merged = mergeDeep(base, override) as Record<string, unknown>

    // Negative invariant — Object.prototype is unchanged.
    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    // The non-special override key still merges.
    expect(merged['name']).toBe('override')
  })

  it('legitimate `prototype` schema field round-trips through default-value merge', () => {
    const base = { prototype: { name: 'base-building' } }
    const override = { prototype: { name: 'override-building' } }
    const merged = mergeDeep(base, override) as {
      prototype: { name: string }
    }

    expect(merged.prototype.name).toBe('override-building')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it('legitimate `constructor` schema field round-trips through default-value merge', () => {
    const base = { constructor: { who: 'base-crew' } }
    const override = { constructor: { who: 'override-crew' } }
    const merged = mergeDeep(base, override) as {
      constructor: { who: string }
    }

    expect(merged.constructor.who).toBe('override-crew')
  })

  it('produces a prototype-less result', () => {
    const merged = mergeDeep({ a: 1 }, { b: 2 }) as Record<string, unknown>
    expect(Object.getPrototypeOf(merged)).toBeNull()
    expect(merged['a']).toBe(1)
    expect(merged['b']).toBe(2)
  })

  it('non-record override wins wholesale (existing semantics preserved)', () => {
    // The merge contract: a non-plain-record override replaces base
    // verbatim. Verifies the swap didn't change the early-return
    // shape.
    expect(mergeDeep({ a: 1 }, null)).toBe(null)
    expect(mergeDeep({ a: 1 }, [1, 2, 3])).toEqual([1, 2, 3])
    expect(mergeDeep({ a: 1 }, 'literal')).toBe('literal')
  })
})
