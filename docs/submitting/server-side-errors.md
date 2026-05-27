---
title: Server-side errors
description: parseApiErrors translates API failure responses into ValidationError[]; setFieldErrors / addFieldErrors / clearFieldErrors mount them into the same reactive surface the validator uses.
metaRows:
  - label: Category
    value: Helper + Return methods
  - label: Parser
    value: parseApiErrors(envelope, { formKey })
    kind: code
  - label: Mounters
    value: setFieldErrors · addFieldErrors · clearFieldErrors
    kind: code
  - label: Returns
    value: '{ ok: true, errors } | { ok: false, reason }'
    kind: code
---

# Server-side errors

> Treat API failures the same as schema failures: same reactive surface, same `firstError` reads, same focus / scroll behavior on submit.

::docs-meta-table
::

Submit with `taken@example.com` as the email and `admin` as the username to watch the simulated server response route through `parseApiErrors` → `setFieldErrors`. The errors land at `errors.email` and `errors.username`, the field-level `firstError` surfaces them next to the inputs, and the form-level focus pull treats them like any other invalid path. Submit with different values to see the success path fire.

::docs-demo{slug="server-side-errors" label="Server Errors Demo"}
::

## The flow

A successful round-trip lands a value at the form; a failed one needs to land an error at the right path. The three pieces:

1. **`parseApiErrors(envelope, { formKey })`**: normalizes the server response into `ValidationError[]`.
2. **`form.setFieldErrors(errors)`** (or `form.addFieldErrors`): mounts the parsed errors into the form's reactive surface.
3. **`form.clearFieldErrors(path?)`**: drops them when the user starts editing or the next submit fires.

```ts
import { parseApiErrors } from 'attaform'

const onSubmit = form.handleSubmit(async (values) => {
  form.clearFieldErrors()
  const response = await api.signup(values)

  if (!response.ok) {
    const parsed = parseApiErrors(response, { formKey: form.key })
    if (parsed.ok) {
      form.setFieldErrors(parsed.errors)
      return
    }
  }
  // success path
})
```

## `parseApiErrors`

```ts
parseApiErrors(
  envelope: ApiErrorEnvelope,
  options: { formKey: string }
): { ok: true; errors: ValidationError[] } | { ok: false; reason: string }
```

`ApiErrorEnvelope` is the shape the server returns: a wrapped object with a `details` array of `{ path, message }` entries. The parser:

- Validates the envelope shape; returns `{ ok: false, reason }` when it doesn't conform.
- Maps each entry's `path` to the form's path tuple.
- Stamps each error with the form key for cross-form isolation.

When the response is a plain `200 { ok: true }`, skip the call entirely; `parseApiErrors` is for failure paths.

## Mounting errors

Three methods land parsed errors into the form:

| Method                    | Use                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `setFieldErrors(errors)`  | Replace the current error set with the supplied list. Use after a fresh server round-trip.                                          |
| `addFieldErrors(errors)`  | Append to the existing set without clearing prior entries. Use when reporting an additional issue alongside existing schema errors. |
| `clearFieldErrors(path?)` | Drop all errors (no arg) or just one path's errors. Use when the user edits a field that previously had a server error.             |

```ts
form.setFieldErrors(parsedErrors)
form.addFieldErrors([{ path: ['email'], message: 'Already registered', code: 'custom' }])
form.clearFieldErrors('email')
form.clearFieldErrors() // clear everything
```

## Same reactive surface

Once mounted, server errors are indistinguishable from schema errors at the read surfaces:

- `form.errors.email` returns the `ValidationError[]` (server or schema, same shape).
- `form.fields.email.firstError` returns the first one.
- `form.fields.email.showErrors` gates display per the [`getDisplayState`](/docs/validation/showing-errors) predicate.
- `form.focusFirstError()` pulls focus to the first server error just like a schema one.

No special "this is a server error" surface in the template. The render code reads `form.fields.<path>.firstError?.message` the same way for both kinds.

## Auto-clear on edit

By default, editing a field after a server error landed at that path does NOT auto-clear the error: it'll persist until the next submit re-runs or `form.clearFieldErrors` fires explicitly. Most servers want a fresh round-trip before the error is "cleared," so this matches the network round-trip semantics.

For "clear on edit" UX, hook a watcher on the path and call `clearFieldErrors(path)`:

```ts
watch(
  () => form.values.email,
  () => form.clearFieldErrors('email')
)
```

## Where to next

- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface server errors plug into.
- [Focus & scroll on invalid submit](/docs/submitting/focus-scroll): same machinery, applied to server errors after mount.
- [`errors`](/docs/reading-the-form/errors): the reactive read surface for every error, server or schema.
