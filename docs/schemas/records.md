---
title: Records & maps
description: z.record() is a string-keyed dictionary with uniform value types; z.map() is the Map<K, V> primitive. Both bind through dynamic-key paths — register(`prefs.${userId}`), errors.scores[name].
metaRows:
  - label: Category
    value: Schema feature
  - label: String-keyed dict
    value: z.record(K, V)
    kind: code
  - label: Map primitive
    value: z.map(K, V)
    kind: code
  - label: Path access
    value: register(`prefs.${dynamicKey}`)
    kind: code
---

# Records & maps

> Dictionaries when the keys aren't known at schema-write time — `z.record` for the common case, `z.map` when you need the `Map<K, V>` primitive and structured-clone fidelity.

::docs-meta-table
::

The demo binds a record of per-user preferences. The keys are user IDs you don't know at compile time, so the schema declares `z.record(z.string(), z.boolean())` — a string-keyed dictionary of booleans. Each key binds dynamically via `register(\`prefs.${userId}\`)`.

::docs-demo{slug="records"}
::

## `z.record(keySchema, valueSchema)`

```ts
const schema = z.object({
  prefs: z.record(z.string(), z.boolean()),
  scores: z.record(z.string(), z.number()),
})

const form = useForm({
  schema,
  defaultValues: { prefs: {}, scores: {} },
})
```

Each value gets a dynamic-key path segment:

```ts
form.values.prefs['user-42'] // boolean | undefined
form.register('prefs.user-42') // path autocomplete; the key segment is dynamic
form.errors.prefs['user-99'] // ValidationError[] | undefined
```

The key schema constrains what's valid; the value schema validates each entry:

```ts
// String keys are the common case
z.record(z.string(), z.boolean())

// Constrained keys
z.record(z.enum(['admin', 'editor', 'viewer']), z.boolean())

// Number-valued
z.record(z.string(), z.number().min(0).max(100))
```

`form.values.prefs[key]` reads `boolean | undefined` — the `| undefined` comes from `noUncheckedIndexedAccess`, the same way array index reads do. Reach for `??` defaults at the call site:

```ts
const checked = form.values.prefs[userId] ?? false
```

## Mutating records

Records don't expose field-array helpers (`append` / `remove` / etc.) — they're keyed dictionaries, not ordered sequences. Mutate them via `setValue` directly:

```ts
form.setValue(`prefs.${userId}`, true) // set / overwrite one entry
form.setValue('prefs', { ...form.values.prefs, [userId]: true }) // whole-record merge
```

For "delete a key entirely," reach for `unset`:

```ts
import { unset } from 'attaform/zod'
form.setValue(`prefs.${userId}`, unset)
```

`unset` at a record entry adds the path to `blankPaths` and surfaces a `'No value supplied'` error if the value schema requires it — the same lifecycle as numeric-leaf blanking.

## `z.map(keySchema, valueSchema)`

Map is the primitive `Map<K, V>` — distinct from records (which are plain JS objects):

```ts
const schema = z.object({
  scoresByUser: z.map(z.string(), z.number()),
})

const form = useForm({
  schema,
  defaultValues: { scoresByUser: new Map() },
})

form.values.scoresByUser // Map<string, number>
form.values.scoresByUser.get('user-42') // number | undefined
```

The runtime treats `Map` as a leaf container — `form.values.scoresByUser` returns the live `Map`, and you call its methods directly. Use map (over record) when:

- You need `Map`-specific semantics — insertion order, key types beyond strings, or `.size` as an O(1) read.
- The form persists to `'indexeddb'` and you want structured-clone fidelity. `JSON.stringify` flattens a `Map` to `{}`; structured clone preserves it.

Records are the right call for serialisation-friendly dictionaries; maps are right when you need the primitive.

## Iterating in templates

For records, iterate over `Object.entries`:

```vue
<template>
  <label v-for="[userId, enabled] in Object.entries(form.values.prefs)" :key="userId">
    <input v-register="form.register(`prefs.${userId}`)" type="checkbox" :checked="enabled" />
    {{ userId }}
  </label>
</template>
```

For maps, iterate the `Map` directly:

```vue
<template>
  <div v-for="[userId, score] in form.values.scoresByUser" :key="userId" class="row">
    <span>{{ userId }}</span>
    <input v-register="form.register(`scoresByUser.${userId}`)" type="number" />
  </div>
</template>
```

The template renders re-run when the underlying record / map updates because `form.values` proxies through the reactivity layer.

## Errors per entry

Errors land at the keyed path, the same as array elements:

```ts
form.errors.prefs['user-42'] // ValidationError[] | undefined
form.errors.scoresByUser['user-99'] // (works for maps too)
```

The aggregate `form.meta.errors` flattens every entry's errors into one list, in path order.

## When to pick which

- **`z.record(z.string(), V)`** — string-keyed dictionaries serialised as JSON. The default choice.
- **`z.record(z.enum([...]), V)`** — keys constrained to a small set. Compile-time autocomplete on the keys.
- **`z.map(K, V)`** — when you need `Map`'s insertion order, non-string keys, or structured-clone fidelity for IndexedDB persistence.
- **`z.object({ … })`** — when the keys are fixed and known at schema-write time. Records are for the dynamic case.

## Where to next

- [Arrays & tuples](/docs/schemas/arrays-and-tuples) — numeric-keyed sequences; the other half of the "many-items" picture.
- [Nested objects](/docs/schemas/nested-objects) — fixed-shape composition; the alternative when keys are known.
- [`unset` — the absent sentinel](/docs/writing-and-mutating/unset) — how to delete a record entry without leaving an `undefined` value behind.
