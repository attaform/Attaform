---
title: Records & maps
description: 'z.record() is a string-keyed dictionary with uniform value types; z.map() is the Map<K, V> primitive. Both bind through dynamic-key paths: register(`prefs.${userId}`), errors.scores[name].'
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

> Dictionaries when the keys aren't known at schema-write time: `z.record` for the common case, `z.map` when you need the `Map<K, V>` primitive and structured-clone fidelity.

::docs-meta-table
::

The demo binds a record of per-user preferences. The keys are user IDs you don't know at compile time, so the schema declares `z.record(z.string(), z.boolean())`, a string-keyed dictionary of booleans. Each key binds dynamically via `register(\`prefs.${userId}\`)`.

::docs-demo{slug="records" label="Records Demo"}
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
form.errors.prefs['user-99'] // ValidationError[] (empty when no errors)
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

`form.values.prefs[key]` reads `boolean | undefined`; the `| undefined` comes from `noUncheckedIndexedAccess`, the same way array index reads do. Reach for `??` defaults at the call site:

```ts
const checked = form.values.prefs[userId] ?? false
```

## Dynamic keys are still typed

A dynamic key is not an escape hatch. A record contributes a `${string}` segment to the path union, so ``register(`prefs.${userId}`)`` is checked against the schema like any other path: the `prefs.` prefix has to be real, and the value type at the leaf is still `boolean`.

What a path needs is for **every segment to carry a type**. An interpolated `string` is a typed segment; the record accepts it. A `string` standing in for the container above it is not, and there the compiler has nothing left to check:

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.object({ prefs: z.record(z.string(), z.boolean()) })
const form = useForm({ schema, key: 'prefs' })

declare const userId: string

form.register(`prefs.${userId}`) // the record key is dynamic, and checked
```

Swap the known prefix for an opaque one and the call stops compiling:

```ts
declare const anyPath: string

form.register(`${anyPath}.enabled`) // rejected: nothing in this path is known
```

That rejection is about the prefix, not the record. The same call with no record anywhere in the path fails identically, and the diagnostic says so:

```
attaform: a plain string cannot be checked against the schema.
Pass a literal path, type the dynamic prefix, or use the segment-array form.
```

This matters most in a row component, where it is tempting to accept the prefix as a plain `string` prop and then drop the whole component to an untyped form to make the binding compile. Type the prop as the prefix instead, and every binding underneath it stays checked:

```vue
<script setup lang="ts">
  import { injectForm } from 'attaform'

  type Shape = { boxes: { choice: string; pairs: Record<string, string> }[] }

  // The prefix is a path, so type it as one.
  const props = defineProps<{ rowPath: `boxes.${number}`; tokens: string[] }>()
  const form = injectForm<Shape>('pdf')
</script>

<template>
  <select v-register="form?.register(`${props.rowPath}.choice`)">
    <option v-for="t in props.tokens" :key="t" :value="t">{{ t }}</option>
  </select>
  <input
    v-for="t in props.tokens"
    :key="t"
    v-register="form?.register(`${props.rowPath}.pairs.${t}`)"
  />
</template>
```

The [segment-array form](/docs/writing-and-mutating/set-value#three-call-shapes) does the same job without the template literal, and is the better read when the prefix is assembled from separate variables:

```ts
import { useForm } from 'attaform'
import { z } from 'zod'

const schema = z.object({
  boxes: z.array(z.object({ pairs: z.record(z.string(), z.string()) })),
})
const form = useForm({ schema, key: 'pdf' })

declare const index: number
declare const token: string

form.register(['boxes', index, 'pairs', token])
```

## Mutating records

Records don't expose field-array helpers (`append` / `remove` / etc.); they're keyed dictionaries, not ordered sequences. Mutate them via `setValue` directly:

```ts
form.setValue(`prefs.${userId}`, true) // set / overwrite one entry
form.setValue('prefs', { ...form.values.prefs, [userId]: true }) // whole-record merge
```

To flag a record entry blank, reach for `unset`:

```ts
import { unset } from 'attaform'
form.setValue(`prefs.${userId}`, unset)
```

`unset` at a record entry writes the value schema's slim default at the path and adds the path to `form.blankPaths`. The bound input renders empty, and a required value schema surfaces `atta:no-value-supplied` reactively. To clear the whole record back to `{}`, pass `unset` at the record container: `form.setValue('prefs', unset)`.

## `z.map(keySchema, valueSchema)`

Map is the primitive `Map<K, V>`, distinct from records (which are plain JS objects):

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

`form.values.scoresByUser` returns the live `Map`, and you call its methods directly. Each entry is also a path in its own right, so `form.register`, `form.setValue`, `form.fields` and `form.errors` all address one the same way they address a record entry:

```ts
form.setValue('scoresByUser.user-42', 90)
form.fields.scoresByUser['user-42'].dirty // true
form.errors.scoresByUser['user-42'] // ValidationError[]
```

The key type you declared decides how a path segment is spelled. A path segment that looks like an integer arrives as a number, so under `z.map(z.string(), V)` the segment `'42'` files the entry under the string `'42'`, and under `z.map(z.number(), V)` it files it under the number `42`. Either way the same path reads it back. A map keyed by something a path cannot spell (an object, a symbol) has no addressable entries, and stays one whole value.

Use map (over record) when:

- You need `Map`-specific semantics: insertion order, key types beyond strings, or `.size` as an O(1) read.
- You save the form's values through a structured-clone channel (IndexedDB, a worker `postMessage`) and want fidelity. `JSON.stringify` flattens a `Map` to `{}`; structured clone preserves it.

Records are the right call for serialization-friendly dictionaries; maps are right when you need the primitive.

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
form.errors.prefs['user-42'] // ValidationError[] (empty when no errors)
form.errors.scoresByUser['user-99'] // (works for maps too)
```

The aggregate `form.meta.errors` flattens every entry's errors into one list, in path order.

## A note on `z.set`

A set is the one container whose contents are not paths. A set member is its own key, so there is no address that survives writing to one: change the member and you have changed where it lives. `form.fields.tags[0]` resolves nothing, and a write to `tags.0` is refused rather than applied.

Read a set through `form.values`, and write it whole:

```ts
form.values.tags // Set<string>
form.setValue('tags', new Set([...form.values.tags, 'new-tag']))
```

A validation error on a member lands on the set itself rather than on any member, on both Zod majors. That makes it a container-self error, so `form.errors.tags` navigates to the set's sub-Proxy and the list lives one step further on, at the [`''` sentinel](/docs/reading-the-form/errors#the-sentinel-container-self-errors):

```ts
form.errors.tags[''] // ValidationError[]: the set's own
form.errors('tags') // the same list, through the flat call form
form.fields('tags').firstOwnError // the first one, display gating included
```

## When to pick which

- **`z.record(z.string(), V)`**: string-keyed dictionaries serialized as JSON. The default choice.
- **`z.record(z.enum([...]), V)`**: keys constrained to a small set. Compile-time autocomplete on the keys.
- **`z.map(K, V)`**: when you need `Map`'s insertion order, non-string keys, or structured-clone fidelity for IndexedDB persistence.
- **`z.object({ … })`**: when the keys are fixed and known at schema-write time. Records are for the dynamic case.

When the record is the entire form rather than a field inside one, reach for a [dictionary form](/docs/schemas/dictionary-forms): the `z.record` becomes the schema root, `form.values` is the map itself, and `form.record()` iterates it.

## Where to next

- [Dictionary forms](/docs/schemas/dictionary-forms): a `z.record` schema as the form root, not just a field inside an object.
- [Arrays & tuples](/docs/schemas/arrays-and-tuples): numeric-keyed sequences; the other half of the "many-items" picture.
- [Nested objects](/docs/schemas/nested-objects): fixed-shape composition; the alternative when keys are known.
- [`unset`, the blank-anywhere sentinel](/docs/writing-and-mutating/unset): how to flag a single record entry blank, or wipe the whole record back to `{}`.
