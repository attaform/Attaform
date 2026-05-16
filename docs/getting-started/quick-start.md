---
title: Quick start
description: Build your first Attaform form in five minutes — a typed Zod schema, validated inputs bound by directive, and a submit handler that knows when the form is ready.
metaRows:
  - label: Time
    value: ~5 minutes
  - label: Prerequisites
    value: Vue 3, Zod
  - label: You'll learn
    value: useForm + register + handleSubmit
---

# Quick start

> A typed schema, validated inputs, a submit handler — the minimum viable form in five minutes.

::docs-meta-table
::

Try the form below — clear the password and submit to watch focus pull to the broken field; submit with valid values to see the alert fire. Every behavior on screen comes from the Zod schema in code, which you'll see in the [Build a form](#build-a-form) section next.

::docs-demo{slug="quick-start"}
::

## Install

```bash
pnpm add attaform zod
```

## Build a form

Hand `useForm` a Zod schema and the reactive surface comes back ready — `values`, `errors`, `meta` — plus a `register` directive that binds inputs:

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const { register, handleSubmit, fields } = useForm({
  schema: z.object({
    email: z.string().email(),
    password: z.string().min(8),
  }),
})

const onSubmit = handleSubmit(async (values) => {
  // values is the parsed Zod output — fully typed.
  await api.signup(values)
})
```

`register('email')` returns what the `v-register` directive binds to. The directive handles the value read, the write, the coercion, and focus on invalid submit. For each field, render its first error via `fields.email.firstError?.message`, gated by `fields.email.showErrors` so the form doesn't yell on first paint.

## What's next

- [Your first schema](/docs/getting-started/your-first-schema) — what Attaform reads from a Zod definition.
- [The form object](/docs/reading-the-form/the-form-object) — the full reactive surface returned by `useForm`.
- [When validation runs](/docs/validation/when-validation-runs) — the moment errors appear.
