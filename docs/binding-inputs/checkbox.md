---
title: Checkbox
description: A single checkbox binds to a boolean; multiple checkboxes sharing a register call bind to an array of the checked values. The directive reads the schema leaf type and picks the right mode.
metaRows:
  - label: Category
    value: Directive binding
  - label: Element
    value: <input type="checkbox">
    kind: code
  - label: Modifiers
    value: none
  - label: Leaf types
    value: boolean · readonly Value[]
    kind: code
---

# Checkbox

> Boolean for one, array of values for a group; the leaf type picks the binding shape.

::docs-meta-table
::

Toggle the single checkbox to flip the boolean. Tick a few in the group to watch the array populate with the matching enum literals. The order in storage reflects the order the boxes were checked, not the declaration order in the template. The schema's leaf type at each path decides which binding mode the directive picks.

::docs-demo{slug="checkbox" label="Checkbox Demo"}
::

## Single checkbox → boolean

When the schema leaf is `z.boolean()`, the directive binds checked-state directly:

```vue
<input v-register="form.register('acceptTerms')" type="checkbox" />
```

`acceptTerms` in storage is `true` while checked, `false` otherwise. The `value` attribute is ignored in this mode; boolean state lives in the `checked` property, not the value.

## Checkbox group → array

When the schema leaf is `z.array(z.enum([...]))` (or any array type), every `<input type="checkbox">` bound to the same path forms a group:

```vue
<input v-register="form.register('languages')" type="checkbox" value="ts" />
<input v-register="form.register('languages')" type="checkbox" value="js" />
<input v-register="form.register('languages')" type="checkbox" value="rust" />
```

Each input's `value` attribute is the entry written into the array when it's checked. Unchecking removes the entry. Storage holds only the currently-checked values; the array starts empty when no box is ticked.

The directive picks the binding mode from the schema, not from how you write the template. Declare `z.array(z.string())` and the same `form.register('languages')` call site automatically groups every bound checkbox.

## Where to next

- [Radio groups](/docs/binding-inputs/radio): the single-pick counterpart.
- [Select & multi-select](/docs/binding-inputs/select): the same array semantics in a dropdown shape.
- [Schema-driven coercion](/docs/binding-inputs/coercion): how leaf types drive binding shape.
