import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'
import { fieldMeta } from '../../../src/runtime/adapters/zod-v3/field-meta'

/**
 * v3 field-meta parity for D13 / SF3: shared-instance per-path
 * disambiguation. One schema instance registered at several form paths
 * surfaces a DISTINCT payload at each. Both adapters walk the tree once,
 * counter-index per-schema visits against `getFieldMetaList(schema)` and
 * bind each visit to its own path; reading `getFieldMeta(target)` alone
 * is last-write-wins and gives every path the same payload.
 *
 * The v4 half is `field-meta-parity.test.ts` under
 * `test/adapters/zod-v4/`, and dual-green is the parity proof.
 */
describe('zod v3: shared-instance field-meta per-path disambiguation (D13 / SF3)', () => {
  it('a schema instance registered at two paths surfaces a distinct payload per path', () => {
    const addr = z.object({ street: z.string() })
    fieldMeta.add(addr, { label: 'Pickup' })
    fieldMeta.add(addr, { label: 'Delivery' })
    const schema = z.object({ pickup: addr, delivery: addr })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    const pickup = adapter.getFieldMetaAtPath?.(['pickup'])
    const delivery = adapter.getFieldMetaAtPath?.(['delivery'])

    // Declaration order matches walk order, so the first registration
    // binds to the first encountered path (`pickup`) and the second
    // binds to `delivery`. Without per-path disambiguation both paths
    // would resolve to whichever registration won the last-write race.
    expect(pickup?.label).toBe('Pickup')
    expect(delivery?.label).toBe('Delivery')
  })

  it('a single registration on a shared schema still resolves at both paths', () => {
    const addr = z.object({ street: z.string() })
    fieldMeta.add(addr, { label: 'Address' })
    const schema = z.object({ home: addr, work: addr })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    expect(adapter.getFieldMetaAtPath?.(['home']).label).toBe('Address')
    // Schemas reused MORE times than they're registered should share
    // the single registration (mirrors v4's `Math.min(idx, list.length-1)`
    // clamp). Without the clamp the second visit would fall back to
    // `humanize('work')` → 'Work'.
    expect(adapter.getFieldMetaAtPath?.(['work']).label).toBe('Address')
  })
})
