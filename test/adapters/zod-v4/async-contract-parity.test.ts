import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/async-contract-parity.test.ts`.
 * v4 already seeds sync-refine errors at construction via
 * `stripAsyncChecks(rootSchema)` in `adapter.ts:365-422`; this file
 * pins that reference so the v3 port lands as proven parity.
 *
 * (`test/adapters/zod-v4/adapter.test.ts:94-169` covers the same
 * ground; mirroring the full suite here keeps the two adapter
 * trees row-for-row aligned during the Phase 10 work and beyond.)
 */
describe('zod v4: strict getDefaultValues seeds sync refine errors alongside async siblings (V4-2 reference)', () => {
  it('seeds sync-refinement errors at construction when an async sibling exists', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z.email().refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
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
    expect(messages).not.toContain('taken')
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
      strict: true,
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('strict: false bypasses the sync-only retry path entirely', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z.email().refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
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
    const schema = z.object({
      email: z.email().refine(async () => Promise.resolve(true), 'never fires'),
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
