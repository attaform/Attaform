---
title: Optional, nullable, defaulted
description: Three modifiers, three different runtime behaviors. .optional() makes the slot absent, .nullable() makes null a valid value, .default(x) fills the slot when input is missing.
metaRows:
  - label: Category
    value: Conceptual
  - label: .optional()
    value: 'inner | undefined'
    kind: code
  - label: .nullable()
    value: 'inner | null'
    kind: code
  - label: .default(x)
    value: inner, slot filled at mount
    kind: code
---

# Optional, nullable, defaulted

> Three modifiers that look similar and mean three different things: `.optional()` lets the slot stay absent, `.nullable()` makes `null` a valid value, `.default(x)` fills the slot when input is missing.

::docs-meta-table
::

The demo runs the same field through all three modifiers side by side. Watch how each one reports its value when nothing has been typed, and how each one validates when you do start typing.

::docs-demo{slug="optional-nullable" label="Optional & Nullable Demo"}
::

## The trichotomy at a glance

```ts
const schema = z.object({
  optional: z.string().optional(), // string | undefined
  nullable: z.string().nullable(), // string | null
  defaulted: z.string().default('seed'), // string
})

const form = useForm({ schema })

form.values.optional // undefined (slot may be absent)
form.values.nullable // '' (synthesised falsy: string default '')
form.values.defaulted // 'seed' (schema-declared default applied)
```

Each modifier sends a different signal at validate time:

| Modifier      | Empty case is valid? | Empty case looks like |
| ------------- | -------------------- | --------------------- |
| `.optional()` | yes                  | `undefined`           |
| `.nullable()` | yes                  | `null`                |
| `.default(x)` | yes                  | `x`                   |
| (plain)       | no                   | `''` / `0` / `false`  |

## `.optional()`: "this slot may be absent"

```ts
z.object({ bio: z.string().optional() })
```

`form.values.bio` reads `string | undefined`. The schema accepts both:

- The slot being absent (the field never gets a value).
- A typed string.

Use `.optional()` when _not filling the field is a valid choice_: a "tell us more about yourself" prompt that's genuinely skippable.

## `.nullable()`: "`null` is an explicit signal"

```ts
z.object({ assignedTo: z.string().nullable() })
```

`form.values.assignedTo` reads `string | null`. The schema accepts:

- `null`, meaning "explicitly unassigned."
- A typed string.

But NOT `undefined`. The slot is required to hold _some_ value; `null` is the signal you've decided "no value here on purpose."

Use `.nullable()` when _unassigned is a meaningful state_ that the data model needs to distinguish from "not yet decided" or "empty string."

## `.default(x)`: "fill the slot with `x` when input is missing"

```ts
z.object({ priority: z.string().default('normal') })
```

`form.values.priority` reads `string`: no union, no `null`, no `undefined`. The schema:

- Applies `'normal'` when no input is supplied.
- Otherwise uses whatever the caller passed.

Use `.default(x)` when _every record needs a value and you have a sensible starting point_: the "Priority" dropdown that should start at "Normal," the "Notifications" toggle that should start on.

## Stacking modifiers

The modifiers compose, but the order changes the meaning:

```ts
z.string().optional().default('seed') // (string | undefined).default → string
z.string().default('seed').optional() // string.optional → string | undefined
z.string().nullable().default(null) // (string | null).default → string | null
```

For form ergonomics, `.default(x)` last is the usual move; it peels the optionality back off, so `form.values.<path>` reads as a concrete type.

## What `form.errors.<path>` does for each

```ts
const schema = z.object({
  optional: z.string().optional(),
  nullable: z.string().nullable(),
  defaulted: z.string().default('seed'),
  required: z.string().min(1, 'Name is required'),
})
const form = useForm({ schema })

// Before any user input
form.errors.optional // undefined (empty slot is valid)
form.errors.nullable // undefined ('' satisfies z.string())
form.errors.defaulted // undefined ('seed' satisfies z.string())
form.errors.required // [...] (z.string().min(1) rejects '')
```

The errors flow from the schema; the modifiers shape what counts as empty. A required `z.string()` with no modifier sees `''` and accepts it (an empty string _is_ a string). Add `.min(1, …)` to require a non-empty string; that's the schema speaking, not a side-channel.

## When to reach for `unset` instead

`.optional()` and `.nullable()` are schema-level; they declare that the empty case is type-valid. Sometimes you want a leaf that's _type-required_ but starts in a deliberate "no value yet" state without changing the schema. That's `unset`:

```ts
import { unset } from 'attaform/zod'

const schema = z.object({ pickup: z.string().min(1, 'Required') })
const form = useForm({ schema, defaultValues: { pickup: unset } })

form.fields.pickup.blank // true
form.errors.pickup // [{ code: 'atta:no-value-supplied', … }]
```

`unset` joins the path to `form.blankPaths`, which surfaces `atta:no-value-supplied` reactively when the schema is required. The schema stays strict; the consumer signals intent at the call site. The same sentinel works at containers, arrays, records, discriminated unions, wrappers, and the root: `defaultValues: { profile: unset }` recursively marks every primitive descendant. See [`unset`](/docs/writing-and-mutating/unset) for the full contract and [the `blank` field-state bit](/docs/validation/blank) for the lifecycle.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults): `.default(x)` is the most common case; per-form `defaultValues` overlays it.
- [How values are stored](/docs/schemas/storage-shape): the per-wrapper read-shape policy in full.
- [The `blank` field-state bit](/docs/validation/blank): the storage / display side-channel that handles "user supplied nothing" without lying about the value.
