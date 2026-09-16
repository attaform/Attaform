import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as ZodV3 from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'
import { wrapAsyncSafeRefinements } from '../../../src/runtime/adapters/zod-v3/strip-async'

// This static import IS subject to the `vi.mock` below, so the `ZodV3`
// VALUE resolves to v4 at runtime (used in the live-skew check). Its
// TYPE, which TypeScript resolves against the real zod-v3 types
// regardless of the runtime mock, gives `z` the correct v3 module shape
// while the v3 runtime value comes from `vi.importActual`.
type ZodV3Module = typeof ZodV3

/**
 * Version-skew guard for the zod-v3 adapter.
 *
 * The published bundle rewrites the adapter's `zod-v3` specifier to
 * `zod` (see `build.config.ts`), so at runtime it resolves to whichever
 * zod the consumer's dependency tree hoists. This mock forces that to a
 * MISMATCHED major (v4) while the schema under test is authored with
 * real v3 (pulled through `vi.importActual`). That is the exact shape of
 * the failure first seen in `apps/bench-arena`: a hoisted v4 beside the
 * v3 a schema was built with.
 *
 * Post-fix the adapter imports `zod-v3` for TYPES only and rebuilds
 * every slim / stripped node from the consumer's own node, so this mock
 * is inert and the assertions below hold. Reintroduce a value
 * `import { z } from 'zod-v3'` plus ambient `z.object()` construction and
 * the mock would poison every rebuild: the v3 slim walk would read an
 * empty accept set and reject every write, failing these same
 * assertions. That is the regression this guard exists to catch.
 */
vi.mock('zod-v3', async () => await vi.importActual('zod/v4'))

let z: ZodV3Module

beforeAll(async () => {
  z = (await vi.importActual('zod-v3')) as ZodV3Module
})

describe('zod-v3 adapter under version skew (hoisted zod v4 alongside v3)', () => {
  it('confirms the skew is live: a value import of zod-v3 resolves to v4', () => {
    // `ZodV3` is the static (mocked) import, so this is the v4 builder.
    const probe = ZodV3.object({ a: ZodV3.string() })
    const def = (probe as unknown as { _def: { type?: string; typeName?: string } })._def
    // v4 carries `_def.type`; v3 carries `_def.typeName`. Seeing v4's
    // shape here proves the adapter's correctness below is genuinely
    // skew-resistant, not an artifact of an inert mock.
    expect(def.typeName).toBeUndefined()
    expect(def.type).toBe('object')
  })

  it('accepts writes: the slim accept-set is non-empty and typed', () => {
    const schema = z.object({ name: z.string().min(2), age: z.number().int() })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    expect([...adapter.getSlimPrimitiveTypesAtPath(['name'])]).toEqual(['string'])
    expect([...adapter.getSlimPrimitiveTypesAtPath(['age'])]).toEqual(['number'])
  })

  it('seeds defaults from the slim shape', () => {
    const schema = z.object({ name: z.string(), agree: z.boolean(), count: z.number() })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    expect(adapter.getDefaultAtPath(['name'])).toBe('')
    expect(adapter.getDefaultAtPath(['agree'])).toBe(false)
    expect(adapter.getDefaultAtPath(['count'])).toBe(0)
  })

  it('still rejects a path absent from the schema', () => {
    const schema = z.object({ name: z.string() })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    expect(adapter.getSlimPrimitiveTypesAtPath(['nope']).size).toBe(0)
  })

  it('builds a discriminated union through the slim path', () => {
    const schema = z.object({
      payment: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), number: z.string() }),
        z.object({ kind: z.literal('cash'), amount: z.number() }),
      ]),
    })
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })

    // Exercises rebuildDiscriminatedUnion (the optionsMap reconstruction)
    // without an empty accept-set swallowing the branch leaf.
    expect(adapter.getSlimPrimitiveTypesAtPath(['payment', 'number']).size).toBeGreaterThan(0)
    expect(() =>
      adapter.getDefaultValues({ useDefaultSchemaValues: true, constraints: {} })
    ).not.toThrow()
  })

  it('rebuilds effects into a working v3 schema', () => {
    // Was the strip walker's case; the rejection-handler walk exercises
    // the same rebuild machinery under the same skew, and is what still
    // ships. The refinement survives the rebuild, so the seed is rejected.
    const schema = z.object({ name: z.string().refine((v) => v.length > 2, 'too short') })
    const rebuilt = wrapAsyncSafeRefinements(schema)

    expect(rebuilt.safeParse({ name: '' }).success).toBe(false)
    expect(rebuilt.safeParse({ name: 'abc' }).success).toBe(true)
  })
})
