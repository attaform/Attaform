---
title: values
description: form.values is a drillable reactive Proxy keyed by schema paths, and a callable that returns a detached snapshot. Dot access for reactive reads, form.values() for the data.
metaRows:
  - label: Category
    value: Return property
  - label: Type
    value: ValuesSurface<Form>
    kind: code
  - label: Reactive
    value: 'Yes'
---

# `values`

> A reactive Proxy keyed by your schema's paths. Drill anywhere for a live read, or call it for a detached snapshot.

::docs-meta-table
::

`form.values` is the reactive read surface for everything the form holds. The Proxy mirrors your schema's shape: every key resolves to a schema path, every container descends as its own sub-Proxy, and every read inside a reactive scope subscribes for re-renders. Reach for any leaf or container, anywhere; the value you read is always the live one. The exact concrete shape (how defaults, `.optional()`, `.nullable()`, and preprocess land) is covered in [How values are stored](/docs/schemas/storage-shape).

::docs-demo{slug="values" label="form.values Demo"}
::

## Two shapes: reactive reads and snapshots

`form.values` answers two different questions, and which one you want decides how you spell it.

- **`form.values.age` is the reactive read.** It tracks the one key you touched, copies nothing, and always gives you the live value. Reach for this inside a `computed`, a `watchEffect`, or a template.
- **`form.values()` is a snapshot.** It returns a detached plain object holding what the form had at the moment you called it. Reach for this at an event boundary: submitting, serializing, diffing, or logging.

The snapshot stays put as the form moves on:

```ts
const before = form.values() // { age: 30, … }
form.setValue('age', 31)

before.age // still 30
form.values().age // 31
```

That is what makes it safe to hand to anything that outlives the call:

```ts
const draft = form.values()
await api.save(draft) // cannot change underneath the request
```

Because a snapshot is a plain object, it survives `structuredClone`, and `watch(() => form.values(), onChange)` fires on every change.

The call form also takes a path, and snapshots just that subtree:

```ts
form.values('profile') // { name, email }, detached
form.values('profile.name') // one leaf
form.values(['profile', 'name']) // the segment-array spelling
```

Snapshots are memoized per change, so calling `form.values()` repeatedly between writes costs nothing extra. Inside a reactive scope, prefer dot access anyway: `form.values.age` re-runs its consumer when `age` changes, where `form.values()` depends on the whole form and re-runs on any change.

The copy is deep across plain objects and arrays. Non-plain instances (`Map`, `Set`, `File`, `Date`) are shared by reference, the same way `JSON.stringify` treats them. Reach for `structuredClone(form.values())` when you need those detached too.

### `form.values` itself is callable, not the data

`typeof form.values === 'function'`. Serialization is handled for you, so `JSON.stringify(form.values)` and `{ ...form.values }` both produce the data. A validator is the one place it shows:

```ts
schema.safeParse(form.values) // rejected: it received a function
schema.safeParse(form.values()) // correct: pass the snapshot
```

When something wants the data rather than the surface, call it.

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

`form.values` is read-only. Changes to storage flow through methods on `form` (`setValue`, `clear`, `reset`, `resetField`, and the field-array helpers `append`, `prepend`, `insert`, `remove`, `swap`, `move`, `replace`) or through inputs bound with `v-register`. Every write hits the same validation, dirty-tracking, and history pipeline. Assigning to `form.values.profile.name` directly is ignored, and warns in dev; Attaform never throws from a read surface, so a write in strict mode fails loudly in the console rather than taking the render down.

Optional leaves (those whose schema admits `undefined`, e.g. `z.string().optional()`) return to the absent state when the user clears the bound input. This keeps the `.optional()` semantic reachable from the DOM: a user who types invalid text into an optional field and then clears it sees storage flip back to `undefined` and the validation error clears too. Required leaves keep `''` (or the slim default for non-strings) on clear.

## Where to next

- [`fields`](/docs/reading-the-form/fields): the same reads plus per-leaf state.
- [`errors`](/docs/reading-the-form/errors): paired error reads.
- [`toRef`](/docs/reading-the-form/to-ref): the ref-shaped escape hatch for path-precise interop.
- [`setValue`](/docs/writing-and-mutating/set-value): the write counterpart.
- [How values are stored](/docs/schemas/storage-shape): the conceptual model behind this surface.
- [The form](/docs/reading-the-form/the-form): every other reactive read.
