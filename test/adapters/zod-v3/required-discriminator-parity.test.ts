import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * The v3 half of required-vs-optional and discriminator parity. Six
 * rules, each an audit ID, each one both adapters must agree on:
 *
 * - **D9**: a `z.void()` slot is NOT required, so it short-circuits in
 *   `isLeafRequiredV3` exactly as `'void'` does in v4's
 *   `isLeafRequired`. Otherwise any write of `undefined` surfaces as a
 *   "required" error.
 * - **D10**: `isRequiredAtPath` checks EVERY walker candidate, not just
 *   the first, so any permissive branch makes a union permissive. v4
 *   expresses the same rule as `resolved.every(isLeafRequired)`.
 * - **D11**: `computeDiscriminator` peels ZodCatch alongside the
 *   wrappers `peelV3Wrappers` handles, and `unwrapToDiscriminatedUnion`
 *   descends ZodIntersection sides. A discriminated union wrapped in
 *   `.catch(...)` or nested in an intersection has to stay detectable,
 *   or the runtime falls back to plain writes and loses variant-aware
 *   reshape.
 * - **D12**: the literal set is read through `getLiteralValues`, which
 *   always returns an array. v3 supports multi-value
 *   `z.literal(['a','b'])` and stores `_def.value` as an array, so a
 *   single-value read would hold the array as one entry and
 *   `isVariantSelected('a')` would be false.
 * - **lazy**: `isLeafRequiredV3` peels `ZodLazy`, matching v4's
 *   `unwrapLazy`, so a `z.lazy(() => x.optional())` leaf is not
 *   required.
 * - **preprocess**: `z.preprocess` is an OPAQUE leaf on both sides, so
 *   raw writes pass through verbatim; v4 gets there by desugaring it to
 *   a pipe. Peeling it like any other `ZodEffects` would make a
 *   preprocess-wrapped optional report required and hide a
 *   preprocess-wrapped union's discriminator. `transform` and
 *   `refinement` effects still peel.
 *
 * The v4 half is `required-discriminator-parity.test.ts` under
 * `test/adapters/zod-v4/`, and dual-green is the parity proof.
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

  describe('discriminated union at the ROOT (variant form)', () => {
    it('resolves the root discriminator + variants via getUnionDiscriminatorAtPath([])', () => {
      const schema = z.discriminatedUnion('method', [
        z.object({ method: z.literal('card'), cardNumber: z.string() }),
        z.object({ method: z.literal('bank'), iban: z.string() }),
      ])
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const ctx = adapter.getUnionDiscriminatorAtPath([])
      expect(ctx).toBeDefined()
      expect(ctx?.discriminatorKey).toBe('method')
      expect(ctx?.isVariantSelected('card')).toBe(true)
      expect(ctx?.isVariantSelected('bank')).toBe(true)
      expect(ctx?.isVariantSelected('paypal')).toBe(false)
    })
  })
})
