import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodV4Adapter } from '../../../src/runtime/adapters/zod-v4/adapter'
import { deriveDefault } from '../../../src/runtime/adapters/zod-v4/default-values'

/**
 * Adapter construction accepts every Zod kind. There is no
 * construction-time audit: a kind the walkers have no case for is
 * carried opaquely (undefined blank, permissive write gate, no
 * sub-paths) rather than refused, so a schema a newer Zod can parse is
 * a schema Attaform can mount.
 *
 * Behaviour of each formerly-refused kind, end to end through a real
 * form and against both majors, lives in
 * `test/adapters/every-zod-kind.test.ts`. This file pins construction.
 */
describe('zod-v4 adapter — construction accepts every kind', () => {
  it.each([
    ['z.promise', () => z.object({ pending: z.promise(z.number()) })],
    ['z.templateLiteral', () => z.object({ greeting: z.templateLiteral(['hello ', z.string()]) })],
    ['z.map', () => z.object({ index: z.map(z.string(), z.number()) })],
    ['z.symbol', () => z.object({ tag: z.symbol() })],
    ['z.function', () => z.object({ cb: z.function() })],
  ])('mounts a schema containing %s', (_label, make) => {
    const schema = make()
    expect(() => zodV4Adapter(schema)).not.toThrow()
    expect(() => zodV4Adapter(schema)('test', { maxRecursionDepth: 64 })).not.toThrow()
  })

  it.each([
    [
      'inside an array of objects',
      () => z.object({ items: z.array(z.object({ p: z.promise(z.string()) })) }),
    ],
    [
      'inside a union branch',
      () => z.object({ mixed: z.union([z.string(), z.promise(z.number())]) }),
    ],
    ['behind .optional()', () => z.object({ pending: z.promise(z.string()).optional() })],
  ])('mounts one nested %s', (_label, make) => {
    expect(() => zodV4Adapter(make())('test', { maxRecursionDepth: 64 })).not.toThrow()
  })

  it('recursive z.lazy() mounts without throwing — adapter walks cap descent via maxRecursionDepth', () => {
    // Classic self-referential: getter resolves back to the same lazy.
    // Pre-B2 this threw at construction; post-B2 the adapter constructs
    // and the runtime walks cap their descent via `maxRecursionDepth`.
    //
    // Caveat: a pathological `z.lazy(() => self)` schema with NO
    // terminal structure cannot be parsed by Zod itself — calling
    // `safeParse` on the slim schema after our walks cap still chains
    // through a long lazy stack that Zod's parser can't unwind. Our
    // contract is "construction doesn't throw"; running the schema
    // against actual data is on the consumer.
    const self: z.ZodType = z.lazy(() => self)
    const schema = z.object({ node: self })
    expect(() => zodV4Adapter(schema)).not.toThrow()
    expect(() => zodV4Adapter(schema)('test', { maxRecursionDepth: 64 })).not.toThrow()
  })

  it('recursive z.lazy() via nested structure mounts without throwing', () => {
    type Node = { value: string; children: Node[] }
    const nodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(nodeSchema) })
    )
    expect(() => zodV4Adapter(z.object({ root: nodeSchema }))).not.toThrow()
  })
})

describe('zod-v4 adapter — supported variants of lazy/intersection/catch', () => {
  it('non-recursive z.lazy(() => z.object(...)) works', () => {
    const inner = z.object({ x: z.number() })
    const schema = z.object({ wrap: z.lazy(() => inner) })
    expect(() => zodV4Adapter(schema)).not.toThrow()
    const adapter = zodV4Adapter(schema)('test', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      strict: false,
      constraints: undefined,
    })
    expect(result.data).toEqual({ wrap: { x: 0 } })
  })

  it('z.intersection of two object schemas merges defaults', () => {
    const schema = z.object({
      item: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
    })
    expect(() => zodV4Adapter(schema)).not.toThrow()
    const adapter = zodV4Adapter(schema)('test', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      strict: false,
      constraints: undefined,
    })
    expect(result.data).toEqual({ item: { a: '', b: 0 } })
  })

  it('z.catch(schema, value) uses the catch value when useDefault=true', () => {
    const schema = z.object({ n: z.number().catch(42) })
    const adapter = zodV4Adapter(schema)('test', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: true,
      strict: false,
      constraints: undefined,
    })
    expect(result.data).toEqual({ n: 42 })
  })

  it('z.catch falls through to inner leaf default when useDefault=false', () => {
    const schema = z.object({ n: z.number().catch(42) })
    const adapter = zodV4Adapter(schema)('test', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      strict: false,
      constraints: undefined,
    })
    expect(result.data).toEqual({ n: 0 })
  })
})

describe('zod-v4 adapter — deriveDefault per kind', () => {
  it('returns the kind blank for map and template-literal', () => {
    // `new Map()` is as honest a blank as `[]` is for an array, and a
    // template literal parses strings so `''` is its blank — the
    // pattern is a refinement-level concern the blank walker ignores,
    // exactly as it ignores `z.string().min(5)`.
    expect(deriveDefault(z.map(z.string(), z.number()), false, 64)).toEqual(new Map())
    expect(deriveDefault(z.templateLiteral(['x ', z.string()]), false, 64)).toBe('')
  })

  it('returns undefined for the kinds with no canonical empty member', () => {
    // There is no empty Promise, no empty function, and `Symbol()`
    // mints a fresh value per call — seeding one would make the blank
    // non-deterministic. `undefined` leaves the slot genuinely absent.
    expect(deriveDefault(z.promise(z.string()), false, 64)).toBeUndefined()
    expect(deriveDefault(z.symbol(), false, 64)).toBeUndefined()
    expect(deriveDefault(z.function(), false, 64)).toBeUndefined()
  })

  it('returns undefined on opaque leaves — no shape is declared to derive from', () => {
    // `custom` is the kind `z.instanceof(X)` and `z.custom<T>()` both
    // compile to (#542); `undefined` is its real answer, not a
    // fallback, exactly as for `z.unknown()`.
    expect(
      deriveDefault(
        z.custom<string>(() => true),
        false,
        64
      )
    ).toBeUndefined()
    expect(deriveDefault(z.instanceof(File), false, 64)).toBeUndefined()
    expect(deriveDefault(z.unknown(), false, 64)).toBeUndefined()
  })
})
