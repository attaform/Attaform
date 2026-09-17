import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * What construction seeds when a schema mixes async and sync checks,
 * for zod v4 — and its twin under `test/adapters/zod-v3/async-contract-parity.test.ts` must agree line for line.
 *
 * It seeds NOTHING. A schema declaring async work anywhere returns from
 * `getDefaultValues` clean, and every verdict — sync or async — arrives
 * on the post-mount async pass that `needsAsyncValidation()` schedules.
 *
 * This is where the two adapters converged. v4 used to rebuild the whole
 * schema with async predicates removed and parse against that copy, so
 * sync refines seeded; v3 could not tell sync from async at the
 * predicate level, so its equivalent dropped EVERY `ZodEffects` and
 * seeded only container and leaf checks. Two walkers, two different
 * answers to the same schema, each a second parallel understanding of
 * its Zod major. Both are gone, and the answer is now one answer.
 *
 * What did not change: a schema with no async work still seeds its sync
 * violations at construction, which the counterweight case below pins.
 */
describe('zod v4: an async sibling defers the whole construction verdict', () => {
  it('seeds nothing when an async refine exists, sync violations included', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z.email().refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { word: '', email: 'a@b.com' },
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('still seeds the same violation when nothing async is present', () => {
    // The counterweight: this is about the MIXTURE, not about the check.
    const schema = z.object({ word: z.string().refine((v) => v.length > 0, 'word required') })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { word: '' },
    })

    expect(result.success).toBe(false)
    expect(result.errors?.map((e) => e.message) ?? []).toContain('word required')
  })

  it('returns success when the sync portion is clean but async refines exist', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z.email().refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
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
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z.email().refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
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
    const schema = z.object({
      email: z.email().refine(async () => Promise.resolve(true), 'never fires'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { email: 'a@b.com' },
    })

    expect(result.success).toBe(true)
  })
})
