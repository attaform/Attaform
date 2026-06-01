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
 * - **lazy parity** — `isLeafRequiredV3` did not peel `ZodLazy`, so a
 *   `z.lazy(() => x.optional())` leaf reported as required while v4
 *   (which peels lazy via `unwrapLazy`) reported not-required. v3 now
 *   peels lazy to match.
 * - **preprocess parity** — `isLeafRequiredV3` and
 *   `unwrapToDiscriminatedUnion` peeled every `ZodEffects` to its inner
 *   source, including `z.preprocess`. v4 desugars preprocess to a pipe
 *   and treats it as an opaque leaf (raw writes pass through verbatim),
 *   so a preprocess-wrapped optional reported required and a
 *   preprocess-wrapped discriminated union exposed no discriminator. v3
 *   now treats preprocess as opaque too, while still peeling `transform`
 *   and `refinement` effects.
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
      // v3's `z.literal` type narrows to a single `Primitive` but
      // the runtime accepts an array as the value-set form. Cast at
      // the construction site so the test can exercise the v3 + v4
      // semantic parity D12 exists to enforce.
      const schema = z.object({
        value: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal(['a', 'b'] as unknown as string), x: z.string() }),
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
      // v4's isLeafRequired already peels lazy; v3 now matches. Before
      // the peel a lazy-wrapped optional reported as required.
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
      // v3 used to peel the effect and report not-required; it now treats
      // preprocess as opaque, matching v4's isLeafRequired.
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
      // Opaque: the runtime can't safely reshape a write through an
      // arbitrary preprocess, so no variant context is exposed.
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
