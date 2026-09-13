// @vitest-environment jsdom
/**
 * The schema root has to be able to hold keys.
 *
 * A form IS a set of addressable fields: `register('email')`,
 * `form.errors('address.city')`, `form.values.total`. Three shapes can
 * hold keys, and a root that is none of them has nothing to address.
 *
 * This is the ONLY schema Attaform refuses, and the distinction matters
 * for the branch that deleted the construction-time kind audit. That
 * audit enumerated kinds someone had written down. This rejects on the
 * absence of the single property the form engine requires, and every
 * kind stays welcome UNDER a key — which is exactly what the second
 * half of this file asserts.
 *
 * v3 has rejected these roots since it shipped. v4 declared the same
 * rule in `SupportedRootSchema`'s docblock ("the adapter's runtime
 * construction rejects them with a legible error") but never enforced
 * it, so a JavaScript consumer, or a TypeScript one whose schema
 * reached `useForm` through a generic that erased the constraint, got a
 * mounted form whose entire value was `''`.
 */
import { describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import { zodAdapter as zodV3Adapter } from '../../src/runtime/adapters/zod-v3'

const buildV4 = (schema: unknown) =>
  zodV4Adapter(schema as Parameters<typeof zodV4Adapter>[0])('f', { maxRecursionDepth: 64 })
const buildV3 = (schema: unknown) =>
  zodV3Adapter(schema as Parameters<typeof zodV3Adapter>[0])('f', { maxRecursionDepth: 64 })

const REFUSED = [
  ['a primitive', () => zV4.string(), () => zV3.string()],
  ['a number', () => zV4.number(), () => zV3.number()],
  ['an array', () => zV4.array(zV4.string()), () => zV3.array(zV3.string())],
  ['a map', () => zV4.map(zV4.string(), zV4.number()), () => zV3.map(zV3.string(), zV3.number())],
  ['a set', () => zV4.set(zV4.string()), () => zV3.set(zV3.string())],
  ['a promise', () => zV4.promise(zV4.string()), () => zV3.promise(zV3.string())],
  ['a function', () => zV4.function(), () => zV3.function()],
  ['a symbol', () => zV4.symbol(), () => zV3.symbol()],
  [
    'a bare union',
    () => zV4.union([zV4.object({ a: zV4.string() }), zV4.object({ b: zV4.string() })]),
    () => zV3.union([zV3.object({ a: zV3.string() }), zV3.object({ b: zV3.string() })]),
  ],
] as const

describe('the schema root must be able to hold keys', () => {
  it.each(REFUSED)('v4 refuses %s at the root', (_label, makeV4) => {
    expect(() => buildV4(makeV4())).toThrow(/schema root must be/)
  })

  it.each(REFUSED)('v3 refuses %s at the root', (_label, _makeV4, makeV3) => {
    expect(() => buildV3(makeV3())).toThrow(/schema root must be/)
  })

  it('both majors name the offending kind in the message', () => {
    // A bare "wrong root" is not actionable; the developer needs to
    // know WHICH shape they handed over.
    expect(() => buildV4(zV4.string())).toThrow(/'string'/)
    expect(() => buildV3(zV3.string())).toThrow(/'ZodString'/)
  })

  it('refuses a non-keyed root hidden behind wrappers', () => {
    // `.optional()` / `.default()` / `.nullable()` are transparent, so
    // the gate peels before deciding. Otherwise the check is trivially
    // dodged by a wrapper that changes nothing structural.
    expect(() => buildV4(zV4.string().optional())).toThrow(/schema root must be/)
    expect(() => buildV4(zV4.array(zV4.string()).default([]))).toThrow(/schema root must be/)
    expect(() => buildV3(zV3.string().optional())).toThrow(/schema root must be/)
  })
})

describe('the three keyed roots are accepted', () => {
  // The counterweight. A gate that refuses too much is worse than the
  // gap it closed.
  it.each([
    ['object', () => zV4.object({ a: zV4.string() }), () => zV3.object({ a: zV3.string() })],
    [
      'record',
      () => zV4.record(zV4.string(), zV4.number()),
      () => zV3.record(zV3.string(), zV3.number()),
    ],
    [
      'discriminated union',
      () =>
        zV4.discriminatedUnion('kind', [
          zV4.object({ kind: zV4.literal('a'), x: zV4.string() }),
          zV4.object({ kind: zV4.literal('b'), y: zV4.number() }),
        ]),
      () =>
        zV3.discriminatedUnion('kind', [
          zV3.object({ kind: zV3.literal('a'), x: zV3.string() }),
          zV3.object({ kind: zV3.literal('b'), y: zV3.number() }),
        ]),
    ],
  ])('accepts a %s root on both majors', (_label, makeV4, makeV3) => {
    expect(() => buildV4(makeV4())).not.toThrow()
    expect(() => buildV3(makeV3())).not.toThrow()
  })

  it('accepts an object root behind transparent wrappers', () => {
    expect(() => buildV4(zV4.object({ a: zV4.string() }).optional())).not.toThrow()
    expect(() => buildV3(zV3.object({ a: zV3.string() }).optional())).not.toThrow()
  })
})

describe('every refused root is welcome one level down', () => {
  // The whole point. The root rule is about addressability, not about
  // which kinds Attaform is willing to carry — so each shape refused
  // above has to mount the moment it is given a name.
  it.each(REFUSED)('v4 accepts %s under a key', (_label, makeV4) => {
    expect(() => buildV4(zV4.object({ field: makeV4() }))).not.toThrow()
  })

  it.each(REFUSED)('v3 accepts %s under a key', (_label, _makeV4, makeV3) => {
    expect(() => buildV3(zV3.object({ field: makeV3() }))).not.toThrow()
  })
})
