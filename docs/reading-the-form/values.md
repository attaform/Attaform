---
title: values
description: form.values is a drillable reactive Proxy keyed by schema paths — read any leaf or container, anywhere, and Vue tracks the access for you.
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
`form.values` is the read surface of the form. Every key matches a schema path; every read inside a reactive scope is tracked by Vue.

## Leaf and container reads

```ts
const form = useForm({
  schema: z.object({
    profile: z.object({
      name: z.string(),
      email: z.email(),
    }),
    age: z.number(),
  }),
})

// Leaf reads
form.values.profile.name
form.values.age

// Container reads — returns the nested object
form.values.profile // { name: '', email: '' }
```

## Reactivity

`form.values` is implemented as a deep Proxy. Reads inside a `computed` / `watchEffect` / template render are tracked; the consumer re-runs when the underlying storage changes:

```vue
<template>
  <p>Hello, {{ form.values.profile.name }}!</p>
</template>
```

Vue's auto-unwrap means you don't write `.value` — the Proxy presents as a plain object surface.

## Writes go through setValue

`form.values` is a read surface. To write, call `form.setValue('email', value)` — the directive and `setValue` are the only write paths, so storage updates always flow through the same validation and dirty-tracking pipeline. Assigning to `form.values.email` directly throws in dev.

## Where to next

- [`errors`](/docs/reading-the-form/errors) — paired error reads.
- [The form object](/docs/reading-the-form/the-form-object) — every other reactive read.
