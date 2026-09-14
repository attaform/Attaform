---
title: Radio groups
description: Every radio sharing a register call belongs to the same group. The directive writes the checked option's value attribute into storage as the single picked value.
metaRows:
  - label: Category
    value: Directive binding
  - label: Element
    value: <input type="radio">
    kind: code
  - label: Modifiers
    value: none
  - label: Leaf type
    value: enum literal · string · number
    kind: code
---

# Radio groups

> One register call across every option; the directive writes the picked option's value attribute into storage.

::docs-meta-table
::

Pick any of the three plans to watch the JSON readout switch to the option's `value` attribute. Every radio bound through the same `form.register('plan')` call automatically belongs to one group; Attaform infers the grouping from the shared path, not from `name=`. The [Schema-driven coercion](/docs/binding-inputs/coercion) page covers how the directive maps option strings to non-string leaf types.

::docs-demo{slug="radio" label="Radio Demo"}
::

## One register call, many options

```vue
<input v-register="form.register('plan')" type="radio" value="starter" />
<input v-register="form.register('plan')" type="radio" value="pro" />
<input v-register="form.register('plan')" type="radio" value="team" />
```

Every radio bound to `form.register('plan')` belongs to the same group. The directive writes the picked option's `value` attribute into storage:

```ts
form.values.plan // 'starter' | 'pro' | 'team'
```

No `name=` ceremony; the shared `register` call IS the group, and Attaform keeps the pick exclusive from the model: choosing one option writes it, and every other radio on the path falls out of step with storage and clears itself. Add a shared `name=` as well when you want the browser's own grouping, which is what gives a radio group its arrow-key navigation.

## Default selection

Defaulting a radio group is no different from defaulting any other field. Set the default in `defaultValues` (or the schema's `.default(...)`), and the matching radio renders pre-selected:

```ts
const form = useForm({
  schema: z.object({
    plan: z.enum(['starter', 'pro', 'team']),
  }),
  defaultValues: { plan: 'starter' },
})
```

The directive sets `checked` on whichever radio's `value` matches the stored value.

## Numeric and enum options

Radio inputs only emit DOM strings, but the schema leaf can be a number, an enum literal, or any other scalar. Declaring the leaf is the whole job; nothing goes on the directive:

```vue
<input v-register="form.register('priority')" type="radio" value="1" />
<input v-register="form.register('priority')" type="radio" value="2" />
```

Against a `z.number()` leaf, `'1'` lands as `1`. [Schema-driven coercion](/docs/binding-inputs/coercion) handles this for every radio and covers every leaf-type mapping. The `.number` modifier a text input or `<select>` reaches for has no role here, which is why the table above reads `none`: the radio binding takes no modifiers.

## Where to next

- [Select & multi-select](/docs/binding-inputs/select): same single-pick semantics in a dropdown shape; reach for it when the option set is long enough to warrant a dropdown.
- [Checkbox & checkbox groups](/docs/binding-inputs/checkbox): the multi-pick counterpart.
- [Schema-driven coercion](/docs/binding-inputs/coercion): how `value=` strings map to non-string leaves.
