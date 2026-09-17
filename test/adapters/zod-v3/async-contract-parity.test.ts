import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * What construction seeds when a schema mixes async and sync checks, on
 * zod v3. Its twin under
 * `test/adapters/zod-v4/async-contract-parity.test.ts` agrees line for
 * line.
 *
 * It seeds NOTHING. A schema declaring async work anywhere returns from
 * `getDefaultValues` clean, and every verdict, sync or async, arrives on
 * the post-mount async pass that `needsAsyncValidation()` schedules.
 *
 * Seeding the sync half would mean parsing against a copy of the schema
 * with its async predicates removed, and building that copy is a second
 * parallel understanding of a Zod major that drifts from the original
 * with nothing to notice. One answer per schema is worth the one
 * async pass of latency.
 *
 * A schema with no async work still seeds its sync violations at
 * construction, which the counterweight case below pins.
 */
describe('zod v3: an async sibling defers the whole construction verdict', () => {
  it('seeds nothing when an async refine exists, container checks included', () => {
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
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('still seeds the same container violation when nothing async is present', () => {
    // The counterweight: this is about the MIXTURE, not about the check.
    const schema = z.object({ items: z.array(z.string()).min(1) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: [] },
    })

    expect(result.success).toBe(false)
    expect(result.errors?.map((e) => e.path[0]) ?? []).toContain('items')
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
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('a FAILING sync sibling is not seeded either, when an async refine is present', () => {
    // The async gate is whole-schema: an obviously failing sync default
    // still returns success, because the construction parse never ran.
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
    })

    expect(result.success).toBe(true)
  })
})
