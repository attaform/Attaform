/**
 * Perf gate for `AbstractSchema#getUnionDiscriminatorAtPath`.
 *
 * The hot writer path walks every ancestor segment on a `setValue`
 * call and consults the discriminator lookup at each step. Without a
 * cache, every keystroke re-walks the schema (an O(depth) tree
 * descent) even on schemas that have no discriminated union anywhere.
 *
 * This file pins the cache:
 *   - v4 perf gate: the second lookup for the same path does NOT
 *     re-invoke `getNestedZodSchemasAtPath` (the heavy inner walker).
 *   - v3 / v4 parity: the cache returns the same DU context object
 *     across repeated lookups and surfaces the same result for both
 *     adapters on the same schema shape.
 */
import { z as zV3 } from 'zod-v3'
import { z as zV4 } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { zodAdapter as zodAdapterV3 } from '../../src/runtime/adapters/zod-v3'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import * as v4Walker from '../../src/runtime/adapters/zod-v4/path-walker'

describe('getUnionDiscriminatorAtPath cache', () => {
  it('v4: second lookup for the same path does not re-walk the schema', () => {
    // A schema with no discriminated union anywhere — the hot real
    // case the audit calls out (every ancestor walk on every
    // keystroke pays the full walker cost).
    const schema = zV4.object({
      profile: zV4.object({
        name: zV4.string(),
        nested: zV4.object({
          deep: zV4.string(),
        }),
      }),
    })
    const adapter = zodV4Adapter(schema)('test-form', { maxRecursionDepth: 8 })

    // Prime: cold call. Records whatever incidental walks happen.
    adapter.getUnionDiscriminatorAtPath(['profile', 'nested'])

    const spy = vi.spyOn(v4Walker, 'getNestedZodSchemasAtPath')
    // Warm: repeated calls for the same path must short-circuit to the cache.
    for (let i = 0; i < 25; i++) {
      adapter.getUnionDiscriminatorAtPath(['profile', 'nested'])
    }
    const calls = spy.mock.calls.length
    spy.mockRestore()
    expect(calls).toBe(0)
  })

  it('v4: cache returns undefined consistently on no-DU schemas at varied depths', () => {
    const schema = zV4.object({
      profile: zV4.object({
        name: zV4.string(),
        nested: zV4.object({ deep: zV4.string() }),
      }),
    })
    const adapter = zodV4Adapter(schema)('test-form', { maxRecursionDepth: 8 })
    expect(adapter.getUnionDiscriminatorAtPath([])).toBeUndefined()
    expect(adapter.getUnionDiscriminatorAtPath(['profile'])).toBeUndefined()
    expect(adapter.getUnionDiscriminatorAtPath(['profile', 'nested'])).toBeUndefined()
    expect(adapter.getUnionDiscriminatorAtPath(['profile', 'nested', 'deep'])).toBeUndefined()
    // Repeats land on the cache; same `undefined` returned.
    expect(adapter.getUnionDiscriminatorAtPath(['profile', 'nested'])).toBeUndefined()
  })

  it('v4: cache surfaces the real DU context once a discriminated union is at the path', () => {
    const schema = zV4.object({
      notify: zV4.discriminatedUnion('channel', [
        zV4.object({ channel: zV4.literal('email'), address: zV4.string() }),
        zV4.object({ channel: zV4.literal('sms'), number: zV4.string() }),
      ]),
    })
    const adapter = zodV4Adapter(schema)('test-form', { maxRecursionDepth: 8 })
    const first = adapter.getUnionDiscriminatorAtPath(['notify'])
    expect(first?.discriminatorKey).toBe('channel')
    expect(first?.isVariantSelected('email')).toBe(true)
    expect(first?.isVariantSelected('telegram')).toBe(false)
    // Subsequent reads hit the cache; same identity-preserving result.
    const second = adapter.getUnionDiscriminatorAtPath(['notify'])
    expect(second).toBe(first)
  })

  it('v3: cache returns undefined consistently on no-DU schemas and the DU context otherwise', () => {
    const noDU = zV3.object({
      profile: zV3.object({ name: zV3.string() }),
    })
    const v3NoDU = zodAdapterV3(noDU)('test-form', { maxRecursionDepth: 8 })
    expect(v3NoDU.getUnionDiscriminatorAtPath(['profile'])).toBeUndefined()
    expect(v3NoDU.getUnionDiscriminatorAtPath(['profile'])).toBeUndefined()

    const withDU = zV3.object({
      notify: zV3.discriminatedUnion('channel', [
        zV3.object({ channel: zV3.literal('email'), address: zV3.string() }),
        zV3.object({ channel: zV3.literal('sms'), number: zV3.string() }),
      ]),
    })
    const v3WithDU = zodAdapterV3(withDU)('test-form', { maxRecursionDepth: 8 })
    const first = v3WithDU.getUnionDiscriminatorAtPath(['notify'])
    expect(first?.discriminatorKey).toBe('channel')
    expect(first?.isVariantSelected('sms')).toBe(true)
    expect(first?.isVariantSelected('mail-pigeon')).toBe(false)
    const second = v3WithDU.getUnionDiscriminatorAtPath(['notify'])
    expect(second).toBe(first)
  })
})
