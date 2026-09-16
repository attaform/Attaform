---
title: Schema-driven coercion
description: Coercion turns DOM strings into numbers and booleans automatically, so a plain text input can back a z.number() or z.boolean() leaf.
metaRows:
  - label: Category
    value: Directive layer
  - label: Defaults
    value: string → number · string → boolean
  - label: Option
    value: useForm({ coerce })
    kind: code
---

# Schema-driven coercion

> Two rules, both on by default: string → number and string → boolean. They are what make a plain text input back a numeric or boolean leaf.

::docs-meta-table
::

Type a number into the `count` field and watch it land in storage as a `number` (not a string). Type "true" or "false" into `enabled` and see it commit as a `boolean`. Both inputs are `type="text"`; coercion is what makes `z.number()` and `z.boolean()` leaves work against plain text inputs at the directive layer.

::docs-demo{slug="coercion" label="Coercion Demo"}
::

## The two rules

Each fires only when the schema declares that single type at the path. A path that accepts `string` as well (`z.union([z.string(), z.number()])`) is left alone, because the schema said either is fine and silent retyping would be a guess.

- **string → number** trims whitespace, parses with `Number()`, and passes the original through on `NaN` (the slim gate then rejects the unparseable value with a friendly message). Whitespace-only inputs skip the coercion so blank-paths machinery stays in charge.
- **string → boolean** lowercases + trims, accepts `'true'` / `'false'` in any case (`'True'`, `'FALSE'`, `' true '`). Anything else passes through so the gate can reject.

The same two rules cover most native HTML input shapes: `<input type="number">` (number leaf), `<input type="checkbox" value="...">` (boolean leaf), `<select>` with numeric option values.

## When coercion fires

Coercion runs **only on user-typed DOM values**. Programmatic writes through [`form.setValue`](/docs/writing-and-mutating/set-value), `form.register('path').setValueWithInternalPath`, or the field-array helpers are **never** coerced; they're typed against the schema's leaf type at the call site, so the value already matches. The strictness is intentional: if you've got the value in hand in code, you knew its type when you typed it.

The coercion step sits between the directive's value extraction and the slim-type gate's write check:

```
DOM event → extract → modifier (.trim, .number) → transforms[] → coerce → slim gate → storage
```

A value neither rule can convert passes through unchanged; the slim gate handles the rejection downstream with a typed diagnostic.

One modifier sits outside that line. [`.trim`](/docs/binding-inputs/modifiers) holds its strip until the user leaves the field, so on each keystroke the transforms and the coercion step both see the untrimmed string, and the trimmed one travels the same line again at blur. `.number` and `.lazy.trim` land exactly where the diagram puts them.

[`<input type="file">`](/docs/binding-inputs/file) inputs skip coercion entirely; `File` handles are objects, not strings, and land in storage as-is.

## Turning it off

```ts
useForm({ coerce: true }) //   the default: string→number, string→boolean
useForm({ coerce: false }) //   no coercion; the slim gate rejects mismatches as-is
```

That is the whole option. Coercion is a narrow, schema-driven convenience, not an extension point, so there is no rule registry to compose.

## Converting anything else

Use a [register transform](/docs/binding-inputs/transforms). Transforms run on user input, immediately before coercion, and whatever they return is what the slim gate sees, so a leaf type Attaform does not coerce is one function away:

```ts
const toDate = (value: unknown): unknown => {
  const parsed = new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : value
}
```

```vue
<input v-register="form.register('publishedAt', { transforms: [toDate] })" />
```

Now that binding writes a real `Date` into a `z.date()` leaf. The transform is a plain function, so hoist it into a module and share it across every form that needs the same conversion.

## Where to next

- [Modifiers](/docs/binding-inputs/modifiers): `.number` for the `<input type="text">` + numeric-leaf combo.
- [Register transforms](/docs/binding-inputs/transforms): the per-field write pipeline that runs before coercion.
- [`form.setValue`](/docs/writing-and-mutating/set-value): the programmatic-write surface that bypasses coercion entirely.
- [The `v-register` directive](/docs/binding-inputs/v-register): the layer coercion plugs into.
