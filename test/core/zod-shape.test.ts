import { describe, expect, it } from 'vitest'
import { z as z4 } from 'zod'
import { z as z3 } from 'zod-v3'
import { isZodV4SchemaShape } from '../../src/runtime/core/zod-shape'

describe('isZodV4SchemaShape', () => {
  it('returns true for a Zod v4 schema (def.type is a string)', () => {
    expect(isZodV4SchemaShape(z4.object({ email: z4.string() }))).toBe(true)
    expect(isZodV4SchemaShape(z4.string())).toBe(true)
    expect(isZodV4SchemaShape(z4.number().min(1))).toBe(true)
  })

  it('returns false for plain objects, primitives, and Zod v3 schemas', () => {
    expect(isZodV4SchemaShape(undefined)).toBe(false)
    expect(isZodV4SchemaShape(null)).toBe(false)
    expect(isZodV4SchemaShape({})).toBe(false)
    expect(isZodV4SchemaShape({ schema: z4.object({}) })).toBe(false)
    expect(isZodV4SchemaShape('z.object({})')).toBe(false)
    expect(isZodV4SchemaShape(42)).toBe(false)
    expect(isZodV4SchemaShape(z3.object({ email: z3.string() }))).toBe(false)
  })

  it('does not get confused by objects whose `def` field is not an object', () => {
    expect(isZodV4SchemaShape({ def: 'not an object' })).toBe(false)
    expect(isZodV4SchemaShape({ def: null })).toBe(false)
  })

  it('requires the inner `def.type` property to be a string', () => {
    expect(isZodV4SchemaShape({ def: { type: 42 } })).toBe(false)
    expect(isZodV4SchemaShape({ def: {} })).toBe(false)
  })
})
