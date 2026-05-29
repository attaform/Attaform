import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'
import { AttaformErrorCode } from '../../../src/runtime/core/error-codes'

/**
 * v3 mirror of v4's validator-threw contract (`zod-v4/adapter.ts:680,
 * 702, 727`). User code inside `.refine` / `.transform` / `.preprocess`
 * can throw (sync) or reject (async). Zod does NOT wrap these into
 * issues at the `safeParseAsync` boundary — they propagate out of the
 * parse as a real throw / rejection. Without a catch in
 * `validateAtPath`, the throw escapes into the runtime's submit and
 * change-mode pipelines as either a `submitError` (handleSubmit) or
 * an unhandled rejection (scheduleFieldValidation), and the consumer
 * never sees a path-scoped error message.
 *
 * v4 surfaces these as `ValidationError { code: 'atta:validator-threw',
 * path }`; v3 currently lets the throw escape. Dual-green after the
 * fix is the parity proof (D4 in the audit ledger; aligned with
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
    // form — `validateAtPath` resolves candidates at the path and runs
    // `safeParseAsync(data)` against each. The path on the error is
    // the requested path, set by `validatorThrewResponse`.
    const result = await adapter.validateAtPath('whatever', ['profile', 'name'])
    expect(result.success).toBe(false)
    expect(result.errors?.[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
    expect(result.errors?.[0]?.path).toEqual(['profile', 'name'])
  })
})
