import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 required-vs-optional and discriminator parity tests for the four
 * audit IDs grouped under this cluster:
 *
 * - **D9** — `z.void()` was missing from `isLeafRequiredV3`'s
 *   short-circuit list, so a `z.void()` slot reported as required (any
 *   write of `undefined` then surfaced as a "required" error). v4 has
 *   `'void'` in the not-required list (`isLeafRequired` short-circuit).
 * - **D10** — `isRequiredAtPath` destructured the first walker
 *   candidate (`const [leaf]`) instead of checking every candidate.
 *   When a path traversed a union and ONLY the first branch was
 *   required, the path looked required overall — v4 returns
 *   `resolved.every(isLeafRequired)` so any permissive branch makes the
 *   union permissive.
 * - **D11** — `computeDiscriminator` peeled wrappers with
 *   `peelV3Wrappers` (Optional / Nullable / Default / Readonly /
 *   Effects / Pipeline / Branded) but not ZodCatch, and
 *   `unwrapToDiscriminatedUnion` did not descend ZodIntersection sides.
 *   So a discriminated union wrapped in `.catch(...)` or inside an
 *   intersection went undetected and the runtime fell back to plain
 *   writes (losing variant-aware reshape).
 * - **D12** — `computeDiscriminator` read `_def.value` as a single
 *   value via `getLiteralValue`. v3 supports multi-value
 *   `z.literal(['a','b'])` which stores `_def.value` as an array, so
 *   the literal set held the array AS one entry and
 *   `isVariantSelected('a')` returned `false`. v4 reads through
 *   `getLiteralValues(litSchema)` which always returns an array.
 *
 * Mirror of `required-discriminator-parity.test.ts` under
 * `test/adapters/zod-v4/`; dual-green after the fix is the parity
 * proof.
 */
describe('zod v3: required + discriminator parity (D9 / D10 / D11 / D12)', () => {
  describe('z.void() is not required (D9)', () => {
    it('a z.void() leaf reports as not required', () => {
      const schema = z.object({ payload: z.void() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.isRequiredAtPath(['payload'])).toBe(false)
    })
  })

  describe('union required = every candidate required (D10)', () => {
    it('union where any branch is permissive makes the path not required', () => {
      const schema = z.object({
        value: z.union([z.object({ x: z.string() }), z.object({ x: z.number().optional() })]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      // First union branch's `x` is required; second is optional → the
      // union as a whole is not required at `value.x`.
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

  describe('discriminated union inside .catch / .intersection (D11)', () => {
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

  describe('multi-value literal discriminator (D12)', () => {
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
