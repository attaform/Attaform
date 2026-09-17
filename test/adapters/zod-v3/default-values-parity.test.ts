import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 default-value parity across the kinds most likely to diverge: the
 * valueless ones (ZodNaN, ZodVoid, ZodAny, ZodUnknown, ZodNever), where
 * warning and returning `null` would be wrong, and the input-normalizer
 * slots (a `'preprocess'` ZodEffects, coerce-flagged primitives such as
 * `z.coerce.string()`), where a synthesised slim concrete misrepresents
 * what the slot accepts. The v4 half is `default-values-parity.test.ts`
 * under `test/adapters/zod-v4/`, and dual-green is the parity proof.
 */
describe('zod v3: default-value parity for NaN / void / any / unknown / never / preprocess / coerce', () => {
  describe('ZodNaN (D5)', () => {
    it('z.nan() default is NaN, not null', () => {
      const schema = z.object({ score: z.nan() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const value = adapter.getDefaultAtPath(['score'])
      expect(value).toBeNaN()
    })
  })

  describe('ZodVoid / ZodAny / ZodUnknown / ZodNever (D6)', () => {
    it('z.void() default is undefined, not null', () => {
      const schema = z.object({ payload: z.void() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })

    it('z.any() default is undefined, not null', () => {
      const schema = z.object({ payload: z.any() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })

    it('z.unknown() default is undefined, not null', () => {
      const schema = z.object({ payload: z.unknown() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })

    it('z.never() default is undefined, not null', () => {
      const schema = z.object({ payload: z.never() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })
  })

  describe('z.preprocess / z.coerce (D8)', () => {
    it('z.preprocess(fn, z.string()) default is undefined, not synthesized ""', () => {
      const schema = z.object({
        normalized: z.preprocess((s) => String(s ?? ''), z.string()),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['normalized'])).toBeUndefined()
    })

    it('z.preprocess(fn, z.string().default("hello")) honors the consumer-declared default', () => {
      const schema = z.object({
        greeting: z.preprocess((s) => String(s ?? ''), z.string().default('hello')),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['greeting'])).toBe('hello')
    })

    it('z.preprocess(fn, z.date()) default is undefined, not synthesized new Date(0)', () => {
      const schema = z.object({
        when: z.preprocess((s) => new Date(String(s ?? '')), z.date()),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['when'])).toBeUndefined()
    })

    it('z.coerce.string() default is undefined, not synthesized ""', () => {
      const schema = z.object({ label: z.coerce.string() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['label'])).toBeUndefined()
    })

    it('z.coerce.number() default is undefined, not synthesized 0', () => {
      const schema = z.object({ weight: z.coerce.number() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['weight'])).toBeUndefined()
    })
  })
})
