import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 mirror of v4's container-checks contract. The audit
 * called this out as D3: v3's former slim-schema pipeline
 * (`stripRefinements` + `getSlimSchema`) rebuilt `z.array` /
 * `z.object` / `z.set` / `z.tuple` containers without re-applying
 * `.min(n)` / `.max(n)` / `.length(n)` (the constructors don't accept
 * a checks arg, so a naïve `z.array(inner)` rebuild silently drops
 * them). The construction verdict then parsed the supplied defaults
 * against that de-checked slim schema and never surfaced a
 * "min(1) violated by []" verdict at construction.
 *
 * Both adapters now split the work: `getDefaultValues` derives the
 * starting value and parses nothing, and `validateSync` parses it
 * against the real schema, so no container check is dropped on the way.
 * Dual-green is the parity proof.
 */
describe('zod v3: validateSync surfaces container .min / .max / .length on defaults (D3)', () => {
  it('z.array(z.string()).min(1) with [] defaults seeds the min-violation error', () => {
    const schema = z.object({ items: z.array(z.string()).min(1) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const data = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: [] },
    })
    const errors = adapter.validateSync(data)

    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => (e.path[0] ?? '') === 'items')).toBe(true)
  })

  it('z.array(z.string()).max(2) with [a,b,c] defaults seeds the max-violation error', () => {
    const schema = z.object({ items: z.array(z.string()).max(2) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const data = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: ['a', 'b', 'c'] },
    })
    const errors = adapter.validateSync(data)

    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => (e.path[0] ?? '') === 'items')).toBe(true)
  })

  it('clean defaults against a checked container still return no errors', () => {
    const schema = z.object({ items: z.array(z.string()).min(1).max(3) })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const data = adapter.getDefaultValues({
      useDefaultSchemaValues: false,
      constraints: { items: ['only one'] },
    })
    const errors = adapter.validateSync(data)

    expect(errors).toEqual([])
  })
})
