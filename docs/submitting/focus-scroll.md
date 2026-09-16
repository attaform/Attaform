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

Submit the form with empty fields to watch focus pull to the first invalid one automatically. That's `handleSubmit` running Attaform's default invalid-submit nudge. The two buttons below dispatch the helpers imperatively, so you can drive focus or smooth-scroll outside the submit handler. Submitting again with valid fields shows the no-op success path.

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

1. Surfaces errors at every invalid path.
2. Calls `form.focusFirstError()` (the same method exposed below).
3. Calls `onError(errors)` if you passed one.
4. Increments `form.meta.submissionAttempts`, last, so a read inside `onError` still sees the previous count. `form.meta.submitted` stays `false` either way; it only flips on a successful callback.

The "first" invalid field is in schema-declaration order, which matches the visual reading order for most forms (top to bottom, left to right).

## `focusFirstError(options?)`

```ts
form.focusFirstError({ preventScroll: false })
```

Returns `true` when a target was found and focused, `false` when no field is in an error state. The optional `preventScroll: true` skips the browser's default focus-related scroll if you've got a custom scroll strategy.

Reach for this when:

- A page-level error banner has a "Jump to first error" button.
- A multi-step form's "Next" button should pull focus on validation failure without going through `handleSubmit`.
- Replacing the automatic nudge with custom UX (see [Driving it yourself](#driving-it-yourself)).

## `scrollToFirstError(options?)`

```ts
form.scrollToFirstError({ behavior: 'smooth', block: 'center' })
```

Returns `true` when a target was found and scrolled into view. Options forward to the underlying `Element.scrollIntoView`: `behavior: 'smooth'` for animated scroll, `block: 'center'` to position the field in the middle of the viewport.

The automatic nudge focuses but doesn't scroll on most browsers (focus triggers a minimal scroll). For tall forms where the first error might be far above the user's current scroll position, layer this on:

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

## Driving it yourself

`focusOnInvalidSubmit` turns the automatic pull off at the form level:

```ts
const form = useForm({
  schema,
  focusOnInvalidSubmit: false,
})
```

Then drive focus and scroll from `onError`:

```ts
const onSubmit = form.handleSubmit(onSubmitValid, () => {
  form.scrollToFirstError({ behavior: 'smooth', block: 'center' })
  form.focusFirstError({ preventScroll: true })
})
```

Turning the automatic nudge off never takes the helpers away: `focusFirstError()` and `scrollToFirstError()` do exactly what they say whatever the form was configured with. That is the point of the off-switch, because the only reason to reach for it is that you want to run the move yourself.

## Where to next

- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface that calls these by default.
- [Server-side errors](/docs/submitting/server-side-errors): bring API failures back into the same focus / scroll machinery.
- [Display state and showing errors](/docs/validation/showing-errors): the predicate that decides when errors render.
