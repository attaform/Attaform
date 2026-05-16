---
title: From schema to inputs
description: The register + v-register pair turns a schema path into a typed two-way binding for any native input element — text, number, select, checkbox, textarea.
metaRows:
  - label: Read time
    value: ~4 minutes
  - label: Builds on
    value: Your first schema
---

# From schema to inputs

> One directive binds any schema path to any native input — Attaform handles the read, the write, and the coercion.

::docs-meta-table
::
::docs-demo{slug="schema-to-inputs"}
::

## The register / v-register pair

`form.register('email')` returns the RegisterValue — a small object the `v-register` directive consumes. Hand it off in the template:

```vue
<input v-register="register('email')" />
```

That's the whole binding. The directive:

- Reads the value from `form.values.email` and writes it into the DOM input.
- Writes back to `form.values.email` on every `input` event (or `change` / `blur` with modifiers).
- Coerces values per the schema — a `type="number"` input lands in `form.values.age` as a number, not a string.
- Tracks `touched` / `focused` / `blurred` / `blank` per field, surfaced through `form.fields`.

## Native inputs, native types

The directive works on every input shape Vue exposes:

```vue
<input v-register="register('email')" type="email" />
<input v-register="register('age')" type="number" />
<input v-register="register('agreed')" type="checkbox" />
<select v-register="register('country')">…</select>
<textarea v-register="register('bio')" />
```

No wrapper component, no per-type binding logic. Your `<input>` stays a native `<input>` — Attaform sits at the directive layer.

## Where to next

- [From inputs to submit](/docs/getting-started/from-inputs-to-submit) — close the loop with `handleSubmit`.
- [The `v-register` directive](/docs/binding-inputs/v-register) — the full directive surface (modifiers, transforms, custom assigners).
