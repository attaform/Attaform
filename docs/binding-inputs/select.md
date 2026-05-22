---
title: Select & multi-select
description: <select> binds to a single picked value; <select multiple> binds to an array of picked values. The directive reads the schema leaf type and picks the mode automatically.
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
    value: scalar (single) · readonly Value[] (multiple)
    kind: code
---

# Select & multi-select

> One element, two leaf shapes: a scalar for `<select>`, an array for `<select multiple>`. Pick the mode in the schema; the directive follows.

::docs-meta-table
::

Pick a country from the single select to watch the JSON readout switch its scalar value. In the multi-select below, hold ⌘ (or Ctrl) and click multiple options. Every picked option's `value=` attribute lands in the `tags` array in selection order. The directive reads the schema leaf at each path and infers single vs. multi automatically.

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

When the schema leaf is an array, `<select multiple>` writes every picked option's value into that array, in selection order:

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

Deselecting an option removes it from the array; the array shape always reflects the current visual selection. No event-listener wiring on your side; the directive infers multi-mode from the `multiple` attribute and the schema's array leaf.

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
