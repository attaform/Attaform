import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'

/**
 * v4 mirror of `test/adapters/zod-v3/path-walker.test.ts` — same scenarios
 * across the same public adapter surface. v4 already resolves these paths
 * correctly; this file pins the reference so the v3 unification in Phase 8
 * lands as proven parity (dual-green = the gap closed).
 */
describe('zod v4: path-walker parity for union/tuple/intersection/lazy/catch', () => {
  describe('ZodUnion', () => {
    it('resolves field paths into union branches via getSchemasAtPath', () => {
      const schema = z.object({
        value: z.union([
          z.object({ kind: z.literal('a'), x: z.string() }),
          z.object({ kind: z.literal('b'), x: z.number() }),
        ]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const resolved = adapter.getSchemasAtPath(['value', 'x'])
      expect(resolved.length).toBeGreaterThanOrEqual(1)
    })

    it('tightens slim gate to declared kinds under a union field', () => {
      const schema = z.object({
        value: z.union([
          z.object({ kind: z.literal('a'), x: z.string() }),
          z.object({ kind: z.literal('b'), y: z.number() }),
        ]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const xKinds = adapter.getSlimPrimitiveTypesAtPath(['value', 'x'])
      expect(xKinds.has('string')).toBe(true)
      expect(xKinds.has('number')).toBe(false)
      const yKinds = adapter.getSlimPrimitiveTypesAtPath(['value', 'y'])
      expect(yKinds.has('number')).toBe(true)
      expect(yKinds.has('string')).toBe(false)
    })
  })

  describe('ZodTuple', () => {
    it('resolves tuple element by index via getSchemasAtPath', () => {
      const schema = z.object({
        pair: z.tuple([z.string(), z.number()]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getSchemasAtPath(['pair', '0'])).toHaveLength(1)
      expect(adapter.getSchemasAtPath(['pair', '1'])).toHaveLength(1)
    })

    it('arrayShapeAtPath returns the tuple length', () => {
      const schema = z.object({
        coords: z.tuple([z.number(), z.number(), z.number()]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.arrayShapeAtPath(['coords'])).toBe(3)
    })

    it('slim gate accepts the declared kind at each tuple index', () => {
      const schema = z.object({
        pair: z.tuple([z.string(), z.number()]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getSlimPrimitiveTypesAtPath(['pair', '0']).has('string')).toBe(true)
      expect(adapter.getSlimPrimitiveTypesAtPath(['pair', '1']).has('number')).toBe(true)
    })
  })

  describe('ZodIntersection', () => {
    it('resolves field paths into intersected sides via getSchemasAtPath', () => {
      const schema = z.object({
        merged: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getSchemasAtPath(['merged', 'a'])).toHaveLength(1)
      expect(adapter.getSchemasAtPath(['merged', 'b'])).toHaveLength(1)
    })

    it('slim gate tightens to the side that declares the field', () => {
      const schema = z.object({
        merged: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getSlimPrimitiveTypesAtPath(['merged', 'a']).has('string')).toBe(true)
      expect(adapter.getSlimPrimitiveTypesAtPath(['merged', 'a']).has('number')).toBe(false)
      expect(adapter.getSlimPrimitiveTypesAtPath(['merged', 'b']).has('number')).toBe(true)
      expect(adapter.getSlimPrimitiveTypesAtPath(['merged', 'b']).has('string')).toBe(false)
    })
  })

  describe('ZodLazy', () => {
    it('descends one lazy layer for a recursive shape', () => {
      type Tree = { name: string; children?: Tree[] | undefined }
      const treeSchema: z.ZodType<Tree> = z.lazy(() =>
        z.object({
          name: z.string(),
          children: z.array(treeSchema).optional(),
        })
      )
      const schema = z.object({ root: treeSchema })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      const resolved = adapter.getSchemasAtPath(['root', 'name'])
      expect(resolved).toHaveLength(1)
      expect(adapter.getSlimPrimitiveTypesAtPath(['root', 'name']).has('string')).toBe(true)
    })

    it('caps descent at maxRecursionDepth so recursive paths beyond the cap fall back to permissive', () => {
      type Tree = { name: string; children?: Tree[] | undefined }
      const treeSchema: z.ZodType<Tree> = z.lazy(() =>
        z.object({
          name: z.string(),
          children: z.array(treeSchema).optional(),
        })
      )
      const schema = z.object({ root: treeSchema })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 2 })
      const within = adapter.getSchemasAtPath(['root', 'children', '0', 'name'])
      expect(within.length).toBeGreaterThanOrEqual(1)
      const beyond = adapter.getSchemasAtPath([
        'root',
        'children',
        '0',
        'children',
        '0',
        'children',
        '0',
        'children',
        '0',
        'name',
      ])
      expect(beyond).toHaveLength(0)
    })
  })

  describe('ZodCatch', () => {
    it('peels catch transparently when resolving a sub-path', () => {
      const schema = z.object({
        config: z.object({ retries: z.number(), label: z.string() }).catch({
          retries: 3,
          label: 'fallback',
        }),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getSchemasAtPath(['config', 'retries'])).toHaveLength(1)
      expect(adapter.getSchemasAtPath(['config', 'label'])).toHaveLength(1)
    })

    it('arrayShapeAtPath returns null for a catch-wrapped array', () => {
      const schema = z.object({
        items: z.array(z.string()).catch([]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.arrayShapeAtPath(['items'])).toBe(null)
    })

    it('arrayShapeAtPath returns the tuple length through catch', () => {
      const schema = z.object({
        coords: z.tuple([z.number(), z.number()]).catch([0, 0] as [number, number]),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.arrayShapeAtPath(['coords'])).toBe(2)
    })

    it('slim gate tightens to the declared kind under catch', () => {
      const schema = z.object({
        config: z.object({ retries: z.number() }).catch({ retries: 3 }),
      })
      const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
      expect(adapter.getSlimPrimitiveTypesAtPath(['config', 'retries']).has('number')).toBe(true)
    })
  })
})
