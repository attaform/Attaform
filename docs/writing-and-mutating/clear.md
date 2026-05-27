---
title: clear & blank values
description: clear writes the schema-slim empty value at one path or the whole form, `''` for strings, `0` for numbers, `[]` for arrays, `false` for booleans. Defaults are intentionally skipped.
metaRows:
  - label: Category
    value: Return method
  - label: Signatures
    value: clear() · clear(path) · clear(segments)
    kind: code
  - label: Writes
    value: schema-slim empty value
  - label: Returns
    value: boolean
    kind: code
---

# `clear` & blank values

> Wipe to the schema's empty shape, not to defaults. For "blank canvas" UX where defaults would be the wrong destination.

::docs-meta-table
::

Click the per-field clear buttons to watch each path drop to its schema-slim empty value: `''` for the string title, `[]` for the tags array, `false` for the published boolean. Click `clear()` to wipe everything. The defaults declared on `useForm` are intentionally skipped; that's the distinction from `reset`. The blank flag on each field flips on to mark the cleared state.

::docs-demo{slug="clear" label="Clear Demo"}
::

## What "blank" means

`clear` writes the **schema-slim** empty value at each cleared path:

| Leaf type     | Cleared value         |
| ------------- | --------------------- |
| `z.string()`  | `''`                  |
| `z.number()`  | `0`                   |
| `z.boolean()` | `false`               |
| `z.array()`   | `[]`                  |
| `z.object()`  | `{}` (then descended) |
| `z.date()`    | `new Date(0)`         |
| `z.file()`    | `null`                |

Same shapes Attaform uses for the initial defaults when nothing is declared in `defaultValues` or `schema.default(...)`. The blank predicate (`fields.<path>.blank`) flips true at every cleared path.

## Clear is not reset

The key distinction: `clear` skips defaults; `reset` restores them. Pick clear when the user-facing intent is "blank canvas": a fresh draft, a wipe, a "start over from nothing". Pick `reset` when the intent is "back to baseline": the form's authoritative starting state.

```ts
form.reset() // values.title === 'A great draft'  (the default)
form.clear() // values.title === ''  (the schema-slim empty)
```

Both wipe `dirty` / `touched` along with the value; both surface the same reactive pipeline.

## Three call shapes

```ts
form.clear() // whole form
form.clear('profile.email') // dotted path
form.clear(['profile', 'email']) // segment tuple
```

Same call ergonomics as `setValue`. The whole-form call clears every path recursively; the per-path forms scope to one leaf or container.

## Returns `boolean`

`true` on accepted writes, `false` when the slim-type gate rejects (rare; the empty value should always be valid for the path's accept set, but containers with required fields may flag).

## When `clear()` is the right call

- A "Compose new" button in a draft UI where the user expects an empty canvas, not a re-populated form.
- After a successful submit when the next interaction should start from nothing rather than the previous defaults.
- Implementing a "Discard and start over" affordance distinct from "Undo my edits".

For "go back to the baseline this form was hydrated with," reach for [`reset`](/docs/writing-and-mutating/reset) instead.

## Where to next

- [`reset` & `resetField`](/docs/writing-and-mutating/reset): restore defaults instead of clearing.
- [`unset`](/docs/writing-and-mutating/unset): flag any path blank in `defaultValues`, `setValue`, or `reset`.
- [Display state and showing errors](/docs/validation/showing-errors): how blank fields interact with the error-display predicate.
