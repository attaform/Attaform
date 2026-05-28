import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

/**
 * v3 constraint-merge parity tests for D19. The pre-fix v3 adapter
 * folded `config.constraints` into schema defaults via lodash `merge`
 * (element-wise array merge, silently skips `undefined`). v4 uses its
 * own `mergeDeep` semantics: arrays replace wholesale, explicit
 * `null` / `undefined` overrides honored. The audit's canonical repro:
 *
 *   schema: z.object({ tags: z.array(z.string()).default(['x', 'y']) })
 *   constraints: { tags: ['a'] }
 *   v4: { tags: ['a'] }            // array replaces wholesale
 *   v3 (pre-fix): { tags: ['a', 'y'] }  // lodash element-wise merge
 *
 * Mirror under `test/adapters/zod-v4/constraint-merge-parity.test.ts`;
 * dual-green after the fix is the parity proof.
 */
describe('zod v3: constraint-merge parity (D19)', () => {
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
    // v4 semantic: the consumer's array fully replaces the schema's.
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
    // v4 semantic: `null` is a leaf override and replaces the default.
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
    // Both sides are plain records → recurse; `name` overridden, `bio`
    // kept at the schema default.
    expect(result.data).toEqual({ profile: { name: 'Ozzy', bio: 'Hello' } })
  })
})
