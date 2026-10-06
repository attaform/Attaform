---
title: Modifiers
description: Three modifiers (.lazy, .trim, .number) adjust how v-register writes back to storage on every keystroke or pick. Each composes with any text-family or select binding, and with a bound component.
metaRows:
  - label: Category
    value: Directive binding
  - label: Modifiers
    value: '.lazy · .trim · .number'
    kind: code
  - label: Element
    value: <input> · <textarea> · <select> · <Component>
    kind: code
  - label: Auto-installed
    value: 'Yes'
---

# Modifiers

> Three knobs on the write side of `v-register`: when to write, what to clean up before writing, what type to land on.

::docs-meta-table
::

Type into the lazy field and watch the readout only update on blur. Pad spaces around a word in the trimmed field to see them stripped. Type a number into the third field. Even though it's `type="text"`, the value lands in storage as a `number` thanks to `.number`. Each modifier composes with any text-family input; the `.number` modifier also applies to `<select>`. All three work on a [bound component](#on-a-component) too.

::docs-demo{slug="modifiers" label="Modifiers Demo"}
::

## `.lazy`

```vue
<input v-register.lazy="form.register('name')" type="text" />
```

Writes fire on the `change` event instead of every `input` event, which for a text field means the write lands when the user leaves it after an edit. Matches Vue's `v-model.lazy` semantics, so readers familiar with the convention can reach for it without re-learning.

Until that write lands, the field holds what the user typed, caret included, even when something else on the page re-renders mid-edit. A write from code, such as `form.setValue`, still replaces the edit, exactly as it does under `v-model.lazy`.

When to reach for it:

- Heavy validation that's expensive on every keystroke (a sync refinement that walks a large list, an async refinement that hits a server).
- A field that should commit a "settled" value, not an in-progress one.

## `.trim`

```vue
<input v-register.trim="form.register('username')" type="text" />
```

Strips leading and trailing whitespace from the DOM string, and commits the stripped value when the user leaves the field. Cleaner storage values + cleaner validation (no `"hello   "` failing a regex that meant to allow `"hello"`).

The strip waits for blur by design. Trimming on each keystroke fights Vue's own patch of the element: the trimmed value reaches storage first, Vue then finds the DOM ahead of it and rewrites the field, and the space the user is still typing disappears under them. So a [register transform](/docs/binding-inputs/transforms) sees the raw text on each keystroke and runs once more on the trimmed text at blur. Put a trimming step in the `transforms` array when every keystroke has to see it stripped.

## `.number`

```vue
<input v-register.number="form.register('age')" type="text" />
<select v-register.number="form.register('priority')">
  …
</select>
```

Coerces the DOM string to a `number` before the write. Useful in two specific shapes:

- **`<input type="text">` for a numeric leaf.** The browser doesn't enforce numeric input on `type="text"`, but the schema leaf is `z.number()`. `.number` parses the string for you.
- **`<select>` with numeric option values.** `<option value="1">` only ever stores `'1'` in the DOM; the `.number` modifier coerces per-pick to `1`.

`<input type="number">` already coerces to a number through [schema-driven coercion](/docs/binding-inputs/coercion); `.number` is for the cases where the input itself isn't numeric.

## Compose freely

Modifiers compose with each other and with the rest of the binding surface:

```vue
<input v-register.lazy.trim="form.register('username')" type="text" />
<input v-register.number.lazy="form.register('age')" type="text" />
```

`.lazy.trim` writes a stripped value on blur; `.number.lazy` writes a parsed number on blur. Order in the template doesn't change the order of operations: the directive applies trim, then number, then writes.

## On a component

The same three modifiers work when `v-register` binds a [component from a library](/docs/binding-inputs/third-party-components), here PrimeVue's `InputText` and `Password`:

```vue
<InputText v-register.trim="form.register('username')" />
<Password v-register.lazy="form.register('password')" />
<InputText v-register.number="form.register('age')" />
```

A component reports its value through emits rather than DOM events, so each modifier keys off the moment focus leaves the component:

- **`.lazy`** holds the component's emits while focus is inside it and commits the last one when focus leaves. Focus moving between the component's own parts, such as its input and its clear button, keeps the edit open. A value the component emits while nobody is editing it, such as a pick from a control that never takes focus, commits straight away.
- **`.trim`** writes each emit as it arrives and commits the trimmed value when focus leaves, the same timing as on a native input.
- **`.number`** casts a string the component emits to a number. An empty or non-numeric string marks the field [blank](/docs/validation/blank), and a value the component already typed, such as the number a numeric input emits, lands as it is.

Attaform applies the modifiers itself and hands the component a plain `v-model`, so nothing gets trimmed or cast twice. A wrapper you wrote with [`useRegister`](/docs/binding-inputs/use-register) passes the modifiers on to its inner control, which applies them exactly as this page describes.

## Where to next

- [Register transforms](/docs/binding-inputs/transforms): for transformations that go beyond the three built-in modifiers.
- [Schema-driven coercion](/docs/binding-inputs/coercion): what happens to the value after the modifier runs.
- [The `v-register` directive](/docs/binding-inputs/v-register): the binding the modifiers attach to.
