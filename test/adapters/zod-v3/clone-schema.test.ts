import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { cloneSchemaDeep } from '../../../src/runtime/adapters/zod-v3/clone-schema'

/**
 * Unit suite for the dependency-free schema clone that replaced
 * `lodash-es/cloneDeep` in the discriminated-union slim path. Pins the
 * invariants the slim path relies on: a working independent schema with
 * its prototype intact, a de-shared `_def` graph, functions carried by
 * reference, reconstructed RegExp / Date, and cycle safety.
 */
describe('cloneSchemaDeep', () => {
  it('clones a Zod object into an independent, working schema', () => {
    const schema = z.object({ a: z.string(), b: z.number() })
    const copy = cloneSchemaDeep(schema)

    expect(copy).toBeInstanceOf(z.ZodObject)
    expect(copy).not.toBe(schema)
    // The structural _def graph is de-shared, which is the whole point.
    expect(copy._def).not.toBe(schema._def)
    expect(copy.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 })
    expect(copy.safeParse({ a: 1, b: 'x' }).success).toBe(false)
  })

  it('clones a discriminated-union option, the real slim-path input', () => {
    const option = z.object({ kind: z.literal('email'), address: z.string() })
    const copy = cloneSchemaDeep(option)

    expect(copy).toBeInstanceOf(z.ZodObject)
    expect(copy._def).not.toBe(option._def)
    expect(copy.parse({ kind: 'email', address: 'a@b' })).toEqual({
      kind: 'email',
      address: 'a@b',
    })
    expect(copy.safeParse({ kind: 'sms', address: 'a@b' }).success).toBe(false)
  })

  it('preserves prototypes and methods on class instances', () => {
    class Box {
      value = 1
      read() {
        return this.value
      }
    }
    const box = new Box()
    const copy = cloneSchemaDeep(box)

    expect(copy).toBeInstanceOf(Box)
    expect(copy).not.toBe(box)
    expect(copy.read()).toBe(1)
  })

  it('carries functions by reference', () => {
    const fn = () => 'x'
    const source = { fn, nested: { n: 1 } }
    const copy = cloneSchemaDeep(source)

    expect(copy.fn).toBe(fn)
    expect(copy.nested).not.toBe(source.nested)
    expect(copy.nested).toEqual({ n: 1 })
  })

  it('deep-copies nested objects and arrays', () => {
    const source = { list: [{ a: 1 }, { b: 2 }] }
    const copy = cloneSchemaDeep(source)

    expect(copy.list).not.toBe(source.list)
    expect(copy.list[0]).not.toBe(source.list[0])
    expect(copy).toEqual({ list: [{ a: 1 }, { b: 2 }] })
  })

  it('reconstructs RegExp and Date instead of sharing them', () => {
    const re = /abc/gi
    re.lastIndex = 3
    const date = new Date(123_456)
    const source = { re, date }
    const copy = cloneSchemaDeep(source)

    expect(copy.re).not.toBe(re)
    expect(copy.re.source).toBe('abc')
    expect(copy.re.flags).toBe('gi')
    expect(copy.re.lastIndex).toBe(3)
    expect(copy.date).not.toBe(date)
    expect(copy.date.getTime()).toBe(123_456)
  })

  it('handles cyclic references without overflowing the stack', () => {
    const node: { name: string; self?: unknown } = { name: 'root' }
    node.self = node
    const copy = cloneSchemaDeep(node)

    expect(copy.name).toBe('root')
    expect(copy.self).toBe(copy)
    expect(copy).not.toBe(node)
  })

  it('returns primitives and top-level functions as-is', () => {
    const fn = () => 1
    expect(cloneSchemaDeep(42)).toBe(42)
    expect(cloneSchemaDeep('text')).toBe('text')
    expect(cloneSchemaDeep(null)).toBe(null)
    expect(cloneSchemaDeep(undefined)).toBe(undefined)
    expect(cloneSchemaDeep(fn)).toBe(fn)
  })
})
