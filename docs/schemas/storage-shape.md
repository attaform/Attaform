---
title: How values are stored
description: form.values exposes the storage shape, raw input with defaults resolved. Schema normalizers (preprocess, coerce, transforms) run at parse, not the write boundary. handleSubmit gets the parsed output.
metaRows:
  - label: Category
    value: Conceptual
  - label: Read shape
    value: form.values, form.fields
    kind: code
  - label: Write shape
    value: setValue, defaultValues
    kind: code
  - label: Submit shape
    value: handleSubmit, form.parse()
    kind: code
---

# How values are stored

> A single mental model for what `form.values` returns. Defaults are pre-resolved, optional / nullable keep their wrappers, and schema-side normalizers (preprocess, coerce, transforms) only fire at parse time. Storage holds the consumer's input verbatim.

::docs-meta-table
::

The demo below shows the same schema across all three views: what `form.values` returns at runtime, what `setValue` accepts, and what `handleSubmit`'s callback sees. The phone field is the giveaway: storage keeps the raw digits the user typed, and the preprocess formatter's output only surfaces inside `handleSubmit`'s callback. Preprocess itself runs every time validation does (each keystroke under `validateOn: 'change'`, each blur under `'blur'`, only at submit under `'submit'`), but its output never lands in storage.

::docs-demo{slug="storage-shape" label="Storage Shape Demo"}
::

## The three shapes

A schema produces three different views of its data, each with a distinct surface:

| Surface                         | Shape      | What it answers                                          |
| ------------------------------- | ---------- | -------------------------------------------------------- |
| `form.values` / `form.fields`   | **read**   | What does storage hold now? (`StorageShape<Schema>`)     |
| `setValue` / `defaultValues`    | **write**  | What may the consumer pass in? (`z.input<Schema>`)       |
| `handleSubmit` / `form.parse()` | **submit** | What does a successful parse yield? (`z.output<Schema>`) |

The same schema produces all three; the surface determines which one you're holding.

```ts
const formatPhone = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  const digits = v.replace(/\D/g, '')
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : v
}

const schema = z.object({
  flag: z.boolean().default(true),
  count: z.coerce.number(),
  phone: z.preprocess(formatPhone, z.string()),
  ratio: z.string().transform((v) => Number(v) / 100),
})

const form = useForm({ schema })

// READ: storage holds the concrete, resolved type
form.values.flag // boolean       ← .default(true) peeled
form.values.count // unknown        ← z.coerce.X() input is unknown
form.values.phone // unknown        ← preprocess input is unknown
form.values.ratio // string        ← transform deferred to parse

// WRITE: anything goes at preprocess / coerce leaves; defaulted leaves accept undefined
form.setValue('flag', undefined) // OK; default fills the gap
form.setValue('count', '42') // OK; raw string lands in storage as-is
form.setValue('phone', '1231231234') // OK; raw digits land in storage as-is

// SUBMIT: schema-side normalizers fire here
form.handleSubmit((data) => {
  data.count // number ← z.coerce.number() converted at parse
  data.phone // string ← preprocess formatted at parse
  data.ratio // number ← .transform() produced this
})
```

## Two layers of mutation

Two distinct surfaces can change what lands in storage. They sit at different boundaries, and `form.values` reflects only one of them.

| Layer                                              | Mutates storage? | When                       |
| -------------------------------------------------- | ---------------- | -------------------------- |
| `v-register` modifiers and register `transforms`   | yes              | at the user-input boundary |
| `z.preprocess` / `z.coerce.X()` / `.transform(fn)` | no               | at parse / submit          |

The directive layer owns write-time mutation: `v-register.trim` strips whitespace as the user blurs, `v-register.number` casts the DOM string to a number, and `register({ transforms: [...] })` runs consumer-supplied functions on every commit. Anything those produce ends up in storage.

Schema-side normalizers do their work later, inside `safeParse`. The consumer's verbatim write lands in storage; `handleSubmit`, `validate`, and `validateAsync` re-parse storage through the schema and surface the typed result. There is no schema shape that mutates storage at the write boundary.

## Per-wrapper read-shape policy

`StorageShape<Schema>` walks each field and applies one of these rules:

| Wrapper               | Field key | Field type at the key          | Rationale                                                                                           |
| --------------------- | --------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `.default(x)`         | required  | inner type (no `\| undefined`) | Storage always holds `x` or a write; never empty.                                                   |
| `.prefault(x)`        | required  | inner type                     | Same as `.default(x)`.                                                                              |
| `.catch(x)`           | required  | inner type                     | Catch wraps a fallback; storage holds a value.                                                      |
| `.optional()`         | optional  | `inner \| undefined`           | Genuinely optional; `undefined` is the wrapper's marker.                                            |
| `.nullable()`         | required  | `inner \| null`                | `null` is the wrapper's "explicit empty".                                                           |
| `.readonly()`         | required  | inner type                     | Read-only is type-only; the read shape is its inner.                                                |
| `z.preprocess(fn, T)` | required  | `unknown`                      | Schema-side normalizer; runs at parse, not at the write boundary. Storage holds raw input.          |
| `z.coerce.X()`        | required  | `unknown`                      | Same as `z.preprocess`: coerce fires inside `safeParse`. Storage holds whatever the consumer wrote. |
| `.transform(fn)`      | required  | source input shape             | Transforms run at parse, not read; storage holds the pre-transform value.                           |
| (plain / fallthrough) | required  | `z.input<T>`                   | Default for anything else.                                                                          |

Reads at every nested level get the same treatment recursively.

## Blank-path synthesis

Required leaves that haven't been written to aren't `undefined`. The runtime fills them with the type's falsy concrete at mount:

| Schema at path    | Initial `form.values.<path>`                          |
| ----------------- | ----------------------------------------------------- |
| `z.string()`      | `''`                                                  |
| `z.number()`      | `0`                                                   |
| `z.boolean()`     | `false`                                               |
| `z.bigint()`      | `0n`                                                  |
| `z.date()`        | `new Date(0)`                                         |
| `z.array(...)`    | `[]`                                                  |
| `z.set(...)`      | `new Set()`                                           |
| `z.record(...)`   | `{}`                                                  |
| `z.object({...})` | recursive: every required property gets its own falsy |

The runtime tracks which paths are still "blank" through the same field-state bit `field.blank` covers; see [the `blank` field-state bit](/docs/validation/blank) for the storage / display divergence story.

## Three edges the invariant doesn't promise to flatten

These read as honest `T | undefined` / `T | null` / `T | undefined` respectively: documented edges, not bugs.

### `.optional()` (no default): `T | undefined`

```ts
const schema = z.object({ bio: z.string().optional() })
const form = useForm({ schema })

form.values.bio // string | undefined
```

The wrapper's whole point is "this slot may be absent." Storage respects it.

### `.nullable()`: `T | null`

```ts
const schema = z.object({ ref: z.string().nullable() })
form.values.ref // string | null
```

`null` is the wrapper's "explicit empty" signal, distinct from `undefined` and from `''`.

### Array element past `length`: `T | undefined`

```ts
const schema = z.object({ tags: z.array(z.string()) })
form.values.tags[0] // string | undefined
```

The `| undefined` taint comes from TypeScript's `noUncheckedIndexedAccess` (which strict configs set), not from the storage invariant. Iteration (`for (const tag of form.values.tags)`) keeps the strict `string` element type; only direct numeric indexing is tainted.

## When to reach for which surface

```ts
const form = useForm({ schema })

// READ: anywhere you need the current value
form.values.email // primary path
form.fields.email.value // same value, plus per-field state
form.toRef('email') // ref-shaped interop for external composables

// WRITE: anywhere you set a value
form.setValue('email', 'a@b.c') // single path
form.setValue({ email: 'a@b.c' }) // whole-form merge
form.clear('email') // wipe to falsy-for-type
form.reset() // re-seed from declared defaults

// SUBMIT: once on form submission
form.handleSubmit((data) => apiPost(data)) // `data` is the post-transform output
const result = await form.parse() // imperative one-shot parse
```

Each surface uses the shape that's correct for its purpose. The mental discipline: **don't reach across surfaces.** If you want post-transform output, go through submit. If you want the raw input, go through `form.values`. If you want to write, go through `setValue` or `clear`; `form.values` is read-only on purpose.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults): how `.default()` flows into the read shape.
- [Optional, nullable, defaulted](/docs/schemas/optional-nullable): the three missing-ness modifiers, side by side.
- [URL availability check](/docs/validation/url-availability-check): a worked example threading `z.preprocess` and async `.refine` against the storage contract.
- [The validation lifecycle](/docs/validation/lifecycle): `parse()` returns the submit shape, parsed.
