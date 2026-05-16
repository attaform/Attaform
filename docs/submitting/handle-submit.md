---
title: handleSubmit
description: handleSubmit wraps a submit callback in Attaform's validation gate — values reach onSuccess only after every async refinement has settled, with focus pulled to the first invalid field if not.
metaRows:
  - label: Category
    value: Return method
  - label: Signature
    value: handleSubmit(onSuccess, onError?)
    kind: code
  - label: Returns
    value: (event?) => Promise<void>
    kind: code
---

# `handleSubmit`

> A submit handler that waits for validation, hands you parsed values, and routes rejections through `onError`.

::docs-meta-table
::
::docs-demo{slug="handle-submit"}
::

## Signature

```ts
const onSubmit = form.handleSubmit(
  async (values) => {
    /* onSuccess */
  },
  (errors) => {
    /* onError — optional */
  }
)
```

The return value is a function ready for `<form @submit.prevent>`. Call signature: `(event?: Event) => Promise<void>`.

## The dispatch contract

When the returned handler fires:

1. The form's submit count increments. `meta.submitCount` lifts; `defaultShouldShowErrors` starts allowing errors to surface for every field.
2. Sync validation runs across every active path.
3. Async refinements are awaited.
4. If every refinement passes, `onSuccess(values)` is called with the **parsed** Zod output — `.transform`-aware, fully typed.
5. If anything fails, focus pulls to the first invalid field and `onError(errors)` fires (when supplied).

While step 4 is awaiting your `onSuccess` callback, `meta.submitting` is `true`. It flips back when the callback resolves — or rejects (`handleSubmit` catches and surfaces errors through `onError`).

## Without onError

```ts
const onSubmit = handleSubmit(async (values) => {
  await api.signup(values)
})
```

Skip `onError` when the default behaviour (focus the first invalid field) is enough. Validation errors still surface through `form.errors.<path>` — the optional callback is for cross-field UI behaviour like a toast or a console log.

## Submission state

```vue
<button :disabled="meta.submitting" type="submit">
  {{ meta.submitting ? 'Saving…' : 'Save' }}
</button>
```

`meta.submitting` is the reactive flag while the success callback runs.

## Where to next

- [`errors`](/docs/reading-the-form/errors) — the per-path error reads.
- [When validation runs](/docs/validation/when-validation-runs) — the timing knob.
- [Showing errors at the right time](/docs/validation/showing-errors) — the `shouldShowErrors` predicate.
