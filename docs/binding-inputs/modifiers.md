---
title: Modifiers
description: Three modifiers — .lazy, .trim, .number — adjust how v-register writes back to storage on every keystroke or pick. Each composes with any text-family or select binding.
metaRows:
  - label: Category
    value: Directive binding
  - label: Modifiers
    value: '.lazy · .trim · .number'
    kind: code
  - label: Element
    value: <input> · <textarea> · <select>
    kind: code
  - label: Auto-installed
    value: 'Yes'
---

# Modifiers

> Three knobs on the write side of `v-register` — when to write, what to clean up before writing, what type to land on.

::docs-meta-table
::

Type into the lazy field and watch the readout only update on blur. Pad spaces around a word in the trimmed field to see them stripped. Type a number into the third field — even though it's `type="text"`, the value lands in storage as a `number` thanks to `.number`. Each modifier composes with any text-family input; the `.number` modifier also applies to `<select>`.

::docs-demo{slug="modifiers"}
::

## `.lazy`

```vue
<input v-register.lazy="register('name')" type="text" />
```

Writes fire on `change` / `blur` instead of every `input` event. Matches Vue's `v-model.lazy` semantics — readers familiar with the convention can reach for it without re-learning.

When to reach for it:

- Heavy validation that's expensive on every keystroke (a sync refinement that walks a large list, an async refinement that hits a server).
- A field that should commit a "settled" value, not an in-progress one.

## `.trim`

```vue
<input v-register.trim="register('username')" type="text" />
```

Strips leading and trailing whitespace from the DOM string before the write lands in storage. Cleaner storage values + cleaner validation (no `"hello   "` failing a regex that meant to allow `"hello"`).

The `.trim` modifier runs before any [register transform](/docs/binding-inputs/transforms) you've supplied, so transforms see the already-trimmed value.

## `.number`

```vue
<input v-register.number="register('age')" type="text" />
<select v-register.number="register('priority')">
  …
</select>
```

Coerces the DOM string to a `number` before the write. Useful in two specific shapes:

- **`<input type="text">` for a numeric leaf.** The browser doesn't enforce numeric input on `type="text"`, but the schema leaf is `z.number()`. `.number` parses the string for you.
- **`<select>` with numeric option values.** `<option value="1">` only ever stores `'1'` in the DOM; the `.number` modifier coerces per-pick to `1`.

`<input type="number">` already coerces to a number through schema-driven coercion ([page 34](/docs/binding-inputs/coercion)); `.number` is for the cases where the input itself isn't numeric.

## Compose freely

Modifiers compose with each other and with the rest of the binding surface:

```vue
<input v-register.lazy.trim="register('username')" type="text" />
<input v-register.number.lazy="register('age')" type="text" />
```

`.lazy.trim` writes a stripped value on blur; `.number.lazy` writes a parsed number on blur. Order in the template doesn't change the order of operations — the directive applies trim, then number, then writes.

## Where to next

- [Register transforms](/docs/binding-inputs/transforms) — for transformations that go beyond the three built-in modifiers.
- [Schema-driven coercion](/docs/binding-inputs/coercion) — what happens to the value after the modifier runs.
- [The `v-register` directive](/docs/binding-inputs/v-register) — the binding the modifiers attach to.
