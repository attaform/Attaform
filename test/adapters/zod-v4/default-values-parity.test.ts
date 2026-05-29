import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/default-values-parity.test.ts` —
 * same scenarios across the same public adapter surface. v4 already
 * produces the contractually-correct default for every case at the time
 * the v3 cluster was written; this file pins the reference so the v3
 * fix lands as proven parity (dual-green = the gap closed).
 */
describe('zod v4: default-value parity for NaN / void / any / unknown / never / preprocess / coerce', () => {
  describe('ZodNaN', () => {
    it('z.nan() default is NaN', () => {
      const schema = z.object({ score: z.nan() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const value = adapter.getDefaultAtPath(['score'])
      expect(value).toBeNaN()
    })
  })

  describe('ZodVoid / ZodAny / ZodUnknown / ZodNever', () => {
    it('z.void() default is undefined', () => {
      const schema = z.object({ payload: z.void() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })

    it('z.any() default is undefined', () => {
      const schema = z.object({ payload: z.any() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })

    it('z.unknown() default is undefined', () => {
      const schema = z.object({ payload: z.unknown() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })

    it('z.never() default is undefined', () => {
      const schema = z.object({ payload: z.never() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['payload'])).toBeUndefined()
    })
  })

  describe('z.preprocess / z.coerce', () => {
    it('z.preprocess(fn, z.string()) default is undefined', () => {
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

    it('z.preprocess(fn, z.date()) default is undefined', () => {
      const schema = z.object({
        when: z.preprocess((s) => new Date(String(s ?? '')), z.date()),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['when'])).toBeUndefined()
    })

    it('z.coerce.string() default is undefined', () => {
      const schema = z.object({ label: z.coerce.string() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['label'])).toBeUndefined()
    })

    it('z.coerce.number() default is undefined', () => {
      const schema = z.object({ weight: z.coerce.number() })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getDefaultAtPath(['weight'])).toBeUndefined()
    })
  })
})
