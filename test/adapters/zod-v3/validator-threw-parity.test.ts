import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'
import { AttaformErrorCode } from '../../../src/runtime/core/error-codes'

/**
 * Consumer code inside `.refine` / `.transform` / `.preprocess` can throw
 * or reject, and Zod does not wrap either into an issue at the
 * `safeParseAsync` boundary: both propagate out of the parse for real.
 * Uncaught, that reaches the submit and change-mode pipelines as a
 * `submitError` or an unhandled rejection, with no path-scoped message
 * for the consumer.
 *
 * `createAbstractSchema` catches it instead and hands back
 * `ValidationError { code: 'atta:validator-threw', path }`. Both
 * adapters compose that factory, so this file and its v4 twin pin the
 * same guarantee from either side (D4 in the audit ledger, under
 * [[feedback-no-uncaught-exceptions]]).
 */
describe('zod v3: validateAtPath wraps user-validator throws as atta:validator-threw (D4)', () => {
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

    // `data` at a leaf path is the leaf value itself, not the full
    // form, `validateAtPath` resolves candidates at the path and runs
    // `safeParseAsync(data)` against each. The path on the error is
    // the requested path, set by `validatorThrewResponse`.
    const result = await adapter.validateAtPath('whatever', ['profile', 'name'])
    expect(result.success).toBe(false)
    expect(result.errors?.[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
    expect(result.errors?.[0]?.path).toEqual(['profile', 'name'])
  })
})
