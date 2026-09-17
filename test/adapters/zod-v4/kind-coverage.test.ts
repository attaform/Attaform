/**
 * Structural kind coverage for the v4 introspector.
 *
 * `kindOf` answers `'unknown'` for a `def.type` it does not recognise,
 * and `'unknown'` is an OPAQUE kind: nothing descends into it and the
 * slim-primitive write gate stops gating, so any value is accepted at
 * that path. A kind Zod adds in a minor version therefore does not fail
 * loudly — it quietly turns off type checking for the fields that use it.
 * That is how `nonoptional` and `success` went unnoticed:
 * `z.string().optional().nonoptional()` accepted a number.
 *
 * So this does not enumerate the kinds we know about. It asks the
 * INSTALLED zod what `def.type` values it can produce and requires every
 * one of them to resolve, which is the #607 pattern: replace a list
 * someone has to remember to update with a rule the next zod minor
 * checks for us. A new kind fails this the day the dependency moves,
 * with the kind named in the message.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { kindOf } from '../../../src/runtime/adapters/zod-v4/introspect'

/**
 * Build one schema from every factory `zod` exports, and collect the
 * `def.type` each produces. The factories take wildly different
 * arguments, so this tries a few plausible shapes and skips a factory
 * that accepts none of them — under-reporting (a kind we never reach)
 * is safe, while over-reporting would make the suite flaky.
 *
 * Results are filtered to things that actually parse, because `zod`
 * exports more than schema factories: `ZodRealError` called as a plain
 * function returns an ERROR object that carries a `_zod.def` and would
 * otherwise be mistaken for a schema Attaform failed to recognise. The
 * test is for a `.parse` method rather than for the `def` the
 * introspector reads, so it stays an independent question rather than
 * restating the thing under test.
 */
function producibleSchemas(): Map<string, unknown> {
  const found = new Map<string, unknown>()
  const attempts: (() => unknown)[] = []
  const zodRecord = z as unknown as Record<string, unknown>
  for (const name of Object.keys(zodRecord)) {
    const factory = zodRecord[name]
    if (typeof factory !== 'function') continue
    const f = factory as (...args: unknown[]) => unknown
    attempts.push(
      () => f(),
      () => f(z.string()),
      () => f('literal-ish'),
      () => f({}),
      () => f(z.string(), z.string()),
      () => f('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })])
    )
  }
  for (const attempt of attempts) {
    let built: object | unknown
    try {
      built = attempt()
    } catch {
      continue
    }
    // A factory can legitimately return a primitive or nothing at all
    // for an argument shape it does not understand.
    if (built === null || typeof built !== 'object') continue
    // Some exports are parsers, not schema factories, and return a
    // promise that rejects. Swallow it here or it surfaces as an
    // unhandled rejection and fails the file from outside any test.
    const candidate: {
      then?: unknown
      parse?: unknown
      _zod?: { def?: { type?: unknown } }
    } = built
    if (typeof candidate.then === 'function') {
      void (built as Promise<unknown>).catch(() => undefined)
      continue
    }
    if (typeof candidate.parse !== 'function') continue
    const type = candidate._zod?.def?.type
    if (typeof type === 'string' && !found.has(type)) found.set(type, built)
  }
  return found
}

describe('every def.type the installed zod can produce resolves to a kind', () => {
  it('finds a representative set to check against', () => {
    // Guards the guard: if the probe stops building schemas (a zod major
    // that renames `_zod.def`, say), every assertion below passes
    // vacuously and the suite goes quiet exactly when it matters most.
    const types = [...producibleSchemas().keys()]
    expect(types.length).toBeGreaterThan(25)
    expect(types).toContain('object')
    expect(types).toContain('string')
  })

  it('resolves every one of them to something other than unknown', () => {
    const unresolved: string[] = []
    for (const [type, schema] of producibleSchemas()) {
      // `z.unknown()` legitimately IS the unknown kind; everything else
      // answering `'unknown'` is an unrecognised spelling.
      if (type === 'unknown') continue
      if (kindOf(schema) === 'unknown') unresolved.push(type)
    }
    expect(unresolved).toEqual([])
  })

  it('resolves the two kinds that were silently opaque', () => {
    // Pinned by name as well as by the rule above, because these two are
    // the reason the rule exists.
    expect(kindOf(z.string().optional().nonoptional())).toBe('nonoptional')
    expect(kindOf(z.success(z.string()))).toBe('success')
  })
})
