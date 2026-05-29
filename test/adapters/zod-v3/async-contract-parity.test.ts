import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 mirror of v4's "sync-error seeding when async siblings throw the
 * strict parse" suite (`test/adapters/zod-v4/adapter.test.ts:94-169`).
 *
 * Pre-fix v3 `getDefaultValues` strips ALL `ZodEffects` up-front
 * (`stripZodEffects: true` regardless of mode) and parses against the
 * slim schema, so:
 *
 *  - sync `.refine` errors on `defaultValues` are silently dropped at
 *    construction (the slim schema has no refines to surface them), and
 *  - an async sibling additionally trips the outer try/catch, which
 *    swallows whatever the slim parse would have returned and degrades
 *    to lax success.
 *
 * v4's strict path parses against the real schema (or
 * `stripAsyncChecks(real)` when an async refine lives in the tree), so
 * sync refine errors on the supplied defaults seed at construction and
 * async-only verdicts stay deferred to the post-mount async pass.
 *
 * Dual-green after the fix is the parity proof (D2 / D14 / V4-2 in the
 * audit ledger).
 */
describe('zod v3: strict getDefaultValues seeds sync refine errors alongside async siblings (D2 / D14 / V4-2)', () => {
  it('seeds sync-refinement errors at construction when an async sibling exists', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z
        .string()
        .email()
        .refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { word: '', email: 'a@b.com' },
      strict: true,
    })

    expect(result.success).toBe(false)
    const messages = result.errors?.map((e) => e.message) ?? []
    expect(messages).toContain('word required')
    // Async refine error must NOT seed at construction — that verdict is
    // deferred to the post-mount async pass scheduled when
    // `needsAsyncValidation()` returns true.
    expect(messages).not.toContain('taken')
  })

  it('returns success when the sync portion is clean but async refines exist', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z
        .string()
        .email()
        .refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { word: 'hello', email: 'a@b.com' },
      strict: true,
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('strict: false bypasses the sync-only retry path entirely', () => {
    // Lax mode is a global opt-out; even an obviously failing sync
    // default returns success without the retry running.
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z
        .string()
        .email()
        .refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { word: '', email: 'a@b.com' },
      strict: false,
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('pure-async schema with clean defaults regression: still returns success', () => {
    // Regression guard: a schema with only async refines and no sync
    // failures must continue to return success at construction. The
    // async-only strip path rebuilds the leaf without its async refine
    // and the parse runs clean.
    const schema = z.object({
      email: z
        .string()
        .email()
        .refine(async () => Promise.resolve(true), 'never fires'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { email: 'a@b.com' },
      strict: true,
    })

    expect(result.success).toBe(true)
  })
})
