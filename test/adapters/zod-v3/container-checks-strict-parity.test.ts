import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 mirror of v4's container-checks strict-mode contract. The audit
 * called this out as D3: v3's slim-schema pipeline
 * (`stripRefinements` + `getSlimSchema`) rebuilds `z.array` /
 * `z.object` / `z.set` / `z.tuple` containers without re-applying
 * `.min(n)` / `.max(n)` / `.length(n)` (the constructors don't accept
 * a checks arg, so a naïve `z.array(inner)` rebuild silently drops
 * them). The strict-mode `getDefaultValues` then parses the supplied
 * defaults against this de-checked slim schema and never surfaces a
 * "min(1) violated by []" verdict at construction.
 *
 * v4 sidesteps the issue by parsing against the real schema (or
 * `stripAsyncChecks(real)` when async refines exist) and routing
 * rebuilds through `carryChecks` (`strip.ts:52-70`), so the container
 * check survives every walk path.
 *
 * Dual-green after the fix is the parity proof.
 */
describe('zod v3: strict getDefaultValues surfaces container .min / .max / .length on defaults (D3)', () => {
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
    // Lax mode is the global opt-out — a container check violation
    // never blocks construction. The container check still fires at
    // runtime via `validateAtPath`, just not at the mount-time seed.
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
