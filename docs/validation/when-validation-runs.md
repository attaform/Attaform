---
title: When validation runs
description: Attaform validates per field on change, blur, or submit, your call, per form. Sync refinements fire immediately; async refinements await.
metaRows:
  - label: Category
    value: Option
  - label: Option
    value: validateOn
    kind: code
  - label: Default
    value: change
    kind: code
---

# When validation runs

> Per-field validation triggers on `change`, `blur`, or `submit`: your call, per form. Sync refinements fire immediately; async refinements await.

::docs-meta-table
::
Validation timing is configured per form via the `validateOn` option:

```ts
const form = useForm({
  schema,
  validateOn: 'change', // default
})
```

## Triggers

| Value                | Per-field validation fires on                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `'change'` (default) | Every committed write to storage. Pairs with the directive's commit cadence (per-keystroke by default, per-blur on `.lazy`). |
| `'blur'`             | When the input loses focus.                                                                                                  |
| `'submit'`           | Only when `handleSubmit` dispatches.                                                                                         |

The directive's commit cadence and the validation trigger are independent. With default `<input v-register>` and `validateOn: 'change'`, both fire per keystroke. Switch to `<input v-register.lazy>` and validation still rides the commit, which now lands on `change` (per-blur). Switch to `validateOn: 'blur'` and validation skips the per-write rhythm entirely.

The same schema runs in every mode: the only thing that changes is _when_ a refinement gets evaluated.

Under `validateOn: 'blur'`, leaving a field you never edited can't change any verdict, so Attaform skips the pass: it tracks whether the form has changed since the last validation and only revalidates when it has. Refocus a field that's showing an error, then tab away, and the error holds steady instead of blinking through `'pending'` and back.

## Debouncing

Pass a `debounceMs` to coalesce rapid bursts:

```ts
useForm({
  schema,
  validateOn: 'change',
  debounceMs: 200,
})
```

The field's last committed write wins after `debounceMs` of quiet. Useful for expensive sync refinements; required for async refinements that hit a network (otherwise every keystroke fires a request).

`debounceMs` is only meaningful with `validateOn: 'change'`. TypeScript rejects pairing it with `'blur'` or `'submit'`, so a misconfigured form is a compile error rather than a silent runtime drop.

## Sync versus async

Sync refinements (`refine`, `superRefine` with synchronous returns) run on the trigger. Async refinements (anything that returns a Promise) are awaited:

- During typing (`validateOn: 'change'`), the field's `form.fields.<path>.validating` flips true while the Promise is in flight.
- On submit, `handleSubmit` waits for every active async refinement to settle before calling the success callback.
- `form.meta.valid` only flips true once every active path has resolved at least one validation pass, including the async ones. No flash-of-valid window.

## Where to next

- [Display state and showing errors](/docs/validation/showing-errors): the `getDisplayState` predicate.
- [`errors`](/docs/reading-the-form/errors): per-path error reads.
