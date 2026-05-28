import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/constraint-merge-parity.test.ts`.
 * v4 already uses `mergeDeep` (array replace wholesale, null/undefined
 * overrides honored); these tests pin the reference.
 */
describe('zod v4: constraint-merge parity', () => {
  it('constraint array replaces schema default array wholesale', () => {
    const schema = z.object({
      tags: z.array(z.string()).default(['x', 'y']),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: true,
      strict: false,
      constraints: { tags: ['a'] },
    })
    expect(result.data).toEqual({ tags: ['a'] })
  })

  it('constraint null override clears a nullable default', () => {
    const schema = z.object({
      label: z.string().nullable().default('fallback'),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: true,
      strict: false,
      constraints: { label: null },
    })
    expect(result.data).toEqual({ label: null })
  })

  it('plain-record constraints merge by key (nested record values preserved)', () => {
    const schema = z.object({
      profile: z.object({
        name: z.string().default('Anon'),
        bio: z.string().default('Hello'),
      }),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: true,
      strict: false,
      constraints: { profile: { name: 'Ozzy' } },
    })
    expect(result.data).toEqual({ profile: { name: 'Ozzy', bio: 'Hello' } })
  })
})
