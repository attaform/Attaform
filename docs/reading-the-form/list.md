---
title: list
description: form.list reads an array or record as one FieldState per element, in order, each carrying a stable key so a keyed v-for survives inserts, removals, moves, and swaps.
metaRows:
  - label: Category
    value: Return method
  - label: Type
    value: (path) => readonly FieldState[]
    kind: code
  - label: Keyed
    value: 'Yes, by element identity'
---

# `list`

> One collection, one FieldState per element, in order. Each entry carries a stable `key`, so a keyed `v-for` keeps every row attached to its element through any reorder.

::docs-meta-table
::

`form.list(path)` is the iteration view over an array or a record. It hands back one [`FieldState`](/docs/reading-the-form/fields) per element, in order, and each entry carries a `key` that follows its element across every shape change. Bind that `key` to your `v-for` and Vue keeps each row's component instance, input focus, and cursor attached to the element the user is working on, even after a drag-reorder.

::docs-demo{slug="form-list" label="form.list Demo"}
::

## Iterating an array

Reach for `list` wherever you render a repeating field. Pair it with the array index for binding and `row.key` for the `:key`:

```vue
<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    roster: z.array(z.string()),
  })

  const form = useForm({ schema })
</script>

<template>
  <div v-for="(row, i) in form.list('roster')" :key="row.key">
    <input v-register="form.register(`roster.${i}`)" />
    <p v-if="row.showErrors">{{ row.firstError?.message }}</p>
  </div>
</template>
```

`list` is typed against every array and record path in the schema, so the path autocompletes to collections only, and each entry's type narrows to the element shape.

## Why key by `row.key`

For an array element, `row.key` is an allocated identity token, not the index. It is minted once for an element and travels with it through `insert`, `remove`, `move`, and `swap`, staying distinct even when two elements hold identical values. Keying a `v-for` by the index instead ties each row to a slot, so a reorder reshuffles which DOM node and component instance render which element; a half-typed input can jump to the wrong row. Keying by `row.key` ties each row to its element, so the row a user is editing stays put when the list around it moves.

The same token is on every FieldState as [`field.key`](/docs/reading-the-form/fields), reachable through `form.fields('roster.0').key` when you need it outside an iteration.

## Records, by their own key

`list` reads a record just as happily as an array. Pass a record path and you get one entry per key, in the record's own order, with each `row.key` set to that entry's natural key:

```vue
<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    scoresByTeam: z.record(z.string(), z.number()),
  })

  const form = useForm({ schema })
</script>

<template>
  <div v-for="row in form.list('scoresByTeam')" :key="row.key">
    <label>{{ row.key }}</label>
    <input v-register="form.register(`scoresByTeam.${row.key}`)" />
  </div>
</template>
```

A record entry already has a stable identity in its key, so `list` hands that straight back as `row.key`, with no allocated token needed. Add an entry with `form.setValue('scoresByTeam.west', 0)` and a new row joins the view; the existing rows keep their keys and their component instances. Attaform reads whether a path is an array or a record from the value at run time, so one `list` call covers both, and a fixed-shape object stays off-limits because its keys are part of its type, not a collection to iterate.

## Each entry is a live FieldState

The entries are the same field states `form.fields` exposes, so every read stays live as the user interacts. A row carries the full surface: `row.value`, `row.errors`, `row.showErrors`, `row.firstError`, `row.touched`, and the rest.

```vue
<template>
  <ul>
    <li v-for="(row, i) in form.list('roster')" :key="row.key">
      <input v-register="form.register(`roster.${i}`)" :aria-invalid="row.showErrors" />
      <span v-if="row.showErrors" :id="row.aria.errorId">{{ row.firstError?.message }}</span>
    </li>
  </ul>
</template>
```

Binding still flows through `form.register` with the element path; `list` supplies the key and the per-row reads, and the array index supplies the register path.

## `form.fields` stays the aggregate

`form.fields('roster')` remains the single aggregated container for the whole array: one rolled-up FieldState whose `errors`, `valid`, and `touched` summarize every element at once. That is the read for an array-level message (`z.array(...).min(1)` lands there). `list` is the complementary per-element view. Reach for the aggregate when you want one verdict for the array, and for `list` when you want a row each.

## Read-only by design

The returned array is frozen. For an array, identity is bookkept by the mutation helpers, so shape changes go through them rather than the view:

- [`append`](/docs/writing-and-mutating/field-arrays) / `prepend` / `insert` to add a row.
- `remove` to drop one, `move` / `swap` to reorder.
- `replace` to overwrite a slot with a fresh element.

Each helper replays its exact change onto the identity tokens, which is what lets `row.key` stay true across the mutation. A record carries its own keys, so you grow or shrink it with `form.setValue` at an entry path, and `row.key` tracks the keys directly.

## Where to next

- [Field-array mutations](/docs/writing-and-mutating/field-arrays): the seven helpers that add, remove, and reorder elements.
- [`fields`](/docs/reading-the-form/fields): the per-leaf FieldState and the `key` every entry carries.
- [The `v-register` directive](/docs/binding-inputs/v-register): the binding each row's input flows through.
- [`errors`](/docs/reading-the-form/errors): the per-path errors behind `row.firstError`.
