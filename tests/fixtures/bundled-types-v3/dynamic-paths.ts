/**
 * Bundled-types guard for runtime-known path segments, Zod v3 half.
 *
 * The v4 fixture of the same name carries the reasoning behind #568;
 * this is the parity counterpart, compiled with `zod` remapped to a v3
 * install. Both majors put a record's dynamic key into the path union
 * the same way, and a one-major consumer is the only place a collapse
 * in the unified entry's overload selection would show up.
 */
import { z } from 'zod' // remapped to a v3 install via tsconfig `paths`
import { useForm } from 'attaform/zod'

const schema = z.object({
  boxes: z
    .array(
      z.object({
        choice: z.string(),
        pairs: z.record(z.string(), z.string()).default({}),
      })
    )
    .default([]),
  prefs: z.record(z.string(), z.boolean()).default({}),
})

const form = useForm({ schema, key: 'dynamic-paths-v3' })

declare const token: string
declare const index: number

form.register(`prefs.${token}`)
form.register(`boxes.${index}.pairs.${token}`)
form.register(['boxes', index, 'pairs', token])
form.setValue(`boxes.${index}.pairs.${token}`, 'X')
form.toRef(`prefs.${token}`)

type RowPath = `boxes.${number}`
declare const rowPath: RowPath
form.register(`${rowPath}.choice`)
form.register(`${rowPath}.pairs.${token}`)

declare const opaquePath: string

// @ts-expect-error an opaque `string` prefix cannot be checked against
// the schema, with or without a record in the path
form.register(`${opaquePath}.choice`)

// @ts-expect-error a container path is addressable but not registrable
form.register(['boxes', index])
