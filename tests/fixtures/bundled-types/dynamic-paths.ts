/**
 * Bundled-types guard for paths whose segments are only known at
 * runtime, through the published artifact.
 *
 * #568 reported that a `z.record` segment types as `never` in
 * `register()`, making the untyped `injectForm(key)` escape the only
 * way through, per component rather than per path. The record segment
 * was not the cause. It widens correctly and always has: a record
 * contributes `${string}` to the path union, so a dynamic key is
 * accepted on every path-addressed API. What actually failed was an
 * opaque `string` PREFIX, which is not record-specific and fails the
 * same way on a path with no record in it at all (see the negative
 * block at the bottom).
 *
 * The distinction only stays true if something holds it, so this
 * fixture pins both halves against the bundled `.d.ts`, where a
 * `rollup-plugin-dts` inlining change could move either one without
 * anyone noticing:
 *
 *   - positive: a dynamic record key, a dynamic array index, and a
 *     typed path prefix all keep their typing, in both the dotted and
 *     the segment-array spelling, across every path-addressed API;
 *   - negative: a path outside the schema is still rejected, and an
 *     opaque `string` still cannot be checked.
 *
 * `test/types/dynamic-paths.test.ts` pins the same matrix against
 * `src` on both Zod majors.
 */
import { z } from 'zod'
import { useForm } from 'attaform/zod'

const schema = z.object({
  boxes: z
    .array(
      z.object({
        choice: z.string(),
        // Option token -> the export value it writes. Keys arrive at
        // runtime, which is the shape behind the report.
        pairs: z.record(z.string(), z.string()).default({}),
      })
    )
    .default([]),
  prefs: z.record(z.string(), z.boolean()).default({}),
})

const form = useForm({ schema, key: 'dynamic-paths-v4' })

declare const token: string
declare const index: number

// --- A dynamic record key, dotted ------------------------------------

form.register(`prefs.${token}`)
form.setValue(`prefs.${token}`, true)
form.toRef(`prefs.${token}`)
form.clear(`prefs.${token}`)
form.fields(`prefs.${token}`)
form.errors(`prefs.${token}`)

// --- A dynamic index and a dynamic key together ----------------------

form.register(`boxes.${index}.choice`)
form.register(`boxes.${index}.pairs.${token}`)
form.setValue(`boxes.${index}.pairs.${token}`, 'X')

// --- The same, in the segment-array spelling -------------------------

form.register(['prefs', token])
form.register(['boxes', index, 'choice'])
form.register(['boxes', index, 'pairs', token])
form.setValue(['boxes', index, 'pairs', token], 'X')
form.toRef(['boxes', index, 'pairs', token])
form.clear(['boxes', index, 'pairs', token])

// --- A typed prefix survives interpolation ---------------------------
//
// The row-component pattern. Typing the prop as a path prefix rather
// than `string` is what keeps a child component's bindings checked;
// this is the answer to "the escape hatch is all-or-nothing per
// component".

type RowPath = `boxes.${number}`
declare const rowPath: RowPath

form.register(`${rowPath}.choice`)
form.register(`${rowPath}.pairs.${token}`)
form.setValue(`${rowPath}.choice`, 'X')

// --- Negative: the boundary is the prefix, not the record ------------

declare const opaquePath: string

// @ts-expect-error an opaque `string` prefix cannot be checked against
// the schema. No record anywhere in this path: the record was never
// what made #568 fail.
form.register(`${opaquePath}.choice`)

// @ts-expect-error same call, same reason, with a record segment on the
// end. The record is not what rejects it.
form.register(`${opaquePath}.pairs.${token}`)

// @ts-expect-error `pairs` is not a key of the row
form.register(`boxes.${index}.pair.${token}`)

// @ts-expect-error a record key is dynamic; the container above it is not
form.register(`box.${index}.pairs.${token}`)

// @ts-expect-error a container path is addressable but not registrable
form.register(['boxes', index])

// @ts-expect-error the segment array is checked the same way the dotted
// form is
form.register(['boxes', index, 'nope'])
