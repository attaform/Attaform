---
title: The validation lifecycle
description: validate(), validateAsync(), and parse() are the three imperative entry points to the validator. Same predicates, different return shapes; pick by what you need to do next.
metaRows:
  - label: Category
    value: Return methods
  - label: Methods
    value: validate · validateAsync · parse
    kind: code
  - label: validate
    value: reactive ref, sync only
  - label: validateAsync
    value: Promise, awaits async refinements
  - label: parse
    value: Promise, returns parsed Zod output
---

# The validation lifecycle

> Three imperative entry points to the same validator. Pick by what you need next: reactive read, awaited verdict, or parsed payload.

::docs-meta-table
::

Click each button to dispatch the matching method against the current form values. The result panel surfaces the return shape of each: a reactive status snapshot from `validate()`, an awaited verdict from `validateAsync()`, and the fully parsed Zod output from `parse()`. The methods share the predicate pipeline; the differences are about what they hand you back.

::docs-demo{slug="validation-lifecycle" label="Lifecycle Demo"}
::

## `validate(path?)`

```ts
const status = form.validate()
// status.value.pending: true while async refinements are in flight
// status.value.success: true once everything passes (after settling)
```

Returns a `Readonly<Ref<ReactiveValidationStatus<Form>>>`, Vue's reactive surface for the validation result. Reads inside `computed` / `watchEffect` / templates track changes; the ref re-renders consumers when the verdict flips.

Sync-only by nature: the predicate work runs synchronously, but async refinements get observed via the `pending` flag rather than awaited. Use `validate()` when you want a reactive "is this valid right now?" read without holding up the caller.

Optional `path` argument scopes the validation to a subtree (`validate('profile.email')` runs predicates only for that path).

## `validateAsync(path?)`

```ts
const result = await form.validateAsync()
if (result.success) {
  // every refinement passed, including async ones
}
```

Returns a `Promise<ValidationResponseWithoutValue<Form>>`. Awaits every async refinement before resolving; the result is the final verdict.

Use this for non-submit code paths that need a synchronous-feeling "is this valid?" gate: a "Save draft" button that can write partial state but wants to know whether the data is shippable, a step-completion guard in a multi-step flow, anything that needs to react after every check has settled.

## `parse(path?)`

```ts
const result = await form.parse()
if (result.success) {
  await api.send(result.data) // parsed Zod output
}
```

Returns a `Promise<ValidationResponse<GetValueFormType>>`, the same shape as `validateAsync` plus the parsed value when validation passes. The parsed value runs through Zod's transforms and refinements, so `result.data` reflects every `.transform(...)` and `.preprocess(...)` in the schema.

`parse` is always async, and there is no synchronous variant by design. A schema can grow an async refinement or transform at any moment, and a sync parse would quietly skip it the instant one lands. One always awaited `parse` closes that whole category, so the call reads the same way every time: `await form.parse()`.

Use `parse` when validation success means dispatching the parsed output to an API or downstream pipeline; `handleSubmit` is built on top of it.

## Choosing between the three

| Need                                                 | Reach for                                         |
| ---------------------------------------------------- | ------------------------------------------------- |
| Reactive "is this valid?" read in a template         | `validate()` (or `meta.valid`)                    |
| Awaited verdict in a code path                       | `validateAsync()`                                 |
| Awaited verdict + parsed payload to ship             | `parse()`                                         |
| Submit gate that calls `onSubmit` with parsed values | `handleSubmit()` (which calls `parse` internally) |

For most form UX, you reach for `meta.valid` (reactive read) and `handleSubmit` (gated dispatch). The three lifecycle methods are escape hatches for the cases where those two don't fit.

## Where to next

- [Per-field validation](/docs/validation/per-field-validation): the predicate patterns the lifecycle runs against.
- [Async refinements](/docs/validation/async-refinements): what `validateAsync` and `parse` await.
- [When validation runs](/docs/validation/when-validation-runs): the `validateOn` cadence that drives passive runs.
- [`handleSubmit`](/docs/submitting/handle-submit): the dispatch surface built on top of `parse`.
