/**
 * One `AbstractSchema` per schema, not per form.
 *
 * An `AbstractSchema` answers questions about a SCHEMA. It holds no
 * form state, and since the form key left the contract there is nothing
 * left in it that could differ between two forms declaring the same
 * schema. Building one per `useForm()` callsite minted 19 methods, 18
 * service closures, 5 memos and 3 flags per form, 3,457 B, to hold
 * answers identical to the ones the form next door already had.
 *
 * Three things have to hold for that sharing to be safe, and each has a
 * group below:
 *
 *  - two forms on one schema get ONE instance, and two forms on two
 *    schemas do not;
 *  - the instance releases when the schema does, so a runtime-built
 *    schema is not pinned for the life of the process;
 *  - the per-path memos inside it are BOUNDED. This is the one that
 *    changed character with sharing: a path can carry a record key or
 *    an array index the consumer invents at runtime, so the key domain
 *    is unbounded even though the schema is finite. Per-form, that grew
 *    until unmount. Per-schema, it would grow until the schema died,
 *    which for a module-level schema is never.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodAdapter as zodV4Adapter } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodV3Adapter } from '../../src/runtime/adapters/zod-v3'
import { MEMO_CAP, memoPut } from '../../src/runtime/core/abstract-schema-factory'
import type { PathKey } from '../../src/runtime/core/paths'

const hasGc = typeof globalThis.gc === 'function'

const v4Schema = z.object({
  name: z.string(),
  prefs: z.record(z.string(), z.object({ at: z.string() })),
})
const v3Schema = zV3.object({
  name: zV3.string(),
  prefs: zV3.record(zV3.string(), zV3.object({ at: zV3.string() })),
})

/** The two majors, each with a fresh schema factory for the churn cases. */
const adapters = [
  {
    name: 'v4',
    schema: v4Schema as unknown as object,
    build: (schema: object) => zodV4Adapter(schema as typeof v4Schema),
    fresh: () =>
      z.object({
        name: z.string(),
        prefs: z.record(z.string(), z.object({ at: z.string() })),
      }) as unknown as object,
    other: () => z.object({ other: z.string() }) as unknown as object,
  },
  {
    name: 'v3',
    schema: v3Schema as unknown as object,
    build: (schema: object) => zodV3Adapter(schema as typeof v3Schema),
    fresh: () =>
      zV3.object({
        name: zV3.string(),
        prefs: zV3.record(zV3.string(), zV3.object({ at: zV3.string() })),
      }) as unknown as object,
    other: () => zV3.object({ other: zV3.string() }) as unknown as object,
  },
] as const

type Built = { isLeafAtPath(path: readonly (string | number)[]): boolean }

function instance(schema: object, build: (s: object) => unknown, key: string, depth = 64): Built {
  const factory = build(schema) as (k: string, o: { maxRecursionDepth: number }) => Built
  return factory(key, { maxRecursionDepth: depth })
}

describe.each(adapters)('shared AbstractSchema — $name', ({ schema, build, fresh, other }) => {
  it('hands two forms on one schema the same instance', () => {
    // Different keys, different adapter-factory calls: the shared thing
    // is keyed on the SCHEMA, not on either of those.
    expect(instance(schema, build, 'form-a')).toBe(instance(schema, build, 'form-b'))
  })

  it('does not share across two schemas of the same shape', () => {
    // Structural equality is not identity. Two schema objects are two
    // schemas, even when they declare the same fields.
    expect(instance(fresh(), build, 'k')).not.toBe(instance(fresh(), build, 'k'))
  })

  it('does not share across two schemas outright', () => {
    expect(instance(schema, build, 'k')).not.toBe(instance(other(), build, 'k'))
  })

  it('does not share across two recursion depths', () => {
    // `maxRecursionDepth` is baked into the walks, so it is part of the
    // identity of the answers, not a detail of the caller.
    expect(instance(schema, build, 'k', 8)).not.toBe(instance(schema, build, 'k', 64))
  })

  it('keeps answering correctly past the memo cap', () => {
    // Past the cap the memo is dropped wholesale, so every answer below
    // is recomputed at least once. A cap that dropped answers on the
    // floor rather than recomputing them fails right here.
    const built = instance(fresh(), build, 'k')
    for (let i = 0; i < MEMO_CAP + 2_000; i++) {
      expect(built.isLeafAtPath(['prefs', `k${i}`, 'at'])).toBe(true)
    }
    expect(built.isLeafAtPath(['prefs', 'k0', 'at'])).toBe(true)
    expect(built.isLeafAtPath(['name'])).toBe(true)
    expect(built.isLeafAtPath(['prefs'])).toBe(false)
  })
})

describe('the per-path memo bound', () => {
  // The size half of the same contract, on the helper itself: what the
  // case above cannot see from outside is whether the memo GREW. It is
  // the sharing that makes this load-bearing. A memo of invented record
  // keys used to die with its form; it now lives as long as the schema,
  // which for a module-level schema is the life of the process.
  it('never grows past the cap', () => {
    const memo = new Map<PathKey, number>()
    for (let i = 0; i < MEMO_CAP * 3; i++) {
      memoPut(memo, `["k${i}"]` as PathKey, i)
      expect(memo.size).toBeLessThanOrEqual(MEMO_CAP)
    }
  })

  it('returns the value it stored, including the entry that tripped the cap', () => {
    const memo = new Map<PathKey, number>()
    for (let i = 0; i < MEMO_CAP; i++) memoPut(memo, `["k${i}"]` as PathKey, i)
    expect(memo.size).toBe(MEMO_CAP)
    // The write that finds the memo full clears it and then stores, so
    // the caller still gets its own answer back rather than a hole.
    const tripped = memoPut(memo, '["last"]' as PathKey, 42)
    expect(tripped).toBe(42)
    expect(memo.size).toBe(1)
    expect(memo.get('["last"]' as PathKey)).toBe(42)
  })
})

describe.skipIf(!hasGc).each(adapters)(
  'shared AbstractSchema releases with its schema — $name',
  ({ build, fresh }) => {
    /** Force collection hard enough for a WeakRef to clear. */
    async function collect(): Promise<void> {
      for (let i = 0; i < 5; i++) {
        globalThis.gc?.()
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
    }

    async function survivors(hold: boolean): Promise<number> {
      const refs: WeakRef<object>[] = []
      const pinned: object[] = []
      for (let i = 0; i < 20; i++) {
        // The IIFE keeps this scope from holding either the schema or
        // the instance, which would retain the thing under measurement.
        const ref = ((): WeakRef<object> => {
          const schema = fresh()
          if (hold) pinned.push(schema)
          return new WeakRef(instance(schema, build, `k${i}`) as unknown as object)
        })()
        refs.push(ref)
      }
      await collect()
      // Keep `pinned` reachable across the collection.
      expect(pinned.length).toBe(hold ? 20 : 0)
      return refs.filter((ref) => ref.deref() !== undefined).length
    }

    it('keeps the instance while the schema is reachable (control)', async () => {
      // The control proves the harness can report a survivor at all,
      // before the next case reports zero and claims that means release.
      expect(await survivors(true)).toBeGreaterThan(0)
    })

    it('releases the instance once the schema is unreachable', async () => {
      expect(await survivors(false)).toBe(0)
    })
  }
)
