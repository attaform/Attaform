import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fingerprintZodSchema } from '../../../src/runtime/adapters/zod-v4/fingerprint'

/**
 * v4 mirror of `test/adapters/zod-v3/fingerprint-walker-parity.test.ts`.
 * The pipeline / set / brand assertions are v4-only by audit framing
 * (v3 had the gaps); native enum is also probed for symmetric coverage.
 * v4 already passes every case at the time the v3 cluster was written.
 */
describe('zod v4: fingerprint walker parity', () => {
  describe('z.enum fingerprints reflect enum members', () => {
    it('z.enum does not throw and distinguishes different member sets', () => {
      const fpA = fingerprintZodSchema(z.object({ v: z.enum(['one', 'two']) }))
      const fpB = fingerprintZodSchema(z.object({ v: z.enum(['three', 'four']) }))
      expect(() => fingerprintZodSchema(z.object({ v: z.enum(['x', 'y']) }))).not.toThrow()
      expect(fpA).not.toBe(fpB)
    })
  })

  describe('ZodPipeline reads in', () => {
    it('pipelines with different inputs yield different fingerprints', () => {
      const fpStr = fingerprintZodSchema(z.object({ v: z.string().pipe(z.string()) }))
      const fpNum = fingerprintZodSchema(z.object({ v: z.number().pipe(z.number()) }))
      expect(fpStr).not.toBe(fpNum)
    })
  })

  describe('ZodSet element type distinguishes structurally-distinct sets', () => {
    it('z.set<string> and z.set<number> yield different fingerprints', () => {
      const fpStr = fingerprintZodSchema(z.object({ v: z.set(z.string()) }))
      const fpNum = fingerprintZodSchema(z.object({ v: z.set(z.number()) }))
      expect(fpStr).not.toBe(fpNum)
    })
  })
})
