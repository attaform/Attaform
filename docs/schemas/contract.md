---
title: The schema contract
description: A schema declares the shape, constraints, and transformations of a value. Attaform is schema-agnostic at the core and ships first-class Zod adapters.
metaRows:
  - label: Category
    value: Conceptual
  - label: Default adapter
    value: attaform (Zod v4)
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

Different schema libraries take different approaches: parser-combinators, classes, descriptor objects, type-only signatures. Attaform is schema-agnostic at its core, consuming any object that implements the [`AbstractSchema`](#schema-agnostic-core) contract. Out of the box, [Zod](https://zod.dev) is the canonical adapter. Zod v4 is the default; Zod v3 is one import away.

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

Two stages within parse can transform a value. `z.preprocess(fn, T)` normalizes the input before the inner schema sees it. `.transform(fn)` converts the validated value to the wire format.

```ts
z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string())

z.string().transform((s) => s.toLowerCase())
```

Both fire at parse time (`handleSubmit`, `validate`, `parse`); storage holds the consumer's raw input verbatim. [How values are stored](/docs/schemas/storage-shape) walks the implications.

### Metadata

Labels, descriptions, placeholders, and free-form annotations live on the schema itself. `withMeta` attaches them at any node.

```ts
import { withMeta } from 'attaform'

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

`attaform` is the canonical import for new projects. `useForm` here takes a Zod schema, walks it once at construction, caches structural metadata, and implements `AbstractSchema` against Zod's runtime. It auto-detects the installed Zod major (v4 by default, v3 when that's what's installed) and routes to the matching adapter.

```ts
import { useForm } from 'attaform'
```

`attaform/zod` is the same surface named explicitly, and `attaform/zod-v3` / `attaform/zod-v4` pin one adapter with no detection. For projects still on Zod v3, `attaform/zod-v3` is the pin. The consumer-facing surface is identical across all four; the parsing engine and metadata walker differ to match each major's internals.

### What the adapters accept

Attaform carries a value it cannot describe rather than refusing it. Anything Zod can express as a **value** is a leaf Attaform will hold, validate, and hand back by identity, including types it has no structural knowledge of.

Opaque leaves are the clearest case. `z.instanceof(File)`, `z.custom<T>()`, `z.unknown()`, and `z.any()` all declare a value without describing its shape, so Attaform stores whatever you write, runs the schema's own predicate at validate time, and exposes no sub-paths under it. `z.instanceof(File)` is how you model a file field on Zod v3; on v4 you can use either that or the native `z.file()`, which additionally understands `.min(size)`, `.max(size)`, and `.mime([...])`.

```ts
const schema = z.object({
  // opaque leaf: Attaform holds the File, Zod checks it
  avatar: z.instanceof(File),
  attachments: z.array(z.instanceof(File)).min(1, 'Attach at least one'),
})
```

Containers behave the same way at every level: `z.set(...)` holds a real `Set`, `z.record(...)` a dictionary, `z.map(...)` is the one container shape still on the refused list below.

A short list of kinds is refused, and hitting one raises [AF02](/e/af02) at `useForm(...)` with the offending path rather than failing later at render:

| Kind                                                 | Why                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `z.promise(...)`                                     | A pending box, not data. Nothing binds to it, no blank exists for it, and validation cannot read it synchronously. Await the value before it enters the form. |
| `z.function(...)`                                    | A callback is behaviour, not form state. Keep it in your component, outside the schema.                                                                       |
| `z.map(...)`, `z.symbol()`, `z.templateLiteral(...)` | Representable in principle, not yet modelled. Reshape a `Map` to a `z.record(...)`, and a template literal to a `z.string()` with a `.regex(...)`.            |

### Class instances and reactivity

Form values live in a reactive tree, and Vue wraps a plain class instance in a proxy on the way out. The instance stays intact: `instanceof` holds and every public method works. Exotic built-ins (`File`, `Blob`, `Date`, `URL`) are handed back untouched, because Vue declines to wrap them.

The one sharp edge is a class whose methods read `#private` fields. Those are keyed to the instance itself, so calling through the proxy throws. Wrap the instance in Vue's `markRaw` before you store it:

```ts
import { markRaw } from 'vue'

form.setValue('session', markRaw(new Session(token)))
```

## Schema-agnostic core

Underneath the Zod entries, the core doesn't know about Zod at all. It consumes any object that implements `AbstractSchema`, a small contract covering identity, defaults, shape introspection, and validation. `attaform/abstract` exposes that core directly through `useAbstractForm`, which takes an `AbstractSchema` adapter instead of a Zod schema. The Zod adapters cover the bulk of real-world schemas; reach for [`AbstractSchema`](/docs/schemas/abstract-schema) and `attaform/abstract` when you're wiring Valibot, ArkType, Effect Schema, or a hand-rolled validator.

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
