---
title: From inputs to submit
description: Wire a submit handler to a typed form — handleSubmit gates dispatch on validation, exposes the parsed values, and reports back through meta.submitting.
meta:
  - label: Read time
    value: ~4 minutes
  - label: Builds on
    value: From schema to inputs
---

# From inputs to submit

> `handleSubmit` waits for validation, hands you parsed values, and reports submission state through `meta.submitting`.

<DocsMetaTable />

<DocsDemo slug="inputs-to-submit" />

## The submit handler

`form.handleSubmit(onSuccess, onError?)` returns a handler bound to `<form @submit.prevent>`. The handler:

- Runs sync + async validation on every active path.
- Waits for pending async refinements before dispatching.
- Calls `onSuccess(values)` only if validation passes — `values` is the parsed Zod output, fully typed.
- Calls `onError(errors)` if validation fails. By default, focus moves to the first invalid field.

```ts
const onSubmit = handleSubmit(
  async (values) => {
    await api.signup(values)
  },
  (errors) => {
    console.log('Validation failed', errors)
  }
)
```

```vue
<form @submit.prevent="onSubmit">…</form>
```

## meta.submitting

While `onSuccess` is running, `form.meta.submitting` is `true`. Use it to disable the submit button or surface a spinner:

```vue
<button :disabled="meta.submitting" type="submit">
  {{ meta.submitting ? 'Saving…' : 'Save' }}
</button>
```

`submitting` flips back to `false` when the callback resolves (or rejects — `handleSubmit` catches and surfaces the failure through its error hooks).

## Where to next

- [`handleSubmit`](/docs/submitting/handle-submit) — the full submit surface, including error handlers and event semantics.
- [The form object](/docs/reading-the-form/the-form-object) — every method and property `useForm` returns.
