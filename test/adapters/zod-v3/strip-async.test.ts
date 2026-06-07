import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { stripAsyncChecks } from '../../../src/runtime/adapters/zod-v3/strip-async'

/**
 * v3 mirror of v4's `stripAsyncChecks` test suite
 * (`test/adapters/zod-v4/strip.test.ts:149-280`). The semantic
 * differs (v4 strips per-check via `isAsyncCheck`; v3 strips ALL
 * `ZodEffects` unconditionally — see `strip-async.ts` docblock for
 * the why), so the v3 cases pin the actual Path-A behavior rather
 * than mirroring v4 row-for-row.
 */
describe('stripAsyncChecks (v3)', () => {
  it('strips a top-level async refine so safeParse no longer throws', () => {
    const schema = z.string().refine(async () => Promise.resolve(true), 'x')
    expect(() => schema.safeParse('whatever')).toThrow()

    const stripped = stripAsyncChecks(schema)
    expect(() => stripped.safeParse('whatever')).not.toThrow()
    const result = stripped.safeParse('whatever')
    expect(result.success).toBe(true)
  })

  it('strips a sync refine too (v3 conservative — sync/async not statically distinguishable)', () => {
    // Path A trade-off: v3 can't tell sync from async refines, so the
    // strip drops both. Sync refine errors lose at construction;
    // container / leaf checks still seed (D3 win).
    const schema = z.string().refine(() => false, 'always-fails')
    const stripped = stripAsyncChecks(schema)
    const result = stripped.safeParse('anything')
    expect(result.success).toBe(true)
  })

  it('preserves container .min on z.array', () => {
    const schema = z.array(z.string()).min(1)
    const stripped = stripAsyncChecks(schema)
    const empty = stripped.safeParse([])
    expect(empty.success).toBe(false)
    const populated = stripped.safeParse(['a'])
    expect(populated.success).toBe(true)
  })

  it('preserves container .max on z.array', () => {
    const schema = z.array(z.string()).max(2)
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(['a', 'b']).success).toBe(true)
    expect(stripped.safeParse(['a', 'b', 'c']).success).toBe(false)
  })

  it('preserves container .length on z.array', () => {
    const schema = z.array(z.string()).length(2)
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(['a', 'b']).success).toBe(true)
    expect(stripped.safeParse(['a']).success).toBe(false)
  })

  it('preserves container .min/.max on z.set', () => {
    const schema = z.set(z.string()).min(1).max(2)
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(new Set()).success).toBe(false)
    expect(stripped.safeParse(new Set(['a'])).success).toBe(true)
    expect(stripped.safeParse(new Set(['a', 'b', 'c'])).success).toBe(false)
  })

  it('preserves .strict() on z.object', () => {
    const schema = z.object({ x: z.string() }).strict()
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ x: 'a' }).success).toBe(true)
    expect(stripped.safeParse({ x: 'a', extra: 1 }).success).toBe(false)
  })

  it('preserves leaf .email() / .min() / .max() checks', () => {
    const schema = z.object({ email: z.string().email().min(5).max(10) })
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ email: 'a@b.co' }).success).toBe(true)
    expect(stripped.safeParse({ email: 'nope' }).success).toBe(false)
  })

  it('strips nested refines in arrays while preserving container checks', () => {
    const schema = z.array(z.string().refine(() => false, 'leaf-refine')).min(1)
    const stripped = stripAsyncChecks(schema)
    // Container check survives.
    expect(stripped.safeParse([]).success).toBe(false)
    // Element refine dropped.
    expect(stripped.safeParse(['anything']).success).toBe(true)
  })

  it('seeds sync sibling checks when an async sibling would throw the original', () => {
    // The D2 / V4-2 case rephrased through stripAsyncChecks. Path A's
    // strip drops every refine, so the seeded errors are the
    // container / leaf checks the original parse couldn't even reach.
    const schema = z.object({
      items: z.array(z.string()).min(1),
      email: z.string().refine(async () => Promise.resolve(true), 'unreachable'),
    })
    expect(() => schema.safeParse({ items: [], email: 'a@b.co' })).toThrow()

    const stripped = stripAsyncChecks(schema)
    const result = stripped.safeParse({ items: [], email: 'a@b.co' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0])
      expect(paths).toContain('items')
    }
  })

  it('recurses through .optional() / .nullable() / .default(v)', () => {
    const schema = z.object({
      a: z
        .string()
        .refine(async () => Promise.resolve(true))
        .optional(),
      b: z
        .string()
        .refine(async () => Promise.resolve(true))
        .nullable(),
      c: z
        .string()
        .refine(async () => Promise.resolve(true))
        .default('seed'),
    })
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ a: undefined, b: null }).success).toBe(true)
  })

  it('terminates on z.lazy() schemas with cycles', () => {
    type Tree = { name: string; children: Tree[] }
    const treeSchema: z.ZodType<Tree> = z.lazy(() =>
      z.object({
        name: z.string().refine(() => true, 'unreachable'),
        children: z.array(treeSchema),
      })
    )
    const stripped = stripAsyncChecks(treeSchema)
    expect(stripped.safeParse({ name: 'root', children: [] }).success).toBe(true)
  })
})

// Branch coverage for the wrapper + container long tail, mirroring the
// v4 suite (`test/adapters/zod-v4/strip.test.ts`). v3 drops every
// ZodEffects wholesale, so each case puts a refine on / inside the kind
// and asserts the parse contract once the effect is gone.
describe('stripAsyncChecks (v3) — wrapper + container long tail', () => {
  it('recurses through .catch()', () => {
    const schema = z
      .string()
      .refine(() => false, 'x')
      .catch('fb')
    const stripped = stripAsyncChecks(schema)
    const parsed = stripped.safeParse('value')
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toBe('value')
  })

  it('recurses through .readonly()', () => {
    const schema = z
      .string()
      .refine(() => false, 'x')
      .readonly()
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse('value').success).toBe(true)
  })

  it('unwraps .brand() and strips the inner effect', () => {
    const schema = z
      .string()
      .refine(() => false, 'x')
      .brand('Branded')
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse('value').success).toBe(true)
  })

  it('recurses the input side of a .pipe()', () => {
    const schema = z.string().pipe(z.string().min(5))
    const stripped = stripAsyncChecks(schema)
    // The output leg (.min(5)) is dropped; the input string survives.
    expect(stripped.safeParse('ab').success).toBe(true)
  })

  it('strips effects inside z.tuple', () => {
    const schema = z.tuple([z.string().refine(() => false, 'x'), z.number()])
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse(['anything', 1]).success).toBe(true)
  })

  it('strips effects inside z.record (one-arg and two-arg forms)', () => {
    const oneArg = stripAsyncChecks(z.record(z.string().refine(() => false, 'x')))
    expect(oneArg.safeParse({ k: 'v' }).success).toBe(true)
    const twoArg = stripAsyncChecks(
      z.record(
        z.string(),
        z.string().refine(() => false, 'x')
      )
    )
    expect(twoArg.safeParse({ k: 'v' }).success).toBe(true)
  })

  it('strips effects inside z.union', () => {
    const schema = z.union([z.string().refine(() => false, 'x'), z.number()])
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse('anything').success).toBe(true)
  })

  it('strips effects inside z.discriminatedUnion variants', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), v: z.string().refine(() => false, 'x') }),
      z.object({ kind: z.literal('b'), n: z.number() }),
    ])
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ kind: 'a', v: 'anything' }).success).toBe(true)
  })

  it('recurses both sides of z.intersection', () => {
    const schema = z.intersection(
      z.object({ a: z.string().refine(() => false, 'x') }),
      z.object({ b: z.number() })
    )
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ a: 'anything', b: 1 }).success).toBe(true)
  })

  it('preserves .passthrough() on z.object', () => {
    const schema = z.object({ x: z.string() }).passthrough()
    const stripped = stripAsyncChecks(schema)
    const parsed = stripped.safeParse({ x: 'a', extra: 1 })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toMatchObject({ x: 'a', extra: 1 })
  })

  it('preserves .catchall() on z.object', () => {
    const schema = z.object({ x: z.string() }).catchall(z.number())
    const stripped = stripAsyncChecks(schema)
    expect(stripped.safeParse({ x: 'a', extra: 5 }).success).toBe(true)
    expect(stripped.safeParse({ x: 'a', extra: 'not-a-number' }).success).toBe(false)
  })
})
