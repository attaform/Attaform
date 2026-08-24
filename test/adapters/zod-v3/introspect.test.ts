import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import {
  assertZodVersion,
  containsAsyncRefine,
  containsAsyncTransform,
  containsDiscriminatedUnion,
  getArrayElement,
  getCatchDefault,
  getChecks,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
  getEffectsKind,
  getIntersectionLeft,
  getIntersectionRight,
  getLazyGetter,
  getLiteralValue,
  getNativeEnumValues,
  getObjectShape,
  getRecordKeyType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getTypeName,
  getUnionOptions,
  hasChecks,
  hasContainerOrRootRefine,
  isAsyncEffect,
  isContainerAfterWrapperPeel,
  kindOf,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipe,
  unwrapPipeIn,
  unwrapPipeOut,
} from '../../../src/runtime/adapters/zod-v3/introspect'

/*
 * Version-pin tests for the zod v3 internals layer. If zod v3 ever changes
 * its `_def.typeName` strings or accessor shapes, this file fails first
 * and localises the breakage to introspect.ts — every other adapter file
 * speaks kindOf() + the stable-shape accessors.
 */

describe('kindOf', () => {
  it('recognises scalar types', () => {
    expect(kindOf(z.string())).toBe('string')
    expect(kindOf(z.number())).toBe('number')
    expect(kindOf(z.boolean())).toBe('boolean')
    expect(kindOf(z.bigint())).toBe('bigint')
    expect(kindOf(z.date())).toBe('date')
    expect(kindOf(z.null())).toBe('null')
    expect(kindOf(z.undefined())).toBe('undefined')
    expect(kindOf(z.void())).toBe('void')
    expect(kindOf(z.never())).toBe('never')
    expect(kindOf(z.any())).toBe('any')
  })

  it('recognises composite types', () => {
    expect(kindOf(z.object({ a: z.string() }))).toBe('object')
    expect(kindOf(z.array(z.number()))).toBe('array')
    expect(kindOf(z.tuple([z.string(), z.number()]))).toBe('tuple')
    expect(kindOf(z.union([z.string(), z.number()]))).toBe('union')
    expect(kindOf(z.record(z.string(), z.number()))).toBe('record')
    expect(kindOf(z.set(z.string()))).toBe('set')
    expect(kindOf(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })))).toBe(
      'intersection'
    )
  })

  it('recognises wrapper types', () => {
    expect(kindOf(z.string().optional())).toBe('optional')
    expect(kindOf(z.string().nullable())).toBe('nullable')
    expect(kindOf(z.string().default('x'))).toBe('default')
    expect(kindOf(z.string().readonly())).toBe('readonly')
    expect(kindOf(z.string().catch('fallback'))).toBe('catch')
    expect(kindOf(z.string().brand('X'))).toBe('branded')
  })

  it('recognises v3-specific composites', () => {
    expect(kindOf(z.string().refine(() => true))).toBe('effects')
    expect(kindOf(z.string().pipe(z.string()))).toBe('pipeline')
    expect(kindOf(z.lazy(() => z.string()))).toBe('lazy')
  })

  it('recognises literal and enums', () => {
    expect(kindOf(z.literal('x'))).toBe('literal')
    expect(kindOf(z.enum(['a', 'b']))).toBe('enum')
    enum NumericEnum {
      A,
      B,
    }
    expect(kindOf(z.nativeEnum(NumericEnum))).toBe('native-enum')
  })

  it('returns "unknown" for non-zod values', () => {
    expect(kindOf({})).toBe('unknown')
    expect(kindOf(null)).toBe('unknown')
    expect(kindOf('not a schema')).toBe('unknown')
  })
})

describe('container accessors', () => {
  it('getObjectShape returns the shape map (via thunk)', () => {
    const shape = getObjectShape(z.object({ a: z.string(), b: z.number() }))
    expect(Object.keys(shape)).toEqual(['a', 'b'])
    expect(kindOf(shape['a'])).toBe('string')
    expect(kindOf(shape['b'])).toBe('number')
  })

  it('getArrayElement reads from _def.type (v3 quirk)', () => {
    const element = getArrayElement(z.array(z.string()))
    expect(kindOf(element)).toBe('string')
  })

  it('getSetValueType returns the element schema', () => {
    expect(kindOf(getSetValueType(z.set(z.number())))).toBe('number')
  })

  it('getRecordKeyType / getRecordValueType return the key / value schemas', () => {
    const record = z.record(z.string(), z.number())
    expect(kindOf(getRecordKeyType(record))).toBe('string')
    expect(kindOf(getRecordValueType(record))).toBe('number')
  })

  it('getTupleItems returns items in order', () => {
    const items = getTupleItems(z.tuple([z.string(), z.number(), z.boolean()]))
    expect(items).toHaveLength(3)
    expect(kindOf(items[0])).toBe('string')
    expect(kindOf(items[1])).toBe('number')
    expect(kindOf(items[2])).toBe('boolean')
  })

  it('getUnionOptions returns the branches', () => {
    const options = getUnionOptions(z.union([z.string(), z.number()]))
    expect(options).toHaveLength(2)
  })

  it('getDiscriminator + getDiscriminatedOptions return the DU shape', () => {
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), value: z.string() }),
      z.object({ kind: z.literal('b'), value: z.number() }),
    ])
    expect(getDiscriminator(du)).toBe('kind')
    expect(getDiscriminatedOptions(du)).toHaveLength(2)
  })

  it('getIntersectionLeft / getIntersectionRight return the two sides', () => {
    const inter = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))
    expect(kindOf(getIntersectionLeft(inter))).toBe('object')
    expect(kindOf(getIntersectionRight(inter))).toBe('object')
  })
})

describe('wrapper unwrap', () => {
  it('unwrapInner peels Optional / Nullable / Default / Catch / Readonly', () => {
    expect(kindOf(unwrapInner(z.string().optional()))).toBe('string')
    expect(kindOf(unwrapInner(z.string().nullable()))).toBe('string')
    expect(kindOf(unwrapInner(z.string().default('x')))).toBe('string')
    expect(kindOf(unwrapInner(z.string().catch('x')))).toBe('string')
    expect(kindOf(unwrapInner(z.string().readonly()))).toBe('string')
  })

  it('unwrapBranded reads from _def.type (v3 quirk)', () => {
    expect(kindOf(unwrapBranded(z.string().brand('X')))).toBe('string')
  })

  it('unwrapEffectsSource reads ZodEffects structural source', () => {
    const refined = z.string().refine(() => true)
    expect(kindOf(unwrapEffectsSource(refined))).toBe('string')
  })

  it('getEffectsKind reports the effect type', () => {
    expect(getEffectsKind(z.string().refine(() => true))).toBe('refinement')
    expect(getEffectsKind(z.string().transform((v) => v))).toBe('transform')
    expect(getEffectsKind(z.preprocess((v) => v, z.string()))).toBe('preprocess')
    expect(getEffectsKind(z.string())).toBeUndefined()
  })

  it('unwrapPipe / unwrapPipeIn / unwrapPipeOut walk pipeline sides', () => {
    const piped = z.string().pipe(z.number())
    expect(kindOf(unwrapPipeIn(piped))).toBe('string')
    expect(kindOf(unwrapPipeOut(piped))).toBe('number')
    expect(kindOf(unwrapPipe(piped))).toBe('string')
  })

  it('unwrapLazy / getLazyGetter resolve the inner schema and getter', () => {
    const inner = z.string()
    const getter = () => inner
    const lazy = z.lazy(getter)
    expect(kindOf(unwrapLazy(lazy))).toBe('string')
    expect(getLazyGetter(lazy)).toBe(getter)
  })

  it('unwrapLazy returns undefined when the getter throws', () => {
    const lazy = z.lazy(() => {
      throw new Error('boom')
    })
    expect(unwrapLazy(lazy)).toBeUndefined()
  })
})

describe('value carriers', () => {
  it('getLiteralValue returns the literal payload', () => {
    expect(getLiteralValue(z.literal('x'))).toBe('x')
    expect(getLiteralValue(z.literal(42))).toBe(42)
  })

  it('getNativeEnumValues returns the enum object', () => {
    enum NumericEnum {
      A,
      B,
    }
    const values = getNativeEnumValues(z.nativeEnum(NumericEnum))
    expect(values?.['A']).toBe(0)
    expect(values?.['B']).toBe(1)
  })

  it('getDefaultValue invokes the v3 thunk', () => {
    expect(getDefaultValue(z.string().default('hi'))).toBe('hi')
    expect(getDefaultValue(z.number().default(42))).toBe(42)
  })

  it('getCatchDefault returns the catch fallback', () => {
    expect(getCatchDefault(z.string().catch('fallback'))).toBe('fallback')
  })

  it('getCatchDefault returns undefined when the fn throws', () => {
    const catched = z.string().catch(() => {
      throw new Error('boom')
    })
    expect(getCatchDefault(catched)).toBeUndefined()
  })
})

describe('refinement payload', () => {
  it('hasChecks + getChecks return refinement state on strings/numbers', () => {
    expect(hasChecks(z.string())).toBe(false)
    expect(hasChecks(z.string().min(3))).toBe(true)
    expect(getChecks(z.string().min(3))).toHaveLength(1)
    expect(getChecks(z.string())).toHaveLength(0)
  })
})

describe('hasContainerOrRootRefine', () => {
  it('returns false for a flat schema with only leaf refines', () => {
    const schema = z.object({
      name: z.string().refine((v) => v.length > 0, 'name-invalid'),
      age: z.number().refine((v) => v >= 0, 'age-invalid'),
    })
    expect(hasContainerOrRootRefine(schema)).toBe(false)
  })

  it('returns true when the root carries a refine', () => {
    const schema = z
      .object({ name: z.string(), other: z.string() })
      .refine(() => true, 'root-invariant')
    expect(hasContainerOrRootRefine(schema)).toBe(true)
  })

  it('returns true when a nested container carries a refine', () => {
    const schema = z.object({
      profile: z.object({ first: z.string() }).refine(() => true, 'profile-invariant'),
    })
    expect(hasContainerOrRootRefine(schema)).toBe(true)
  })

  it('isContainerAfterWrapperPeel sees through Optional/Nullable/Default to a container', () => {
    expect(isContainerAfterWrapperPeel(z.object({}).optional())).toBe(true)
    expect(isContainerAfterWrapperPeel(z.array(z.string()).nullable())).toBe(true)
    expect(isContainerAfterWrapperPeel(z.string().optional())).toBe(false)
  })
})

describe('isAsyncEffect', () => {
  it('flags an async transform / preprocess; sync siblings clear', () => {
    const asyncTransform = z.string().transform(async (v) => Promise.resolve(`${v}!`))
    const asyncPreprocess = z.preprocess(async (v) => Promise.resolve(v), z.string())
    const syncTransform = z.string().transform((v) => `${v}!`)
    expect(isAsyncEffect(asyncTransform)).toBe(true)
    expect(isAsyncEffect(asyncPreprocess)).toBe(true)
    expect(isAsyncEffect(syncTransform)).toBe(false)
  })

  it('returns false for refinement effects regardless of the user fn (v3 wraps refines sync)', () => {
    // v3's `.refine` stores a sync wrapper at `_def.effect.refinement`
    // that closes over the user predicate. The user fn's async-ness is
    // not statically observable; `isAsyncEffect` returns `false` for
    // refinement effects unconditionally. `containsAsyncRefine` is the
    // conservative full-tree probe (true for any refine).
    expect(isAsyncEffect(z.string().refine(async () => Promise.resolve(true), 'x'))).toBe(false)
    expect(isAsyncEffect(z.string().refine(() => true, 'x'))).toBe(false)
  })

  it('returns false for non-ZodEffects schemas', () => {
    expect(isAsyncEffect(z.string())).toBe(false)
    expect(isAsyncEffect(z.object({ x: z.string() }))).toBe(false)
  })
})

describe('containsDiscriminatedUnion', () => {
  it('false for a plain object schema', () => {
    expect(containsDiscriminatedUnion(z.object({ a: z.string(), b: z.number() }))).toBe(false)
  })

  it('true for a top-level discriminated union', () => {
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ])
    expect(containsDiscriminatedUnion(du)).toBe(true)
  })

  it('true for a union nested under an object key', () => {
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ])
    expect(containsDiscriminatedUnion(z.object({ notify: du }))).toBe(true)
  })

  it('true for a union inside an array element (never-populated arrays still count)', () => {
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ])
    expect(containsDiscriminatedUnion(z.object({ items: z.array(du) }))).toBe(true)
  })

  it('false for a plain (non-discriminated) union', () => {
    expect(containsDiscriminatedUnion(z.object({ v: z.union([z.string(), z.number()]) }))).toBe(
      false
    )
  })
})

describe('containsAsyncRefine', () => {
  it('flags any leaf refine at the root — sync or async (v3 conservative)', () => {
    // v3 cannot statically distinguish sync from async refines; both
    // are treated as "potentially async" so the runtime never misses
    // the post-mount async pass.
    expect(containsAsyncRefine(z.string().refine(async () => Promise.resolve(true)))).toBe(true)
    expect(containsAsyncRefine(z.string().refine(() => true))).toBe(true)
  })

  it('flags a refine nested under containers and wrappers', () => {
    const nested = z.object({
      profile: z
        .object({
          tags: z.array(
            z
              .string()
              .refine(() => true)
              .optional()
          ),
        })
        .nullable(),
    })
    expect(containsAsyncRefine(nested)).toBe(true)
  })

  it('returns false for schemas without any ZodEffects refinements', () => {
    expect(containsAsyncRefine(z.string())).toBe(false)
    expect(containsAsyncRefine(z.object({ name: z.string(), age: z.number() }))).toBe(false)
    // A bare transform (no refinement effects) doesn't trip the flag.
    expect(
      containsAsyncRefine(z.object({ x: z.string().transform(async (v) => Promise.resolve(v)) }))
    ).toBe(false)
  })

  it('flags through ZodPipeline and ZodBranded wrappers', () => {
    const pipeline = z.string().pipe(z.string().refine(() => true))
    const branded = z
      .string()
      .refine(() => true)
      .brand<'Tag'>()
    expect(containsAsyncRefine(pipeline)).toBe(true)
    expect(containsAsyncRefine(branded)).toBe(true)
  })
})

describe('containsAsyncTransform', () => {
  it('flags an async transform / preprocess at the root', () => {
    expect(containsAsyncTransform(z.string().transform(async (v) => Promise.resolve(v)))).toBe(true)
    expect(containsAsyncTransform(z.preprocess(async (v) => Promise.resolve(v), z.string()))).toBe(
      true
    )
  })

  it('does not flag sync transforms / preprocess', () => {
    expect(containsAsyncTransform(z.string().transform((v) => v))).toBe(false)
    expect(containsAsyncTransform(z.preprocess((v) => v, z.string()))).toBe(false)
  })

  it('does not flag refinements (sync or async) — those are the refine walker’s domain', () => {
    expect(containsAsyncTransform(z.string().refine(async () => Promise.resolve(true)))).toBe(false)
    expect(containsAsyncTransform(z.string().refine(() => true))).toBe(false)
  })

  it('flags an async transform nested under union options', () => {
    const schema = z.object({
      payload: z.union([z.string(), z.string().transform(async (v) => Promise.resolve(`${v}!`))]),
    })
    expect(containsAsyncTransform(schema)).toBe(true)
  })
})

describe('assertZodVersion', () => {
  it('accepts a genuine zod v3 schema', () => {
    expect(() => assertZodVersion(z.string())).not.toThrow()
  })

  it('rejects a non-zod value with a helpful message', () => {
    expect(() => assertZodVersion({})).toThrow(/zod v3/i)
  })

  it('rejects a v4-like def shape', () => {
    // Simulates accidentally passing a zod-v4 schema into the v3 adapter.
    // v4 schemas expose `def.type`, not `_def.typeName`.
    const v4Like = { def: { type: 'string' } }
    expect(() => assertZodVersion(v4Like)).toThrow(/zod v3/i)
  })
})

describe('getTypeName', () => {
  it('exposes the raw v3 typeName discriminant', () => {
    expect(getTypeName(z.string())).toBe('ZodString')
    expect(getTypeName(z.object({}))).toBe('ZodObject')
    expect(getTypeName({})).toBeUndefined()
    expect(getTypeName(null)).toBeUndefined()
  })
})
