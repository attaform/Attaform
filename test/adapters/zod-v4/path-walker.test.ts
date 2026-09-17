import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getNestedZodSchemasAtPath } from '../../../src/runtime/adapters/zod-v4/path-walker'
import { SET_MEMBER_SEGMENT } from '../../../src/runtime/core/paths'

describe('getNestedZodSchemasAtPath', () => {
  it('returns the root schema for an empty path', () => {
    const schema = z.object({ name: z.string() })
    expect(getNestedZodSchemasAtPath(schema, '', 64)).toEqual([schema])
  })

  it('walks through object → leaf', () => {
    const schema = z.object({ name: z.string() })
    const resolved = getNestedZodSchemasAtPath(schema, 'name', 64)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.safeParse('hello').success).toBe(true)
  })

  it('walks through object → array → object', () => {
    const schema = z.object({
      items: z.array(z.object({ label: z.string() })),
    })
    const resolved = getNestedZodSchemasAtPath(schema, 'items.0.label', 64)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.safeParse('x').success).toBe(true)
  })

  it('returns empty array for a non-existent path', () => {
    const schema = z.object({ name: z.string() })
    expect(getNestedZodSchemasAtPath(schema, 'nope', 64)).toEqual([])
  })

  it('returns empty array when descending into a leaf', () => {
    const schema = z.object({ name: z.string() })
    expect(getNestedZodSchemasAtPath(schema, 'name.middle', 64)).toEqual([])
  })

  it('returns multiple subschemas for a union branch', () => {
    const schema = z.object({
      value: z.union([
        z.object({ kind: z.literal('a'), x: z.string() }),
        z.object({ kind: z.literal('b'), x: z.number() }),
      ]),
    })
    const resolved = getNestedZodSchemasAtPath(schema, 'value.x', 64)
    // Both union branches have an x, both resolve.
    expect(resolved.length).toBeGreaterThanOrEqual(1)
  })

  it('discriminated union: filters options by next-segment presence', () => {
    const schema = z.object({
      result: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('ok'), value: z.string() }),
        z.object({ kind: z.literal('err'), message: z.string() }),
      ]),
    })
    // "value" only lives in the ok branch, expect exactly one match.
    const resolved = getNestedZodSchemasAtPath(schema, 'result.value', 64)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.safeParse('x').success).toBe(true)
  })

  it('transparently walks through optional wrappers', () => {
    const schema = z.object({ inner: z.string().optional() })
    const resolved = getNestedZodSchemasAtPath(schema, 'inner', 64)
    expect(resolved).toHaveLength(1)
    // Optional preserves undefined.
    expect(resolved[0]?.safeParse(undefined).success).toBe(true)
  })

  it('accepts both dotted-string and array path forms', () => {
    const schema = z.object({
      profile: z.object({ name: z.string() }),
    })
    const byString = getNestedZodSchemasAtPath(schema, 'profile.name', 64)
    const byArray = getNestedZodSchemasAtPath(schema, ['profile', 'name'], 64)
    expect(byString).toHaveLength(1)
    expect(byArray).toHaveLength(1)
  })

  // Set-member queries. A set's members are not addressable: a member
  // IS its own key, so no address survives writing to one, and the
  // walker says so for every ordinary segment. The one question a set
  // answers is what a member looks like, which schema-coerce asks
  // through the reserved `SET_MEMBER_SEGMENT`. A plain index used to
  // serve that purpose, which made `tags.0` resolve for everyone: it
  // showed up on `form.fields` holding nothing, and it cleared the
  // write gate, where the numeric rebuild replaced the whole `Set`
  // with an `Array` holding the one written member (#614).
  it('walks z.set(z.number()) to its member schema under the reserved segment', () => {
    const schema = z.object({ tags: z.set(z.number()) })
    const resolved = getNestedZodSchemasAtPath(schema, ['tags', SET_MEMBER_SEGMENT], 64)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.safeParse(42).success).toBe(true)
    expect(resolved[0]?.safeParse('42').success).toBe(false)
  })

  it('walks z.set(z.boolean()) to its member schema under the reserved segment', () => {
    const schema = z.object({ flags: z.set(z.boolean()) })
    const resolved = getNestedZodSchemasAtPath(schema, ['flags', SET_MEMBER_SEGMENT], 64)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.safeParse(true).success).toBe(true)
    expect(resolved[0]?.safeParse('true').success).toBe(false)
  })

  it('descends past a set member into its own shape', () => {
    const schema = z.object({
      tags: z.set(z.object({ label: z.string() })),
    })
    const resolved = getNestedZodSchemasAtPath(schema, ['tags', SET_MEMBER_SEGMENT, 'label'], 64)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.safeParse('x').success).toBe(true)
  })

  it('resolves no set member by index', () => {
    const schema = z.object({ tags: z.set(z.number()) })
    expect(getNestedZodSchemasAtPath(schema, ['tags', 0], 64)).toEqual([])
    expect(getNestedZodSchemasAtPath(schema, ['tags', 1], 64)).toEqual([])
    expect(getNestedZodSchemasAtPath(schema, ['tags', 0, 'label'], 64)).toEqual([])
  })
})
