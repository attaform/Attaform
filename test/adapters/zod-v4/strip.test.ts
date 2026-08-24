import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { stripAsyncChecks } from '../../../src/runtime/adapters/zod-v4/strip'

describe('stripAsyncChecks', () => {
  it('strips a top-level async refine so safeParse no longer throws', () => {
    const schema = z.string().refine(async (v) => Promise.resolve(v === 'OK'), 'must be OK')
    // Sanity: original throws on sync safeParse.
    expect(() => schema.safeParse('OK')).toThrow()
    const stripped = stripAsyncChecks(schema)
    expect(() => stripped.safeParse('OK')).not.toThrow()
    expect(stripped.safeParse('OK').success).toBe(true)
    // Async check stripped → previously-failing 'nope' now passes.
    expect(stripped.safeParse('nope').success).toBe(true)
  })

  it('preserves a sync refine while stripping a co-located async refine', () => {
    const schema = z
      .string()
      .refine(async (v) => Promise.resolve(v.length > 0), 'must be non-empty (async)')
      .refine((v) => v !== 'banned', 'banned word (sync)')
    const stripped = stripAsyncChecks(schema)
    // Sync survives — 'banned' rejected, with the sync message.
    const banned = stripped.safeParse('banned')
    expect(banned.success).toBe(false)
    if (!banned.success) {
      expect(banned.error.issues[0]?.message).toBe('banned word (sync)')
    }
    // Async stripped — empty string no longer rejected.
    expect(stripped.safeParse('').success).toBe(true)
  })

  it('seeds sync sibling errors when an async sibling would throw the original', () => {
    const schema = z.object({
      word: z.string().refine((v) => v.length > 0, 'word required'),
      email: z.email().refine(async (v) => Promise.resolve(v !== 'taken@x.com'), 'taken'),
    })
    expect(() => schema.safeParse({ word: '', email: 'a@b.com' })).toThrow()
    const stripped = stripAsyncChecks(schema)
    const result = stripped.safeParse({ word: '', email: 'a@b.com' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain('word required')
      // Async refine error must NOT appear — it was stripped.
      expect(messages).not.toContain('taken')
    }
  })

  it('strips a cross-field async refine at the object root, preserving sync child refines', () => {
    const schema = z
      .object({ word: z.string().refine((v) => v.length > 0, 'word required') })
      .refine(async (data) => Promise.resolve(data.word.length < 100), 'too long (async)')
    expect(() => schema.safeParse({ word: '' })).toThrow()
    const stripped = stripAsyncChecks(schema)
    const result = stripped.safeParse({ word: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('word required')
    }
  })

  it('recurses through .optional()', () => {
    const schema = z
      .string()
      .refine(async (v) => Promise.resolve(v === 'OK'))
      .optional()
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(undefined).success).toBe(true)
    expect(stripped.safeParse('anything').success).toBe(true)
  })

  it('recurses through .nullable()', () => {
    const schema = z
      .string()
      .refine(async () => Promise.resolve(true))
      .nullable()
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(null).success).toBe(true)
    expect(stripped.safeParse('value').success).toBe(true)
  })

  it('recurses through .default(v)', () => {
    const schema = z
      .string()
      .refine(async () => Promise.resolve(true))
      .default('seed')
    const stripped = stripAsyncChecks(schema)
    const result = stripped.safeParse(undefined)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('seed')
  })

  it('strips async checks inside discriminated-union variants independently', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('a'),
        x: z.string().refine((v) => v.length > 0, 'x required'),
      }),
      z.object({
        kind: z.literal('b'),
        y: z.string().refine(async (v) => Promise.resolve(v === 'OK'), 'y must be OK'),
      }),
    ])
    expect(() => schema.safeParse({ kind: 'b', y: 'nope' })).toThrow()
    const stripped = stripAsyncChecks(schema)
    // Variant b: async stripped, anything passes for y.
    expect(stripped.safeParse({ kind: 'b', y: 'nope' }).success).toBe(true)
    // Variant a: sync refine survives.
    const result = stripped.safeParse({ kind: 'a', x: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('x required')
    }
  })

  it('terminates on z.lazy() schemas with async refines (cycle-safe)', () => {
    type Tree = { name: string; children: Tree[] }
    const treeSchema: z.ZodType<Tree> = z.lazy(() =>
      z.object({
        name: z.string().refine(async (v) => Promise.resolve(v.length > 0), 'name required'),
        children: z.array(treeSchema),
      })
    )
    // Smoke: stripAsyncChecks must not infinite-loop.
    const stripped = stripAsyncChecks(treeSchema)
    expect(stripped.safeParse({ name: '', children: [] }).success).toBe(true)
  })

  it('passes pure-sync schemas through behaviourally unchanged', () => {
    const schema = z.object({
      a: z.string().min(3, 'min 3'),
      b: z.number().int().positive(),
    })
    const stripped = stripAsyncChecks(schema)
    // Same parse verdicts — sync schemas have no async checks to strip.
    expect(stripped.safeParse({ a: 'ab', b: 1 }).success).toBe(false)
    expect(stripped.safeParse({ a: 'abc', b: 1 }).success).toBe(true)
    expect(stripped.safeParse({ a: 'abc', b: -1 }).success).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// Branch coverage for the long tail of the kind switch. The blocks
// above assert the high-value paths; these reach the container,
// wrapper, and leaf cases that production schemas hit less often. Every
// assertion is on the parse/derivation CONTRACT, except the deliberate
// identity (`toBe`) checks, which ARE the contract for pass-through
// leaves.
// ───────────────────────────────────────────────────────────────────

describe('stripAsyncChecks — container long tail', () => {
  it('strips an async refine inside z.array', () => {
    const schema = z.array(z.string().refine(async () => Promise.resolve(false), 'a'))
    const stripped = stripAsyncChecks(schema)
    expect(() => stripped.safeParse(['x'])).not.toThrow()
    expect(stripped.safeParse(['x']).success).toBe(true)
  })

  it('strips an async refine inside z.set', () => {
    const schema = z.set(z.string().refine(async () => Promise.resolve(false), 'a'))
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(new Set(['x'])).success).toBe(true)
  })

  it('strips an async refine inside z.tuple', () => {
    const schema = z.tuple([z.string().refine(async () => Promise.resolve(false), 'a')])
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(['x']).success).toBe(true)
  })

  it('strips an async refine inside z.record', () => {
    const schema = z.record(
      z.string(),
      z.string().refine(async () => Promise.resolve(false), 'a')
    )
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ k: 'x' }).success).toBe(true)
  })

  it('strips an async refine inside z.union', () => {
    const schema = z.union([z.string().refine(async () => Promise.resolve(false), 'a'), z.number()])
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse('x').success).toBe(true)
  })

  it('strips async checks on number / bigint leaves', () => {
    const num = stripAsyncChecks(z.number().refine(async () => Promise.resolve(false), 'a'))
    expect(num.safeParse(5).success).toBe(true)
    const big = stripAsyncChecks(z.bigint().refine(async () => Promise.resolve(false), 'a'))
    expect(big.safeParse(5n).success).toBe(true)
  })

  it('recurses through .readonly()', () => {
    const schema = z
      .string()
      .refine(async () => Promise.resolve(false), 'a')
      .readonly()
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse('x').success).toBe(true)
  })

  it('recurses through z.intersection', () => {
    const schema = z.intersection(
      z.object({ a: z.string().refine(async () => Promise.resolve(false), 'a') }),
      z.object({ b: z.number() })
    )
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ a: 'x', b: 1 }).success).toBe(true)
  })

  it('recurses through .catch()', () => {
    const schema = z
      .string()
      .refine(async () => Promise.resolve(false), 'a')
      .catch('fb')
    const stripped = stripAsyncChecks(schema)
    const parsed = stripped.safeParse('x')
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toBe('x')
  })

  it('leaves a pipe / transform unchanged (async surfaces from the inner catch)', () => {
    const p = z.string().transform((s) => s.length)
    expect(stripAsyncChecks(p)).toBe(p)
  })

  it('passes pure-sync leaves through by identity', () => {
    const leaves: ReadonlyArray<z.ZodType> = [
      z.boolean(),
      z.date(),
      z.literal('x'),
      z.null(),
      z.undefined(),
      z.nan(),
      z.symbol(),
      z.file(),
      z.map(z.string(), z.number()),
    ]
    for (const leaf of leaves) {
      expect(stripAsyncChecks(leaf)).toBe(leaf)
    }
  })
})
