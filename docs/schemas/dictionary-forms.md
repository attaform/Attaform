---
title: Dictionary forms
description: A z.record schema can be the form root, not just a field. form.values is the dictionary itself, form.record() iterates the entries, and a bare record root defaults to an empty map.
metaRows:
  - label: Category
    value: Schema feature
  - label: Form root
    value: z.record(keySchema, valueSchema)
    kind: code
  - label: Entry view
    value: form.record()
    kind: code
  - label: Default
    value: empty map
---

# Dictionary forms

> When the form _is_ a map, make the map the root. A `z.record` schema at the top level gives you a dictionary form: `form.values` is the map itself, and `form.record()` iterates its entries.

::docs-meta-table
::

The demo is a team roster keyed by member id. The ids are data you only learn at run time, so the schema root is a `z.record(z.string(), …)`, a string-keyed dictionary of members. The whole form is that map: edit a member, add one, drop one, and watch `form.values` track it below.

::docs-demo{slug="dictionary-forms" label="Dictionary Form Demo"}
::

## The schema

A dictionary form declares a `z.record` schema as the root, not nested under a key. The key schema constrains what counts as a valid key; the value schema validates each entry:

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.record(
  z.string(),
  z.object({ role: z.enum(['admin', 'editor', 'viewer']), tier: z.number() })
)

const form = useForm({ schema })
```

There is no wrapper key. `form.values` reads as `Record<string, { role: 'admin' | 'editor' | 'viewer'; tier: number }>`, the map itself.

## `form.values` is the dictionary

Because the record is the root, `form.values` is the whole map, and entries bind through their own key:

```ts
form.values() // the whole map: Record<string, { role; tier }>
form.values()['ada'] // one entry, or undefined
form.register('ada.role') // bind an entry sub-field
form.errors['ada']?.['tier'] // ValidationError[] for that entry's tier
```

The `| undefined` on an entry read comes from `noUncheckedIndexedAccess`, the same way a record field reads anywhere else. Reach for `??` defaults at the call site when you need one.

## Iterating with `form.record()`

`form.record()` with no argument is the root entry view: one [`FieldState`](/docs/reading-the-form/fields) per entry, keyed by the entry's own key. It is the root counterpart of [`form.record(path)`](/docs/reading-the-form/record), which views a nested record. The keys come from the form, so you render whatever entries exist without keeping a parallel list of your own:

```vue
<template>
  <div v-for="(member, id) in form.record()" :key="id">
    <label>{{ id }}</label>
    <input v-register="form.register(`${id}.tier`)" type="number" />
    <small v-if="member.showErrors">{{ member.firstError?.message }}</small>
  </div>
</template>
```

Each `member` is a live `FieldState`, the same surface [`form.fields`](/docs/reading-the-form/fields) exposes, so every read stays current as the user types. Binding still flows through [`form.register`](/docs/binding-inputs/v-register) with the entry path, which the key supplies.

## Adding, editing, and removing entries

A dictionary form carries its own keys, so you grow and shrink it through [`setValue`](/docs/writing-and-mutating/set-value). Editing and adding are ordinary path writes:

```ts
form.setValue('ada.tier', 4) // edit one entry's field
form.setValue('mae', { role: 'viewer', tier: 1 }) // add a key that isn't there yet
```

Removing is the one case the root changes. A nested record drops a key by rewriting its container path; a record root has no container path, so you rewrite the form itself. Passing a single argument to `setValue` is a whole-form write, and for a dictionary form the whole form is the map:

```ts
const next = { ...form.values() }
delete next['ada']
form.setValue(next) // write the map back without that key
```

Surviving entries keep their field states and component instances across the write; only the dropped row unmounts.

## Defaults

A bare record root defaults to an empty map, ready to grow:

```ts
const form = useForm({ schema })
form.values() // {}
```

Seed initial entries with `defaultValues`, the same shape as the form value:

```ts
const form = useForm({
  schema,
  defaultValues: { ada: { role: 'admin', tier: 3 } },
})
```

## When the keys are fixed, reach for an object

Dictionary forms are for keys you learn at run time. When the keys are known at schema-write time, a `z.object` root is the better fit: fixed keys, a distinct type per field, and compile-time autocomplete on each one. The two compose freely. An object form can hold a `z.record` field (see [Records & maps](/docs/schemas/records)), and a dictionary form's value schema can be any Zod schema, including objects, arrays, and nested records.

## Where to next

- [Records & maps](/docs/schemas/records): `z.record` as a field inside an object form, plus the `z.map` primitive.
- [`record`](/docs/reading-the-form/record): the entry view, `form.record(path)` for a nested record and `form.record()` for the root.
- [`setValue`](/docs/writing-and-mutating/set-value): the writes that grow, edit, and shrink a dictionary.
- [Nested objects](/docs/schemas/nested-objects): fixed-shape composition, the alternative when the keys are known.
