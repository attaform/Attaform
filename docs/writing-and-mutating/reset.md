---
title: reset & resetField
description: reset() restores the whole form to its defaults; resetField(path) restores one field. Both wipe dirty / touched state along with the value.
metaRows:
  - label: Category
    value: Return method
  - label: Signatures
    value: reset(nextDefaults?) · resetField(path)
    kind: code
  - label: Restores
    value: value, dirty, touched, errors at scope
  - label: Returns
    value: void
    kind: code
---

# `reset` & `resetField`

> The defaults are the destination — `reset` for the whole form, `resetField` for one path. Both wipe state along with values.

::docs-meta-table
::

Type into any field to flip it dirty. Click `resetField` to restore one path; click `reset()` to restore everything; click `reset(newDefaults)` to redirect the defaults AND restore in one call. The dirty markers and the form-level pristine/dirty status update reactively as state reset propagates.

::docs-demo{slug="reset" label="Reset Demo"}
::

## `reset()` restores defaults

```ts
form.reset()
```

Every path goes back to its `defaultValues` entry — or, where no override was given, to the schema-slim default (`''` for strings, `0` for numbers, `false` for booleans). Alongside the value reset:

- `dirty` flips false on every leaf.
- `touched` flips false on every leaf.
- `errors` clear at every path.
- `meta.submitCount`, `meta.isSubmitted`, `meta.submitError` stay (they latch across the lifetime of the form).

`reset()` is the right call after a successful submit when you want the form to look fresh, or when a "Discard changes" button needs to back out unsaved edits.

## `reset(nextDefaults)` redirects defaults

Pass a new defaults object to update the form's defaults AND reset in one step:

```ts
form.reset({ name: 'New Default', email: 'new@example.com' })
```

After this call, the new object IS the form's defaults for any subsequent `reset()` or `resetField` call. Useful when the form needs to switch contexts — editing record A then loading record B's values as the new baseline.

The argument is a `Partial<DefaultValuesInput<Form>>` — fields you don't mention pick up the previous defaults. Pass `{}` to reset with no changes to the defaults.

## `resetField(path)` restores one path

```ts
form.resetField('email')
```

Same semantics as `reset()`, scoped to a single path:

- Value goes back to the path's default.
- `dirty` and `touched` flip false at that path.
- Errors at that path clear.

Useful when one field's been edited but the user wants to discard just that change while keeping the rest of the form's edits in place.

## Reset vs clear

`reset` and `resetField` go to **defaults**. [`clear`](/docs/writing-and-mutating/clear) goes to **blank** — the schema-slim empty value, skipping defaults. Pick reset when "back to baseline" is the goal; pick clear when "wipe to zero" is.

## Where to next

- [`setValue` patterns](/docs/writing-and-mutating/set-value) — write specific values without going through defaults.
- [`clear`](/docs/writing-and-mutating/clear) — wipe to blank values, defaults intentionally skipped.
- [Submit lifecycle](/docs/submitting/handle-submit) — handlers that pair reset with successful submits.
