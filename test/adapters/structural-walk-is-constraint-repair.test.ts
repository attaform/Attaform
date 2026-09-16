/**
 * The structural-fix walk repairs what CONSTRAINTS broke, and nothing
 * else. That is the invariant a fast path now rests on, so it is
 * checked here rather than assumed.
 *
 * `getDefaultValues` derives a tree from the schema, merges the
 * consumer's `defaultValues` over it, then runs `fixStructuralDefaults`
 * to repair mismatches the merge introduced: a constraint supplying a
 * primitive where the schema declares an object, a discriminated-union
 * value carrying keys from a variant it is not. Both adapters now skip
 * that walk when there are no constraints, which is 20 to 24 percent of
 * `getDefaultValues` on a wide form, in the common case, since most
 * forms pass no `defaultValues` at all.
 *
 * The skip is correct only while the derivation alone produces a tree
 * the walk would not touch, and nothing enforces that. A future change
 * to `deriveDefault` that emitted, say, a foreign-variant key at a DU
 * would make the fast path silently ship the unrepaired tree, with no
 * error anywhere.
 *
 * So the property is written as a FIXED POINT, through the public
 * surface: deriving with no constraints must equal deriving with that
 * same derivation handed back AS the constraints. The second call has
 * constraints, so it takes the walking path; the first does not. If the
 * walk would have changed the derivation, the two disagree.
 *
 * When this fails, the fast path is the thing to remove. The walk is
 * not the thing to change.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodAdapter as zodV4Adapter } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodV3Adapter } from '../../src/runtime/adapters/zod-v3'

type Defaults = {
  getDefaultValues(config: { useDefaultSchemaValues: boolean; constraints?: unknown }): {
    data: unknown
  }
}

function probe(build: (s: never) => unknown, schema: unknown): Defaults {
  const factory = build(schema as never) as (
    k: string,
    o: { maxRecursionDepth: number }
  ) => Defaults
  return factory('walk-probe', { maxRecursionDepth: 64 })
}

/**
 * Structural equality that survives the values a form can hold: Map,
 * Set, Date, BigInt. The walk is free to REPLACE a container with an
 * equal one, and that is a change this test must not care about, so
 * comparison is by value throughout.
 */
function snapshot(v: unknown): unknown {
  if (typeof v === 'bigint') return `bigint:${v}`
  if (v instanceof Date) return `date:${v.getTime()}`
  if (v instanceof Map) {
    return { __map: [...v.entries()].map(([k, val]) => [snapshot(k), snapshot(val)]) }
  }
  if (v instanceof Set) return { __set: [...v].map(snapshot) }
  if (Array.isArray(v)) return v.map(snapshot)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = snapshot((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/**
 * The shapes the walk exists to repair, plus the ones most likely to
 * drift: unions and DUs (variant keys), containers behind optional and
 * nullable wrappers (structural fill), keyed collections (record, map,
 * set), fixed-arity tuples, and chained wrappers around defaults.
 */
const V4_CASES: [string, unknown][] = [
  ['flat object', z.object({ a: z.string(), n: z.number(), b: z.boolean() })],
  [
    'nested objects',
    z.object({ user: z.object({ name: z.string(), deep: z.object({ x: z.string() }) }) }),
  ],
  ['optional container', z.object({ profile: z.object({ city: z.string() }).optional() })],
  ['nullable container', z.object({ profile: z.object({ city: z.string() }).nullable() })],
  ['array of objects', z.object({ rows: z.array(z.object({ label: z.string() })) })],
  ['tuple', z.object({ pair: z.tuple([z.string(), z.number()]) })],
  ['record', z.object({ prefs: z.record(z.string(), z.string()) })],
  ['record of objects', z.object({ prefs: z.record(z.string(), z.object({ at: z.string() })) })],
  ['map', z.object({ m: z.map(z.string(), z.number()) })],
  ['set', z.object({ s: z.set(z.string()) })],
  [
    'discriminated union',
    z.object({
      payment: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), cardNumber: z.string() }),
        z.object({ kind: z.literal('bank'), iban: z.string() }),
      ]),
    }),
  ],
  [
    'discriminated union with defaults on both arms',
    z.object({
      payment: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), cardNumber: z.string().default('4242') }),
        z.object({ kind: z.literal('bank'), iban: z.string().default('DE00') }),
      ]),
    }),
  ],
  ['plain union', z.object({ v: z.union([z.string(), z.number()]) })],
  [
    'union of objects',
    z.object({ v: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) }),
  ],
  ['defaults everywhere', z.object({ a: z.string().default('x'), n: z.number().default(3) })],
  ['optional wrapping a default', z.object({ a: z.string().default('x').optional() })],
  ['catch', z.object({ a: z.string().catch('fallback') })],
  ['readonly', z.object({ a: z.string().readonly() })],
  [
    'intersection',
    z.object({ v: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })) }),
  ],
  [
    'deep nesting under an array',
    z.object({ rows: z.array(z.object({ inner: z.object({ q: z.number() }) })) }),
  ],
]

const V3_CASES: [string, unknown][] = [
  ['flat object', zV3.object({ a: zV3.string(), n: zV3.number(), b: zV3.boolean() })],
  ['nested objects', zV3.object({ user: zV3.object({ name: zV3.string() }) })],
  ['optional container', zV3.object({ profile: zV3.object({ city: zV3.string() }).optional() })],
  ['nullable container', zV3.object({ profile: zV3.object({ city: zV3.string() }).nullable() })],
  ['array of objects', zV3.object({ rows: zV3.array(zV3.object({ label: zV3.string() })) })],
  ['tuple', zV3.object({ pair: zV3.tuple([zV3.string(), zV3.number()]) })],
  ['record', zV3.object({ prefs: zV3.record(zV3.string(), zV3.string()) })],
  [
    'record of objects',
    zV3.object({ prefs: zV3.record(zV3.string(), zV3.object({ at: zV3.string() })) }),
  ],
  ['map', zV3.object({ m: zV3.map(zV3.string(), zV3.number()) })],
  ['set', zV3.object({ s: zV3.set(zV3.string()) })],
  [
    'discriminated union',
    zV3.object({
      payment: zV3.discriminatedUnion('kind', [
        zV3.object({ kind: zV3.literal('card'), cardNumber: zV3.string() }),
        zV3.object({ kind: zV3.literal('bank'), iban: zV3.string() }),
      ]),
    }),
  ],
  ['plain union', zV3.object({ v: zV3.union([zV3.string(), zV3.number()]) })],
  ['defaults everywhere', zV3.object({ a: zV3.string().default('x'), n: zV3.number().default(3) })],
  ['optional wrapping a default', zV3.object({ a: zV3.string().default('x').optional() })],
  ['catch', zV3.object({ a: zV3.string().catch('fallback') })],
  [
    'intersection',
    zV3.object({
      v: zV3.intersection(zV3.object({ a: zV3.string() }), zV3.object({ b: zV3.number() })),
    }),
  ],
]

const ADAPTERS = [
  { name: 'v4', build: zodV4Adapter as unknown as (s: never) => unknown, cases: V4_CASES },
  { name: 'v3', build: zodV3Adapter as unknown as (s: never) => unknown, cases: V3_CASES },
] as const

describe.each(ADAPTERS)(
  '$name: deriving is already a fixed point of the walk',
  ({ build, cases }) => {
    describe.each([true, false])('useDefaultSchemaValues=%s', (useDefaultSchemaValues) => {
      it.each(cases)('%s', (_label, schema) => {
        const derived = probe(build, schema).getDefaultValues({
          useDefaultSchemaValues,
        }).data
        // Handing the derivation back as constraints takes the walking
        // path. Equal results mean the walk had nothing to repair.
        const rewalked = probe(build, schema).getDefaultValues({
          useDefaultSchemaValues,
          constraints: derived,
        }).data
        expect(snapshot(rewalked)).toEqual(snapshot(derived))
      })
    })
  }
)

describe.each(ADAPTERS)(
  '$name: the walk still repairs what constraints break',
  ({ name, build }) => {
    // Without these the suite above could pass because the walk does
    // nothing at all, which would make the fast path right for the wrong
    // reason and hide a regression in the repair itself.
    it('rebuilds a container a constraint replaced with a primitive', () => {
      const schema =
        name === 'v4'
          ? z.object({ profile: z.object({ city: z.string(), zip: z.string() }) })
          : zV3.object({ profile: zV3.object({ city: zV3.string(), zip: zV3.string() }) })
      const walked = probe(build, schema).getDefaultValues({
        useDefaultSchemaValues: true,
        constraints: { profile: 'not-an-object' },
      }).data
      expect(walked).toEqual({ profile: { city: '', zip: '' } })
    })

    it('drops foreign-variant keys at a discriminated union', () => {
      const schema =
        name === 'v4'
          ? z.object({
              payment: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('card'), cardNumber: z.string() }),
                z.object({ kind: z.literal('bank'), iban: z.string() }),
              ]),
            })
          : zV3.object({
              payment: zV3.discriminatedUnion('kind', [
                zV3.object({ kind: zV3.literal('card'), cardNumber: zV3.string() }),
                zV3.object({ kind: zV3.literal('bank'), iban: zV3.string() }),
              ]),
            })
      const walked = probe(build, schema).getDefaultValues({
        useDefaultSchemaValues: true,
        constraints: { payment: { kind: 'bank', iban: 'DE00', cardNumber: '4242' } },
      }).data
      expect(walked).toEqual({ payment: { kind: 'bank', iban: 'DE00' } })
    })
  }
)
