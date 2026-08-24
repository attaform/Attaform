import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  assertZodVersion,
  containsAsyncRefine,
  containsAsyncTransform,
  containsDiscriminatedUnion,
  getArrayElement,
  getChecks,
  getDefaultValue,
  getEnumValues,
  getLiteralValues,
  getObjectShape,
  getTupleItems,
  getUnionOptions,
  hasChecks,
  hasContainerOrRootRefine,
  isAsyncCheck,
  kindOf,
  unwrapInner,
} from '../../../src/runtime/adapters/zod-v4/introspect'

/*
 * Version-pin tests for the zod v4 internals layer. If zod v4 ever changes
 * its `def.type` strings or accessor shapes, this file fails first and
 * localizes the breakage to introspect.ts — every other adapter file
 * speaks kindOf() + the stable-shape accessors.
 */

describe('kindOf', () => {
  it('recognises scalar types', () => {
    expect(kindOf(z.string())).toBe('string')
    expect(kindOf(z.number())).toBe('number')
    expect(kindOf(z.boolean())).toBe('boolean')
    expect(kindOf(z.null())).toBe('null')
    expect(kindOf(z.undefined())).toBe('undefined')
  })

  it('recognises composite types', () => {
    expect(kindOf(z.object({ a: z.string() }))).toBe('object')
    expect(kindOf(z.array(z.number()))).toBe('array')
    expect(kindOf(z.tuple([z.string(), z.number()]))).toBe('tuple')
    expect(kindOf(z.union([z.string(), z.number()]))).toBe('union')
  })

  it('recognises wrapper types', () => {
    expect(kindOf(z.string().optional())).toBe('optional')
    expect(kindOf(z.string().nullable())).toBe('nullable')
    expect(kindOf(z.string().default('x'))).toBe('default')
  })

  it('recognises literal and enum', () => {
    expect(kindOf(z.literal('x'))).toBe('literal')
    expect(kindOf(z.enum(['a', 'b']))).toBe('enum')
  })

  it('returns "unknown" for non-zod values', () => {
    expect(kindOf({})).toBe('unknown')
    expect(kindOf(null)).toBe('unknown')
    expect(kindOf('not a schema')).toBe('unknown')
  })
})

describe('accessors', () => {
  it('getObjectShape returns shape map', () => {
    const shape = getObjectShape(z.object({ a: z.string(), b: z.number() }))
    expect(Object.keys(shape)).toEqual(['a', 'b'])
  })

  it('getArrayElement returns the element schema', () => {
    const element = getArrayElement(z.array(z.string()))
    expect(kindOf(element)).toBe('string')
  })

  it('getTupleItems returns the item schemas in order', () => {
    const items = getTupleItems(z.tuple([z.string(), z.number()]))
    expect(items).toHaveLength(2)
    expect(kindOf(items[0])).toBe('string')
    expect(kindOf(items[1])).toBe('number')
  })

  it('getUnionOptions returns the branches', () => {
    const options = getUnionOptions(z.union([z.string(), z.number()]))
    expect(options).toHaveLength(2)
  })

  it('getLiteralValues returns the value array', () => {
    expect(getLiteralValues(z.literal('x'))).toEqual(['x'])
  })

  it('getEnumValues returns the entry values', () => {
    expect(getEnumValues(z.enum(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('unwrapInner peels one layer of optional / nullable / default', () => {
    expect(kindOf(unwrapInner(z.string().optional()))).toBe('string')
    expect(kindOf(unwrapInner(z.string().nullable()))).toBe('string')
    expect(kindOf(unwrapInner(z.string().default('x')))).toBe('string')
  })

  it('getDefaultValue returns the configured default', () => {
    expect(getDefaultValue(z.string().default('hi'))).toBe('hi')
    expect(getDefaultValue(z.number().default(42))).toBe(42)
  })
})

describe('checks payload', () => {
  it('hasChecks / getChecks reflect the schema refinement list', () => {
    expect(hasChecks(z.string())).toBe(false)
    expect(hasChecks(z.string().min(3))).toBe(true)
    expect(getChecks(z.string().min(3))).toHaveLength(1)
    expect(getChecks(z.string())).toHaveLength(0)
  })
})

describe('isAsyncCheck', () => {
  it('flags an async refine check and clears a sync one', () => {
    // v4 stores refines in `def.checks[].def.fn`; isAsyncCheck reads
    // the fn's `constructor.name` exactly like the v3 introspect's
    // ZodEffects walker.
    const asyncChecks = getChecks(z.string().refine(async () => Promise.resolve(true)))
    const syncChecks = getChecks(z.string().refine(() => true))
    expect(asyncChecks).toHaveLength(1)
    expect(syncChecks).toHaveLength(1)
    expect(isAsyncCheck(asyncChecks[0])).toBe(true)
    expect(isAsyncCheck(syncChecks[0])).toBe(false)
  })

  it('returns false for non-check inputs', () => {
    expect(isAsyncCheck(null)).toBe(false)
    expect(isAsyncCheck({})).toBe(false)
    expect(isAsyncCheck({ _def: { fn: 'not a function' } })).toBe(false)
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

  it('returns true for a refine through optional/nullable to a container', () => {
    const schema = z.object({
      payment: z
        .object({ card: z.string() })
        .refine(() => true, 'card-invariant')
        .optional(),
    })
    expect(hasContainerOrRootRefine(schema)).toBe(true)
  })

  it('returns true for a refine on a union / discriminated-union container', () => {
    const u = z.union([z.string(), z.number()]).refine(() => true, 'either')
    const du = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), v: z.string() }),
        z.object({ kind: z.literal('b'), v: z.number() }),
      ])
      .refine(() => true, 'cross-cut')
    expect(hasContainerOrRootRefine(u)).toBe(true)
    expect(hasContainerOrRootRefine(du)).toBe(true)
  })

  it('returns true for a refine on intersection / record / set', () => {
    const intersect = z
      .intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))
      .refine(() => true)
    const rec = z.record(z.string(), z.number()).refine(() => true)
    const set = z.set(z.string()).refine(() => true)
    expect(hasContainerOrRootRefine(intersect)).toBe(true)
    expect(hasContainerOrRootRefine(rec)).toBe(true)
    expect(hasContainerOrRootRefine(set)).toBe(true)
  })

  it('returns true for a refine on an array container', () => {
    const schema = z.object({
      tags: z.array(z.string()).refine((arr) => arr.length > 0, 'non-empty'),
    })
    expect(hasContainerOrRootRefine(schema)).toBe(true)
  })

  it('handles cycles without recursing forever', () => {
    type N = { name: string; child?: N | undefined }
    const node: z.ZodType<N> = z.lazy(() =>
      z.object({ name: z.string(), child: z.lazy(() => node).optional() })
    )
    // The lazy resolver builds new instances per call; this only proves
    // the walker terminates rather than diverging. False is correct here:
    // no refines anywhere.
    expect(hasContainerOrRootRefine(node)).toBe(false)
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
  it('flags an async leaf refine at the root', () => {
    expect(containsAsyncRefine(z.string().refine(async () => Promise.resolve(true)))).toBe(true)
  })

  it('clears a sync-only schema (v4 reads checks exactly)', () => {
    // v4 is more precise than v3 — sync refines do NOT trip the flag
    // because `isAsyncCheck` reads the user fn's constructor.name.
    expect(containsAsyncRefine(z.string().refine(() => true))).toBe(false)
    expect(containsAsyncRefine(z.string())).toBe(false)
    expect(containsAsyncRefine(z.object({ name: z.string(), age: z.number() }))).toBe(false)
  })

  it('flags an async refine nested under containers and wrappers', () => {
    const nested = z.object({
      profile: z
        .object({
          tags: z.array(
            z
              .string()
              .refine(async () => Promise.resolve(true))
              .optional()
          ),
        })
        .nullable(),
    })
    expect(containsAsyncRefine(nested)).toBe(true)
  })

  it('does not flag a bare async transform (that’s the transform walker’s domain)', () => {
    expect(
      containsAsyncRefine(z.object({ x: z.string().transform(async (v) => Promise.resolve(v)) }))
    ).toBe(false)
  })

  it('flags through pipe / intersection / discriminated-union / record / set', () => {
    const pipe = z.pipe(
      z.string(),
      z.string().refine(async () => Promise.resolve(true))
    )
    const intersect = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.string().refine(async () => Promise.resolve(true)) })
    )
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), v: z.string() }),
      z.object({ kind: z.literal('b'), v: z.string().refine(async () => Promise.resolve(true)) }),
    ])
    const rec = z.record(
      z.string(),
      z.string().refine(async () => Promise.resolve(true))
    )
    const set = z.set(z.string().refine(async () => Promise.resolve(true)))
    expect(containsAsyncRefine(pipe)).toBe(true)
    expect(containsAsyncRefine(intersect)).toBe(true)
    expect(containsAsyncRefine(du)).toBe(true)
    expect(containsAsyncRefine(rec)).toBe(true)
    expect(containsAsyncRefine(set)).toBe(true)
  })

  it('flags through a lazy recursive schema (one hop)', () => {
    type N = { name: string; child?: N | undefined }
    const node: z.ZodType<N> = z.lazy(() =>
      z.object({
        name: z.string().refine(async () => Promise.resolve(true)),
        child: z.lazy(() => node).optional(),
      })
    )
    expect(containsAsyncRefine(node)).toBe(true)
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

  it('does not flag refines (sync or async) — the refine walker’s domain', () => {
    expect(containsAsyncTransform(z.string().refine(async () => Promise.resolve(true)))).toBe(false)
    expect(containsAsyncTransform(z.string().refine(() => true))).toBe(false)
  })

  it('flags an async transform nested under union options', () => {
    const schema = z.object({
      payload: z.union([z.string(), z.string().transform(async (v) => Promise.resolve(`${v}!`))]),
    })
    expect(containsAsyncTransform(schema)).toBe(true)
  })

  it('flags through intersection / record / set / lazy', () => {
    const intersect = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.string().transform(async (v) => Promise.resolve(v)) })
    )
    const rec = z.record(
      z.string(),
      z.string().transform(async (v) => Promise.resolve(v))
    )
    const set = z.set(z.string().transform(async (v) => Promise.resolve(v)))
    type N = { v: string; child?: N | undefined }
    const node: z.ZodType<N> = z.lazy(() =>
      z.object({
        v: z.string().transform(async (v) => Promise.resolve(v)),
        child: z.lazy(() => node).optional(),
      })
    )
    expect(containsAsyncTransform(intersect)).toBe(true)
    expect(containsAsyncTransform(rec)).toBe(true)
    expect(containsAsyncTransform(set)).toBe(true)
    expect(containsAsyncTransform(node)).toBe(true)
  })
})

describe('assertZodVersion', () => {
  it('accepts a genuine zod v4 schema', () => {
    expect(() => assertZodVersion(z.string())).not.toThrow()
  })

  it('rejects a non-zod value with a helpful message', () => {
    expect(() => assertZodVersion({})).toThrow(/zod v4/i)
  })

  it('rejects a plain-object schema-look-alike', () => {
    // Simulates accidentally passing a zod-v3 schema into the v4 adapter.
    // v3 schemas expose `_def.typeName`, not `def.type`.
    const v3Like = { _def: { typeName: 'ZodString' } }
    expect(() => assertZodVersion(v3Like)).toThrow(/zod v4/i)
  })
})
