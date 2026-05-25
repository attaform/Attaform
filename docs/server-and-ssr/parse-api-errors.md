---
title: Parsing API errors
description: parseApiErrors normalizes server failure responses into ValidationError[] that setFieldErrors mounts into the form. One parser, three envelope shapes, both structured and bare-string entries, discriminated result type.
metaRows:
  - label: Category
    value: Helper
  - label: Signature
    value: 'parseApiErrors(envelope, { formKey })'
    kind: code
  - label: Returns
    value: '{ ok, errors, rejected? }'
    kind: code
  - label: Mount with
    value: setFieldErrors / addFieldErrors
    kind: code
---

# Parsing API errors

> Map server failure responses into Attaform's reactive error store via `parseApiErrors`. JSON envelopes or bare details records, dotted paths, codes preserved end-to-end.

::docs-meta-table
::

This page focuses on the **parser surface**: the envelope shapes the helper accepts, the discriminated result type, and how `setFieldErrors` mounts the parsed entries. The [Server-side errors](/docs/submitting/server-side-errors) page covers the full pipeline integration with `handleSubmit`. Both pages reference the same parser; this one's the deep dive.

## The signature

```ts
parseApiErrors(
  envelope: unknown,
  options: { formKey: string }
): ParseApiErrorsResult
```

`envelope` is whatever the server returned; the parser introspects it to figure out which shape it received. `options.formKey` stamps each produced `ValidationError` with the form's key for cross-form isolation. The full options bag also accepts `defaultCode` (default `'api:unknown'`, used for bare-string entries) and the size caps `maxEntries` / `maxPathDepth` / `maxTotalSegments` for hostile-payload protection.

## The result type

A discriminated result so malformed payloads don't throw:

```ts
type ParseApiErrorsResult = {
  readonly ok: boolean
  readonly errors: ValidationError[]
  readonly rejected?: string
}
```

- `{ ok: true, errors }`: envelope recognized. `errors` may be empty (server returned a 422 with no field-level details).
- `{ ok: false, errors: [], rejected }`: envelope shape wasn't recognized. `rejected` carries a one-line description ("payload was string, expected object", etc.). Log it; don't apply.

```ts
const result = parseApiErrors(err.data, { formKey: form.key })
if (result.ok) {
  form.setFieldErrors(result.errors)
} else {
  console.error('Unexpected error payload:', result.rejected, err.data)
}
```

## Envelope shapes

### Wrapped envelope

```ts
{
  error: {
    details: {
      email: { message: 'already taken', code: 'api:duplicate-email' },
      password: [
        { message: 'too short', code: 'api:min-length' },
        { message: 'must contain a digit', code: 'api:digit-required' },
      ],
    },
  },
}
```

The parser walks to `error.details` and reads each key-value pair as `path → ValidationError[]`.

### Bare details record

```ts
{
  email: { message: 'already taken', code: 'api:duplicate-email' },
  password: [
    { message: 'too short', code: 'api:min-length' },
    { message: 'must contain a digit', code: 'api:digit-required' },
  ],
}
```

Same logic, no `error.details` wrapper; the parser introspects the top level for `{ message, code }` entries (or arrays thereof) keyed by path. Pick this shape when the API already returns flat field-error records.

### Entry shape

Each detail value is one of two shapes (or a mix-and-match array of both):

1. **Structured**: `{ message: string, code: string }`. The `code` is forwarded verbatim onto the produced `ValidationError`.

   ```ts
   { message: 'already taken', code: 'api:duplicate-email' }
   ```

2. **Bare-string**: a plain string. The parser synthesizes a `ValidationError` with `message` set to the string and `code` set to `options.defaultCode` (default `'api:unknown'`). This is the Rails / Django REST Framework / FastAPI / Laravel shape:

   ```ts
   { email: ['Email already taken.'], username: 'too short' }
   ```

   Pass a more specific `defaultCode` (`'api:server-validation'`, `'myapp:legacy'`, etc.) when you know the source.

A field's value is either a single entry, an array, or a mix of structured and bare-string entries. Array entries each produce their own `ValidationError`, so a single field can carry multiple distinct failures.

## Path shapes

Keys are dotted paths; the parser canonicalizes them into the form's path tuple:

```ts
{
  'user.email': { message: 'already taken', code: 'api:dup' },
  'items.0.qty': { message: 'must be positive', code: 'api:pos' },
  'meta.tags.2': { message: 'invalid tag', code: 'api:invalid-tag' },
}
```

- Plain field names → object property segments.
- Numeric segments → array indices.
- Multi-segment dots → nested object traversal.

Bracket notation is NOT recognized; `items[0].qty` doesn't parse. Use `items.0.qty` instead and match your API's serialization to the dotted-segment convention.

## Code prefixes

Pick a prefix for the codes (`api:`, `auth:`, `myapp:`) and stay consistent. The prefix lets renderers branch on `code` rather than matching message strings:

```vue
<template>
  <span v-if="form.errors.email?.[0]?.code === 'api:duplicate-email'" class="error">
    That email is already registered.
    <NuxtLink :to="`/sign-in?email=${form.values.email}`">Sign in instead?</NuxtLink>
  </span>
  <span v-else-if="form.errors.email?.[0]" class="error">
    {{ form.errors.email[0].message }}
  </span>
</template>
```

The prefix also helps when a single field carries both schema and API errors: schema codes typically start `zod:` / `atta:`; API codes start with your prefix. Filtering by prefix tells you which source emitted each entry.

## Mounting parsed errors

Three methods land parsed errors into the form:

| Method                    | Behavior                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `setFieldErrors(errors)`  | Replace the user-error set with the supplied list. Common case after a fresh server round-trip. |
| `addFieldErrors(errors)`  | Append to the existing set without clearing prior entries.                                      |
| `clearFieldErrors(path?)` | Drop all errors (no arg) or just one path's user-errors.                                        |

```ts
form.setFieldErrors(parsed.errors)
form.addFieldErrors([{ path: ['email'], message: 'Already registered', code: 'custom' }])
form.clearFieldErrors('email')
form.clearFieldErrors() // clear everything
```

User-injected errors persist across schema revalidation and successful submits; they're stored separately from schema errors. Schema validation can't replace them, and a successful submit doesn't auto-clear them. The user's next keystroke re-runs schema validation against the field (updating the schema half), but your API entries stay until you call `clearFieldErrors` or unmount.

## Auto-clear on edit?

By default, editing a field after a server error landed at that path does NOT auto-clear the error. Most servers want a fresh round-trip before the error is "cleared," so this matches the network round-trip semantics.

For "clear on edit" UX, hook a watcher:

```ts
watch(
  () => form.values.email,
  () => form.clearFieldErrors('email')
)
```

## Reading the parsed errors in the template

Once mounted, server errors are indistinguishable from schema errors at the read surfaces:

- `form.errors.email` returns the `ValidationError[]` (server or schema, same shape).
- `form.fields.email.firstError` returns the first one.
- `form.fields.email.showErrors` gates display per the [`shouldShowErrors`](/docs/validation/showing-errors) predicate.
- `focusFirstError()` pulls focus to the first server error just like a schema one.

No special "this is a server error" surface in the template. The render code reads `form.fields.<path>.firstError?.message` the same way for both kinds.

## Where to next

- [Server-side errors](/docs/submitting/server-side-errors): the full `handleSubmit` integration story.
- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface that owns the success / error split.
- [Focus & scroll on invalid submit](/docs/submitting/focus-scroll): server errors plug into the same focus pull as schema errors.
