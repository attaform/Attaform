---
title: Server-side errors
description: form.setErrors mounts server errors into the same reactive surface the validator uses. One shape in (an Error or { message?, path?, code?, data? }), one shape out (ValidationError).
metaRows:
  - label: Category
    value: Return methods
  - label: Set
    value: form.setErrors(errors) · form.setErrors(path, errors)
    kind: code
  - label: Clear
    value: form.clearErrors(path?)
    kind: code
  - label: Accepts
    value: 'Error | { message?, path?, code?, data? }'
    kind: code
---

# Server-side errors

> A server rejection is just another invalid path. Hand Attaform the errors and they land in the same reactive surface as schema errors: same `firstError` reads, same focus and scroll on submit, same display gating.

::docs-meta-table
::

The demo signs in against a simulated backend. Submit with the wrong password to land an error right under the field; sign in as `locked@example.com` to get a form-level lockout whose structured `data` payload carries the unlock time. Every response routes through a single `form.setErrors` call.

::docs-demo{slug="server-side-errors" label="Server Errors Demo"}
::

## One shape in, one shape out

Attaform reads and writes errors in one shape, `ValidationError`, the same record the validator produces. So when your server speaks that shape, there is nothing to translate: hand the array straight to `form.setErrors`.

```ts
const onSubmit = form.handleSubmit(async (values) => {
  form.clearErrors()
  const response = await api.signIn(values)

  if (!response.ok) {
    form.setErrors(response.errors)
    return
  }
  // success path
})
```

`response.errors` is a `ValidationError[]`: each entry carries a `message`, an optional `path`, an optional `code`, and an optional `data` payload. An entry with a `path` lands at that field; an entry with no path lands at the form level, in the global `[]` bucket. `form.setErrors` stamps the form key on every entry as it lands, so errors stay isolated to this form.

Returning after `setErrors` is a failed submit: `form.meta.submitted` stays `false` and focus pulls to the first error. It does not fire `onError`, though, that callback is the verdict on Attaform's own validation, which already passed here. You do not need to throw to signal the rejection, and you do not need to call `form.focusFirstError()` by hand. Reserve a thrown error for the unexpected (a network drop, a 500), which also lands on `form.meta.submitError` for inspection.

## `setErrors` and `clearErrors`

`form.setErrors` owns the manual error layer, the errors you set by hand. Schema errors live in their own layer and merge in on read, so setting manual errors never disturbs validation. Its call forms mirror [`form.setValue`](/docs/writing-and-mutating/set-value):

| Call                      | Effect                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `setErrors(errors)`       | Replace the whole manual layer with this list. Each entry lands at its own `path`. |
| `setErrors(prev => next)` | Functional replace. `prev` is the current manual layer as a `ValidationError[]`.   |
| `setErrors(path, errors)` | Scope to one path. Replaces that path's manual errors and stamps the path for you. |
| `clearErrors(path?)`      | Clear one path, or everything with no argument, schema and manual errors alike.    |

```ts
form.setErrors(response.errors) // whole layer, each entry at its path
form.setErrors([{ message: 'Service unavailable, try again shortly.' }]) // a form-level banner
form.setErrors('email', [{ message: 'Already registered' }]) // scoped to one field
form.setErrors((prev) => [...prev, { path: ['email'], message: 'Also flagged by fraud check' }])
form.clearErrors('email') // one field
form.clearErrors() // everything
```

A whole-layer `setErrors` is a full replace: any path absent from the new list is cleared. Reach for the scoped form or the functional updater when you want to touch one path and leave the rest alone.

## The error shape

What you read back is firm: every `ValidationError` has a `message`, a `path`, a `code`, and a `formKey`. What you pass in is loose, so a server response rarely needs massaging:

```ts
type ErrorInput =
  | Error
  | {
      message?: string
      path?: (string | number)[]
      code?: string
      data?: Json | null
      formKey?: FormKey
    }
```

- **`message`** is optional. An `Error` contributes its `message`; a missing or empty message becomes `"Unknown error"` rather than throwing.
- **`path`** defaults to `[]` (form level). The scoped `setErrors(path, ...)` form stamps the path for you and ignores any path on the entry.
- **`code`** defaults to `atta:user-error`. Set your own (`auth:locked`, `api:duplicate`) to branch on it in the UI.
- **`data`** is an opaque `Json` payload Attaform never inspects. It rides along untouched, so a lockout can carry its unlock time, a challenge its captcha token, a step-up its MFA descriptor.
- **`formKey`** is accepted but ignored: the form always stamps its own. So a `ValidationError` you read back (from `form.errors()`, or a server that already speaks the shape) is itself valid input, with no mapping required.

Reading `data` where you render the error is how the lockout banner in the demo knows when to unlock:

```ts
const lockout = computed(() => {
  const locked = form.meta.ownErrors.find((e) => e.code === 'auth:locked')
  const data = locked?.data as { unlocksAt?: string } | null | undefined
  return data?.unlocksAt ? new Date(data.unlocksAt) : null
})
```

## Servers that speak a different shape

When a backend returns its own envelope, map it to `ValidationError` in one pass at the call site. There is no parser to configure and no shape for Attaform to guess at: you own the one line that knows your server, and everything past it is the canonical contract.

```ts
const response = await api.signUp(values)

if (!response.ok) {
  form.setErrors(response.failures.map((f) => ({ path: f.field.split('.'), message: f.detail })))
  return
}
```

## The same reactive surface

Once set, server errors are indistinguishable from schema errors at every read:

- `form.errors.email` returns the `ValidationError[]` at that path, server or schema, same shape.
- `form.fields.email.firstError` returns the first one, and `form.fields.email.showErrors` gates its display through the [display-state](/docs/validation/showing-errors) predicate.
- `form.meta.ownErrors` returns the form-level errors on their own, and `form.meta.firstOwnError` is the first, ideal for a top-of-form banner.
- `form.focusFirstError()` pulls focus to the first server error exactly as it would a schema one.

No "this one came from the server" branch in your template. The render code reads `form.fields.<path>.firstError?.message` the same way for both.

## Clearing on a fresh round-trip

A server error stays put until you clear it: editing the field does not drop it on its own, which matches the network round-trip (the value is not re-checked until the next submit). Clearing the whole layer at the top of `handleSubmit` is the common rhythm, so each submit starts clean.

For clear-on-edit UX, watch the path and clear it:

```ts
watch(
  () => form.values.email,
  () => form.clearErrors('email')
)
```

## Where to next

- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface server errors plug into.
- [Focus & scroll on invalid submit](/docs/submitting/focus-scroll): the same machinery, applied to server errors after they land.
- [`errors`](/docs/reading-the-form/errors): the reactive read surface for every error, server or schema.
- [Types reference](/docs/reference/types): `ValidationError`, `ErrorInput`, and `Json` in full.
