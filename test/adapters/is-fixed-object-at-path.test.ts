import { describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodAdapter as zodAdapterV4 } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodAdapterV3 } from '../../src/runtime/adapters/zod-v3'

/**
 * Adapter-level contract for `isFixedObjectAtPath`. The surface proxies
 * query it to tell a FIXED object (closed declared keys — a schema field
 * descends even before its data lands) from an OPEN / union container
 * (array / record / set / tuple / union / discriminated union — descent
 * follows live keys, absence is `undefined`). Root is always fixed;
 * wrappers peel; an unknown path is not fixed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (z: any) =>
  z.object({
    leaf: z.string(),
    obj: z.object({ inner: z.object({ a: z.string() }), a: z.string() }),
    optObj: z.object({ a: z.string() }).optional(),
    rec: z.record(z.string(), z.string()),
    arr: z.array(z.string()),
    tup: z.tuple([z.string(), z.number()]),
    du: z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), x: z.string() }),
      z.object({ k: z.literal('b'), y: z.number() }),
    ]),
    uni: z.union([z.string(), z.number()]),
    st: z.set(z.string()),
  })

const adapters = [
  { name: 'v4', adapter: zodAdapterV4(build(zV4) as never)('f', { maxRecursionDepth: 64 }) },
  { name: 'v3', adapter: zodAdapterV3(build(zV3) as never)('f', { maxRecursionDepth: 64 }) },
] as const

describe.each(adapters)('isFixedObjectAtPath — $name', ({ adapter }) => {
  it('the root form is a fixed object', () => {
    expect(adapter.isFixedObjectAtPath([])).toBe(true)
  })

  it('a z.object is fixed, at any depth', () => {
    expect(adapter.isFixedObjectAtPath(['obj'])).toBe(true)
    expect(adapter.isFixedObjectAtPath(['obj', 'inner'])).toBe(true)
  })

  it('an optional-wrapped object peels to fixed', () => {
    expect(adapter.isFixedObjectAtPath(['optObj'])).toBe(true)
  })

  it('open and union containers are NOT fixed', () => {
    expect(adapter.isFixedObjectAtPath(['rec'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['arr'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['tup'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['du'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['uni'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['st'])).toBe(false)
  })

  it('a primitive leaf is not a fixed object', () => {
    expect(adapter.isFixedObjectAtPath(['leaf'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['obj', 'a'])).toBe(false)
  })

  it('an unknown path is not a fixed object', () => {
    expect(adapter.isFixedObjectAtPath(['nope'])).toBe(false)
    expect(adapter.isFixedObjectAtPath(['obj', 'nope'])).toBe(false)
  })
})
