---
title: File inputs
description: <input type="file"> binds to a single File (or null when empty); type="file" multiple binds to a File[]. Live File handles, ready for FormData or upload.
metaRows:
  - label: Category
    value: Directive binding
  - label: Element
    value: <input type="file"> · <input type="file" multiple>
    kind: code
  - label: Modifiers
    value: none
  - label: Leaf types
    value: File | null (single) · readonly File[] (multiple)
    kind: code
---

# File inputs

> Single file → `File | null`. Multiple → `readonly File[]`. Live handles, ready for `FormData` or your upload pipeline.

::docs-meta-table
::

Pick a file in the single input to watch the avatar slot fill in with the file name + size. Pick more in the multi-input below to see them stack; the directive writes a `File[]` in the order the picker returned them. Both surfaces hand you live `File` handles you can append to `FormData` or stream into an upload.

::docs-demo{slug="file" label="File Input Demo"}
::

## Single file → File | null

```vue
<input v-register="form.register('avatar')" type="file" accept="image/*" />
```

```ts
const form = useForm({
  schema: z.object({
    avatar: z.file().nullable(),
  }),
  defaultValues: { avatar: null },
})

form.values.avatar // File | null
```

Selecting a file writes the `File` handle into storage. Clearing the input (or selecting then cancelling) writes `null`.

## Multiple files → File[]

```vue
<input v-register="form.register('attachments')" type="file" multiple />
```

```ts
const form = useForm({
  schema: z.object({
    attachments: z.array(z.file()),
  }),
  defaultValues: { attachments: [] },
})

form.values.attachments // readonly File[]
```

Every file in the picker selection lands in the array, in picker order. Re-selecting replaces the array; the input never accumulates across picks.

## Zod v3, and `z.instanceof(File)`

`z.file()` is a Zod v4 kind. On Zod v3 the spelling is `z.instanceof(File)`, which works identically through the directive and is also accepted by the v4 adapter, so a schema written this way runs unchanged on both majors:

```ts
const schema = z.object({
  avatar: z.instanceof(File).nullable(),
  attachments: z.array(z.instanceof(File)),
})
```

The trade-off is refinements. `z.file()` understands `.min(size)`, `.max(size)`, and `.mime([...])`; `z.instanceof(File)` is an opaque leaf, so size and type rules go in a `.refine(...)` you write yourself. Prefer `z.file()` when you are on v4 and not sharing the schema with a v3 codebase.

## Uploading via FormData

Live `File` handles work directly with the upload pipelines you'd reach for anyway:

```ts
const onSubmit = form.handleSubmit(async (values) => {
  const body = new FormData()
  if (values.avatar) body.append('avatar', values.avatar)
  for (const file of values.attachments) {
    body.append('attachments', file)
  }
  await fetch('/api/upload', { method: 'POST', body })
})
```

The handles Attaform gives back are the originals, not copies, so they append straight to `FormData`. The schema's `z.file()` leaf type carries the constraint through validation; refinements like `.min(size)`, `.max(size)`, `.mime([...])` surface in `form.errors.<path>` like any other validator.

## Reset behavior

`form.reset()` clears the file input back to `null` / `[]`. The directive also resets the underlying `<input>`'s `value` attribute, so the picker shows "No file chosen" after the reset, no stale filename hanging around.

## Where to next

- [`reset` & `resetField`](/docs/writing-and-mutating/reset): programmatic clearing.
- [Schema-driven coercion](/docs/binding-inputs/coercion): how File leaves move through the directive.
- [`handleSubmit`](/docs/submitting/handle-submit): wraps your upload callback in the validation gate.
