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

Wrappers resolve to the wrapper's own empty rather than the inner type's, which is what makes the cleared value visible to a partial-update backend:

| Wrapper       | Cleared value                            |
| ------------- | ---------------------------------------- |
| `.optional()` | `undefined` (the key leaves the payload) |
| `.nullable()` | `null`                                   |
| `.default(x)` | the inner type's empty, **not** `x`      |

Same shapes Attaform uses for the initial defaults when nothing is declared in `defaultValues` or `schema.default(...)`. The blank predicate (`fields.<path>.blank`) flips true at every cleared path.

The `.optional()` row is the one to design around. A cleared optional leaf drops out of `form.values()` entirely, and a backend that reads an absent key as "leave unchanged" turns the user's deliberate clear into a no-op. Spell a field the user must be able to empty as a required `z.string()` so the clear ships as `''`.

## Clear is not reset

The key distinction: `clear` skips defaults; `reset` restores them. Pick clear when the user-facing intent is "blank canvas": a fresh draft, a wipe, a "start over from nothing". Pick `reset` when the intent is "back to baseline": the form's authoritative starting state.

```ts
form.reset() // values.title === 'A great draft'  (the default)
form.clear() // values.title === ''  (the schema-slim empty)
```

The destination is not the only difference. `reset` is a fresh start, so it wipes `dirty` and `touched` back to their mount values. `clear` is an ordinary write that happens to write the empty value, so it leaves both alone: a cleared field stays `touched` if the user had been in it, and reads `dirty` because the empty value differs from the default. That is the right pair of answers for a "Discard" button, which should still count as an edit, but it does mean a submit gated on `!form.meta.dirty` stays enabled after a `clear()`.

## Three call shapes

```ts
form.clear() // whole form
form.clear('profile.email') // dotted path
form.clear(['profile', 'email']) // segment tuple
```

Same call ergonomics as `setValue`. The whole-form call clears every path recursively; the per-path forms scope to one leaf or container.

`clear()` and `clear('')` are not the same call. The no-argument form targets the whole form; `''` is a path like any other, so `clear('')` targets a schema key literally named `''` and leaves every sibling untouched. `touch()` and `touch('')` split the same way.

## Returns `boolean`

`true` on accepted writes, `false` when Attaform could not resolve an empty value at the path, which in practice means the path is not in the schema. A required leaf never causes a `false`: `clear` writes the empty value regardless and lets validation raise the error. On a `false` return the form is unchanged.

## When `clear()` is the right call

- A "Compose new" button in a draft UI where the user expects an empty canvas, not a re-populated form.
- After a successful submit when the next interaction should start from nothing rather than the previous defaults.
- Implementing a "Discard and start over" affordance distinct from "Undo my edits".

For "go back to the baseline this form was hydrated with," reach for [`reset`](/docs/writing-and-mutating/reset) instead.

## Where to next

- [`reset` & `resetField`](/docs/writing-and-mutating/reset): restore defaults instead of clearing.
- [`unset`](/docs/writing-and-mutating/unset): flag any path blank in `defaultValues`, `setValue`, or `reset`.
- [Display state and showing errors](/docs/validation/showing-errors): how blank fields interact with the error-display predicate.
