---
title: values
description: form.values is a drillable reactive Proxy keyed by schema paths. Read any leaf or container, anywhere, and Vue tracks the access for you.
metaRows:
  - label: Category
    value: Return property
  - label: Type
    value: NestedReadType<Form>
    kind: code
  - label: Reactive
    value: 'Yes'
---

# `values`

> A reactive Proxy keyed by your schema's paths. Drill anywhere, read anything, let Vue track it.

::docs-meta-table
::

`form.values` is the reactive read surface for everything the form holds. The Proxy mirrors your schema's shape: every key resolves to a schema path, every container descends as its own sub-Proxy, and every read inside a reactive scope subscribes for re-renders. Reach for any leaf or container, anywhere; the value you read is always the live one. The exact concrete shape (how defaults, `.optional()`, `.nullable()`, and preprocess land) is covered in [How values are stored](/docs/schemas/storage-shape).

::docs-demo{slug="values" label="form.values Demo"}
::

## Leaf and container reads

```ts
const schema = z.object({
  profile: z.object({
    name: z.string(),
    email: z.email(),
  }),
  age: z.number(),
})

const form = useForm({ schema })

// Leaf reads
form.values.profile.name
form.values.age

// Container reads return the nested object
form.values.profile // { name: '', email: '' }
```

## Reactivity

`form.values` is implemented as a deep Proxy. Reads inside a `computed`, `watchEffect`, or template render are tracked; the consumer re-runs when the underlying storage changes:

```vue
<template>
  <p>Hello, {{ form.values.profile.name }}!</p>
</template>
```

Vue's auto-unwrap means you don't write `.value`; the Proxy presents as a plain object surface.

## Reading in templates

`form.values.<path>` is a plain expression in templates, conditionals, and bindings:

```vue
<template>
  <button :disabled="!form.values.profile.email">Send invite</button>
  <p v-if="form.values.age >= 18">Adult plan available.</p>
  <span class="badge">Saving as {{ form.values.profile.firstName || 'guest' }}</span>
</template>
```

Each read subscribes the surrounding render so updates flow without manual `watch` or `computed` wiring.

## Writes never go through the Proxy

`form.values` is read-only. Changes to storage flow through methods on `form` (`setValue`, `clear`, `reset`, `resetField`, and the field-array helpers `append`, `prepend`, `insert`, `remove`, `swap`, `move`, `replace`) or through inputs bound with `v-register`. Every write hits the same validation, dirty-tracking, and history pipeline; assigning to `form.values.email` directly throws in dev.

## Where to next

- [`fields`](/docs/reading-the-form/fields): the same reads plus per-leaf state.
- [`errors`](/docs/reading-the-form/errors): paired error reads.
- [`toRef`](/docs/reading-the-form/to-ref): the ref-shaped escape hatch for path-precise interop.
- [`setValue`](/docs/writing-and-mutating/set-value): the write counterpart.
- [How values are stored](/docs/schemas/storage-shape): the conceptual model behind this surface.
- [The form](/docs/reading-the-form/the-form): every other reactive read.
