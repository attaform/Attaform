/**
 * One memoized capability walk per schema node (#691).
 *
 * Each adapter used to answer its capability questions with a separate
 * walk per question, and asked some of them again on every construction.
 * `capabilitiesOf` answers them all from one walk and memoizes the answer
 * per node for the life of the process; `scanCapabilities` is the same
 * walk without the memo, for sub-schemas built per path query.
 *
 * The oracle below is the separate walks as they stood before the
 * fusion, reproduced on the adapters' public accessors: four predicates
 * on v4, five on v3, each with its own `WeakSet` and its own
 * short-circuit. The fused answer has to equal every one of them over a
 * hand-built corpus (lazy cycles, pipes, records, maps, sets,
 * intersections, catch and default wrappers, a node shared between a
 * map and the rest of the tree) and over generated trees that mix those
 * kinds with sync and async refines, transforms and preprocesses.
 *
 * `preprocessOrCoerce` joined the record later (#695). Its oracle is the
 * same kind of separate walk, and one more property ties it to the
 * question it answers for the store: wherever `isPreprocessOrCoerceLeaf`
 * holds, the root's bit is set.
 */
import { fc, test } from '@fast-check/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodAdapter as zodAdapterV4 } from '../../src/runtime/adapters/zod-v4'
import {
  capabilitiesOf as capabilitiesOfV4,
  getChecks,
  isAsyncCheck,
  isCoercePrimitive as isCoercePrimitiveV4,
  isPreprocessNode as isPreprocessNodeV4,
  kindOf,
  scanCapabilities as scanCapabilitiesV4,
} from '../../src/runtime/adapters/zod-v4/introspect'
import { zodAdapter as zodAdapterV3 } from '../../src/runtime/adapters/zod-v3'
import {
  capabilitiesOf as capabilitiesOfV3,
  getArrayElement,
  getEffectsKind,
  getIntersectionLeft,
  getIntersectionRight,
  getMapKeyType,
  getMapValueType,
  getObjectShape,
  getRecordKeyType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getUnionOptions,
  isAsyncEffect,
  isCoercePrimitive as isCoercePrimitiveV3,
  isContainerAfterWrapperPeel,
  isPreprocessNode as isPreprocessNodeV3,
  scanCapabilities as scanCapabilitiesV3,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
  unwrapPipeOut,
} from '../../src/runtime/adapters/zod-v3/introspect'
import { isZodSchemaType } from '../../src/runtime/adapters/zod-v3/helpers'
import { SET_MEMBER_SEGMENT } from '../../src/runtime/core/paths'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- The oracle: the separate walks before the fusion ----------

const V4_SINGLE = ['innerType', 'element', 'in', 'out', 'left', 'right', 'keyType', 'valueType']
const V4_RECORD = ['shape', 'entries']
const V4_LIST = ['options', 'items']
const V4_CONTAINER = [
  'shape',
  'entries',
  'element',
  'options',
  'items',
  'keyType',
  'valueType',
  'left',
  'right',
]

function walkV4(schema: any, visit: (node: any) => boolean, visited: WeakSet<object>): boolean {
  if (typeof schema !== 'object' || schema === null) return false
  if (visited.has(schema)) return false
  visited.add(schema)
  if (visit(schema)) return true
  const def = schema.def
  if (def === undefined) return false
  for (const key of V4_SINGLE) {
    if (def[key] !== undefined && walkV4(def[key], visit, visited)) return true
  }
  for (const key of V4_RECORD) {
    if (def[key] !== undefined) {
      for (const sub of Object.values(def[key])) if (walkV4(sub, visit, visited)) return true
    }
  }
  for (const key of V4_LIST) {
    if (def[key] !== undefined) {
      for (const sub of def[key]) if (walkV4(sub, visit, visited)) return true
    }
  }
  if (typeof def.getter === 'function') {
    try {
      if (walkV4(def.getter(), visit, visited)) return true
    } catch {
      // As before: a lazy that throws on resolution is no match.
    }
  }
  return false
}

function oracleV4(schema: any) {
  const walk = (visit: (node: any) => boolean) => walkV4(schema, visit, new WeakSet())
  return {
    asyncRefine: walk((node) => getChecks(node).some((check) => isAsyncCheck(check))),
    asyncTransform: walk((node) => {
      const fn = node.def?.transform
      return typeof fn === 'function' && fn.constructor.name === 'AsyncFunction'
    }),
    discriminatedUnion: walk((node) => kindOf(node) === 'discriminated-union'),
    containerOrRootRefine: walk((node) => {
      const def = node.def
      if (def === undefined) return false
      if (!V4_CONTAINER.some((key) => def[key] !== undefined)) return false
      return getChecks(node).length > 0
    }),
    preprocessOrCoerce: walk((node) => isCoercePrimitiveV4(node) || isPreprocessNodeV4(node)),
  }
}

type V3Target =
  | 'refinement'
  | 'transform-or-preprocess'
  | 'discriminated-union'
  | 'map-or-set'
  | 'preprocess-or-coerce'

const V3_WRAPPERS = ['ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodCatch', 'ZodReadonly'] as const

function walkForTargetV3(schema: any, target: V3Target, visited: WeakSet<object>): boolean {
  if (typeof schema !== 'object' || schema === null) return false
  if (visited.has(schema)) return false
  visited.add(schema)
  const next = (child: any) => child !== undefined && walkForTargetV3(child, target, visited)
  if (target === 'preprocess-or-coerce' && isCoercePrimitiveV3(schema)) return true
  if (isZodSchemaType(schema, 'ZodEffects')) {
    const kind = getEffectsKind(schema)
    if (target === 'preprocess-or-coerce' && isPreprocessNodeV3(schema)) return true
    if (target === 'refinement' && kind === 'refinement') return true
    if (
      target === 'transform-or-preprocess' &&
      (kind === 'transform' || kind === 'preprocess') &&
      isAsyncEffect(schema)
    ) {
      return true
    }
    return next(unwrapEffectsSource(schema))
  }
  if (V3_WRAPPERS.some((name) => isZodSchemaType(schema, name))) return next(unwrapInner(schema))
  if (isZodSchemaType(schema, 'ZodBranded')) return next(unwrapBranded(schema))
  if (isZodSchemaType(schema, 'ZodLazy')) return next(unwrapLazy(schema))
  if (isZodSchemaType(schema, 'ZodPipeline')) {
    return next(unwrapPipeIn(schema)) || next(unwrapPipeOut(schema))
  }
  if (isZodSchemaType(schema, 'ZodObject')) return Object.values(getObjectShape(schema)).some(next)
  if (isZodSchemaType(schema, 'ZodArray')) return next(getArrayElement(schema))
  if (isZodSchemaType(schema, 'ZodTuple')) return getTupleItems(schema).some(next)
  if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    if (target === 'discriminated-union' && isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
      return true
    }
    return getUnionOptions(schema).some(next)
  }
  if (isZodSchemaType(schema, 'ZodIntersection')) {
    return next(getIntersectionLeft(schema)) || next(getIntersectionRight(schema))
  }
  if (isZodSchemaType(schema, 'ZodRecord')) {
    return next(getRecordKeyType(schema)) || next(getRecordValueType(schema))
  }
  if (isZodSchemaType(schema, 'ZodSet')) {
    if (target === 'map-or-set') return true
    return next(getSetValueType(schema))
  }
  if (isZodSchemaType(schema, 'ZodMap')) {
    if (target === 'map-or-set') return true
    return next(getMapKeyType(schema)) || next(getMapValueType(schema))
  }
  return false
}

function containerOrRootRefineV3(schema: any, visited: WeakSet<object>): boolean {
  if (typeof schema !== 'object' || schema === null) return false
  if (visited.has(schema)) return false
  visited.add(schema)
  const next = (child: any) => child !== undefined && containerOrRootRefineV3(child, visited)
  if (isZodSchemaType(schema, 'ZodEffects')) {
    const inner = unwrapEffectsSource(schema)
    if (inner === undefined) return false
    if (isContainerAfterWrapperPeel(inner)) return true
    return next(inner)
  }
  if (V3_WRAPPERS.some((name) => isZodSchemaType(schema, name))) return next(unwrapInner(schema))
  if (isZodSchemaType(schema, 'ZodBranded')) return next(unwrapBranded(schema))
  if (isZodSchemaType(schema, 'ZodLazy')) return next(unwrapLazy(schema))
  if (isZodSchemaType(schema, 'ZodPipeline')) {
    return next(unwrapPipeIn(schema)) || next(unwrapPipeOut(schema))
  }
  if (isZodSchemaType(schema, 'ZodObject')) return Object.values(getObjectShape(schema)).some(next)
  if (isZodSchemaType(schema, 'ZodArray')) return next(getArrayElement(schema))
  if (isZodSchemaType(schema, 'ZodTuple')) return getTupleItems(schema).some(next)
  if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    return getUnionOptions(schema).some(next)
  }
  if (isZodSchemaType(schema, 'ZodIntersection')) {
    return next(getIntersectionLeft(schema)) || next(getIntersectionRight(schema))
  }
  if (isZodSchemaType(schema, 'ZodRecord')) {
    return next(getRecordKeyType(schema)) || next(getRecordValueType(schema))
  }
  if (isZodSchemaType(schema, 'ZodSet')) return next(getSetValueType(schema))
  // This walk had no ZodMap arm: a refine on a map entry's object never
  // counted, so a keystroke inside the entry skipped it (#691, d7). It
  // looks below a map now, as v4's always has.
  if (isZodSchemaType(schema, 'ZodMap')) {
    return next(getMapKeyType(schema)) || next(getMapValueType(schema))
  }
  return false
}

function oracleV3(schema: any) {
  const walk = (target: V3Target) => walkForTargetV3(schema, target, new WeakSet())
  return {
    asyncRefine: walk('refinement'),
    asyncTransform: walk('transform-or-preprocess'),
    discriminatedUnion: walk('discriminated-union'),
    containerOrRootRefine: containerOrRootRefineV3(schema, new WeakSet()),
    preprocessOrCoerce: walk('preprocess-or-coerce'),
    mapOrSet: walk('map-or-set'),
  }
}

// ---------- The corpus ----------

/** Built per adapter from its own `z`, so each case is a fresh tree. */
function corpus(z: any, record: (value: any) => any): Record<string, any> {
  const asyncCheck = async () => {
    await Promise.resolve()
    return true
  }
  const refinedObject = z.object({ a: z.string() }).refine(() => true)
  const du = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('a'), x: z.string() }),
    z.object({ kind: z.literal('b'), y: z.number().refine(asyncCheck) }),
  ])
  const tree: any = z.lazy(() =>
    z.object({ label: z.string().refine(() => true), children: z.array(tree) })
  )
  const ring: any = z.lazy(() => z.object({ next: ring.optional(), lookup: z.map(z.string(), du) }))
  return {
    'a plain object': z.object({ a: z.string(), b: z.number().min(1) }),
    'a leaf refine': z.object({ a: z.string().refine(() => true) }),
    'an async leaf refine': z.object({ a: z.string().refine(asyncCheck) }),
    'a root refine': z.object({ a: z.string(), b: z.string() }).refine(() => true),
    'a root superRefine': z.object({ a: z.string() }).superRefine(() => undefined),
    'a refine on an optional object': z
      .object({ p: z.object({ a: z.string() }).optional() })
      .refine(() => true),
    'a sync transform': z.object({ a: z.string().transform((v: string) => v.length) }),
    'an async transform': z.object({
      a: z.string().transform(async (v: string) => Promise.resolve(v)),
    }),
    'a sync preprocess': z.object({ a: z.preprocess((v: unknown) => v, z.string()) }),
    'an async preprocess': z.object({
      a: z.preprocess(async (v: unknown) => Promise.resolve(v), z.string()),
    }),
    'a coerce leaf': z.object({ n: z.coerce.number() }),
    'a coerce leaf in a union': z.object({ v: z.union([z.string(), z.coerce.number()]) }),
    'a coerce leaf under a map': z.object({ m: z.map(z.string(), z.coerce.date()) }),
    'a preprocess under a record': z.object({
      r: record(z.preprocess((v: unknown) => v, z.number())),
    }),
    'a preprocess under a lazy': z.object({
      l: z.lazy(() => z.object({ p: z.preprocess((v: unknown) => v, z.string()) })),
    }),
    'a pipe with a refined output': z.object({
      a: z.string().pipe(z.string().refine(asyncCheck)),
    }),
    'a pipe into a refined object': z.object({
      a: z.unknown().pipe(z.object({ b: z.string() }).refine(() => true)),
    }),
    'a discriminated union': z.object({ notify: du }),
    'a plain union': z.object({ v: z.union([z.string(), z.number()]) }),
    'an array of refined objects': z.object({ items: z.array(refinedObject) }),
    'a tuple': z.object({ t: z.tuple([z.string(), z.number().refine(() => true)]) }),
    'a record of refined objects': z.object({ r: record(refinedObject) }),
    'an intersection': z.object({
      i: z.intersection(
        z.object({ a: z.string() }),
        z.object({ b: z.string().refine(asyncCheck) })
      ),
    }),
    'a set': z.object({ s: z.set(z.string().refine(() => true)) }),
    'a map of strings': z.object({ m: z.map(z.string(), z.string()) }),
    'a refined object only under a map': z.object({ m: z.map(z.string(), refinedObject) }),
    'a refined object under a map, then outside it': z.object({
      m: z.map(z.string(), refinedObject),
      o: refinedObject,
    }),
    'a refined object outside a map, then under it': z.object({
      o: refinedObject,
      m: z.map(z.string(), refinedObject),
    }),
    'catch and default wrappers': z.object({
      c: z
        .string()
        .refine(() => true)
        .catch('x'),
      d: z
        .object({ a: z.string() })
        .refine(() => true)
        .default({ a: '' }),
      r: z.object({ a: z.string() }).readonly(),
    }),
    'a branded leaf': z.object({ b: z.string().brand('Id') }),
    'a lazy cycle': z.object({ root: tree }),
    'a lazy cycle through a map': z.object({ head: ring }),
    'a lazy that throws': z.object({
      l: z.lazy(() => {
        throw new Error('not yet')
      }),
    }),
  }
}

const ADAPTERS = [
  {
    name: 'zod-v4',
    z: zV4 as any,
    record: (value: any) => zV4.record(zV4.string(), value),
    capabilitiesOf: (schema: any): Record<string, boolean> => ({ ...capabilitiesOfV4(schema) }),
    oracle: oracleV4,
    build: (schema: any) => zodAdapterV4(schema)('f', { maxRecursionDepth: 64 }),
  },
  {
    name: 'zod-v3',
    z: zV3 as any,
    record: (value: any) => zV3.record(value),
    capabilitiesOf: (schema: any): Record<string, boolean> => ({ ...capabilitiesOfV3(schema) }),
    oracle: oracleV3,
    build: (schema: any) => zodAdapterV3(schema)('f', { maxRecursionDepth: 64 }),
  },
] as const

/** Generated trees mixing every capability-bearing kind the corpus has. */
function arbitrarySchema(z: any, record: (value: any) => any, depth: number): fc.Arbitrary<any> {
  const asyncCheck = async () => {
    await Promise.resolve()
    return true
  }
  const leaf = fc.constantFrom(
    () => z.string(),
    () => z.number().min(1),
    () => z.string().refine(() => true),
    () => z.string().refine(asyncCheck),
    () => z.string().transform((v: string) => v),
    () => z.string().transform(async (v: string) => Promise.resolve(v)),
    () => z.preprocess((v: unknown) => v, z.string()),
    () => z.preprocess(async (v: unknown) => Promise.resolve(v), z.string()),
    () => z.coerce.number(),
    () => z.string().pipe(z.string().min(1)),
    () => z.string().brand('B'),
    () => z.string().catch(''),
    () => z.lazy(() => z.string())
  )
  if (depth === 0) return leaf.map((make) => make())
  const inner = arbitrarySchema(z, record, depth - 1)
  return fc.oneof(
    leaf.map((make) => make()),
    inner.map((s) => s.optional()),
    inner.map((s) => s.nullable()),
    inner.map((s) => z.array(s)),
    inner.map((s) => z.set(s)),
    inner.map((s) => z.map(z.string(), s)),
    inner.map(record),
    inner.map((s) => z.lazy(() => s)),
    fc.array(inner, { minLength: 1, maxLength: 3 }).map((items) => z.tuple(items)),
    fc.array(inner, { minLength: 2, maxLength: 3 }).map((options) => z.union(options)),
    fc.tuple(inner, inner).map(([a, b]) => z.intersection(a, b)),
    fc
      .array(inner, { minLength: 1, maxLength: 3 })
      .map((items) =>
        z.object(Object.fromEntries(items.map((s: any, i: number) => [`k${String(i)}`, s])))
      ),
    fc
      .array(inner, { minLength: 1, maxLength: 3 })
      .map((items) =>
        z
          .object(Object.fromEntries(items.map((s: any, i: number) => [`k${String(i)}`, s])))
          .refine(() => true)
      ),
    inner.map((s) =>
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), v: s }),
        z.object({ kind: z.literal('b') }),
      ])
    ),
    // The same node under a map and beside it, in either order.
    inner.map((s) => z.object({ m: z.map(z.string(), s), o: s })),
    inner.map((s) => z.object({ o: s, m: z.map(z.string(), s) }))
  )
}

/**
 * Segments the generated trees address: object keys, the discriminator
 * and variant key, the map-beside-object keys, tuple and array indices,
 * the set-member segment, and a key nothing declares (records and maps
 * accept any).
 */
const PATH_SEGMENT = fc.constantFrom<string | number>(
  'k0',
  'k1',
  'k2',
  'kind',
  'v',
  'm',
  'o',
  0,
  1,
  SET_MEMBER_SEGMENT,
  'x'
)

describe('capabilitiesOf (#691)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      for (const [title, schema] of Object.entries(corpus(adapter.z, adapter.record))) {
        it(`matches the separate walks: ${title}`, () => {
          // The throwing lazy reports itself in development; both walks
          // resolve it, so both report.
          vi.spyOn(console, 'warn').mockImplementation(() => undefined)
          expect(adapter.capabilitiesOf(schema)).toEqual(adapter.oracle(schema))
        })
      }

      test.prop([arbitrarySchema(adapter.z, adapter.record, 3)])(
        'matches the separate walks over generated trees',
        (schema) => {
          expect(adapter.capabilitiesOf(schema)).toEqual(adapter.oracle(schema))
        }
      )

      test.prop([
        arbitrarySchema(adapter.z, adapter.record, 3),
        fc.array(fc.array(PATH_SEGMENT, { maxLength: 5 }), { minLength: 1, maxLength: 20 }),
      ])('sets the root bit wherever isPreprocessOrCoerceLeaf holds', (schema, tails) => {
        // The store reads the bit to skip its authored-path bookkeeping, which
        // is only consulted where `isPreprocessOrCoerceLeaf` holds. A path can
        // only resolve to nodes the walk visits, so the bit covers every one.
        const abstract = adapter.build(adapter.z.object({ root: schema }))
        const bit = abstract.hasPreprocessOrCoerce?.()
        for (const tail of tails) {
          if (abstract.isPreprocessOrCoerceLeaf(['root', ...tail])) expect(bit).toBe(true)
        }
      })

      it('walks a node once, then answers from the memo', () => {
        const schema = adapter.z.object({
          a: adapter.z.string().refine(() => true),
          b: adapter.z.array(adapter.z.number()),
        })
        const rootAdds = vi.fn()
        const add = WeakSet.prototype.add
        vi.spyOn(WeakSet.prototype, 'add').mockImplementation(function (
          this: WeakSet<WeakKey>,
          value: WeakKey
        ) {
          if (value === schema) rootAdds()
          return add.call(this, value)
        })
        const first =
          adapter.name === 'zod-v4' ? capabilitiesOfV4(schema) : capabilitiesOfV3(schema)
        expect(rootAdds).toHaveBeenCalledTimes(1)
        const second =
          adapter.name === 'zod-v4' ? capabilitiesOfV4(schema) : capabilitiesOfV3(schema)
        expect(rootAdds).toHaveBeenCalledTimes(1)
        expect(second).toBe(first)
      })

      it('scans a sub-schema without the memo', () => {
        // A sub-schema is built per path query and asked once, so its walk
        // skips the memo: an insert costs more than the few nodes it saves.
        const schema = adapter.z.object({ a: adapter.z.string().refine(() => true) })
        const expected = adapter.oracle(schema)
        const rootAdds = vi.fn()
        const add = WeakSet.prototype.add
        vi.spyOn(WeakSet.prototype, 'add').mockImplementation(function (
          this: WeakSet<WeakKey>,
          value: WeakKey
        ) {
          if (value === schema) rootAdds()
          return add.call(this, value)
        })
        const scan = adapter.name === 'zod-v4' ? scanCapabilitiesV4 : scanCapabilitiesV3
        const of = adapter.name === 'zod-v4' ? capabilitiesOfV4 : capabilitiesOfV3
        expect(scan(schema)).toEqual(expected)
        scan(schema)
        expect(rootAdds).toHaveBeenCalledTimes(2)
        of(schema)
        expect(rootAdds).toHaveBeenCalledTimes(3)
      })

      it('records only the node a query started from, not what it saw inside a cycle', () => {
        const asyncCheck = async () => Promise.resolve(true)
        const z = adapter.z
        // The walk from `outer` reaches `inner`, then meets `outer` again
        // through the lazy and stops there, so what it saw below `inner`
        // misses the async refine that only `outer` carries.
        const outer: any = z.object({
          flag: z.string().refine(asyncCheck),
          inner: z.lazy(() => inner),
        })
        const inner: any = z.object({ back: z.lazy(() => outer) })
        const of = (schema: any) =>
          adapter.name === 'zod-v4' ? capabilitiesOfV4(schema) : capabilitiesOfV3(schema)
        expect(of(outer).asyncRefine).toBe(true)
        expect(of(inner).asyncRefine).toBe(true)
        expect(adapter.capabilitiesOf(inner)).toEqual(adapter.oracle(inner))
      })
    })
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
