---
title: Defaults from the schema
description: Schema-declared defaults flow into form.values at mount and on reset. defaultValues overlays them; unset opts a leaf back to blank. The schema is the source of truth.
metaRows:
  - label: Category
    value: Conceptual
  - label: Declared on schema
    value: z.string().default(x), z.number().default(n)
    kind: code
  - label: Overlaid per form
    value: useForm({ defaultValues })
    kind: code
  - label: Re-applied by
    value: form.reset()
    kind: code
---

# Defaults from the schema

> Schema `.default()` declarations seed `form.values` at mount and re-seed on `reset()`. The per-form `defaultValues` option overlays the schema's defaults. Same semantics, different scope.

::docs-meta-table
::

The demo below shows the same schema mounted three ways: bare (defaults from the schema), with a `defaultValues` overlay (per-form override), and with `unset` (a specific leaf opted back to blank). Each form starts from the same declaration; the option drives the initial state.

::docs-demo{slug="schema-defaults" label="Schema Defaults Demo"}
::

## Schema-declared defaults

```ts
const schema = z.object({
  notify: z.boolean().default(true),
  count: z.number().default(10),
  tag: z.string().default('untitled'),
})

const form = useForm({ schema })

form.values.notify // true
form.values.count // 10
form.values.tag // 'untitled'
```

At mount, the adapter resolves the schema's declared defaults into a complete initial value tree. `form.values.<path>` reads concrete types: no `undefined`, no manual checks for "did the schema run yet?"

The same defaults re-seed on `reset()`:

```ts
form.setValue('count', 99)
form.values.count // 99
form.reset()
form.values.count // 10, back to the schema's default
```

## Per-form `defaultValues` overlay

When you pass `defaultValues` to `useForm`, the overlay sits on top of the schema's defaults:

```ts
const form = useForm({
  schema,
  defaultValues: { count: 42 },
})

form.values.notify // true        ← schema default
form.values.count // 42         ← overlay wins
form.values.tag // 'untitled'  ← schema default
```

The overlay is a `DeepPartial` of the form's input shape. Supply only the leaves you want to override; missing leaves fall back to the schema's declared default.

This is the right place for environment-specific defaults: a "remember me" toggle defaulting to true on a desktop app vs. false on a kiosk, a discount-rate default that flows from a feature flag, etc.

## Three patterns for `defaultValues`

```ts
import { unset } from 'attaform/zod'

// 1. Plain values: explicit defaults flow into storage
useForm({ schema, defaultValues: { email: 'me@example.com', count: 10 } })

// 2. Omit defaultValues entirely: numeric leaves auto-mark blank,
//    strings and booleans take their schema default
useForm({ schema })

// 3. Mark any path as `unset`: leaf, container, or the whole form.
//    The runtime writes the schema's slim value and flags every
//    primitive descendant in form.blankPaths.
useForm({ schema, defaultValues: { email: unset, count: 10 } })
useForm({ schema, defaultValues: { profile: unset } }) // whole container
useForm({ schema, defaultValues: unset }) // every primitive leaf
```

The third pattern uses `unset` as a sentinel that lands at any path. Required schemas under the unset path surface a `code: 'atta:no-value-supplied'` error reactively. See [the `unset` page](/docs/writing-and-mutating/unset) for the position-by-position contract and [the `blank` field-state bit](/docs/validation/blank) for the storage / display divergence story.

## Numeric leaves auto-mark blank

Numeric primitives (`number`, `bigint`) are special: when no explicit value is supplied, the leaf auto-marks as blank because storage's slim default (`0`, `0n`) differs from what the DOM shows (an empty `<input type="number">`).

```ts
// schema: z.object({ age: z.number(), title: z.string() })
useForm({ schema })

form.values.age // 0       ← storage slim default
form.fields.age.blank // true    ← auto-marked
form.errors.age // [{ code: 'atta:no-value-supplied', … }]

form.values.title // ''      ← storage slim default
form.fields.title.blank // false   ← NOT auto-marked (matches DOM)
form.errors.title // undefined  (z.string() accepts '')
```

Strings and booleans don't auto-mark because their slim defaults match what the DOM natively shows. The schema is the authority on whether `''` / `false` is acceptable; numerics need the side-channel to disambiguate "user typed `0`" from "user supplied nothing." See [the `blank` field-state bit](/docs/validation/blank) for the full lifecycle.

## `.default(x)` vs. `.prefault(x)` vs. `.catch(x)`

Zod offers three wrappers that influence the initial value:

```ts
z.string().default('foo') // pre-parse: used when input is undefined
z.string().prefault('foo') // same as default in Zod v4 (alias)
z.string().catch('foo') // post-parse fallback: used when parse fails
```

For form defaults, you usually want `.default(x)`; it fills the slot before any user input lands. `.catch(x)` is for recovery: if the schema would otherwise raise an error, fall back to `x`. The adapter recognizes all three and feeds the initial value into `form.values` the same way; the difference shows up at parse time.

## `reset()` vs. `clear()`

The two operations look adjacent but mean different things:

```ts
const schema = z.object({
  notify: z.boolean().default(true),
  count: z.number().default(5),
})
const form = useForm({ schema })

form.reset() // notify → true,  count → 5  (declared defaults)
form.clear() // notify → false, count → 0  (falsy-for-type)
```

`reset` re-applies the schema's declared `.default()` values; `clear` ignores them and writes the type's falsy concrete instead. Both accept a path argument: `resetField(path)` re-seeds one leaf, `clear(path?)` wipes one or the whole form.

For "wipe to blank state" UX, prefer `clear`. For "back to the form's starting state" UX, prefer `reset`.

## Where to next

- [How values are stored](/docs/schemas/storage-shape): the slim write shape and the read vs. write vs. submit distinction.
- [Optional, nullable, defaulted](/docs/schemas/optional-nullable): what each missing-ness modifier means for the initial value.
- [`reset` & `resetField`](/docs/writing-and-mutating/reset): the imperative surface that re-applies defaults.
