---
title: Quick start
description: Build your first Attaform in five minutes. A typed Zod schema, validated inputs bound by directive, and a submit handler that knows when the form is ready.
metaRows:
  - label: Time
    value: ~5 minutes
  - label: You'll learn
    value: useForm + register + handleSubmit
---

# Quick start

> A typed schema, validated inputs, a submit handler. The minimum viable form in five minutes.

::docs-meta-table
::

Try the form below: clear the password and submit to watch focus pull to the broken field; submit with valid values to see the alert fire. Every behavior on screen comes from the Zod schema in code, which you'll see in the [Build a form](#build-a-form) section next.

::docs-demo{slug="quick-start" label="Sign-in Demo"}
::

## Build a form

Hand `useForm` a Zod schema and the reactive form comes back ready. This page reaches for three properties on the returned form: `register` for the input binding, `handleSubmit` for the submit gate, and `fields` for per-field error reads.

<!-- @generated-start:quick-start-script -->

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

const form = useForm({ schema })

const onSubmit = form.handleSubmit(async (values) => {
  await fetch('/api/sign-in', { method: 'POST', body: JSON.stringify(values) })
})
```

<!-- @generated-end:quick-start-script -->

Bind inputs to schema paths with `v-register`:

<!-- @generated-start:quick-start-template -->

```vue
<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label>
      Password
      <input type="password" v-register="form.register('password')" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <button :disabled="form.meta.submitting" type="submit">Sign in</button>
  </form>
</template>
```

<!-- @generated-end:quick-start-template -->

`form.register('email')` returns what the `v-register` directive binds to. The directive handles the value read, the write, the coercion, and focus on invalid submit. Errors render via `form.fields.<path>.firstError?.message`, gated by `form.fields.<path>.showErrors` so the form doesn't yell on first paint.

## What's next

- [Your first schema](/docs/getting-started/your-first-schema): what Attaform reads from a Zod definition.
- [The form](/docs/reading-the-form/the-form): the full reactive surface returned by `useForm`.
- [When validation runs](/docs/validation/when-validation-runs): the moment errors appear.
