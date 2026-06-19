---
title: handleSubmit
description: handleSubmit wraps a submit callback in Attaform's validation gate. Values reach onSubmit only after every async refinement has settled, with focus pulled to the first invalid field if not.
metaRows:
  - label: Category
    value: Return method
  - label: Signature
    value: handleSubmit(onSubmit, onError?)
    kind: code
  - label: Returns
    value: (event?) => Promise<void>
    kind: code
---

# `handleSubmit`

> A submit handler that waits for validation, hands you parsed values, and routes rejections through `onError`.

::docs-meta-table
::

Submit the form without checking the terms box to watch the `onError` path fire: focus pulls to the broken field and the rejection alert lands. Check the box, fill the email, submit again to see `onSubmit` receive the parsed values. The [dispatch contract](#the-dispatch-contract) section traces every step between the click and the callback.

::docs-demo{slug="handle-submit" label="handleSubmit Demo"}
::

## Signature

```ts
const submit = form.handleSubmit(
  async (values) => {
    /* onSubmit */
  },
  (errors) => {
    /* onError, optional */
  }
)
```

The return value is a function ready for `<form @submit.prevent>`. Call signature: `(event?: Event) => Promise<void>`.

## The dispatch contract

When the returned handler fires:

1. The form's submit count increments. `form.meta.submissionAttempts` lifts; the default `getDisplayState` heuristic starts surfacing errors for every field.
2. Sync validation runs across every active path.
3. Async refinements are awaited.
4. If every refinement passes, `onSubmit(values)` is called with the **parsed** Zod output: `.transform`-aware, fully typed.
5. The submit counts as a success, flipping `form.meta.submitted` to `true`, only when `onSubmit` resolves without throwing and leaves no errors set. A callback that hands a server rejection to `setErrors` and returns is a failed submit (see [server-side errors](/docs/submitting/server-side-errors)).
6. On any failure, whether a validation error, a thrown callback, or errors the callback set with `setErrors`, focus pulls to the first invalid field and `onError(errors)` fires (when supplied).

While step 4 is awaiting your `onSubmit` callback, `form.meta.submitting` is `true`. It flips back when the callback resolves or rejects (`handleSubmit` catches and surfaces errors through `onError`).

## Without onError

```ts
const submit = form.handleSubmit(async (values) => {
  await api.signup(values)
})
```

Skip `onError` when the default behavior (focus the first invalid field) is enough. Validation errors still surface through `form.errors.<path>`; the optional callback is for cross-field UI behavior like a toast or a console log.

## Submission state

```vue
<button :disabled="form.meta.submitting" type="submit">
  {{ form.meta.submitting ? 'Saving…' : 'Save' }}
</button>
```

`form.meta.submitting` is the reactive flag while the `onSubmit` callback runs.

## Where to next

- [`errors`](/docs/reading-the-form/errors): the per-path error reads.
- [When validation runs](/docs/validation/when-validation-runs): the timing knob.
- [Display state and showing errors](/docs/validation/showing-errors): the `getDisplayState` predicate.
