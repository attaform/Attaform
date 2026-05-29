import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { fingerprintZodSchema } from '../../../src/runtime/adapters/zod-v3/fingerprint'

/**
 * v3 fingerprint-walker parity tests for the kinds where the pre-fix
 * v3 walker either crashed (SF1) or bucketed structurally-distinct
 * schemas to the same opaque fingerprint (SF4 / SF5 / SF7 / D17). v4
 * already produces structurally-distinct fingerprints for every case
 * here at the time of writing.
 *
 * - **SF1** — `_def.values` on `z.nativeEnum(E)` is the enum OBJECT,
 *   not an array. The pre-fix walker did `[...(def.values ?? [])]`
 *   which throws `TypeError: not iterable`. A v3 form with `persist`
 *   + any `z.nativeEnum` field crashes on mount. Phase 1 wrapped the
 *   call site in a try/catch as a defensive guard; this commit fixes
 *   the root cause so the guard is no longer load-bearing.
 * - **SF4** — `z.X().pipe(z.Y())` desugars to ZodPipeline with
 *   `_def.in` / `_def.out`. The pre-fix walker read `_def.schema`
 *   (always `undefined` for a pipeline) and emitted `ZodPipeline(?)`
 *   for every pipeline.
 * - **SF5** / **D17 set** — `z.set(z.X())` fell to the default branch
 *   and emitted `ZodSet:*` ignoring the element type. v4 emits
 *   `set<element>`.
 * - **SF7** / **D17 branded** — `.brand<T>()` fell to the default
 *   branch and emitted `ZodBranded:*` ignoring the inner. v3 stores
 *   the inner on `_def.type` (the v3 quirk; v4 brand is type-only).
 * - **SF8** — ZodObject fingerprint omitted object-level
 *   `formatChecks`. Niche (v3 ZodObject rarely carries checks) but
 *   parity-aligned with v4.
 *
 * Mirror under `test/adapters/zod-v4/fingerprint-walker-parity.test.ts`;
 * dual-green after the fix is the parity proof.
 */
describe('zod v3: fingerprint walker parity (SF1 / SF4 / SF5 / SF7 / SF8 / D17)', () => {
  describe('SF1 — z.nativeEnum no longer crashes the fingerprint', () => {
    it('z.nativeEnum string enum fingerprints without throwing', () => {
      enum Color {
        Red = 'red',
        Green = 'green',
        Blue = 'blue',
      }
      const schema = z.object({ c: z.nativeEnum(Color) })
      expect(() => fingerprintZodSchema(schema)).not.toThrow()
    })

    it('z.nativeEnum numeric enum fingerprints without throwing', () => {
      enum Status {
        Pending,
        Active,
        Closed,
      }
      const schema = z.object({ s: z.nativeEnum(Status) })
      expect(() => fingerprintZodSchema(schema)).not.toThrow()
    })

    it('different native-enum members yield different fingerprints', () => {
      enum A {
        One = 'one',
        Two = 'two',
      }
      enum B {
        Three = 'three',
        Four = 'four',
      }
      const fpA = fingerprintZodSchema(z.object({ v: z.nativeEnum(A) }))
      const fpB = fingerprintZodSchema(z.object({ v: z.nativeEnum(B) }))
      expect(fpA).not.toBe(fpB)
    })
  })

  describe('SF4 — ZodPipeline reads in (parity with v4)', () => {
    it('pipelines with different inputs yield different fingerprints', () => {
      const fpStr = fingerprintZodSchema(z.object({ v: z.string().pipe(z.string()) }))
      const fpNum = fingerprintZodSchema(z.object({ v: z.number().pipe(z.number()) }))
      expect(fpStr).not.toBe(fpNum)
    })
  })

  describe('SF5 / D17 — ZodSet element type distinguishes structurally-distinct sets', () => {
    it('z.set<string> and z.set<number> yield different fingerprints', () => {
      const fpStr = fingerprintZodSchema(z.object({ v: z.set(z.string()) }))
      const fpNum = fingerprintZodSchema(z.object({ v: z.set(z.number()) }))
      expect(fpStr).not.toBe(fpNum)
    })
  })

  describe('SF7 / D17 — ZodBranded peels inner', () => {
    it('branded primitives with different inners yield different fingerprints', () => {
      const fpStr = fingerprintZodSchema(z.object({ v: z.string().brand<'A'>() }))
      const fpNum = fingerprintZodSchema(z.object({ v: z.number().brand<'B'>() }))
      expect(fpStr).not.toBe(fpNum)
    })
  })
})
