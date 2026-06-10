/**
 * Standing lock for the Bust 3 init optimization (targeted single-pass
 * authored-path derivation).
 *
 * `create-form-store`'s `rebuildAuthoredPaths` learns which paths the
 * schema author declared a `.default()` at by diffing the with-defaults
 * value tree against the schema's BLANK baseline. That baseline used to
 * come from a second full `getDefaultValues({ useDefaultSchemaValues:
 * false })` pass — a whole-schema clone (`getSlimSchema`) plus up to two
 * `safeParse`s — even though the diff only ever reads the value tree.
 *
 * Bust 3 swaps that pass for the raw `deriveDefault(false)` walk the
 * factory already exposes as `getEmptyValueAtPath([])`, which is ~32x
 * cheaper. This file is the proof the swap is observationally inert: the
 * raw baseline is STRUCTURALLY identical to the old slim-parsed one, so
 * the authored-path set (which feeds `filterAuthoredErrors`, i.e. which
 * mount-time verdicts a consumer sees) is unchanged. Locked on BOTH
 * adapters because the `.catch()` / chain-peel semantics diverge between
 * them and the equivalence has to hold for each.
 *
 * If a future change makes `getEmptyValueAtPath([])` and the slim
 * `getDefaultValues(false)` pass drift, this fails — that drift would
 * silently move authored-path filtering, so it must surface here.
 */
import { describe, it, expect } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodAdapter as zodV4Adapter } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodV3Adapter } from '../../src/runtime/adapters/zod-v3'

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Mirror of `create-form-store`'s module-private `walkAuthoredFromSchemaDiff`
 * (key format is irrelevant to the assertion, so a plain join stands in for
 * the canonicalized PathKey). Marks every leaf whose value differs between
 * the with-defaults tree and the blank baseline.
 */
function authoredFromDiff(
  withDefaults: unknown,
  baseline: unknown,
  prefix: (string | number)[],
  out: Set<string>
): void {
  if (isPlainRecord(withDefaults) && isPlainRecord(baseline)) {
    const keys = new Set<string>([...Object.keys(withDefaults), ...Object.keys(baseline)])
    for (const k of keys) authoredFromDiff(withDefaults[k], baseline[k], [...prefix, k], out)
    return
  }
  if (Array.isArray(withDefaults) && Array.isArray(baseline)) {
    const len = Math.max(withDefaults.length, baseline.length)
    for (let i = 0; i < len; i++)
      authoredFromDiff(withDefaults[i], baseline[i], [...prefix, i], out)
    return
  }
  if (!Object.is(withDefaults, baseline) && prefix.length > 0) out.add(prefix.join('.'))
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS: Array<{ tag: string; z: any; adapter: any }> = [
  { tag: 'v4', z: zV4, adapter: zodV4Adapter },
  { tag: 'v3', z: zV3, adapter: zodV3Adapter },
]

describe.each(ADAPTERS)('authored-baseline equivalence [$tag]', ({ z, adapter }) => {
  // Each shape stresses a different corner of the with-defaults-vs-blank
  // diff: a plain pass-through, a value default, a default that COINCIDES
  // with the leaf empty (must NOT register as authored), an explicit
  // `.default(undefined)`, nesting, `.catch()` (adapter-divergent),
  // optional-wrapped default (chain-peel), array-of-objects, typed
  // empties, and a discriminated union's first-option seeding.
  const shapes: Record<string, any> = {
    flatStrings: z.object({ a: z.string(), b: z.string() }),
    defaultValue: z.object({ a: z.string().default('x'), b: z.number() }),
    defaultEqualsEmpty: z.object({ a: z.string().default('') }),
    defaultUndefined: z.object({ a: z.string().default(undefined as unknown as string) }),
    nested: z.object({ outer: z.object({ inner: z.string().default('seed'), plain: z.string() }) }),
    catchValue: z.object({ a: z.string().catch('c'), b: z.string() }),
    optionalDefault: z.object({ a: z.string().default('x').optional() }),
    arrayOfObjects: z.object({ rows: z.array(z.object({ n: z.string().default('d') })) }),
    typedEmpties: z.object({ n: z.number(), b: z.boolean(), d: z.date(), e: z.enum(['x', 'y']) }),
    discriminatedUnion: z.object({
      du: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), x: z.string().default('dx') }),
        z.object({ kind: z.literal('b'), y: z.number() }),
      ]),
    }),
  }

  for (const [name, schema] of Object.entries(shapes)) {
    const built = adapter(schema)('authored-baseline-probe', { maxRecursionDepth: 64 })

    it(`raw blank baseline equals the slim-parsed baseline — ${name}`, () => {
      const slimPassBaseline = built.getDefaultValues({
        useDefaultSchemaValues: false,
        strict: true,
      }).data
      const rawBaseline = built.getEmptyValueAtPath([])
      expect(rawBaseline).toStrictEqual(slimPassBaseline)
    })

    it(`authored-path set is identical from either baseline — ${name}`, () => {
      const withDefaults = built.getDefaultValues({
        useDefaultSchemaValues: true,
        constraints: undefined,
        strict: true,
      }).data
      const slimPassBaseline = built.getDefaultValues({
        useDefaultSchemaValues: false,
        strict: true,
      }).data
      const rawBaseline = built.getEmptyValueAtPath([])

      const viaSlimPass = new Set<string>()
      authoredFromDiff(withDefaults, slimPassBaseline, [], viaSlimPass)
      const viaRaw = new Set<string>()
      authoredFromDiff(withDefaults, rawBaseline, [], viaRaw)

      expect([...viaRaw].sort()).toStrictEqual([...viaSlimPass].sort())
    })
  }
})
