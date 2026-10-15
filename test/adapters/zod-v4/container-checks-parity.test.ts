import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/container-checks-parity.test.ts`.
 * v4's `validateSync` parses the derived defaults against the real schema
 * rather than a rebuild, so container `.min` / `.max` / `.length` are
 * never dropped in the first place. This file pins the reference the v3
 * port is measured against.
 */
describe('zod v4: validateSync surfaces container .min / .max / .length on defaults (D3 reference)', () => {
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
