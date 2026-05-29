import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/required-discriminator-parity.test.ts`.
 * Same four cluster scenarios across the same public adapter surface. v4
 * already passes D9, D10, and D12 at the time the v3 cluster was
 * written; the catch-peel scenario in D11 is investigated empirically
 * here — if it fails, the v4 side has the same gap and the fix lands
 * symmetrically.
 */
describe('zod v4: required + discriminator parity', () => {
  describe('z.void() is not required', () => {
    it('a z.void() leaf reports as not required', () => {
      const schema = z.object({ payload: z.void() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['payload'])).toBe(false)
    })
  })

  describe('union required = every candidate required', () => {
    it('union where any branch is permissive makes the path not required', () => {
      const schema = z.object({
        value: z.union([z.object({ x: z.string() }), z.object({ x: z.number().optional() })]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['value', 'x'])).toBe(false)
    })

    it('union where every branch is required keeps the path required', () => {
      const schema = z.object({
        value: z.union([z.object({ x: z.string() }), z.object({ x: z.number() })]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['value', 'x'])).toBe(true)
    })
  })

  describe('discriminated union inside .catch / .intersection', () => {
    it('peels .catch to reach the discriminated union', () => {
      const schema = z.object({
        payload: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), x: z.string() }),
            z.object({ kind: z.literal('b'), y: z.number() }),
          ])
          .catch({ kind: 'a' as const, x: '' }),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const ctx = adapter.getUnionDiscriminatorAtPath(['payload'])
      expect(ctx).toBeDefined()
      expect(ctx?.discriminatorKey).toBe('kind')
      expect(ctx?.isVariantSelected('a')).toBe(true)
      expect(ctx?.isVariantSelected('b')).toBe(true)
    })

    it('descends z.intersection to reach a discriminated union on either side', () => {
      const schema = z.object({
        combo: z.intersection(
          z.object({ tag: z.string() }),
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), x: z.string() }),
            z.object({ kind: z.literal('b'), y: z.number() }),
          ])
        ),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const ctx = adapter.getUnionDiscriminatorAtPath(['combo'])
      expect(ctx).toBeDefined()
      expect(ctx?.discriminatorKey).toBe('kind')
      expect(ctx?.isVariantSelected('a')).toBe(true)
    })
  })

  describe('multi-value literal discriminator', () => {
    it('z.literal(["a","b"]) registers every literal value as a selectable variant', () => {
      const schema = z.object({
        value: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal(['a', 'b']), x: z.string() }),
          z.object({ kind: z.literal('c'), y: z.number() }),
        ]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const ctx = adapter.getUnionDiscriminatorAtPath(['value'])
      expect(ctx).toBeDefined()
      expect(ctx?.isVariantSelected('a')).toBe(true)
      expect(ctx?.isVariantSelected('b')).toBe(true)
      expect(ctx?.isVariantSelected('c')).toBe(true)
      expect(ctx?.isVariantSelected('d')).toBe(false)
    })
  })
})
