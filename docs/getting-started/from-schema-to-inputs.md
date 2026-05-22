---
title: From schema to inputs
description: The register + v-register pair turns a schema path into a typed two-way binding for any native input element: text, number, select, checkbox, textarea.
metaRows:
  - label: Read time
    value: ~4 minutes
  - label: Builds on
    value: Your first schema
---

# From schema to inputs

> One directive binds any schema path to any native input. Attaform handles the read, the write, and the coercion.

::docs-meta-table
::

The demo binds five native inputs (a text input for `fullName`, a numeric `age`, a country `<select>`, a `newsletter` checkbox, a `bio` textarea) against a single Zod schema. Type into any of them and the live `form.values` JSON below the form updates with the right type: the number input lands as a `number`, the checkbox as a `boolean`, the select as its enum literal. One directive handles every shape; the [register / v-register pair](#the-register-v-register-pair) section unpacks why.

::docs-demo{slug="schema-to-inputs" label="Inputs Demo"}
::

## Setting up the form

`useForm` is the entry point. Hand it a Zod schema; it returns a reactive form carrying every binding helper this page uses. Save the return value and reach for the pieces by name:

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const schema = z.object({
  fullName: z.string().min(2),
  age: z.number().int().min(13),
  country: z.string(),
  newsletter: z.boolean(),
  bio: z.string().optional(),
})

const form = useForm({ schema })
```

- `form.register(path)` is the per-input binding factory. The template hands its return value to `v-register`.
- `form.fields` is the reactive map of per-field state (errors, focus, touched, etc).
- `form.values` is the reactive parsed values, paths and types straight from the schema.

The rest of this page reaches for these three off the same `form` handle. The demo above does the same.

## The register / v-register pair

`form.register('email')` returns a small binding object the `v-register` directive consumes. Hand it off in the template:

```vue
<input v-register="form.register('email')" />
```

That's the whole binding. The directive:

- Reads from `form.values.email` and writes the current value into the DOM input.
- Writes back to `form.values.email` on every `input` event (or `change` / `blur` with directive modifiers).
- Coerces values per the schema, so `type="number"` lands in `form.values.age` as a number, not a string.
- Tracks per-field interaction state on `form.fields.email` (focused, touched, blurred, blank, plus errors and a few more). The [`fields` page](/docs/reading-the-form/fields) names every bit.

## Native inputs, native types

The directive works on every input shape Vue exposes. The schema dictates the value type; the input attribute dictates the DOM control:

```vue
<input v-register="form.register('fullName')" />
<input v-register="form.register('age')" type="number" />
<input v-register="form.register('newsletter')" type="checkbox" />
<select v-register="form.register('country')">…</select>
<textarea v-register="form.register('bio')" />
```

No wrapper component, no per-type binding logic. Your `<input>` stays a native `<input>`; Attaform sits at the directive layer.

## Where to next

- [From inputs to submit](/docs/getting-started/from-inputs-to-submit): close the loop with `handleSubmit`, the helper that gates dispatch on validation.
- [The `v-register` directive](/docs/binding-inputs/v-register): the full directive surface (modifiers, transforms, custom assigners).
