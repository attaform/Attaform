import { describe, expect, it, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import { IDENTITY, buildCoerceFn, resolveCoerceEnabled } from '../../src/runtime/core/schema-coerce'
import type { AbstractSchema } from '../../src/runtime/types/types-api'

/**
 * Unit tests for the schema-coerce module: the on/off switch, the
 * per-path closure, and the two built-in rules. These cases run
 * without DOM; the matching DOM-flow integration coverage is in
 * `test/composables/coerce.test.ts`.
 */

function adapter(schema: z.ZodObject): AbstractSchema<unknown, unknown> {
  return zodV4Adapter(schema)('f', { maxRecursionDepth: 64 }) as unknown as AbstractSchema<
    unknown,
    unknown
  >
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveCoerceEnabled', () => {
  it('only an explicit false turns coercion off', () => {
    expect(resolveCoerceEnabled(true)).toBe(true)
    expect(resolveCoerceEnabled(undefined)).toBe(true)
    expect(resolveCoerceEnabled(false)).toBe(false)
  })
})

describe('buildCoerceFn', () => {
  it('with coercion disabled → IDENTITY singleton', () => {
    const schema = adapter(z.object({ x: z.number() }))
    const fn = buildCoerceFn(schema, ['x'], false)
    expect(fn).toBe(IDENTITY)
  })

  it('returns identity for an unresolvable path (empty accept set)', () => {
    const schema = adapter(z.object({ x: z.number() }))
    const fn = buildCoerceFn(schema, ['unknown'], true)
    expect(fn('25')).toBe('25')
  })
})

describe('numeric scalar coercion', () => {
  const schema = adapter(z.object({ age: z.number() }))
  const fn = buildCoerceFn(schema, ['age'], true)

  it("'25' → 25", () => {
    expect(fn('25')).toBe(25)
  })

  it("'25.5' → 25.5", () => {
    expect(fn('25.5')).toBe(25.5)
  })

  it("'' → '' (NOT 0: empty string passthrough)", () => {
    expect(fn('')).toBe('')
  })

  it("'   ' (whitespace-only) → passthrough (NOT 0)", () => {
    // Without the trim-then-empty guard, `Number('  ')` is 0 and
    // would slip past the empty-string check. Trim normalises to
    // '' which the rule rejects.
    expect(fn('   ')).toBe('   ')
  })

  it("'  25  ' (padded) → 25 (whitespace tolerated)", () => {
    expect(fn('  25  ')).toBe(25)
  })

  it("'abc' → 'abc' (passthrough; gate decides)", () => {
    expect(fn('abc')).toBe('abc')
  })

  it("'1e309' (overflow) → passthrough", () => {
    expect(fn('1e309')).toBe('1e309')
  })

  it('already-number → no-op (returns same value)', () => {
    expect(fn(42)).toBe(42)
  })

  it('null → passthrough on z.number().nullable()', () => {
    const nullSchema = adapter(z.object({ age: z.number().nullable() }))
    const nullFn = buildCoerceFn(nullSchema, ['age'], true)
    expect(nullFn(null)).toBe(null)
  })
})

describe('boolean scalar coercion', () => {
  const schema = adapter(z.object({ active: z.boolean() }))
  const fn = buildCoerceFn(schema, ['active'], true)

  it("'true' → true", () => {
    expect(fn('true')).toBe(true)
  })

  it("'false' → false", () => {
    expect(fn('false')).toBe(false)
  })

  it("'True' / 'TRUE' / 'False' (case-insensitive)", () => {
    expect(fn('True')).toBe(true)
    expect(fn('TRUE')).toBe(true)
    expect(fn('False')).toBe(false)
    expect(fn('FALSE')).toBe(false)
  })

  it("'  true  ' (padded) → true (whitespace tolerated)", () => {
    expect(fn('  true  ')).toBe(true)
    expect(fn('  False  ')).toBe(false)
  })

  it("'yes' → 'yes' (passthrough)", () => {
    expect(fn('yes')).toBe('yes')
  })

  it('already-boolean → no-op', () => {
    expect(fn(true)).toBe(true)
    expect(fn(false)).toBe(false)
  })
})

describe('union ambiguity', () => {
  it('z.union([z.string(), z.number()]) → all inputs passthrough', () => {
    const schema = adapter(z.object({ flex: z.union([z.string(), z.number()]) }))
    const fn = buildCoerceFn(schema, ['flex'], true)
    expect(fn('25')).toBe('25')
    expect(fn(25)).toBe(25)
    expect(fn('hi')).toBe('hi')
  })
})

describe('array element coercion', () => {
  it('z.array(z.number()): string members coerced', () => {
    const schema = adapter(z.object({ ids: z.array(z.number()) }))
    const fn = buildCoerceFn(schema, ['ids'], true)
    const result = fn(['1', '2', '3'])
    expect(result).toEqual([1, 2, 3])
  })

  it('mixed-coercible: bad members preserve as-is', () => {
    const schema = adapter(z.object({ ids: z.array(z.number()) }))
    const fn = buildCoerceFn(schema, ['ids'], true)
    expect(fn(['1', 'abc', '3'])).toEqual([1, 'abc', 3])
  })

  it('reference-equal pass-through when nothing changed', () => {
    const schema = adapter(z.object({ ids: z.array(z.number()) }))
    const fn = buildCoerceFn(schema, ['ids'], true)
    const arr = [1, 2, 3]
    expect(fn(arr)).toBe(arr)
  })

  it('z.array(z.boolean()): string members coerced', () => {
    const schema = adapter(z.object({ flags: z.array(z.boolean()) }))
    const fn = buildCoerceFn(schema, ['flags'], true)
    expect(fn(['true', 'false', 'true'])).toEqual([true, false, true])
  })
})

describe('Set element coercion', () => {
  it('z.set(z.number()): string members coerced', () => {
    const schema = adapter(z.object({ tags: z.set(z.number()) }))
    const fn = buildCoerceFn(schema, ['tags'], true)
    const result = fn(new Set(['1', '2'])) as Set<unknown>
    expect([...result]).toEqual([1, 2])
  })

  it('z.set(z.boolean()): string members coerced', () => {
    const schema = adapter(z.object({ flags: z.set(z.boolean()) }))
    const fn = buildCoerceFn(schema, ['flags'], true)
    const result = fn(new Set(['true', 'false'])) as Set<unknown>
    expect([...result]).toEqual([true, false])
  })

  it('reference-equal pass-through when nothing changed', () => {
    const schema = adapter(z.object({ tags: z.set(z.number()) }))
    const fn = buildCoerceFn(schema, ['tags'], true)
    const s = new Set([1, 2, 3])
    expect(fn(s)).toBe(s)
  })
})

describe('array of permissive elements', () => {
  it('z.array(z.union([z.string(), z.number()])) → passthrough', () => {
    const schema = adapter(z.object({ flex: z.array(z.union([z.string(), z.number()])) }))
    const fn = buildCoerceFn(schema, ['flex'], true)
    const arr = ['1', 2, 'three']
    expect(fn(arr)).toBe(arr)
  })
})

describe('no rule targets a kind the library does not ship', () => {
  it('z.bigint() leaves a numeric-looking string alone', () => {
    // Only string->number and string->boolean ship. A path that accepts
    // bigint alone has no coercion target, so the slim gate: not this
    // layer, rules on the write.
    const schema = adapter(z.object({ amount: z.bigint() }))
    const fn = buildCoerceFn(schema, ['amount'], true)
    expect(fn('42')).toBe('42')
  })
})
