---
title: record
description: form.record reads a record as one FieldState per entry, keyed by the entry's own key, so you iterate dynamic keys without tracking them yourself.
metaRows:
  - label: Category
    value: Return method
  - label: Type
    value: (path?) => Readonly<Record<string, FieldState>>
    kind: code
  - label: Keyed
    value: 'Yes, by record key'
---

# `record`

> One record, one FieldState per entry, keyed by the entry's own key. Iterate it with `v-for="(field, key) in form.record(path)"` and bind `:key="key"`.

::docs-meta-table
::

`form.record(path)` is the iteration view over a record. Where [`list`](/docs/reading-the-form/list) hands back an ordered array for an array path, `record` hands back a keyed object for a record path: one [`FieldState`](/docs/reading-the-form/fields) per entry, under the entry's own key. Reach for it whenever the keys are the data, set at run time rather than declared in the schema.

::docs-demo{slug="form-record" label="form.record Demo"}
::

## Iterating a record

Declare the record on your schema, then iterate `form.record` by its key. The keys come from the form, so you render whatever entries exist without keeping a parallel list of your own:

```vue
<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'

  const schema = z.object({
    scoresByTeam: z.record(z.string(), z.number()),
  })

  const form = useForm({ schema })
</script>

<template>
  <div v-for="(field, key) in form.record('scoresByTeam')" :key="key">
    <label>{{ key }}</label>
    <input v-register="form.register(`scoresByTeam.${key}`)" />
    <p v-if="field.showErrors">{{ field.firstError?.message }}</p>
  </div>
</template>
```

`record` is typed against every record path in the schema (a `z.record(...)`, not a fixed-shape `z.object({ ... })`), so the path autocompletes to records only, and each entry's type narrows to the record's value shape.

## Each entry is a live FieldState

Each value in the returned object is the same field state [`fields`](/docs/reading-the-form/fields) exposes, so every read stays live as the user types. An entry carries the full surface: `field.value`, `field.errors`, `field.showErrors`, `field.firstError`, `field.touched`, and the rest. Binding still flows through [`form.register`](/docs/binding-inputs/v-register) with the entry path, which the key supplies.

## Growing and shrinking

The returned object is frozen, a read-only view. A record carries its own keys, so you grow or shrink it through [`setValue`](/docs/writing-and-mutating/set-value) at an entry path. Write a key that isn't there yet and a new entry joins the view:

```ts
form.setValue('scoresByTeam.west', 0)
```

The existing entries keep their field states and their component instances; only the new row mounts. To drop an entry, write the record back without that key.

## `form.fields` stays the aggregate

`form.fields('scoresByTeam')` remains the single aggregated container for the whole record: one rolled-up FieldState whose `errors`, `valid`, and `touched` summarize every entry at once. Reach for the aggregate when you want one verdict for the record, and for `record` when you want an entry each.

## The root record, `form.record()`

When the schema root is itself a `z.record` (a [dictionary form](/docs/schemas/dictionary-forms)), call `form.record()` with no argument for the root entry view. It hands back the same keyed object of field states, one per entry, for the form's top-level map:

```vue
<template>
  <div v-for="(member, id) in form.record()" :key="id">
    <input v-register="form.register(`${id}.tier`)" type="number" />
  </div>
</template>
```

The no-argument form is available only on a record root; on a fixed-shape object root it is a compile error, the same way the path form requires a record path. See [Dictionary forms](/docs/schemas/dictionary-forms) for the whole-form story.

## `list` is the array counterpart

For an array, reach for [`list`](/docs/reading-the-form/list), which returns an ordered FieldState array keyed by an allocated identity token that survives reorders. `record` and `list` split cleanly by path type: a record reads through `record`, an array through `list`, and each rejects the other at compile time.

## Where to next

- [`list`](/docs/reading-the-form/list): the array counterpart, one FieldState per element with reorder-stable keys.
- [Dictionary forms](/docs/schemas/dictionary-forms): a `z.record` schema as the form root, iterated with the no-argument `form.record()`.
- [Records & maps](/docs/schemas/records): declaring a `z.record(...)` schema and binding its entries.
- [`fields`](/docs/reading-the-form/fields): the per-leaf FieldState every entry carries.
- [`setValue`](/docs/writing-and-mutating/set-value): how an entry joins or leaves the record.
