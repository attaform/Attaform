---
title: Your first schema
description: Attaform reads any Zod schema (required strings, optional fields, refinements, defaults) and turns it into a typed, reactive Attaform with no extra mapping.
metaRows:
  - label: Read time
    value: ~5 minutes
  - label: Builds on
    value: Quick start
---

# Your first schema

> Any Zod schema becomes a typed, reactive Attaform.

::docs-meta-table
::

Type into any of the demo's four inputs (`email`, `password`, `displayName`, `age`) and watch the live `form.values` JSON below the form update in real time. `form.values` is the reactive view of the form data that `useForm` returns, paths and types straight from the schema you handed in. The [What Attaform reads](#what-attaform-reads) section below traces each Zod construct in the demo to its form behavior.

::docs-demo{slug="first-schema" label="Signup Demo"}
::

## What Attaform reads

`useForm` is Attaform's entry point. Hand it a Zod schema and it returns a reactive form carrying every helper a template needs: a per-input binding factory, a per-field state map, and the live parsed values. Save the return value and reach for the pieces by name:

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
  displayName: z.string().min(2).optional(),
  age: z.number().int().min(13),
})

const form = useForm({ schema })
```

Object fields become reactive paths on `form.values`; nested objects become nested paths; refinements become per-field validators surfaced through `form.fields`.

The schema above covers most of what a real signup form needs:

- `email` and `password` are **required strings**. Attaform stores `''` as the default, so `form.values.email` starts as `''` and updates as the user types.
- `displayName` is **optional**. Storage still starts at `''`; the `.optional()` flag lets the field's empty string pass schema parsing at submit time.
- `age` is a **required number**. Storage starts at `0`; the `min(13)` refinement runs every time the field validates and shows up on `form.fields.age.errors`.

## Defaults from the schema

You don't redeclare defaults when you call `useForm`. Attaform reads them from the schema: `''` for strings, `0` for numbers, `false` for booleans, `[]` for arrays, `{}` for objects. Override per field with `defaultValues`:

```ts
const form = useForm({
  schema,
  defaultValues: {
    age: 18,
    displayName: 'Anonymous',
  },
})
```

Overrides are partial. Fields you don't mention pick up the schema's own default.

## Where to next

- [From schema to inputs](/docs/getting-started/from-schema-to-inputs): bind the schema to native inputs with `register` + `v-register`.
- [The form](/docs/reading-the-form/the-form): every property `useForm` returns.
