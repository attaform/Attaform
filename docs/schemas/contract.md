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

`attaform` is the canonical import for new projects. `useForm` here takes a Zod schema, walks it once at construction, caches structural metadata, and implements `AbstractSchema` against Zod's runtime. It reaches the right major on its own, by one of two routes.

Under the `attaform/vite` plugin (or `attaform/nuxt`, which installs it), the import is rewritten at build time to `attaform/zod-v3` or `attaform/zod-v4` against the Zod version you have installed. That is the route to want: the resolution happens once, and the bundle carries one adapter.

Without a build plugin (webpack, rspack, esbuild, plain ESM), `useForm` dispatches at runtime instead, on the shape of the schema you handed it rather than on what is installed. A v3 schema and a v4 schema both land on the right adapter, in the same app if it comes to that. The convenience is paid for in bundle size, since both adapters ship.

```ts
import { useForm } from 'attaform'
```

`attaform/zod` is the same surface named explicitly. `attaform/zod-v3` and `attaform/zod-v4` pin one adapter outright: never rewritten, never carrying the other. That makes them the lean import on tooling the plugin does not cover, as well as the pin for a project staying on Zod v3. The consumer-facing surface is identical across all four; the parsing engine and metadata walker differ to match each major's internals.

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

Containers behave the same way at every level: `z.set(...)` holds a real `Set`, `z.map(...)` a real `Map`, `z.record(...)` a dictionary.

**No kind is refused.** Attaform does not decide what a field is allowed to hold. A `z.symbol()` or a `z.function()` field is unusual, but it is your call to make, and if the value needs serializing before it crosses the wire that is work for your `handleSubmit` callback, not a reason for Attaform to reject the schema up front. The same goes for a kind a newer Zod introduces after this release: Attaform carries what it cannot describe rather than crashing on it.

Each kind gets a blank value, which is what `form.values` reads before anything is written and what `form.clear(path)` writes back:

| Kind                                                      | Blank                        |
| --------------------------------------------------------- | ---------------------------- |
| `z.string()`, `z.templateLiteral(...)`                    | `''`                         |
| `z.number()` / `z.bigint()` / `z.boolean()` / `z.date()`  | `0` / `0n` / `false` / epoch |
| `z.enum([...])` / `z.literal(x)`                          | the first member / `x`       |
| `z.array(...)`                                            | `[]`                         |
| `z.tuple([a, b])`                                         | `[a's blank, b's blank]`     |
| `z.object(...)`                                           | `{}`, every key recursed     |
| `z.record(...)`                                           | `{}`                         |
| `z.set(...)` / `z.map(...)`                               | `new Set()` / `new Map()`    |
| `z.file()`                                                | `null`                       |
| `z.union([...])` / `z.discriminatedUnion(...)`            | the first option's blank     |
| `z.coerce.X()`, `z.preprocess(fn, X)`                     | absent (`undefined`)         |
| `z.symbol()`, `z.function()`, `z.promise(...)`            | absent (`undefined`)         |
| `z.any()`, `z.unknown()`, `z.custom()`, `z.instanceof(X)` | absent (`undefined`)         |

Two rows are worth reading twice, because both seed a value nobody chose. A tuple blanks position by position rather than to `[]`, so `z.tuple([z.string(), z.number()])` reads `['', 0]` on mount and a `v-for` over it renders both positions straight away. And a required `z.enum([...])` blanks to its **first member**, which a bound `<select>` then paints as the selected row. Neither one is marked [blank](/docs/validation/blank), so a user who never opens that dropdown still submits the first option. Where that matters, declare the field `.optional()` (the slot stays absent) or seed it yourself through `defaultValues`.

The last three rows are absent for three different reasons. An opaque leaf declares nothing about its value's shape, so there is no blank to derive. A symbol, a function, and a promise are describable but have no empty member: there is no empty Promise, no empty function, and `Symbol()` mints a fresh value on every call, so seeding one would make the blank non-deterministic. `z.coerce.X()` and `z.preprocess(fn, X)` are the third case: both declare an input boundary your own code owns, so the inner leaf's blank would be a value Attaform invented on the far side of a conversion it cannot run yet. A `.default(x)` you declare on either one is still honored, so `z.coerce.number().default(5)` seeds `5`. In every case the slot stays genuinely absent until something writes to it.

Three things are worth knowing before you reach for the referential kinds. All three are Zod's semantics rather than Attaform's, and all three are pinned by tests so they stay stated rather than discovered.

- `setValue(path, fn)` normally means a functional update. At a `z.function()` leaf it means the value, because the schema said so. Everywhere else the updater reading stands, opaque leaves included.
- Zod's own `parse` returns a validating **wrapper** around a `z.function()`, not the function you wrote. Storage keeps your identity; `handleSubmit` and `validate` hand you Zod's wrapper.
- `z.promise(X)` does not mean "a field holding a promise". It means "a promise that must resolve to `X`", so validating one reaches through it, and the two Zod majors do that differently. On v4 the parse awaits the stored promise, so a slow one delays validation and a never-resolving one blocks it. On v3 the parse reports success immediately and puts a derived promise carrying the real verdict into its result; nothing awaits that, so a failing one surfaces as an unhandled rejection rather than as a form error. Attaform does not silence it, because a blanket catch would also swallow rejections from your own promises sitting in opaque leaves.

  To park a promise in a field without Zod reaching into it, use `z.custom<Promise<T>>()` or `z.unknown()`. Both carry the value untouched on both majors.

### The one rule: the root must hold keys

A form is a set of addressable fields, so the schema you hand `useForm` has to have keys to address. Three shapes do: `z.object({ ... })`, `z.record(key, value)`, and `z.discriminatedUnion(key, [ ... ])`. A `z.string()` or a `z.array(...)` root raises [AF15](/e/af15) at `useForm(...)`.

The check peels transparent wrappers before it decides, so `z.object({ ... }).optional()` or `.default({})` at the root is accepted for what it wraps, and `z.string().optional()` is refused for the same reason its bare form is.

That rule is about addressability, not about kinds. Every kind above is welcome the moment you give it a name:

```ts
// Refused: nothing to address.
const schema = z.string()

// Accepted.
const schema = z.object({ nickname: z.string() })
```

### Class instances and reactivity

Form values live in a reactive tree, and Vue wraps a plain class instance in a proxy on the way out. The instance stays intact: `instanceof` holds and every public method works. Exotic built-ins (`File`, `Blob`, `Date`, `URL`) are handed back untouched, because Vue declines to wrap them.

The one sharp edge is a class whose methods read `#private` fields. Those are keyed to the instance itself, so calling through the proxy throws. Wrap the instance in Vue's `markRaw` before you store it:

```ts
import { markRaw } from 'vue'

form.setValue('session', markRaw(new Session(token)))
```

### Code in your schema never takes the page down

A schema is not inert data. `z.lazy(() => ...)`, `.default(() => ...)` and `.catch(() => ...)` hold functions you wrote, and Attaform calls them during its own work: deriving blank values at mount, resolving a recursive node, fingerprinting. If one of those throws, the throw lands in the middle of an Attaform walk.

Attaform contains it. The field falls back to absent, exactly as if the schema had never described it, and development logs once per kind of failure with the original error attached. The rest of the form mounts and stays usable.

```ts
const schema = z.object({
  // If this factory throws, `draft` reads as undefined and the console
  // says why. `title` is unaffected and the form still mounts.
  draft: z.string().default(() => JSON.parse(localStorage.getItem('draft') ?? '')),
  title: z.string(),
})
```

The same holds for the values you write. Attaform walks them, so a property that is an accessor gets read; one that throws is treated as an absent key rather than allowed to escape from `setValue`, `reset`, or a render.

Callbacks you hand over deliberately already have somewhere to go, and keep going there: a throw from `onSubmit` or `onError` lands on `form.meta.submitError`, and a throw from a `register({ transforms })` function lands on `field.transformError`.

A handful of throws stay deliberately loud, on one rule: the mistake is at the call site rather than a failure at runtime, so surfacing it where it was made is the only useful answer. A malformed path (`form.errors('a..b')`), an invalid `useForm` configuration, a root with no keys to address ([AF15](/e/af15)), a schema built by the Zod major the pinned adapter cannot read ([AF01](/e/af01)), and `form.rehydrate()` on a form that captured no factory ([AF10](/e/af10)) all raise on the spot.

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

Every schema carries a structural fingerprint: a short string that changes when the shape changes (adding or removing a field, changing a leaf type, restructuring nesting) but stays stable under refinement, transform, or metadata tweaks.

It has one consumer today: the dev-mode shared-key check. Two `useForm({ key: 'x' })` calls whose schemas disagree structurally warn at the second call, which is what catches a key you meant to be unique and a genuine shape drift between two components that share one form.

`schema.fingerprint()` lives on the adapter; the runtime calls it when needed.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults): how `.default()` declarations flow into initial values.
- [How values are stored](/docs/schemas/storage-shape): the per-wrapper read-shape policy.
- [Optional, nullable, defaulted](/docs/schemas/optional-nullable): three modifiers, three different meanings.
