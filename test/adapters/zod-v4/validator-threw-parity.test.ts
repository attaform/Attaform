import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'
import { AttaformErrorCode } from '../../../src/runtime/core/error-codes'

/**
 * v4 half of the validator-threw contract; the v3 half is
 * `test/adapters/zod-v3/validator-threw-parity.test.ts`, which carries
 * the reasoning. `createAbstractSchema` wraps `safeParseAsync` in a
 * try/catch and routes a consumer validator's throw through
 * `validatorThrewResponse`, and both adapters compose it.
 */
describe('zod v4: validateAtPath wraps user-validator throws as atta:validator-threw (D4 reference)', () => {
  it('async-rejecting .refine surfaces as a ValidationError, not an unhandled rejection', async () => {
    const schema = z.object({
      name: z.string().refine(async () => {
        await Promise.resolve()
        throw new Error('refine async boom')
      }, 'unreachable'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = await adapter.validateAtPath({ name: 'whatever' }, undefined)
    expect(result.success).toBe(false)
    expect(result.errors?.length ?? 0).toBeGreaterThan(0)
    expect(result.errors?.[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })

  it('async-rejecting .transform surfaces as a ValidationError', async () => {
    const schema = z.object({
      name: z.string().transform(async () => {
        await Promise.resolve()
        throw new Error('transform async boom')
      }),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = await adapter.validateAtPath({ name: 'whatever' }, undefined)
    expect(result.success).toBe(false)
    expect(result.errors?.length ?? 0).toBeGreaterThan(0)
    expect(result.errors?.[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })

  it('async-rejecting .preprocess surfaces as a ValidationError', async () => {
    const schema = z.object({
      name: z.preprocess(async () => {
        await Promise.resolve()
        throw new Error('preprocess async boom')
      }, z.string()),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = await adapter.validateAtPath({ name: 'whatever' }, undefined)
    expect(result.success).toBe(false)
    expect(result.errors?.length ?? 0).toBeGreaterThan(0)
    expect(result.errors?.[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })

  it('path-scoped validate carries the requested path on the validator-threw error', async () => {
    const schema = z.object({
      profile: z.object({
        name: z.string().refine(async () => {
          await Promise.resolve()
          throw new Error('boom')
        }, 'unreachable'),
      }),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = await adapter.validateAtPath('whatever', ['profile', 'name'])
    expect(result.success).toBe(false)
    expect(result.errors?.[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
    expect(result.errors?.[0]?.path).toEqual(['profile', 'name'])
  })
})
