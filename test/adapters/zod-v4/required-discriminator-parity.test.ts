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
 *
 * The lazy-parity block is the anchor for the v3 fix: v4's
 * `isLeafRequired` already peels `ZodLazy`, so these cases pass
 * unchanged and prove the v3 side now matches. The preprocess-parity
 * block is the same kind of anchor: v4 already treats `z.preprocess` as
 * an opaque leaf (it desugars to a pipe whose input is a transform), so
 * these cases pass unchanged and pin the behavior v3 now matches.
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

  describe('z.lazy is transparent for required-ness (lazy parity)', () => {
    it('peels z.lazy to a permissive inner so the leaf is not required', () => {
      const schema = z.object({ node: z.lazy(() => z.string().optional()) })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['node'])).toBe(false)
    })

    it('a z.lazy wrapping a required inner stays required', () => {
      const schema = z.object({ node: z.lazy(() => z.string()) })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['node'])).toBe(true)
    })
  })

  describe('z.preprocess is an opaque leaf (preprocess parity)', () => {
    it('a preprocess-wrapped optional leaf reports as required (opaque, not peeled)', () => {
      const schema = z.object({ f: z.preprocess((v) => v, z.string().optional()) })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['f'])).toBe(true)
    })

    it('a preprocess-wrapped discriminated union exposes no discriminator (no reshape)', () => {
      const schema = z.object({
        p: z.preprocess(
          (v) => v,
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), x: z.string() }),
            z.object({ kind: z.literal('b'), y: z.number() }),
          ])
        ),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getUnionDiscriminatorAtPath(['p'])).toBeUndefined()
    })

    it('a transform-wrapped optional still peels (transform stays transparent)', () => {
      const schema = z.object({
        f: z
          .string()
          .optional()
          .transform((v) => v),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['f'])).toBe(false)
    })

    it('a transform-wrapped discriminated union still exposes its discriminator', () => {
      const schema = z.object({
        p: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), x: z.string() }),
            z.object({ kind: z.literal('b'), y: z.number() }),
          ])
          .transform((v) => v),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getUnionDiscriminatorAtPath(['p'])?.discriminatorKey).toBe('kind')
    })
  })
})
