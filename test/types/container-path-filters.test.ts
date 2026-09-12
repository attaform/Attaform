import { describe, expectTypeOf, it } from 'vitest'
import { z as z4 } from 'zod'
import { z as z3 } from 'zod-v3'
import type { UseFormReturn } from '../../src/zod'

/**
 * Standing pin for the two container-path filters, `ArrayPath` and
 * `RecordPath`, plus the `ArrayItem` / `RecordValue` extractors that
 * ride on them.
 *
 * `Form` is the schema's INPUT shape, so `.default()` / `.optional()`
 * make a leaf `T | undefined`, and `NestedType` tags a discriminated
 * union's per-variant keys the same way. Both filters used to read that
 * tag as "not a container" and drop the path, which took every
 * optional, defaulted, nullable and DU-variant array out of the seven
 * field-array helpers and out of `form.list` / `form.record`, while the
 * runtime accepted all of them (#541). The matrix below is one schema
 * per shape so a filter that narrows again fails here rather than in a
 * consumer's app.
 *
 * The last block pins something the filters do not own: the interior
 * discriminated union's own sub-paths in `FlatPath`. #541 reported
 * those missing on zod 4.3.6 and they resolve on 4.4.3 with Attaform's
 * walker unchanged, so that half of the report was fixed upstream, by
 * nobody here, and can regress the same way.
 *
 * Compile-time only. `useForm` needs a Vue app context, and only the
 * types the checker sees matter, so every call below runs against a
 * recursive Proxy typed as the real return. Same device as
 * `discriminated-union-root.test.ts`. `pnpm typecheck` is the gate.
 */

function formStandIn<Schema>(): UseFormReturn<Schema> {
  const handler: ProxyHandler<() => unknown> = {
    get: () => proxy,
    apply: () => proxy,
  }
  const proxy: unknown = new Proxy(() => undefined, handler)
  return proxy as UseFormReturn<Schema>
}

// --- zod v4 matrix ---------------------------------------------------

const _row4 = z4.object({ a: z4.string() })
const _income4 = z4.discriminatedUnion('exists', [
  z4.object({ exists: z4.literal(true), entries: z4.array(_row4).min(1) }),
  z4.object({ exists: z4.literal(false), entries: z4.array(_row4).max(0).default([]) }),
])
const _schema4 = z4.object({
  plain: z4.array(_row4),
  defaulted: z4.array(_row4).default([]),
  optional: z4.array(_row4).optional(),
  nullable: z4.array(_row4).nullable(),
  strings: z4.array(z4.string()).default([]),
  rec: z4.record(z4.string(), z4.number()),
  recDefaulted: z4.record(z4.string(), z4.number()).default({}),
  recOptional: z4.record(z4.string(), z4.number()).optional(),
  scalar: z4.string(),
  scalarOptional: z4.string().optional(),
  obj: z4.object({ k: z4.string() }),
  objOptional: z4.object({ k: z4.string() }).optional(),
  // Symmetric DU: `entries` is in both variants, one of them defaulted.
  income: _income4,
  // Asymmetric DU: `crates` is in one variant only.
  shipment: z4.discriminatedUnion('kind', [
    z4.object({ kind: z4.literal('bulk'), crates: z4.array(_row4) }),
    z4.object({ kind: z4.literal('single'), note: z4.string() }),
  ]),
  members: z4.array(z4.object({ income: _income4 })),
})

const form4 = formStandIn<typeof _schema4>()

describe('ArrayPath — every array leaf is addressable, optional or not (v4)', () => {
  it('admits required, defaulted, optional and nullable arrays', () => {
    form4.append('plain', { a: 'x' })
    form4.append('defaulted', { a: 'x' })
    form4.append('optional', { a: 'x' })
    form4.append('nullable', { a: 'x' })
    form4.append('strings', 'x')
  })

  it('admits an array reached through a discriminated union', () => {
    // Symmetric variants, one arm defaulted: the exact #541 shape.
    form4.append('income.entries', { a: 'x' })
    // Present in one variant only.
    form4.append('shipment.crates', { a: 'x' })
    // The same DU nested inside an array element.
    form4.append('members.0.income.entries', { a: 'x' })
  })

  it('admits the defaulted array on all seven helpers and on list', () => {
    form4.append('defaulted', { a: 'x' })
    form4.prepend('defaulted', { a: 'x' })
    form4.insert('defaulted', 0, { a: 'x' })
    form4.remove('defaulted', 0)
    form4.swap('defaulted', 0, 1)
    form4.move('defaulted', 0, 1)
    form4.replace('defaulted', 0, { a: 'x' })
    form4.list('defaulted')
  })

  it('keeps non-arrays out', () => {
    // @ts-expect-error a string leaf is not an array
    form4.append('scalar', 'x')
    // @ts-expect-error an optional string leaf is still not an array
    form4.append('scalarOptional', 'x')
    // @ts-expect-error a fixed-shape object is not an array
    form4.append('obj', { k: 'x' })
    // @ts-expect-error an optional fixed-shape object is not an array either
    form4.append('objOptional', { k: 'x' })
    // @ts-expect-error a record is not an array
    form4.append('rec', 1)
    // @ts-expect-error the discriminant is a boolean leaf
    form4.append('income.exists', true)
    // @ts-expect-error no such path
    form4.append('nope', { a: 'x' })
  })
})

describe('ArrayItem — an admitted path resolves its element type (v4)', () => {
  it('resolves through optionality, defaults and DU variants', () => {
    expectTypeOf(form4.list('defaulted')[0]?.value).toEqualTypeOf<{ a: string } | undefined>()
    expectTypeOf(form4.list('optional')[0]?.value).toEqualTypeOf<{ a: string } | undefined>()
    expectTypeOf(form4.list('nullable')[0]?.value).toEqualTypeOf<{ a: string } | undefined>()
    expectTypeOf(form4.list('strings')[0]?.value).toEqualTypeOf<string | undefined>()
    expectTypeOf(form4.list('income.entries')[0]?.value).toEqualTypeOf<{ a: string } | undefined>()
    expectTypeOf(form4.list('shipment.crates')[0]?.value).toEqualTypeOf<{ a: string } | undefined>()
  })

  it('rejects an element of the wrong shape', () => {
    // @ts-expect-error element is `{ a: string }`, not `{ b: number }`
    form4.append('defaulted', { b: 1 })
    // @ts-expect-error element is `string`
    form4.append('strings', 1)
  })
})

describe('RecordPath / RecordValue — records survive the same shapes (v4)', () => {
  it('admits required, defaulted and optional records', () => {
    form4.record('rec')
    form4.record('recDefaulted')
    form4.record('recOptional')
  })

  it('resolves the record value type', () => {
    expectTypeOf(form4.record('rec')['k']?.value).toEqualTypeOf<number | undefined>()
    expectTypeOf(form4.record('recDefaulted')['k']?.value).toEqualTypeOf<number | undefined>()
    expectTypeOf(form4.record('recOptional')['k']?.value).toEqualTypeOf<number | undefined>()
  })

  it('keeps fixed-shape objects and arrays out', () => {
    // @ts-expect-error statically known keys, no string index signature
    form4.record('obj')
    // @ts-expect-error optionality does not turn a fixed object into a record
    form4.record('objOptional')
    // @ts-expect-error an array is not a record
    form4.record('plain')
    // @ts-expect-error a defaulted array is not a record either
    form4.record('defaulted')
  })
})

describe('FlatPath — an interior DU offers its variant sub-paths (v4)', () => {
  it('addresses the discriminant and the shared variant field', () => {
    // Fixed upstream between zod 4.3.6 and 4.4.3, not here. Pinned so a
    // zod release that walks a discriminated union differently fails in
    // this repo instead of in a consumer's editor.
    form4.setValue('income.exists', false)
    form4.setValue(['income', 'exists'], false)
    form4.setValue('shipment.note', 'x')
    form4.values('income.entries')
  })

  it('addresses a variant sub-path through an array element', () => {
    form4.setValue('members.0.income.exists', true)
    form4.values('members.0.income.entries')
  })
})

// --- zod v3 matrix ---------------------------------------------------

const _row3 = z3.object({ a: z3.string() })
const _income3 = z3.discriminatedUnion('exists', [
  z3.object({ exists: z3.literal(true), entries: z3.array(_row3).min(1) }),
  z3.object({ exists: z3.literal(false), entries: z3.array(_row3).max(0).default([]) }),
])
const _schema3 = z3.object({
  plain: z3.array(_row3),
  defaulted: z3.array(_row3).default([]),
  optional: z3.array(_row3).optional(),
  nullable: z3.array(_row3).nullable(),
  strings: z3.array(z3.string()).default([]),
  rec: z3.record(z3.string(), z3.number()),
  recDefaulted: z3.record(z3.string(), z3.number()).default({}),
  recOptional: z3.record(z3.string(), z3.number()).optional(),
  scalar: z3.string(),
  obj: z3.object({ k: z3.string() }),
  income: _income3,
  members: z3.array(z3.object({ income: _income3 })),
})

const form3 = formStandIn<typeof _schema3>()

describe('container-path filters hold identically on the v3 adapter', () => {
  it('admits every array leaf', () => {
    form3.append('plain', { a: 'x' })
    form3.append('defaulted', { a: 'x' })
    form3.append('optional', { a: 'x' })
    form3.append('nullable', { a: 'x' })
    form3.append('strings', 'x')
    form3.append('income.entries', { a: 'x' })
    form3.append('members.0.income.entries', { a: 'x' })
    form3.list('defaulted')
  })

  it('admits every record leaf', () => {
    form3.record('rec')
    form3.record('recDefaulted')
    form3.record('recOptional')
  })

  it('resolves element and value types', () => {
    expectTypeOf(form3.list('defaulted')[0]?.value).toEqualTypeOf<{ a: string } | undefined>()
    expectTypeOf(form3.list('strings')[0]?.value).toEqualTypeOf<string | undefined>()
    expectTypeOf(form3.record('recDefaulted')['k']?.value).toEqualTypeOf<number | undefined>()
  })

  it('keeps non-containers out', () => {
    // @ts-expect-error a string leaf is not an array
    form3.append('scalar', 'x')
    // @ts-expect-error a fixed-shape object is not an array
    form3.append('obj', { k: 'x' })
    // @ts-expect-error element is `{ a: string }`, not `{ b: number }`
    form3.append('defaulted', { b: 1 })
    // @ts-expect-error statically known keys, no string index signature
    form3.record('obj')
    // @ts-expect-error an array is not a record
    form3.record('defaulted')
  })

  it('offers the interior DU variant sub-paths', () => {
    form3.setValue('income.exists', false)
    form3.setValue('members.0.income.exists', true)
    form3.values('income.entries')
  })
})
