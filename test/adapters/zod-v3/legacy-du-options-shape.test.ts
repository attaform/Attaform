/**
 * Discriminated-union support across zod v3's own history.
 *
 * Zod changed where a DU keeps its branches in 3.20.0: before that
 * release `_def.options` was a `Map` keyed by discriminator value and
 * there was no `_def.optionsMap`; from 3.20.0 on it is an array beside a
 * separate map. The adapter read it as an array through an `as` cast,
 * which compiles against either — so on an older zod the walk saw a Map,
 * found no entries, and every consumer `.default()` inside a DU branch
 * was silently dropped. `peerDependencies.zod` permitted those versions.
 *
 * The shape is reproduced here rather than installed. A second aliased
 * zod would pin one version and cost an install; rebuilding the def is
 * exact (it is the same object graph zod itself built, with the branches
 * moved into the container that release used) and pins the SHAPE, which
 * is the thing that varied. The repo's own install stays on a current
 * v3, where these same cases run through the array path in the parity
 * suites.
 *
 * Verified against real installs while writing: 3.12, 3.14, 3.17 and
 * 3.19 carry the Map, and 3.20 through 3.25 carry the array.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v3'

const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card'), cardNumber: z.string().default('4242') }),
  z.object({ kind: z.literal('bank'), iban: z.string().default('DE00') }),
])

const wrapped = z.object({ payment: schema })

/**
 * Rewrite a DU's def into the pre-3.20 container: the branches move into
 * a `Map` at `_def.options` and `_def.optionsMap` goes away, exactly as
 * that release had it.
 */
function asLegacyShape<T>(du: T): T {
  const def = (du as { _def: Record<string, unknown> })._def
  const options = def['options'] as readonly z.AnyZodObject[]
  const discriminator = def['discriminator'] as string
  const map = new Map<unknown, z.AnyZodObject>()
  for (const option of options) {
    const literal = option.shape[discriminator] as unknown as { _def: { value: unknown } }
    map.set(literal._def.value, option)
  }
  def['options'] = map
  delete def['optionsMap']
  return du
}

/** The slice of the adapter these cases read, named so no call site casts. */
type DefaultsProbe = {
  getDefaultValues(config: { useDefaultSchemaValues: boolean; strict: boolean }): {
    data: unknown
  }
  getSlimPrimitiveTypesAtPath(path: readonly (string | number)[]): ReadonlySet<string>
}

function probeFor(root: z.ZodTypeAny): DefaultsProbe {
  const build = zodAdapter as unknown as (
    s: z.ZodTypeAny
  ) => (key: string, options: { maxRecursionDepth: number }) => DefaultsProbe
  return build(root)('legacy', { maxRecursionDepth: 64 })
}

function defaultsOf(root: z.ZodTypeAny, strict: boolean): unknown {
  return probeFor(root).getDefaultValues({ useDefaultSchemaValues: true, strict }).data
}

describe('a discriminated union whose options are a Map (zod v3 before 3.20.0)', () => {
  it('still derives the first branch and its declared defaults', () => {
    const legacy = asLegacyShape(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), cardNumber: z.string().default('4242') }),
        z.object({ kind: z.literal('bank'), iban: z.string().default('DE00') }),
      ])
    )
    // The regression: the walk read the Map as an array, found nothing,
    // and returned a branch with no fields at all.
    expect(defaultsOf(z.object({ payment: legacy }), false)).toEqual({
      payment: { kind: 'card', cardNumber: '4242' },
    })
  })

  it('agrees with the array shape the current zod uses', () => {
    // The parity assertion is the point: the same schema must produce the
    // same defaults whichever container this zod happened to keep its
    // branches in.
    const modern = defaultsOf(wrapped, false)
    const legacy = defaultsOf(
      z.object({
        payment: asLegacyShape(
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('card'), cardNumber: z.string().default('4242') }),
            z.object({ kind: z.literal('bank'), iban: z.string().default('DE00') }),
          ])
        ),
      }),
      false
    )
    expect(legacy).toEqual(modern)
  })

  it('agrees in strict mode too, where the rebuilt union has to parse', () => {
    // A rebuild has to write the branches back into the container this
    // zod's own `_parse` reads. Handing an array to a zod that expects a
    // Map produces a union that matches nothing, so strict mode is where
    // that half of the fix is observable.
    const legacy = defaultsOf(
      z.object({
        payment: asLegacyShape(
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('card'), cardNumber: z.string().default('4242') }),
            z.object({ kind: z.literal('bank'), iban: z.string().default('DE00') }),
          ])
        ),
      }),
      true
    )
    expect(legacy).toEqual(defaultsOf(wrapped, true))
  })

  it('keeps the rebuilt union parseable', () => {
    const legacy = asLegacyShape(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), cardNumber: z.string().default('4242') }),
        z.object({ kind: z.literal('bank'), iban: z.string().default('DE00') }),
      ])
    )
    const probe = probeFor(z.object({ payment: legacy }))
    expect(probe.getSlimPrimitiveTypesAtPath(['payment', 'cardNumber']).has('string')).toBe(true)
  })
})
