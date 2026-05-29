import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'
import { fieldMeta } from '../../../src/runtime/adapters/zod-v4/field-meta'

/**
 * v4 mirror of `test/adapters/zod-v3/field-meta-parity.test.ts`. v4
 * already does per-path disambiguation via `walkForMeta` +
 * `getPathMetaMap` (`adapter.ts:773-799`); these tests pin the
 * reference so the v3 port lands as proven parity.
 */
describe('zod v4: shared-instance field-meta per-path disambiguation', () => {
  it('a schema instance registered at two paths surfaces a distinct payload per path', () => {
    const addr = z.object({ street: z.string() })
    fieldMeta.add(addr, { label: 'Pickup' })
    fieldMeta.add(addr, { label: 'Delivery' })
    const schema = z.object({ pickup: addr, delivery: addr })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    expect(adapter.getFieldMetaAtPath?.(['pickup']).label).toBe('Pickup')
    expect(adapter.getFieldMetaAtPath?.(['delivery']).label).toBe('Delivery')
  })

  it('a single registration on a shared schema still resolves at both paths', () => {
    const addr = z.object({ street: z.string() })
    fieldMeta.add(addr, { label: 'Address' })
    const schema = z.object({ home: addr, work: addr })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    expect(adapter.getFieldMetaAtPath?.(['home']).label).toBe('Address')
    expect(adapter.getFieldMetaAtPath?.(['work']).label).toBe('Address')
  })
})
