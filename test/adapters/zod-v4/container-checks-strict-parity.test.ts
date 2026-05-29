import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/container-checks-strict-parity.test.ts`.
 * v4 routes strict-mode `getDefaultValues` through the real schema and
 * preserves container `.min` / `.max` / `.length` via `carryChecks`
 * (`strip.ts:52-70`); this file pins that reference so the v3 port
 * lands as proven parity.
 */
describe('zod v4: strict getDefaultValues surfaces container .min / .max / .length on defaults (D3 reference)', () => {
  it('z.array(z.string()).min(1) with [] defaults seeds the min-violation error', () => {
    const schema = z.object({ items: z.array(z.string()).min(1) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: [] },
      strict: true,
    })

    expect(result.success).toBe(false)
    expect(result.errors?.length ?? 0).toBeGreaterThan(0)
    expect(result.errors?.some((e) => (e.path[0] ?? '') === 'items')).toBe(true)
  })

  it('z.array(z.string()).max(2) with [a,b,c] defaults seeds the max-violation error', () => {
    const schema = z.object({ items: z.array(z.string()).max(2) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: ['a', 'b', 'c'] },
      strict: true,
    })

    expect(result.success).toBe(false)
    expect(result.errors?.length ?? 0).toBeGreaterThan(0)
    expect(result.errors?.some((e) => (e.path[0] ?? '') === 'items')).toBe(true)
  })

  it('clean defaults against a checked container still return success', () => {
    const schema = z.object({ items: z.array(z.string()).min(1).max(3) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: ['only one'] },
      strict: true,
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('strict: false bypasses container checks even when violated', () => {
    const schema = z.object({ items: z.array(z.string()).min(1) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const result = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: [] },
      strict: false,
    })

    expect(result.success).toBe(true)
    expect(result.errors).toBeUndefined()
  })
})
