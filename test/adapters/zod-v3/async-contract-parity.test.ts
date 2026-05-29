import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 take on v4's "sync-error seeding when async siblings throw the
 * strict parse" suite (`test/adapters/zod-v4/adapter.test.ts:94-169`).
 *
 * The v4 reference seeds sync `.refine` errors at construction
 * alongside async siblings via per-check `isAsyncCheck` filtering. v3
 * cannot — `.refine` wraps the user predicate inside a sync closure
 * (see `introspect.ts isAsyncEffect`), so sync vs async isn't
 * statically observable. Path A (signed off during Phase 10): the
 * construction-time strip drops every `ZodEffects` when the original
 * `safeParse` throws "Async refinement encountered". Sync refines
 * lose seeding in mixed sync+async forms; container + leaf checks
 * still surface. The parity story: v3 surfaces container / leaf
 * verdicts on mixed schemas; full sync-refine seeding is reserved for
 * pure-sync schemas (no async refines anywhere).
 *
 * Dual-green after the fix is the parity proof for the cases v3 CAN
 * seed (D14 / V4-2 in the audit ledger).
 */
describe('zod v3: strict getDefaultValues seeds container/leaf errors alongside async refines (D2 / D14 / V4-2, Path A)', () => {
  it('seeds container .min violation at construction when an async refine sibling exists', () => {
    // Mixed schema: `items` carries a container check; `email` carries
    // an async refine. The original `safeParse` throws on the async
    // refine, the strip-and-retry drops every ZodEffects but preserves
    // the `.min(1)` container check, and the empty `items` array
    // surfaces as a path-scoped error at construction.
    const schema = z.object({
      items: z.array(z.string()).min(1),
      email: z
        .string()
        .email()
        .refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: [], email: 'a@b.com' },
      strict: true,
    })

    expect(result.success).toBe(false)
    const paths = result.errors?.map((e) => e.path[0]) ?? []
    expect(paths).toContain('items')
    // Async refine error must NOT seed at construction — that verdict
    // is deferred to the post-mount async pass scheduled when
    // `needsAsyncValidation()` returns true.
    const messages = result.errors?.map((e) => e.message) ?? []
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
