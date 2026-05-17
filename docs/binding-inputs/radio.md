---
title: Radio groups
description: Every radio sharing a register call belongs to the same group — the directive writes the checked option's value attribute into storage as the single picked value.
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

Pick any of the three plans to watch the JSON readout switch to the option's `value` attribute. Every radio bound through the same `register('plan')` call automatically belongs to one group — Attaform infers the grouping from the shared path, not from `name=`. The [Schema-driven coercion](/docs/binding-inputs/coercion) page covers how the directive maps option strings to non-string leaf types.

::docs-demo{slug="radio" label="Radio Demo"}
::

## One register call, many options

```vue
<input v-register="register('plan')" type="radio" value="starter" />
<input v-register="register('plan')" type="radio" value="pro" />
<input v-register="register('plan')" type="radio" value="team" />
```

Every radio bound to `register('plan')` belongs to the same group. The directive writes the picked option's `value` attribute into storage:

```ts
form.values.plan // 'starter' | 'pro' | 'team'
```

No `name=` ceremony — the shared `register` call IS the group. The browser's per-name single-pick semantics still apply for keyboard navigation; Attaform reads the result.

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

Radio inputs only emit DOM strings, but the schema leaf can be a number, an enum literal, or any other scalar. The `.number` modifier coerces:

```vue
<input v-register.number="register('priority')" type="radio" value="1" />
<input v-register.number="register('priority')" type="radio" value="2" />
```

The directive parses `'1'` → `1` before writing. The [Schema-driven coercion](/docs/binding-inputs/coercion) page covers every leaf-type mapping.

## Where to next

- [Checkbox & checkbox groups](/docs/binding-inputs/checkbox) — the multi-pick counterpart.
- [Select & multi-select](/docs/binding-inputs/select) — same single-pick semantics in a dropdown.
- [Schema-driven coercion](/docs/binding-inputs/coercion) — how `value=` strings map to non-string leaves.
