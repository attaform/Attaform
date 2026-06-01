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

  // v4 already routes the constraint merge through core `mergeDeep`; this
  // is the parity anchor for the v3 swap. A consumer-provided `__proto__`
  // key in constraints stays inert.
  it('a __proto__ key in constraints stays inert (no prototype reassignment)', () => {
    const schema = z.object({ name: z.string().default('base') })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    const constraints: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true},"name":"override"}'
    )
    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: true,
      strict: true,
      constraints,
    })
    expect((result.data as Record<string, unknown>)['name']).toBe('override')
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype)
    expect((result.data as Record<string, unknown>)['polluted']).toBeUndefined()
    const freshProbe: Record<string, unknown> = {}
    expect(freshProbe['polluted']).toBeUndefined()
  })
})
