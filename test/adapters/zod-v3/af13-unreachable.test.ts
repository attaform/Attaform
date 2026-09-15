import { z } from 'zod-v3'
import { describe, expect, it } from 'vitest'
import { V3_INTROSPECTOR } from '../../../src/runtime/adapters/zod-v3/walker-introspector'
import { deriveDefaultWalk } from '../../../src/runtime/core/walk-derive-default'
import { kindOf } from '../../../src/runtime/adapters/zod-v3/introspect'

/*
 * AF13 is the v3 adapter's backstop for a kind the blank-derivation
 * walker has no case for. No Zod v3 schema reaches it: every kind the
 * v3 introspector names has its own case, and a `typeName` it does not
 * recognize is read as `unknown`, which has a case of its own.
 *
 * `docs/e/af13.md` says exactly that, and tells a reader who sees the
 * code to file it as an Attaform bug rather than reshape a schema.
 * This is the test behind that page. If AF13 becomes reachable, the
 * page has to change with it, and so does the message, which still
 * carries advice from the era of refused kinds that `AF02` and `AF03`
 * were retired for.
 *
 * It runs the walk the adapter runs, against the same introspector,
 * with the fallback swapped for a recorder. The adapter's own
 * contribution to that hook is the AF13 `console.warn` and nothing
 * else, so a kind that never reaches the hook never reaches the code.
 */

/** Walk `schema` exactly as `getDefaultValuesFromZodSchema` does. */
function derive(schema: z.ZodTypeAny): { kindsHit: string[]; data: unknown } {
  const kindsHit: string[] = []
  const data = deriveDefaultWalk(schema, true, V3_INTROSPECTOR, 64, {
    unsupportedKindFallback: (_inner, kind) => {
      kindsHit.push(kind)
      return null
    },
  })
  return { kindsHit, data }
}

describe('AF13 stays a backstop', () => {
  it('no Zod v3 kind reaches the unsupported-kind fallback', () => {
    const shape: z.ZodRawShape = {
      promise: z.promise(z.string()),
      fn: z.function(),
      symbol: z.symbol(),
      map: z.map(z.string(), z.number()),
      set: z.set(z.string()),
      nan: z.nan(),
      voided: z.void(),
      never: z.never().optional(),
      any: z.any(),
      unknown: z.unknown(),
      bigint: z.bigint(),
      date: z.date(),
      nativeEnum: z.nativeEnum({ A: 'a' }),
      enumerated: z.enum(['a', 'b']),
      literal: z.literal('a'),
      lazy: z.lazy(() => z.object({ n: z.string() })),
      tuple: z.tuple([z.string()]),
      intersection: z.intersection(z.object({ x: z.string() }), z.object({ y: z.number() })),
      union: z.union([z.string(), z.number()]),
      branded: z.string().brand<'X'>(),
      caught: z.string().catch('x'),
      readonly: z.string().readonly(),
      preprocessed: z.preprocess((v) => v, z.string()),
      piped: z.string().pipe(z.string()),
      record: z.record(z.string(), z.number()),
      nested: z.object({ deep: z.array(z.boolean()) }),
      nullableLeaf: z.string().nullable(),
      defaulted: z.string().default('d'),
    }

    const { kindsHit, data } = derive(z.object(shape))
    expect(kindsHit).toEqual([])
    // The walk really ran: it derived a blank for the kinds that have
    // one, so an empty hit list is coverage rather than a no-op.
    expect(data).toMatchObject({ map: new Map(), set: new Set(), enumerated: 'a', defaulted: 'd' })
  })

  it('a kind from a future Zod release reads as `unknown`, which the walker handles', () => {
    // The shape a newer `zod@3` minor would present: a node whose
    // `typeName` this adapter has never heard of. It reads as
    // `unknown`, the same kind `z.unknown()` produces, and that kind
    // derives no blank and reaches no fallback. This is the branch
    // that leaves AF13 unreachable, and the one AF03 was retired in
    // favour of.
    expect(kindOf({ _def: { typeName: 'ZodFutureKind' } })).toBe('unknown')

    const { kindsHit, data } = derive(z.object({ opaque: z.unknown() }))
    expect(kindsHit).toEqual([])
    expect(data).toStrictEqual({ opaque: undefined })
  })
})
