---
title: Field-array mutations
description: Seven helpers (append, prepend, insert, remove, swap, move, replace) typed against every ArrayPath in your schema. Stable per-item validation and dirty tracking across every shape change.
metaRows:
  - label: Category
    value: Return methods
  - label: Helpers
    value: append · prepend · insert · remove · swap · move · replace
  - label: Type
    value: typed against ArrayPath<Form>
    kind: code
  - label: Stable keys
    value: 'Yes, per-item identity preserved'
---

# Field-array mutations

> Seven shape-changing helpers, typed against every array path in your schema. Stable per-item identity across moves, removes, and swaps.

::docs-meta-table
::

Use the row arrows and per-row × button to move and remove items; the buttons below dispatch every helper against the array. Watch the readout: the order, count, and contents reflect each call. Stable keys mean per-item validation state, dirty bits, and DOM focus survive shape changes; reordering doesn't reset what the user typed.

::docs-demo{slug="field-arrays" label="Field Arrays Demo"}
::

## The seven helpers

Each helper is typed against the form's `ArrayPath<Form>` set; TypeScript autocompletes only the paths that actually point at an array. The value-shape generic narrows on the inferred element type.

| Helper                        | Signature         | What it does                                            |
| ----------------------------- | ----------------- | ------------------------------------------------------- |
| `append(path, value)`         | adds at the end   | Appends one item to the array.                          |
| `prepend(path, value)`        | adds at index 0   | Adds one item to the front; shifts the rest right.      |
| `insert(path, index, value)`  | adds at index     | Inserts one item; shifts subsequent items right.        |
| `remove(path, index)`         | drops at index    | Removes one item; shifts subsequent items left.         |
| `swap(path, a, b)`            | swaps two indices | Exchanges the items at the two indices.                 |
| `move(path, from, to)`        | moves an item     | Removes from `from` and re-inserts at `to` in one step. |
| `replace(path, index, value)` | replaces at index | Overwrites the item at `index` without changing length. |

## Reading the path

```ts
const form = useForm({
  schema: z.object({
    checkpoints: z.array(z.string()),
  }),
})

form.append('checkpoints', 'New checkpoint')
form.remove('checkpoints', 2)
```

The path string autocompletes to every array path in the schema. Nested arrays work the same way: `register('teams.0.players')` for an inner array, and the helpers take the same form.

## Stable per-item identity

Every helper preserves the existing items' reactive identity:

- `append` leaves indices 0..n unchanged.
- `prepend` shifts every existing item's index by 1, but the item's own validation state, dirty bit, and bound DOM element follow it to the new index.
- `swap` / `move` / `remove` follow the same rule: items keep their state across shape changes.

Practical consequence: a user typing in row 3, hitting "Move up", finishes typing in row 2 without losing focus or having the entered text reset. The directive's per-element identity tracks the item, not the slot.

## Validation per item

Per-item validation runs independently for each array slot. An error at `checkpoints.2` clears when the item at index 2 is removed; an error at `checkpoints.0` survives a `move(0, 4)` (the item moved, the error moved with it).

For array-level refinements (`z.array(...).min(3)` or `.refine(arr => arr.length > 0)`), the error lands at the array path itself, not at any slot. Read it via `errors.checkpoints` (or `fields.checkpoints.firstError`).

## Reset behavior

`reset()` restores the array's default: same length, same item values, every item back to its pre-edit state. `clear('checkpoints')` writes `[]`. No special "reset the array's helpers", same pipeline as the rest of the writes.

## Where to next

- [`form.list`](/docs/reading-the-form/list): iterate the array as one FieldState per element, keyed by `key` so a `v-for` survives every reorder.
- [`setValue` patterns](/docs/writing-and-mutating/set-value): when you need to write the whole array, not mutate one slot.
- [`reset` & `resetField`](/docs/writing-and-mutating/reset): restore the array to its baseline.
- [Display state and showing errors](/docs/validation/showing-errors): array-level error display.
