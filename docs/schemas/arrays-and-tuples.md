---
title: Arrays & tuples
description: z.array() is variable-length, z.tuple() is fixed-length. Both bind through numeric path segments: register('items.0.name'), errors.tags[2], fields.items[3].title.
metaRows:
  - label: Category
    value: Schema feature
  - label: Variable length
    value: z.array(elem)
    kind: code
  - label: Fixed length
    value: z.tuple([a, b, c])
    kind: code
  - label: Path access
    value: register('items.3.name')
    kind: code
---

# Arrays & tuples

> Two container shapes, one binding pattern. Numeric segments in the path point to elements, and the field-array helpers cover every mutation a list-shaped input needs.

::docs-meta-table
::

The demo binds an array of objects (todo items) and a fixed-length tuple (a date range with exactly two endpoints). Both flow through the same `register('path.index.subpath')` shape; the schema's array-ness is what unlocks `append` / `remove` / `swap`.

::docs-demo{slug="arrays-and-tuples" label="Arrays & Tuples Demo"}
::

## `z.array(elem)`: variable length

```ts
const schema = z.object({
  todos: z.array(
    z.object({
      title: z.string().min(1, 'Title is required'),
      done: z.boolean().default(false),
    })
  ),
})

const form = useForm({ schema, defaultValues: { todos: [] } })
```

Each element gets a numeric segment in its path:

```ts
form.values.todos[0].title // string
form.values.todos[2].done // boolean
form.register('todos.3.title') // path autocomplete works
form.errors.todos[1]?.title // ValidationError[] | undefined
```

Templates iterate with `v-for`:

```vue
<template>
  <div v-for="(_, i) in form.values.todos" :key="i" class="row">
    <input v-register="form.register(`todos.${i}.title`)" />
    <input v-register="form.register(`todos.${i}.done`)" type="checkbox" />
    <button type="button" @click="form.remove('todos', i)">−</button>
  </div>
  <button type="button" @click="form.append('todos', { title: '', done: false })">Add todo</button>
</template>
```

The `i` keyed loop pattern is fine for static lists. For lists where items can reorder, use a stable per-row identifier instead; see [Performance](/docs/server-and-ssr/performance) for the keying discussion.

## Field-array helpers

Seven helpers cover the common mutations:

| Method                                | What it does                    |
| ------------------------------------- | ------------------------------- |
| `form.append('path', element)`        | Push to the end.                |
| `form.prepend('path', element)`       | Unshift to the front.           |
| `form.insert('path', index, element)` | Insert at a specific index.     |
| `form.remove('path', index)`          | Remove at an index.             |
| `form.swap('path', i, j)`             | Swap two positions.             |
| `form.move('path', from, to)`         | Move an element to a new index. |
| `form.replace('path', elements[])`    | Replace the whole array.        |

All seven preserve sibling state where applicable (touched, focused, errors), reorder field-state to follow the items, and record one undo position per call; see [Field-array mutations](/docs/writing-and-mutating/field-arrays) for the full reference.

## `z.tuple([a, b, c])`: fixed length

```ts
const schema = z.object({
  dateRange: z.tuple([z.date(), z.date()]),
})

const form = useForm({
  schema,
  defaultValues: { dateRange: [new Date(), new Date()] },
})
```

Each position is its own slot with its own type:

```ts
form.values.dateRange[0] // Date
form.values.dateRange[1] // Date
form.register('dateRange.0') // path autocomplete narrows to position 0
form.register('dateRange.1') // position 1
form.register('dateRange.2') // type error (tuple has only 2 positions)
```

Tuples don't expose the field-array helpers; `form.append('dateRange', new Date())` is a type error because the tuple has a fixed shape. For mixed-shape sequences (a `[string, number, boolean]`), tuples are how you say "exactly this layout, in this order."

## When to pick which

- **Array**: when the list grows and shrinks at runtime, and every element has the same shape. Todos, tags, line items, attachments.
- **Tuple**: when the sequence has a fixed length and the positions may differ in type or meaning. Date ranges, coordinate pairs, RGB color triples, [latitude, longitude] tuples.

If you find yourself reaching for `z.array(z.union([a, b]))` to mean "exactly one of A followed by exactly one of B," reach for a tuple instead; `z.tuple([a, b])` says the same thing, more precisely.

## Errors land where the schema expects

Errors per element:

```ts
form.errors.todos[0]?.title // ValidationError[] for todos[0].title
form.errors.dateRange[1] // ValidationError[] for dateRange[1]
```

The aggregate `form.meta.errors` flattens every leaf's errors into a single list. Cross-element refinements (a `.refine` on the whole array) land on the array path itself rather than a specific element. `form.errors.todos[0]` (note the `[0]` index after the `.errors.todos` access) reads the first error attached to the array, which is the cross-element one.

## Async element-level refinements

Element-level async refinements work the way you'd expect. Each element validates independently:

```ts
const schema = z.object({
  skus: z.array(
    z.string().refine(async (sku) => await api.checkSku(sku), {
      message: 'Unknown SKU',
    })
  ),
})

// form.errors.skus[2]: pending until the async refinement settles
// for that element
```

See [Async refinements](/docs/validation/async-refinements) for cancellation semantics and the "pending" state.

## Where to next

- [Field-array mutations](/docs/writing-and-mutating/field-arrays): the seven helpers in depth, with element keying patterns.
- [Records & maps](/docs/schemas/records): when the keys aren't numeric indices.
- [Nested objects](/docs/schemas/nested-objects): fixed-shape composition vs. variable-length sequences.
