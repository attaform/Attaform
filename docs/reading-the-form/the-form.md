---
title: The form
description: useForm returns one reactive form carrying values, fields, errors, meta, register, handleSubmit, setValue, and reset, all typed against your schema.
metaRows:
  - label: Category
    value: Return shape
  - label: Returned by
    value: useForm
    kind: code
---

# The form

> Every form on the page is reactive and supports reading, mutations, validation, and submission handling, all typed against your schema.

::docs-meta-table
::

One call, one form. `useForm` hands back a reactive form that already knows your schema's shape, types, defaults, and validation. Everything below is a property of that single `form` handle: drillable value reads, per-leaf field state, error arrays, the submit handler, mutators. Wire one input, then reach for whatever else you need on the same `form`.

```ts
const schema = z.object({
  email: z.email(),
  age: z.number(),
})

const form = useForm({ schema })
```

The demo below renders one form against an email + name schema. Type, blur, submit, reset; the panels on the right read the same `form` you wire into the inputs.

::docs-demo{slug="the-form" label="The Form Demo"}
::

## Reactive reads

```ts
form.values // drillable proxy: form.values.email
form.fields // per-leaf FieldState: form.fields.email.touched
form.errors // per-path errors: form.errors.email
form.meta // submit / valid / pending aggregates
```

Every read inside a reactive scope (template, `computed`, `watchEffect`) is tracked. Vue re-runs the consumer when the underlying storage changes.

## Directive surface

```ts
form.register('email')
```

`register` returns the RegisterValue the `v-register` directive consumes. Hand it to any native input: text, number, select, checkbox, radio, textarea, file.

## Submission

```ts
const onSubmit = form.handleSubmit(async (values) => {
  await api.signup(values)
})
```

`handleSubmit` gates dispatch on validation. Returns a handler ready for `<form @submit>` (it calls `preventDefault` for you, so `.prevent` is redundant).

## Per-field writes

```ts
import { unset } from 'attaform'

form.setValue('email', 'new@example.com')
form.setValue('age', unset) // flag any path blank by passing the sentinel
form.resetField('email')
```

## Form-level operations

```ts
form.reset() // re-seed every path from defaultValues
form.clear() // wipe every path to its falsy-for-type baseline
form.interact() // simulate a full interaction so seeded values reveal their errors
```

`form.interact(path)` takes a path to arm just one subtree, which is how you surface a single field-array row's errors without a form-wide submit. See [showing errors](/docs/validation/showing-errors#reveal-errors-without-a-submit).

Every write path runs the same validation, dirty-tracking, and history pipeline.

## Validation

```ts
form.validate() // sync pass
form.validateAsync() // awaits async refinements
```

Validators emit into `form.errors` on completion. The same pipeline runs inside [`handleSubmit`](/docs/submitting/handle-submit) before your success callback fires, so reach for `validate` directly only when you need a check outside the submit cycle.

## Where to next

- [`values`](/docs/reading-the-form/values): drillable reads.
- [`fields`](/docs/reading-the-form/fields): per-leaf state, validation, and DOM handles.
- [`errors`](/docs/reading-the-form/errors): per-path error reads.
- [`meta`](/docs/reading-the-form/meta): the form-level aggregation plus the submission cycle.
- [`toRef`](/docs/reading-the-form/to-ref): the ref-shaped escape hatch.
- [The `v-register` directive](/docs/binding-inputs/v-register): the bind layer.
