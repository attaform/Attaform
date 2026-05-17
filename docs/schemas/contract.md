---
title: The schema contract
description: A schema declares the shape, constraints, and transformations of a value. Attaform is schema-agnostic at the core and ships first-class Zod adapters.
metaRows:
  - label: Category
    value: Conceptual
  - label: Default adapter
    value: attaform/zod (Zod v4)
    kind: code
  - label: Also shipped
    value: attaform/zod-v3
    kind: code
  - label: Custom
    value: AbstractSchema contract
    kind: code
---

# The schema contract

> A schema declares a value's shape, types, constraints, and transformations. One declaration drives validation, type inference, defaults, and metadata, all from the same source.

::docs-meta-table
::

This page is the mental model for what a schema is and what it lets you do. The rest of the Schemas cluster takes each capability one at a time with side-by-side schema-and-result demos.

## What a schema is

A schema is a declarative description of data. It states what keys exist, what types they hold, how they nest, which values are valid, and which transformations apply on the way in or out. A single declaration carries the answer to every question about the data's shape.

Different schema libraries take different approaches: parser-combinators, classes, descriptor objects, type-only signatures. Attaform is schema-agnostic at its core; the library consumes any object that implements the [`AbstractSchema`](#schema-agnostic-core) contract. Out of the box, [Zod](https://zod.dev) is the canonical adapter. Zod v4 is the default; Zod v3 is one import away.

```ts
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  age: z.number().int().min(13),
})
```

That schema is the artifact every dimension below describes. Attaform reads it once and derives validation, defaults, types, and reactive surfaces from it.

## What a schema declares

A schema covers six dimensions. Each one stands on its own; the rest of the Schemas cluster takes each in depth.

### Shape

The structural skeleton: which keys exist, what types they hold, how they nest. Zod composes shape through `z.object`, `z.array`, `z.tuple`, `z.record`, `z.discriminatedUnion`, `z.enum`, and the primitives (`z.string`, `z.number`, `z.boolean`, `z.date`, `z.bigint`).

```ts
const schema = z.object({
  profile: z.object({
    name: z.string(),
    interests: z.array(z.string()),
  }),
  notify: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('email'), address: z.email() }),
    z.object({ channel: z.literal('sms'), phone: z.string() }),
  ]),
})
```

Shape is the substrate every other dimension builds on. The per-construct deep dives live at [Nested objects](/docs/schemas/nested-objects), [Arrays & tuples](/docs/schemas/arrays-and-tuples), [Records & maps](/docs/schemas/records), and [Discriminated unions](/docs/schemas/discriminated-unions).

### Type safety

Every key, every leaf, every nested path carries a TypeScript type derived from the declaration. The schema is the single thing the type system reads; inference flows outward from there.

```ts
type Account = z.infer<typeof schema>
// { profile: { name: string; interests: string[] }, notify: ... }
```

No manual generics, no `any`, no reaching for plumbing whenever a field is added or renamed.

### Validation

Refinements declare which values are valid. A predicate runs against a parsed value and either passes or attaches an error.

```ts
const password = z
  .string()
  .min(8, 'At least 8 characters')
  .refine((s) => /[A-Z]/.test(s), 'Needs an uppercase letter')
```

Refinements can be asynchronous. `z.string().refine(async (v) => await api.isAvailable(v))` awaits the predicate before parsing settles. Synchronous predicates run eagerly; asynchronous ones await before submit dispatches. [When validation runs](/docs/validation/when-validation-runs) covers the timing model.

### Transformation

Two boundaries can transform a value. `z.preprocess(fn, T)` runs before parsing, normalising input as it lands. `.transform(fn)` runs after parsing, converting the validated value to the wire format.

```ts
z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string())

z.string().transform((s) => s.toLowerCase())
```

The two run at different times and surface different shapes. [How values are stored](/docs/schemas/storage-shape) walks the implications.

### Metadata

Labels, descriptions, placeholders, and free-form annotations live on the schema itself. `withMeta` attaches them at any node.

```ts
import { withMeta } from 'attaform/zod'

const schema = z.object({
  email: withMeta(z.email(), {
    label: 'Email address',
    description: "We'll only use it for receipts.",
    placeholder: 'you@example.com',
  }),
})
```

Metadata travels with the schema; UI that consumes it reads from the declaration directly.

### Defaults

`.default(x)` declares the value a field takes when no input is supplied. `.catch(x)` declares a fallback for parse failures.

```ts
const schema = z.object({
  priority: z.string().default('normal'),
  remember: z.boolean().default(true),
})
```

[Defaults from the schema](/docs/schemas/defaults) covers how declared defaults seed initial values and which operations re-apply them.

## Zod adapters

`attaform/zod` wraps Zod v4 and is the canonical import for new projects. It walks the schema once at construction, caches structural metadata, and implements `AbstractSchema` against Zod's runtime.

```ts
import { useForm } from 'attaform/zod'
```

For projects still on Zod v3, swap the import: `attaform/zod-v3`. The consumer-facing surface is identical; the parsing engine and metadata walker differ to match v3's internals.

## Schema-agnostic core

The core package (`attaform`) doesn't import Zod. It consumes any object that implements `AbstractSchema`, a small contract covering identity, defaults, shape introspection, and validation. The Zod adapters cover the bulk of real-world schemas; reach for [`AbstractSchema`](/docs/schemas/abstract-schema) directly when you're wiring Valibot, ArkType, Effect Schema, or a hand-rolled validator.

## Refinements vs. transforms

Refinements and transforms look adjacent but answer different questions.

```ts
// Refinement: runs at validate, doesn't change the value
z.string().refine((s) => /[a-z]/.test(s), 'Needs a lowercase letter')

// Transform: runs at parse, changes the value
z.string().transform((s) => s.toLowerCase())
```

Refinements ask "is this value acceptable?" Transforms ask "given this value, what should the next stage see?" Schemas stack both in any order; the order matters at validate / parse time.

The split is intentional. Refinements drive live feedback as users type; transforms shape the wire format on the way out.

## Fingerprinting

Every schema carries a structural fingerprint: a short string that changes when the shape changes (adding or removing a field, changing a leaf type, restructuring nesting) but stays stable under refinement, transform, or metadata tweaks. The fingerprint surfaces in two places:

- Persistence keys (a schema change auto-invalidates stale drafts).
- Shared-key form mismatches in dev (two `useForm({ key: 'x' })` calls with different schemas warn).

`schema.fingerprint()` lives on the adapter; the runtime calls it when needed.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults): how `.default()` declarations flow into initial values.
- [How values are stored](/docs/schemas/storage-shape): the per-wrapper read-shape policy.
- [Optional, nullable, defaulted](/docs/schemas/optional-nullable): three modifiers, three different meanings.
