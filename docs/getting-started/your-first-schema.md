---
title: Your first schema
description: Attaform reads any Zod object schema — required strings, optional fields, refinements, defaults — and turns them into a typed reactive form with no extra mapping.
metaRows:
  - label: Read time
    value: ~5 minutes
  - label: Builds on
    value: Quick start
---

# Your first schema

> Attaform reads any Zod object schema directly and turns it into a typed reactive form.

::docs-meta-table
::
::docs-demo{slug="first-schema"}
::

## What Attaform reads

Any Zod object schema is a valid Attaform schema. Object fields become form paths; nested objects become nested paths; refinements become per-field validators.

The schema below covers most of what a real signup form needs:

```ts
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(2).optional(),
  age: z.number().int().min(13),
})
```

- `email` and `password` are **required strings**. Attaform stores `''` as the default and refuses to submit until both have a value.
- `displayName` is **optional**. Storage starts at `''`; an empty string at submit time is OK (the optional flag lets the schema parse).
- `age` is a **required number**. Storage starts at `0`; the `min(13)` refinement runs every time the field validates.

## Defaults from the schema

You don't redeclare defaults in `useForm`. Attaform reads them from the schema — `''` for strings, `0` for numbers, `false` for booleans, `[]` for arrays, `{}` for objects. Override per field with `defaultValues`:

```ts
const { register, handleSubmit } = useForm({
  schema,
  defaultValues: {
    age: 18,
    displayName: 'Anonymous',
  },
})
```

Overrides are partial — fields you don't mention pick up the schema-slim default.

## Where to next

- [From schema to inputs](/docs/getting-started/from-schema-to-inputs) — bind the schema to native inputs.
- [The form object](/docs/reading-the-form/the-form-object) — the reactive surface returned by `useForm`.
