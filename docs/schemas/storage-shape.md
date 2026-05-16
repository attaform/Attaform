---
title: How values are stored
description: form.values exposes the slim write shape — concrete types after defaults and preprocess resolve, but before transforms run. handleSubmit gets the post-transform output. One schema, three views.
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
    value: handleSubmit, form.process()
    kind: code
---

# How values are stored

> A single mental model for what `form.values` returns. Defaults are pre-resolved; preprocess is normalized; optional / nullable keep their wrappers; transforms only run at parse time.

::docs-meta-table
::

The demo below shows the same schema across all three views — what `form.values` returns at runtime, what `setValue` accepts, and what `handleSubmit`'s callback sees. Watch the transforms only kick in on submit; reads stay in the input shape.

::docs-demo{slug="storage-shape"}
::

## The three shapes

A schema produces three different views of its data, each with a distinct surface:

| Surface                           | Shape      | What it answers                                          |
| --------------------------------- | ---------- | -------------------------------------------------------- |
| `form.values` / `form.fields`     | **read**   | What does storage hold now? (`ReadShape<Schema>`)        |
| `setValue` / `defaultValues`      | **write**  | What may the consumer pass in? (`z.input<Schema>`)       |
| `handleSubmit` / `form.process()` | **submit** | What does a successful parse yield? (`z.output<Schema>`) |

The same schema produces all three; the surface determines which one you're holding.

```ts
const schema = z.object({
  flag: z.boolean().default(true),
  count: z.number().default(0),
  trimmed: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string()),
  ratio: z.string().transform((v) => Number(v) / 100),
})

const form = useForm({ schema })

// READ — storage holds the concrete, resolved type
form.values.flag // boolean       ← .default(true) peeled
form.values.count // number        ← .default(0) peeled
form.values.trimmed // string        ← preprocess peeled to inner input
form.values.ratio // string        ← transform deferred to parse

// WRITE — `unknown` for preprocess slots, `undefined` allowed for defaulted
form.setValue('flag', undefined) // OK — default fills the gap
form.setValue('trimmed', '  hi  ') // OK — preprocess normalises at write

// SUBMIT — transforms run, refinements fire
form.handleSubmit((data) => {
  data.ratio // number ← .transform() produced this
})
```

## Per-wrapper read-shape policy

`ReadShape<Schema>` walks each field and applies one of these rules:

| Wrapper               | Field key | Field type at the key          | Rationale                                                                                         |
| --------------------- | --------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `.default(x)`         | required  | inner type (no `\| undefined`) | Storage always holds `x` or a write — never empty.                                                |
| `.prefault(x)`        | required  | inner type                     | Same as `.default(x)`.                                                                            |
| `.catch(x)`           | required  | inner type                     | Catch wraps a fallback; storage holds a value.                                                    |
| `.optional()`         | optional  | `inner \| undefined`           | Genuinely optional — `undefined` is the wrapper's marker.                                         |
| `.nullable()`         | required  | `inner \| null`                | `null` is the wrapper's "explicit empty".                                                         |
| `.readonly()`         | required  | inner type                     | Read-only is type-only; the read shape is its inner.                                              |
| `z.preprocess(fn, T)` | required  | inner-T input shape            | Preprocess normalises at the write boundary; storage holds the post-preprocess inner-input value. |
| `.transform(fn)`      | required  | source input shape             | Transforms run at parse, not read — storage holds the pre-transform value.                        |
| (plain / fallthrough) | required  | `z.input<T>`                   | Default for anything else.                                                                        |

Reads at every nested level get the same treatment recursively.

## Blank-path synthesis

Required leaves that haven't been written to aren't `undefined` — the runtime fills them with the type's falsy concrete at mount:

| Schema at path    | Initial `form.values.<path>`                           |
| ----------------- | ------------------------------------------------------ |
| `z.string()`      | `''`                                                   |
| `z.number()`      | `0`                                                    |
| `z.boolean()`     | `false`                                                |
| `z.bigint()`      | `0n`                                                   |
| `z.date()`        | `new Date(0)`                                          |
| `z.array(...)`    | `[]`                                                   |
| `z.set(...)`      | `new Set()`                                            |
| `z.record(...)`   | `{}`                                                   |
| `z.object({...})` | recursive — every required property gets its own falsy |

The runtime tracks which paths are still "blank" through the same field-state bit `field.blank` covers — see [the `blank` field-state bit](/docs/validation/blank) for the storage / display divergence story.

## Three edges the invariant doesn't promise to flatten

These read as honest `T | undefined` / `T | null` / `T | undefined` respectively — documented edges, not bugs:

### `.optional()` (no default) — `T | undefined`

```ts
const schema = z.object({ bio: z.string().optional() })
const form = useForm({ schema })

form.values.bio // string | undefined
```

The wrapper's whole point is "this slot may be absent." Storage respects it.

### `.nullable()` — `T | null`

```ts
const schema = z.object({ ref: z.string().nullable() })
form.values.ref // string | null
```

`null` is the wrapper's "explicit empty" signal — distinct from `undefined` and from `''`.

### Array element past `length` — `T | undefined`

```ts
const schema = z.object({ tags: z.array(z.string()) })
form.values.tags[0] // string | undefined
```

The `| undefined` taint comes from TypeScript's `noUncheckedIndexedAccess` (which strict configs set), not from the storage invariant. Iteration (`for (const tag of form.values.tags)`) keeps the strict `string` element type; only direct numeric indexing is tainted.

## When to reach for which surface

```ts
const form = useForm({ schema })

// READ — anywhere you need the current value
form.values.email // primary path
form.fields.email.value // same value, plus per-field state
form.toRef('email') // ref-shaped interop for external composables

// WRITE — anywhere you set a value
form.setValue('email', 'a@b.c') // single path
form.setValue({ email: 'a@b.c' }) // whole-form merge
form.clear('email') // wipe to falsy-for-type
form.reset() // re-seed from declared defaults

// SUBMIT — once on form submission
form.handleSubmit((data) => apiPost(data)) // `data` is the post-transform output
const result = await form.process() // imperative one-shot parse
```

Each surface uses the shape that's correct for its purpose. The mental discipline: **don't reach across surfaces.** If you want post-transform output, go through submit. If you want the raw input, go through `form.values`. If you want to write, go through `setValue` or `clear` — `form.values` is read-only on purpose.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults) — how `.default()` flows into the read shape.
- [Optional, nullable, defaulted](/docs/schemas/optional-nullable) — the three missing-ness modifiers, side by side.
- [The validation lifecycle](/docs/validation/lifecycle) — `process()` returns the submit shape, parsed.
