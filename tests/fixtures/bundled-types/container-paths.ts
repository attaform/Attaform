/**
 * Bundled-types guard for the two container-path filters through the
 * published artifact.
 *
 * `ArrayPath` / `RecordPath` used to test the resolved leaf with a bare
 * `extends readonly unknown[]`, and `Form` is the schema's input shape,
 * so one `.default([])`, `.optional()` or `.nullable()` made the leaf
 * `T | undefined` and the path left the union, as did every array
 * reached through a discriminated-union variant. The runtime accepted
 * all of them (#541). The in-repo suite pins this against `src`; this
 * fixture pins it against the bundled `.d.ts`, where a `rollup-plugin-dts`
 * inlining change could reintroduce the narrowing on its own.
 *
 * It also pins the four path aliases as named exports, so dropping one
 * from the barrel fails here rather than in a consumer's editor.
 */
import { z } from 'zod'
import { useForm } from 'attaform/zod'
import type { ArrayItem, ArrayPath, RecordPath, RecordValue } from 'attaform'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const row = z.object({ a: z.string() })
const containerSchema = z.object({
  plain: z.array(row),
  defaulted: z.array(row).default([]),
  optional: z.array(row).optional(),
  nullable: z.array(row).nullable(),
  rec: z.record(z.string(), z.number()),
  recDefaulted: z.record(z.string(), z.number()).default({}),
  scalar: z.string(),
  obj: z.object({ k: z.string() }),
  income: z.discriminatedUnion('exists', [
    z.object({ exists: z.literal(true), entries: z.array(row).min(1) }),
    z.object({ exists: z.literal(false), entries: z.array(row).max(0).default([]) }),
  ]),
})

const form = useForm({ schema: containerSchema, key: 'containers-v4' })

// Every array leaf is a field-array path, absent-capable or not.
form.append('plain', { a: 'x' })
form.append('defaulted', { a: 'x' })
form.append('optional', { a: 'x' })
form.append('nullable', { a: 'x' })
form.append('income.entries', { a: 'x' })
form.prepend('defaulted', { a: 'x' })
form.insert('defaulted', 0, { a: 'x' })
form.remove('defaulted', 0)
form.swap('defaulted', 0, 1)
form.move('defaulted', 0, 1)
form.replace('defaulted', 0, { a: 'x' })
form.list('defaulted')

// Every record leaf is a record path.
form.record('rec')
form.record('recDefaulted')

// An admitted path resolves its element / value type rather than `never`.
type _ElValue = Expect<
  Equal<ReturnType<typeof form.list<'defaulted'>>[number]['value'], { a: string }>
>
type _RecValue = Expect<
  Equal<ReturnType<typeof form.record<'recDefaulted'>>[string]['value'], number>
>

// Non-containers stay rejected.
// @ts-expect-error a string leaf is not an array
form.append('scalar', 'x')
// @ts-expect-error a fixed-shape object is not an array
form.append('obj', { k: 'x' })
// @ts-expect-error element is `{ a: string }`
form.append('defaulted', { b: 1 })
// @ts-expect-error a fixed-shape object has no string index signature
form.record('obj')
// @ts-expect-error an array is not a record
form.record('defaulted')

// The interior discriminated union offers its variant sub-paths.
form.setValue('income.exists', false)
form.values('income.entries')

// The four aliases are importable and behave on a plain form shape.
type Shape = {
  rows?: { a: string }[]
  scores?: Record<string, number>
  name: string
}
type _ArrayPath = Expect<Equal<Extract<ArrayPath<Shape>, 'rows'>, 'rows'>>
type _NotArrayPath = Expect<Equal<Extract<ArrayPath<Shape>, 'name'>, never>>
type _ArrayItem = Expect<Equal<ArrayItem<Shape, 'rows'>, { a: string }>>
type _RecordPath = Expect<Equal<Extract<RecordPath<Shape>, 'scores'>, 'scores'>>
type _NotRecordPath = Expect<Equal<Extract<RecordPath<Shape>, 'rows'>, never>>
type _RecordValue = Expect<Equal<RecordValue<Shape, 'scores'>, number>>

export { form }
