---
title: The reactive form
description: useForm returns one reactive form, values, fields, errors, meta, register, handleSubmit, setValue, reset, all typed against your schema.
metaRows:
  - label: Category
    value: Return shape
  - label: Returned by
    value: useForm
    kind: code
---

# The reactive form

> Every form on the page is one reactive form: reads, mutators, validation, submit handler, all typed against the schema.

::docs-meta-table
::
`useForm` returns a single reactive form with everything you need to read, write, validate, and submit. The shape is uniform across schema flavors and entry points.

```ts
const form = useForm({ schema })
```

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

`handleSubmit` gates dispatch on validation. Returns a handler ready for `<form @submit.prevent>`.

## Mutations

```ts
import { unset } from 'attaform/zod'

form.setValue('email', 'new@example.com')
form.setValue('age', unset) // flag any path blank by passing the sentinel
form.reset()
form.resetField('email')
form.clear()
```

Every write path runs the same validation, dirty-tracking, and history pipeline.

## Validation

```ts
form.validate() // sync pass
form.validateAsync() // awaits async refinements
```

Validators emit into `form.errors` on completion.

## Where to next

- [`values`](/docs/reading-the-form/values): drillable reads.
- [`errors`](/docs/reading-the-form/errors): per-path error reads.
- [The `v-register` directive](/docs/binding-inputs/v-register): the bind layer.
