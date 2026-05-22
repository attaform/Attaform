---
title: Text, number, textarea
description: The native text family — type="text", type="number", and <textarea> — all bind through v-register. The number input lands in storage as a number, the strings as strings.
metaRows:
  - label: Category
    value: Directive binding
  - label: Elements
    value: <input type="text"> · <input type="number"> · <textarea>
    kind: code
  - label: Modifiers
    value: '.lazy · .trim · .number'
    kind: code
  - label: Auto-installed
    value: 'Yes'
---

# Text, number, textarea

> One directive, three native inputs, three leaf types — text → string, number → number, textarea → string.

::docs-meta-table
::

Type into all three inputs and watch the JSON readout update. The number input's value lands as a `number` (not a string), even though the DOM only deals in strings. The directive handles the leaf-type coercion; the [Schema-driven coercion](/docs/binding-inputs/coercion) page explains the rule that powers it.

::docs-demo{slug="text-number-textarea" label="Text Inputs Demo"}
::

## Bind any of the three

```vue
<input v-register="register('name')" type="text" />
<input v-register="register('age')" type="number" />
<textarea v-register="register('bio')" />
```

All three follow the same write pattern: `input` event → directive reads the DOM value → coerces to the schema leaf type → writes to storage. No wrapper, no per-element binding code.

## Modifiers

Three modifiers apply across all text-family inputs:

```vue
<input v-register.lazy="register('name')" type="text" />
<input v-register.trim="register('name')" type="text" />
<input v-register.number="register('age')" type="text" />
```

| Modifier  | Effect                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `.lazy`   | Writes fire on `change` / `blur` instead of every `input` event. Matches Vue's `v-model.lazy` semantics.                         |
| `.trim`   | Strips leading and trailing whitespace before the write.                                                                         |
| `.number` | Coerces the DOM string to a number before the write — useful when `type="text"` is required but the schema leaf is `z.number()`. |

The full set lives in the [Modifiers](/docs/binding-inputs/modifiers) page; `.number` and `<input type="number">` are documented side-by-side there.

## Where to next

- [Modifiers](/docs/binding-inputs/modifiers) — `.lazy`, `.trim`, `.number` in depth.
- [Register transforms](/docs/binding-inputs/transforms) — composable per-field write transforms.
- [Schema-driven coercion](/docs/binding-inputs/coercion) — how the directive maps DOM strings to leaf types.
