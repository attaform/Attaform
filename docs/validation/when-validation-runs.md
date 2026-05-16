---
title: When validation runs
description: Attaform validates per field on input, change, blur, or submit — your call, per form. Sync refinements fire immediately; async refinements await.
meta:
  - label: Category
    value: Option
  - label: Option
    value: validateOn
    kind: code
  - label: Default
    value: input
    kind: code
---

# When validation runs

> Per-field validation triggers on `input`, `change`, `blur`, or `submit` — your call, per form. Sync refinements fire immediately; async refinements await.

<DocsMetaTable />

Validation timing is configured per form via the `validateOn` option:

```ts
const form = useForm({
  schema,
  validateOn: 'input', // default
})
```

## Triggers

| Value               | Per-field validation fires on                                     |
| ------------------- | ----------------------------------------------------------------- |
| `'input'` (default) | Every keystroke or change event.                                  |
| `'change'`          | When the input commits a value (e.g., `change` event on selects). |
| `'blur'`            | When the input loses focus.                                       |
| `'submit'`          | Only when `handleSubmit` dispatches.                              |

The same schema runs in every mode — the only thing that changes is _when_ a refinement gets evaluated.

## Debouncing

Pass a `debounceMs` to coalesce keystrokes:

```ts
useForm({
  schema,
  validateOn: 'input',
  debounceMs: 200,
})
```

The field's last input event wins after `debounceMs` of quiet. Useful for expensive sync refinements; required for async refinements that hit a network (otherwise every keystroke fires a request).

## Sync versus async

Sync refinements (`refine`, `superRefine` with synchronous returns) run on the trigger. Async refinements (anything that returns a Promise) are awaited:

- During typing (`validateOn: 'input'`), the field's `meta.pending` flips true while the Promise is in flight.
- On submit, `handleSubmit` waits for every active async refinement to settle before calling the success callback.
- `form.meta.valid` only flips true once every active path has resolved at least one validation pass — including the async ones. No flash-of-valid window.

## Where to next

- [Showing errors at the right time](/docs/validation/showing-errors) — the `shouldShowErrors` predicate.
- [`errors`](/docs/reading-the-form/errors) — per-path error reads.
