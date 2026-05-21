---
title: Errors reference
description: Every library-emitted error class and every AttaformErrorCode. Catch AttaformError once, branch on subclass — and code-key library validations through the small set of stable identifiers.
metaRows:
  - label: Category
    value: Reference
  - label: Base class
    value: AttaformError extends Error
    kind: code
  - label: Code prefix
    value: 'atta:'
    kind: code
  - label: Match by
    value: instanceof for classes, code for ValidationError
---

# Errors reference

> Every library-emitted error class with the failure mode it represents, plus the small set of stable `code` identifiers for `ValidationError` entries the library produces.

::docs-meta-table
::

This page is reference material. Two surfaces: throw-class errors (caught with `instanceof`) and `ValidationError.code` strings (matched in template / handler logic). Both follow the `atta:` prefix convention for library-emitted entries; consumer codes use whatever prefix you pick (`api:`, `auth:`, `myapp:`).

## Catching errors polymorphically

Every library-emitted throw extends `AttaformError`, so a single polymorphic catch works:

```ts
import { AttaformError } from 'attaform'

try {
  // useForm setup, register call, persist call, etc.
} catch (err) {
  if (err instanceof AttaformError) {
    // It's one of ours — log and handle.
    console.error('[attaform]', err.name, err.message)
  } else {
    throw err
  }
}
```

Branch on the subclass for targeted handling:

```ts
import { AttaformError, OutsideSetupError, SensitivePersistFieldError } from 'attaform'

try {
  // …
} catch (err) {
  if (err instanceof OutsideSetupError) {
    // Move the call into a Vue setup function
  } else if (err instanceof SensitivePersistFieldError) {
    // Drop the { persist: true }, or pass acknowledgeSensitive
  } else if (err instanceof AttaformError) {
    // Catch-all
  } else {
    throw err
  }
}
```

## Error classes

### `AttaformError`

Base class — never thrown directly, only via subclasses. Provides the polymorphic-catch entry point.

```ts
class AttaformError extends Error {}
```

### `InvalidPathError`

A path string can't be canonicalized against the form's schema. Typical cause: a typo in `register('parh')` or `setValue('a.bb.c')` against a schema with no `.bb`.

### `InvalidUseFormConfigError`

`useForm` received an invalid configuration — most often a schema passed directly instead of inside an options object (`useForm(schema)` rather than `useForm({ schema })`).

### `SubmitErrorHandlerError`

The `onError` callback passed to `handleSubmit` threw. Caught and re-thrown wrapped in this class so the wrapping submit lifecycle can distinguish "user error handler crashed" from "validation failed."

### `RegistryNotInstalledError`

A library API needs the registry attached to a Vue app, but it isn't installed. Auto-install kicks in for the lazy bootstrap path, so this usually means `useRegistry()` was called from outside a Vue app's lifecycle.

### `OutsideSetupError`

`useForm` / `injectForm` / similar composable called outside Vue setup. Move the call inside a `setup()` function or `<script setup>` block.

### `ReservedFormKeyError`

The `__atta:` namespace is reserved for internal use; passing a form key starting with `__atta:` throws. Pick a different prefix.

### `SensitivePersistFieldError`

`register(path, { persist: true })` was called for a path matching the resolved `sensitiveNames` list. Either drop the `persist: true`, pass `{ acknowledgeSensitive: true }` for an intentional override, or remove the path from the `sensitiveNames` list. Carries the offending path on `err.path`.

### `AnonPersistError`

Persistence is configured on an anonymous (no `key`) form. The cause property distinguishes:

- `'no-key'` — no `key` passed; persistence needs a stable key to prefix storage entries.
- `'register-without-config'` — a register call passes `{ persist: true }` against an anonymous form (which wouldn't have a backend even with `persist:` on the form).

Carries `schemaFields` (the leaves on the form's schema, for diagnostic context) and `callSite` (the file:line of the offending call).

## `AttaformErrorCode`

A small, stable enum for library-emitted `ValidationError.code` values. The codes follow `atta:` prefix convention; pair with `parseApiErrors` to read the `code` field reactively in templates.

```ts
import { AttaformErrorCode } from 'attaform'

if (form.errors.email?.[0]?.code === AttaformErrorCode.NoValueSupplied) {
  // …
}
```

| Code value               | Constant                            | Emitted when                                                       |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| `atta:no-value-supplied` | `AttaformErrorCode.NoValueSupplied` | A required leaf is in `blankPaths` (numeric auto-mark or `unset`). |
| `atta:adapter-threw`     | `AttaformErrorCode.AdapterThrew`    | An `AbstractSchema` method (validate, getDefaults, etc.) threw.    |
| `atta:path-not-found`    | `AttaformErrorCode.PathNotFound`    | A path canonicalization rejected the input as not reachable.       |

Three codes today; the enum will grow as code-keyed error paths emerge. Don't expect every library-internal error to surface as a stable code — the codes are reserved for cases where consumer templates legitimately want to branch on a specific failure mode without matching message strings.

## The `ValidationError` shape

Every error in `form.errors.<path>`, `form.meta.errors`, and the parser's result has this shape:

```ts
type ValidationError = {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  readonly code: string
  readonly formKey: string
}
```

- `path` — the canonical segment tuple (`['profile', 'email']`).
- `message` — the human-readable error text.
- `code` — stable identifier (`atta:no-value-supplied`, `zod:invalid_type`, `api:duplicate-email`, etc.).
- `formKey` — which form emitted the error. Useful for cross-form aggregation in wizards.

The `code` is what consumers branch on; the `message` is what templates render. Avoid matching `message` strings — they're localized and may change over time without breaking the public contract.

## Code prefixes by source

| Prefix  | Source                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `atta:` | Library-emitted (the three `AttaformErrorCode` values).                                                                 |
| `zod:`  | Zod adapter (computed from `issue.code` — `zod:invalid_type`, `zod:too_small`, etc.).                                   |
| `api:`  | Conventional prefix for consumer-emitted server errors. Pick whatever convention fits the app — `auth:`, `myapp:`, etc. |

The prefix tells you where the error came from without parsing the rest of the string.

## Where to next

- [`parseApiErrors`](/docs/server-and-ssr/parse-api-errors) — generate consumer-coded `ValidationError`s from server responses.
- [The `blank` field-state bit](/docs/validation/blank) — the side-channel that surfaces `atta:no-value-supplied`.
- [Server-side errors](/docs/submitting/server-side-errors) — the full flow from API failure to reactive `form.errors`.
