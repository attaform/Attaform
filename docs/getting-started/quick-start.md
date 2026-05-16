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

::docs-demo{slug="quick-start"}
::

## Install

::ui-install-command{:show-quick-start="false"}
::

## Build a form

Hand `useForm` a Zod schema and the reactive surface comes back ready: `values`, `errors`, `meta`, plus a `register` helper that the `v-register` directive binds to:

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const { register, handleSubmit, fields } = useForm({
  schema: z.object({
    email: z.email(),
    password: z.string().min(8),
  }),
})

const onSubmit = handleSubmit((values) => {
  // values is the parsed Zod output, fully typed.
  alert(JSON.stringify(values, null, 2))
})
```

Bind inputs to schema paths with `v-register`:

```vue
<template>
  <form @submit="onSubmit">
    <input v-register="register('email')" />
    <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>

    <input v-register="register('password')" type="password" />
    <em v-if="fields.password.showErrors">{{ fields.password.firstError?.message }}</em>

    <button type="submit">Sign in</button>
  </form>
</template>
```

`register('email')` returns what the `v-register` directive binds to. The directive handles the value read, the write, the coercion, and focus on invalid submit. Errors render via `fields.<path>.firstError?.message`, gated by `fields.<path>.showErrors` so the form doesn't yell on first paint.

## What's next

- [Your first schema](/docs/getting-started/your-first-schema): what Attaform reads from a Zod definition.
- [The form object](/docs/reading-the-form/the-form-object): the full reactive surface returned by `useForm`.
- [When validation runs](/docs/validation/when-validation-runs): the moment errors appear.
