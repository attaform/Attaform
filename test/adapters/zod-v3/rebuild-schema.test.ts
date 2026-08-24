import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import * as z4 from 'zod/v4'
import {
  rebuildArray,
  rebuildDiscriminatedUnion,
  rebuildIntersection,
  rebuildLazy,
  rebuildObject,
  rebuildRecord,
  rebuildSet,
  rebuildTuple,
  rebuildUnion,
  rebuildWrapperInner,
} from '../../../src/runtime/adapters/zod-v3/rebuild-schema'

/**
 * Unit suite for the version-faithful schema rebuild that replaced the
 * adapter's ambient `z.object()` / `z.array()` / ... construction. The
 * invariants pinned here are what make a hoisted second zod harmless:
 * each rebuild stays on the input node's prototype, never mutates the
 * original, and the discriminated-union recipe reconstructs the parse
 * `optionsMap`, not just the options array.
 */

// `_def.optionsMap` is internal; read it through a local cast rather
// than widening the public types.
function optionsMapOf(schema: z.ZodTypeAny): Map<unknown, z.AnyZodObject> {
  return (schema as unknown as { _def: { optionsMap: Map<unknown, z.AnyZodObject> } })._def
    .optionsMap
}

describe('rebuildObject', () => {
  it('preserves the prototype and typeName, swapping only the shape', () => {
    const original = z.object({ a: z.string().min(5) })
    const rebuilt = rebuildObject(original, { a: z.string() })

    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.getPrototypeOf(original))
    expect(rebuilt).toBeInstanceOf(z.ZodObject)
    expect(rebuilt._def.typeName).toBe('ZodObject')
  })

  it('seeds the _cached slot so the first parse does not throw', () => {
    const rebuilt = rebuildObject(z.object({ a: z.string().min(5) }), { a: z.string() })
    // `Object.create` skips the constructor that seeds `_cached` to
    // null; without the explicit seed `_getCached` returns undefined
    // and this parse throws on `cached.shape`.
    expect((rebuilt as unknown as { _cached: unknown })._cached).toBe(null)
    expect(rebuilt.parse({ a: '' })).toEqual({ a: '' })
  })

  it('parses against the new shape, not the original checks', () => {
    const original = z.object({ a: z.string().min(5) })
    const rebuilt = rebuildObject(original, { a: z.string() })
    // min(5) is gone on the rebuild.
    expect(rebuilt.safeParse({ a: '' }).success).toBe(true)
  })

  it('never mutates the original node', () => {
    const original = z.object({ a: z.string().min(5) })
    rebuildObject(original, { a: z.string() })
    // The original still rejects the short string.
    expect(original.safeParse({ a: '' }).success).toBe(false)
    expect(original._def).not.toBeUndefined()
  })
})

describe('rebuild* container helpers', () => {
  it('rebuildArray swaps the element and drops length checks', () => {
    const original = z.array(z.string()).min(2)
    const rebuilt = rebuildArray(original, z.string())
    expect(rebuilt).toBeInstanceOf(z.ZodArray)
    expect(rebuilt._def.type).toBeInstanceOf(z.ZodString)
    expect(rebuilt.parse(['only-one'])).toEqual(['only-one'])
  })

  it('rebuildSet swaps the value type', () => {
    const rebuilt = rebuildSet(z.set(z.number()), z.string())
    expect(rebuilt).toBeInstanceOf(z.ZodSet)
    expect(rebuilt.parse(new Set(['x']))).toEqual(new Set(['x']))
  })

  it('rebuildRecord swaps value (and key when given)', () => {
    const oneArg = rebuildRecord(z.record(z.number()), z.string())
    expect(oneArg).toBeInstanceOf(z.ZodRecord)
    expect(oneArg.parse({ a: 'x' })).toEqual({ a: 'x' })

    const twoArg = rebuildRecord(z.record(z.string(), z.number()), z.string(), z.string())
    expect(twoArg.parse({ a: 'x' })).toEqual({ a: 'x' })
  })

  it('rebuildTuple swaps the items', () => {
    const rebuilt = rebuildTuple(z.tuple([z.number()]), [z.string(), z.number()])
    expect(rebuilt).toBeInstanceOf(z.ZodTuple)
    expect(rebuilt.parse(['x', 1])).toEqual(['x', 1])
  })

  it('rebuildUnion swaps the options', () => {
    const rebuilt = rebuildUnion(z.union([z.string(), z.number()]), [z.boolean(), z.number()])
    expect(rebuilt).toBeInstanceOf(z.ZodUnion)
    expect(rebuilt.parse(true)).toBe(true)
    expect(rebuilt.safeParse('nope').success).toBe(false)
  })

  it('rebuildIntersection swaps both sides', () => {
    const rebuilt = rebuildIntersection(
      z.intersection(z.string(), z.string()),
      z.object({ a: z.string() }),
      z.object({ b: z.number() })
    )
    expect(rebuilt).toBeInstanceOf(z.ZodIntersection)
    expect(rebuilt.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 })
  })

  it('rebuildWrapperInner swaps a transparent wrapper inner', () => {
    const rebuilt = rebuildWrapperInner(z.string().optional(), z.number())
    expect(rebuilt).toBeInstanceOf(z.ZodOptional)
    expect(rebuilt.parse(undefined)).toBeUndefined()
    expect(rebuilt.parse(5)).toBe(5)
    expect(rebuilt.safeParse('x').success).toBe(false)
  })

  it('resets container constraint slots to fresh-constructor defaults', () => {
    // This is the byte-faithfulness guarantee for the slim path: the
    // rebuild must match the old `z.array()` / `z.object()` (which drop
    // these), so the lenient slim parse of an empty seed never fails.
    expect(rebuildArray(z.array(z.string()).min(3), z.string()).safeParse([]).success).toBe(true)
    expect(rebuildSet(z.set(z.number()).min(2), z.number()).safeParse(new Set()).success).toBe(true)
    const strict = rebuildObject(z.object({ a: z.string() }).strict(), { a: z.string() })
    expect(strict.safeParse({ a: 'x', extra: 1 }).success).toBe(true)
  })

  it('rebuildLazy resolves the getter to the new target', () => {
    const rebuilt = rebuildLazy(
      z.lazy(() => z.string()),
      z.number()
    )
    expect(rebuilt).toBeInstanceOf(z.ZodLazy)
    expect(rebuilt._def.getter()).toBeInstanceOf(z.ZodNumber)
    expect(rebuilt.parse(7)).toBe(7)
  })
})

describe('rebuildDiscriminatedUnion', () => {
  it('remaps the optionsMap to the NEW (slim) options in order', () => {
    const card = z.object({ kind: z.literal('card'), number: z.string().min(4) })
    const cash = z.object({ kind: z.literal('cash'), amount: z.number() })
    const original = z.discriminatedUnion('kind', [card, cash])
    // Distinct slim options in the original order (number's min dropped).
    const slimCard = rebuildObject(card, { kind: z.literal('card'), number: z.string() })
    const slimCash = rebuildObject(cash, { kind: z.literal('cash'), amount: z.number() })
    const rebuilt = rebuildDiscriminatedUnion(original, [slimCard, slimCash])

    const map = optionsMapOf(rebuilt)
    // The map points at the SLIM options, not the originals.
    expect(map.get('card')).toBe(slimCard)
    expect(map.get('cash')).toBe(slimCash)
    // Routing reaches the slim branch: min(4) is gone, so 'ab' parses.
    expect(rebuilt.parse({ kind: 'card', number: 'ab' })).toEqual({ kind: 'card', number: 'ab' })
  })

  it('rejects an unmapped discriminator with invalid_union_discriminator', () => {
    const card = z.object({ kind: z.literal('card'), number: z.string() })
    const cash = z.object({ kind: z.literal('cash'), amount: z.number() })
    const rebuilt = rebuildDiscriminatedUnion(z.discriminatedUnion('kind', [card, cash]), [
      card,
      cash,
    ])
    const result = rebuilt.safeParse({ kind: 'wire' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('invalid_union_discriminator')
    }
  })

  it('carries every value of a multi-value (enum) discriminator to its slim option', () => {
    const ab = z.object({ kind: z.enum(['a', 'b']), v: z.string() })
    const c = z.object({ kind: z.literal('c'), w: z.number() })
    const original = z.discriminatedUnion('kind', [ab, c])
    const slimAb = rebuildObject(ab, { kind: z.enum(['a', 'b']), v: z.string() })
    const slimC = rebuildObject(c, { kind: z.literal('c'), w: z.number() })
    const rebuilt = rebuildDiscriminatedUnion(original, [slimAb, slimC])

    // Reused from zod's own optionsMap, both enum values route to the
    // same slim option.
    const map = optionsMapOf(rebuilt)
    expect(map.get('a')).toBe(slimAb)
    expect(map.get('b')).toBe(slimAb)
    expect(map.get('c')).toBe(slimC)
  })
})

describe('realm faithfulness (the anti-skew invariant)', () => {
  it('rebuilds onto the INPUT node prototype, never an ambient one', () => {
    // A v3-built node rebuilds to v3's prototype.
    const v3obj = z.object({ a: z.string() })
    expect(Object.getPrototypeOf(rebuildObject(v3obj, { a: z.string() }))).toBe(
      Object.getPrototypeOf(v3obj)
    )

    // The SAME helper handed a foreign-realm node (zod v4, standing in
    // for a mismatched hoisted major) keeps that node's prototype. The
    // rebuild never substitutes a constructor of its own, so a second
    // zod in the tree cannot leak into the result.
    const v4obj = z4.object({ a: z4.string() }) as unknown as z.ZodTypeAny
    expect(Object.getPrototypeOf(rebuildObject(v4obj, {}))).toBe(Object.getPrototypeOf(v4obj))
    expect(Object.getPrototypeOf(rebuildObject(v4obj, {}))).not.toBe(Object.getPrototypeOf(v3obj))
  })
})
