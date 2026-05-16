---
title: Quick start
description: Build your first Attaform form in five minutes — a typed Zod schema, validated inputs bound by directive, and a submit handler that knows when the form is ready.
meta:
  - label: Time
    value: ~5 minutes
  - label: Prerequisites
    value: Vue 3, Zod
  - label: You'll learn
    value: useForm + register + handleSubmit
---

# Quick start

> A typed schema, validated inputs, a submit handler — the minimum viable form in five minutes.

<DocsMetaTable />

<DocsDemo slug="quick-start" />

## Install

```bash
pnpm add attaform zod
```

Plug Attaform into your Vue app once, then call `useForm` wherever you need a form:

```ts
import { createApp } from 'vue'
import { createAttaform } from 'attaform'
import App from './App.vue'

createApp(App).use(createAttaform()).mount('#app')
```

Nuxt users install the [Nuxt module](/docs/getting-started/installation) instead — same behavior, zero ceremony.

## Build a form

Hand `useForm` a Zod schema and the reactive surface comes back ready — `values`, `errors`, `meta` — plus a `register` directive that binds inputs:

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const { register, handleSubmit, errors } = useForm({
  schema: z.object({
    email: z.string().email(),
    password: z.string().min(8),
  }),
})
```

`register('email')` returns what the `v-register` directive binds to. The directive handles the value read, the write, the coercion, and focus on invalid submit.

## What's next

- [Your first schema](/docs/getting-started/your-first-schema) — what Attaform reads from a Zod definition.
- [The form object](/docs/reading-the-form/the-form-object) — the full reactive surface returned by `useForm`.
- [When validation runs](/docs/validation/when-validation-runs) — the moment errors appear.
