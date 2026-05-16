---
title: Schema-driven coercion
description: The default coercion registry turns DOM strings into numbers and booleans automatically. Compose your own entries to coerce any leaf type.
metaRows:
  - label: Category
    value: Directive layer
  - label: Defaults
    value: string → number · string → boolean
  - label: Option
    value: useForm({ coerce })
    kind: code
  - label: Registry type
    value: readonly CoercionEntry[]
    kind: code
---

# Schema-driven coercion

> Two built-in rules handle 90 % of real forms — string → number and string → boolean. Compose more when your schema needs them.

::docs-meta-table
::

Type a number into the `count` field and watch it land in storage as a `number` (not a string). Type "true" or "false" into `enabled` and see it commit as a `boolean`. Both inputs are `type="text"` — coercion is what makes `z.number()` and `z.boolean()` leaves work against plain text inputs at the directive layer.

::docs-demo{slug="coercion"}
::

## The default registry

```ts
defaultCoercionRules = [
  { input: 'string', output: 'number', transform: parseNumber },
  { input: 'string', output: 'boolean', transform: parseTrueFalse },
]
```

- **string → number** trims whitespace, parses with `Number()`, returns `coerced: false` on `NaN` (the slim gate then rejects the unparseable value with a friendly message). Whitespace-only inputs skip the coercion so blank-paths machinery stays in charge.
- **string → boolean** lowercases + trims, accepts `'true'` / `'false'` in any case (`'True'`, `'FALSE'`, `' true '`). Anything else skips so the gate can reject.

The same two rules cover most native HTML input shapes: `<input type="number">` (number leaf), `<input type="checkbox" value="...">` (boolean leaf), `<select>` with numeric option values.

## When coercion fires

Coercion runs **only on user-typed DOM values**. Programmatic writes through `form.setValue`, `register('path').setValueWithInternalPath`, or the field-array helpers are **never** coerced — they're typed against the schema's leaf type at the call site, so the value already matches.

The coercion step sits between the directive's value extraction and the slim-type gate's write check:

```
DOM event → extract → modifier (.trim, .number) → transforms[] → coerce → slim gate → storage
```

A value the registry can't coerce (`coerced: false`) passes through unchanged; the slim gate handles the rejection downstream with a typed diagnostic.

## Extending the default registry

`useForm({ coerce })` accepts three forms:

```ts
useForm({ coerce: true }) //   defaults (string→number, string→boolean)
useForm({ coerce: false }) //   no coercion — slim gate rejects mismatches as-is
useForm({ coerce: [...defaultCoercionRules, defineCoercion({ ... })] })
```

Spread `defaultCoercionRules` to extend; pass a bare array to **replace** entirely. Adding a string → Date rule for ISO timestamps:

```ts
import { useForm } from 'attaform/zod'
import { defaultCoercionRules, defineCoercion } from 'attaform'

useForm({
  schema,
  coerce: [
    ...defaultCoercionRules,
    defineCoercion({
      input: 'string',
      output: 'date',
      transform: (s) => {
        const d = new Date(s)
        return Number.isFinite(d.getTime()) ? { coerced: true, value: d } : { coerced: false }
      },
    }),
  ],
})
```

Now `<input type="text" v-register="register('publishedAt')" />` against a `z.date()` leaf works without modifiers.

## App-wide defaults

Set coercion at the plugin level so every form picks up the same custom rule without per-form opt-in:

```ts
import { createAttaform } from 'attaform/zod'
import { defaultCoercionRules, defineCoercion } from 'attaform'

createAttaform({
  defaults: {
    coerce: [
      ...defaultCoercionRules,
      defineCoercion({
        /* ... */
      }),
    ],
  },
})
```

Per-form `useForm({ coerce })` overrides the plugin default. The plugin default overrides the library default. Three layers, deterministic resolution.

## Sync, no throws

Coercion rules MUST be sync. They SHOULD NOT throw — wrap internal try / catch when the conversion can fail (e.g. `BigInt('not-a-number')` throws for non-numeric strings). The library wraps each invocation in try / catch as defense in depth; throws are caught, logged once per `(input, output)` pair, and the original value passes through to the slim gate.

## Where to next

- [Modifiers](/docs/binding-inputs/modifiers) — `.number` for the `<input type="text">` + numeric-leaf combo without touching the registry.
- [Register transforms](/docs/binding-inputs/transforms) — the per-field write pipeline that runs before coercion.
- [The `v-register` directive](/docs/binding-inputs/v-register) — the layer coercion plugs into.
