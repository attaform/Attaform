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

Pick a file in the single input to watch the avatar slot fill in with the file name + size. Pick more in the multi-input below to see them stack — the directive writes a `File[]` in the order the picker returned them. Both surfaces hand you live `File` handles you can append to `FormData` or stream into an upload.

::docs-demo{slug="file"}
::

## Single file → File | null

```vue
<input v-register="register('avatar')" type="file" accept="image/*" />
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
<input v-register="register('attachments')" type="file" multiple />
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

## Uploading via FormData

Live `File` handles work directly with the upload pipelines you'd reach for anyway:

```ts
const onSubmit = form.handleSubmit(async (values) => {
  const body = new FormData()
  body.append('avatar', values.avatar!)
  for (const file of values.attachments) {
    body.append('attachments', file)
  }
  await fetch('/api/upload', { method: 'POST', body })
})
```

The schema's `z.file()` leaf type carries the constraint through validation; refinements like `.min(size)`, `.max(size)`, `.mime([...])` surface in `errors.<path>` like any other validator.

## Reset behavior

`form.reset()` clears the file input back to `null` / `[]`. The directive also resets the underlying `<input>`'s `value` attribute — the picker shows "No file chosen" after the reset, no stale filename hanging around.

## Where to next

- [`reset` & `resetField`](/docs/writing-and-mutating/reset) — programmatic clearing.
- [Schema-driven coercion](/docs/binding-inputs/coercion) — how File leaves move through the directive.
- [`handleSubmit`](/docs/submitting/handle-submit) — wraps your upload callback in the validation gate.
