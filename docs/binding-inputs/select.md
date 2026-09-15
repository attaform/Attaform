---
title: Select & multi-select
description: <select> binds to a single picked value; <select multiple> binds to a list of picked values. The multiple attribute picks the mode, and the schema leaf matches it.
metaRows:
  - label: Category
    value: Directive binding
  - label: Element
    value: <select> · <select multiple>
    kind: code
  - label: Modifiers
    value: '.number'
    kind: code
  - label: Leaf types
    value: scalar (single) · readonly Value[] · Set<Value> (multiple)
    kind: code
---

# Select & multi-select

> One element, two leaf shapes: a scalar for `<select>`, a list for `<select multiple>`. The `multiple` attribute picks the mode; the schema leaf matches it.

::docs-meta-table
::

Pick a country from the single select to watch the JSON readout switch its scalar value. In the multi-select below, hold ⌘ (or Ctrl) and click multiple options. Every picked option's `value=` attribute lands in the `tags` array, in the order the options appear in the markup. The `multiple` attribute is what puts the directive in list mode.

::docs-demo{slug="select" label="Select Demo"}
::

## Single select → scalar

When the schema leaf is a scalar (enum, string, number), `<select>` binds to that one value:

```vue
<select v-register="form.register('country')">
  <option value="us">United States</option>
  <option value="uk">United Kingdom</option>
</select>
```

The picked option's `value=` attribute lands in `form.values.country`. The schema's leaf type drives the storage type: `z.enum(['us', 'uk'])` keeps the value as the matching literal.

## Multi-select → array

`<select multiple>` writes every picked option's value into a list leaf, ordered the way the options are written rather than the way they were clicked:

```vue
<select v-register="form.register('tags')" multiple>
  <option value="design">Design</option>
  <option value="eng">Engineering</option>
  <option value="ops">Ops</option>
  <option value="sales">Sales</option>
</select>
```

```ts
const form = useForm({
  schema: z.object({
    tags: z.array(z.enum(['design', 'eng', 'ops', 'sales'])),
  }),
  defaultValues: { tags: [] },
})

form.values.tags // ['design', 'ops']
```

Deselecting an option removes it from the array; the array shape always reflects the current visual selection. No event-listener wiring on your side.

The `multiple` attribute is the whole switch. The directive reads each picked option off the element in document order, so a user who clicks Ops and then Design still gets `['design', 'ops']`. Reach for a list leaf and `multiple` together: a list leaf on a plain `<select>`, or a scalar leaf on a `<select multiple>`, is a mismatch the directive names in the dev console rather than guessing at.

A `z.set(...)` leaf works the same way and lands a `Set` instead of an array, members in that same order.

## A path the form does not hold

A `<select>` is the one control with no natural empty look. An `<input>` renders blank whether its path holds `''` or holds nothing at all, but a dropdown has to show a row. Attaform shows the row the author nominated as empty, the same way a text input shows `''` for a path that was never seeded.

That matters most under a `z.record`, where the key set is a function of something else on the form and a key legitimately appears at render time:

```ts
const schema = z.object({
  pairs: z.record(z.string(), z.string()).default({}),
})

const form = useForm({ schema, defaultValues: { pairs: { yes: '1' } } })
```

```vue
<select v-register="form.register('pairs.no')">
  <option value="">Not paired</option>
  <option value="0">0</option>
</select>
```

`pairs` has no `no` key, so the select shows `Not paired`. Nothing is written to get there: the key stays absent, a select that merely renders never invents a record entry, and `form.fields('pairs.no')?.blank` still reports that nobody supplied a value. A path marked blank through the [`unset` sentinel](/docs/writing-and-mutating/unset) shows the same option for the same reason.

Give every select bound to an optional or late-arriving path an option carrying the empty value. Without one, the dropdown renders with nothing selected, which is the truthful paint: the form holds no value and no option stands for that. Falling back to the first option instead would record a choice nobody made.

A value the option list does not carry reads the same way. A `country` of `'purple'` against `us` / `uk` / `ca` shows nothing selected rather than an arbitrary one, which is the signal that the model and the option list have drifted apart.

`<select multiple>` needs no placeholder. A path the form does not hold picks no members, which is what an untouched multi-select looks like anyway.

## The `.number` modifier

`<option value="...">` only stores strings. When the schema's array (or scalar) leaf is `z.number()` or `z.array(z.number())`, the `.number` modifier coerces every picked option's value to a number before the write:

```vue
<select v-register.number="form.register('priority')">
  <option value="1">Low</option>
  <option value="2">Medium</option>
  <option value="3">High</option>
</select>
```

The directive parses `'1'` → `1` per option. The [Schema-driven coercion](/docs/binding-inputs/coercion) page documents the full leaf-type mapping.

## Custom display values

The dropdown's option labels are pure HTML; bind them however you'd render any other list:

```vue
<script setup lang="ts">
  const countries = [
    { code: 'us', flag: '🇺🇸', name: 'United States' },
    { code: 'uk', flag: '🇬🇧', name: 'United Kingdom' },
    { code: 'ca', flag: '🇨🇦', name: 'Canada' },
    { code: 'au', flag: '🇦🇺', name: 'Australia' },
  ]
</script>

<template>
  <select v-register="form.register('country')">
    <option v-for="opt in countries" :key="opt.code" :value="opt.code">
      {{ opt.flag }} {{ opt.name }}
    </option>
  </select>
</template>
```

The directive only cares about each option's `value=` attribute; the visible label can be anything. `<optgroup>` works the same way: the directive reads option values whether or not they're nested under a group label.

## Where to next

- [Radio groups](/docs/binding-inputs/radio): single-pick counterpart in radio form; reach for it when the option set is short enough to show inline.
- [Checkbox & checkbox groups](/docs/binding-inputs/checkbox): array shape via grouped checkboxes.
- [Schema-driven coercion](/docs/binding-inputs/coercion): how `value=` strings map to non-string leaf types.
