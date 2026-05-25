---
title: Focus & scroll on invalid submit
description: handleSubmit pulls focus to the first invalid field by default. focusFirstError and scrollToFirstError are the imperative escape hatches when the default isn't enough.
metaRows:
  - label: Category
    value: Return methods
  - label: Auto behavior
    value: handleSubmit on invalid → focusFirstError
    kind: code
  - label: Helpers
    value: focusFirstError(options?) · scrollToFirstError(options?)
    kind: code
  - label: Returns
    value: boolean; true if a target was found
    kind: code
---

# Focus & scroll on invalid submit

> The default does the right thing on submit. The imperative helpers exist for when you need to drive focus or scroll outside the submit path.

::docs-meta-table
::

Submit the form with empty fields to watch focus pull to the first invalid one automatically. That's `handleSubmit` running its default invalid-submit policy (`'focus-first-error'`). The two buttons below dispatch the helpers imperatively, so you can drive focus or smooth-scroll outside the submit handler. Submitting again with valid fields shows the no-op success path.

::docs-demo{slug="focus-scroll" label="Focus & Scroll Demo"}
::

## Default on invalid submit

`handleSubmit` pulls focus to the first invalid field on failed submission:

```ts
const onSubmit = form.handleSubmit(async (values) => {
  await api.send(values)
})
```

When validation fails, the handler:

1. Increments `form.meta.submissionAttempts`. `form.meta.submitted` stays `false`; it only flips on a successful callback.
2. Surfaces errors at every invalid path.
3. Calls `form.focusFirstError()` (the same method exposed below).
4. Calls `onError(errors)` if you passed one.

The "first" invalid field is in schema-declaration order, which matches the visual reading order for most forms (top to bottom, left to right).

## `focusFirstError(options?)`

```ts
form.focusFirstError({ preventScroll: false })
```

Returns `true` when a target was found and focused, `false` when no field is in an error state. The optional `preventScroll: true` skips the browser's default focus-related scroll if you've got a custom scroll strategy.

Reach for this when:

- A page-level error banner has a "Jump to first error" button.
- A multi-step form's "Next" button should pull focus on validation failure without going through `handleSubmit`.
- Replacing the default invalid-submit policy with custom UX (see [Customizing the invalid-submit policy](#customizing-the-invalid-submit-policy)).

## `scrollToFirstError(options?)`

```ts
form.scrollToFirstError({ behavior: 'smooth', block: 'center' })
```

Returns `true` when a target was found and scrolled into view. Options forward to the underlying `Element.scrollIntoView`: `behavior: 'smooth'` for animated scroll, `block: 'center'` to position the field in the middle of the viewport.

The default invalid-submit policy focuses but doesn't scroll on most browsers (focus triggers a minimal scroll). For tall forms where the first error might be far above the user's current scroll position, layer this on:

```ts
const onSubmit = form.handleSubmit(
  async (values) => {
    /* ... */
  },
  () => {
    form.scrollToFirstError({ behavior: 'smooth', block: 'center' })
  }
)
```

## Customizing the invalid-submit policy

Disable the default focus pull at the form level and run your own:

```ts
useForm({
  schema,
  onInvalidSubmit: 'none', // skip the default focus
})
```

Then drive focus + scroll from `onError`:

```ts
const onSubmit = form.handleSubmit(onSubmitValid, () => {
  form.scrollToFirstError({ behavior: 'smooth', block: 'center' })
  form.focusFirstError({ preventScroll: true })
})
```

The `'focus-first-error'` (default), `'scroll-to-first-error'`, `'both'`, and `'none'` policy options live on the form config and on `createAttaform({ defaults })` for an app-wide default. See the [Types reference](/docs/reference/types) for the full set.

## Where to next

- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface that calls these by default.
- [Server-side errors](/docs/submitting/server-side-errors): bring API failures back into the same focus / scroll machinery.
- [Showing errors at the right time](/docs/validation/showing-errors): the predicate that decides when errors render.
