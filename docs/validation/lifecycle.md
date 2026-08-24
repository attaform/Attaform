---
title: The validation lifecycle
description: validate() and parse() are the two imperative entry points to the validator. Same predicates, different return shapes; parse's commit mode also lands the verdict on form.errors.
metaRows:
  - label: Category
    value: Return methods
  - label: Methods
    value: validate · parse
    kind: code
  - label: validate
    value: reactive ref, tracks async refinements via pending
  - label: parse
    value: Promise, returns parsed Zod output
  - label: parse commit mode
    value: writes the verdict to form.errors
---

# The validation lifecycle

> Two imperative entry points to the same validator. Pick by what you need next: a reactive read, or an awaited verdict with the parsed payload. `parse`'s commit mode also lands the verdict on `form.errors`.

::docs-meta-table
::

Click each button to dispatch the matching method against the current form values. The result panel surfaces the return shape of each: a reactive status snapshot from `validate()`, an awaited committing run from `form.parse({ commit: true })`, and the pure parsed read from `form.parse()`. The methods share the predicate pipeline; the differences are about what they hand you back and what they leave behind.

::docs-demo{slug="validation-lifecycle" label="Lifecycle Demo"}
::

## `validate(path?)`

```ts
const status = form.validate()
// status.value.pending: true while async refinements are in flight
// status.value.success: true once everything passes (after settling)
```

Returns a `Readonly<Ref<ReactiveValidationStatus<Form>>>`, Vue's reactive surface for the validation result. Reads inside `computed` / `watchEffect` / templates track changes; the ref re-renders consumers when the verdict flips.

The predicate work runs on every form mutation, and async refinements are observed via the `pending` flag rather than awaited. Use `validate()` when you want a reactive "is this valid right now?" read without holding up the caller.

Optional `path` argument scopes the validation to a subtree (`validate('profile.email')` runs predicates only for that path).

## `parse(path?)`

```ts
const result = await form.parse()
if (result.success) {
  await api.send(result.data) // parsed Zod output
}
```

Returns a `Promise<ValidationResponse<GetValueFormType>>`: the awaited verdict plus the parsed value when validation passes. The parsed value runs through Zod's transforms and refinements, so `result.data` reflects every `.transform(...)` and `.preprocess(...)` in the schema.

The default call is a pure read. Nothing is written to `form.errors`, and any in-flight per-field validation keeps running undisturbed: `parse()` answers "what would the parsed form look like right now?" without touching the live error surface.

`parse` is always async, and there is no synchronous variant by design. A schema can grow an async refinement or transform at any moment, and a sync parse would quietly skip it the instant one lands. One always awaited `parse` closes that whole category, so the call reads the same way every time: `await form.parse()`.

Use `parse` when validation success means dispatching the parsed output to an API or downstream pipeline; `handleSubmit` is built on top of it.

## `parse(path?, { commit: true })`

```ts
const result = await form.parse({ commit: true })
if (!result.success) {
  // result.errors is also live on form.errors now
}
```

Commit mode makes the run authoritative. Two things change relative to the pure read: the verdict is written to the error store at the parsed scope, so `form.errors` and the per-field error surfaces reflect it immediately, and any in-flight per-field validation runs are cancelled first (the same pre-check `handleSubmit` performs), so a slow background run can't overwrite the result you just awaited.

Use it for non-submit code paths that need an awaited "is this valid?" gate with visible consequences: a "Save draft" button that wants both the answer and the error highlighting, a step-completion guard in a multi-step flow, an autosave gate. Scope it with a path to validate and commit a single subtree: `await form.parse('profile.email', { commit: true })` lands a deterministic view of `form.errors.profile.email`.

## Choosing between them

| Need                                                 | Reach for                                         |
| ---------------------------------------------------- | ------------------------------------------------- |
| Reactive "is this valid?" read in a template         | `validate()` (or `meta.valid`)                    |
| Awaited verdict + parsed payload, no side effects    | `parse()`                                         |
| Awaited verdict that also lands on `form.errors`     | `parse({ commit: true })`                         |
| Submit gate that calls `onSubmit` with parsed values | `handleSubmit()` (which calls `parse` internally) |

For most form UX, you reach for `meta.valid` (reactive read) and `handleSubmit` (gated dispatch). The lifecycle methods are escape hatches for the cases where those two don't fit.

## Where to next

- [Per-field validation](/docs/validation/per-field-validation): the predicate patterns the lifecycle runs against.
- [Async refinements](/docs/validation/async-refinements): what `parse` awaits.
- [When validation runs](/docs/validation/when-validation-runs): the `validateOn` cadence that drives passive runs.
- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface built on top of `parse`.
