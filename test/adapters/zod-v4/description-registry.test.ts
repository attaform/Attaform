import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import * as zm from 'zod/mini'
// The Zod 4 build that ships inside zod 3.25 keeps its global registry
// private to the module, as every 4.x before 4.1.13 does.
import * as zOld from 'zod-v3/v4'
import * as zmOld from 'zod-v3/v4-mini'
import { zodV4Adapter } from '../../../src/runtime/adapters/zod-v4/adapter'
import type { SupportedRootSchema } from '../../../src/runtime/adapters/zod-v4/types-root'

/**
 * #703: a field's schema description, read through the adapter. Every
 * Zod 4 way of setting one writes to Zod's global registry, which a mini
 * schema has no `.description` getter over, so the adapter reads the
 * registry itself and falls back to classic's getter where the registry
 * is out of reach.
 */
function descriptionAt(schema: SupportedRootSchema, key: string): string | undefined {
  const adapter = zodV4Adapter(schema)('description-registry', { maxRecursionDepth: 64 })
  return adapter.getFieldMetaAtPath?.([key]).description
}

describe('#703: schema descriptions', () => {
  it('reads a mini description set by describe() or meta()', () => {
    const schema = zm.object({
      described: zm.string().check(zm.describe('Your name')),
      meta: zm.string().check(zm.meta({ description: 'Your city' })),
      wrapped: zm.optional(zm.string().check(zm.describe('Your nickname'))),
      plain: zm.string(),
    })
    expect(descriptionAt(schema, 'described')).toBe('Your name')
    expect(descriptionAt(schema, 'meta')).toBe('Your city')
    expect(descriptionAt(schema, 'wrapped')).toBe('Your nickname')
    expect(descriptionAt(schema, 'plain')).toBeUndefined()
  })

  it('reads a mini description registered on the global registry', () => {
    const schema = zm.object({
      name: zm.string().register(zm.globalRegistry, { description: 'Your name' }),
    })
    expect(descriptionAt(schema, 'name')).toBe('Your name')
  })

  it('reads a classic description as before', () => {
    const schema = z.object({
      described: z.string().describe('Your name'),
      meta: z.string().meta({ description: 'Your city' }),
      wrapped: z.string().describe('Your nickname').optional(),
    })
    expect(descriptionAt(schema, 'described')).toBe('Your name')
    expect(descriptionAt(schema, 'meta')).toBe('Your city')
    expect(descriptionAt(schema, 'wrapped')).toBe('Your nickname')
  })

  it('falls back to classic .description where the registry is module-private', () => {
    const classic = zOld.object({ name: zOld.string().describe('Your name') })
    expect(descriptionAt(classic, 'name')).toBe('Your name')

    // Mini has no getter to fall back to, so an older 4.x description
    // stays out of reach.
    const mini = zmOld.object({
      name: zmOld.string().register(zmOld.globalRegistry, { description: 'Your name' }),
    })
    expect(descriptionAt(mini, 'name')).toBeUndefined()
  })
})
