---
title: The schema contract
description: A schema is the form's source of truth. Types, defaults, refinements, and the validation surface flow from one declaration. Attaform is schema-agnostic at the core, with Zod adapters in the box.
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

> One declaration drives the whole form. Types for inference, defaults for initial state, refinements for validation, and the field metadata that powers labels and descriptions.

::docs-meta-table
::

This page is the mental model; there's no widget to demonstrate. The rest of the Schemas cluster makes each piece concrete with side-by-side schema-and-result demos.

## What a schema gives you

A single schema declaration produces every reactive surface the form exposes:

| Surface                 | Comes from                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `form.values`           | The **read shape**: concrete types after defaults / preprocess resolve.  |
| `form.fields.<path>`    | One `FieldState` per leaf: value, errors, touched, blurred, blank, meta. |
| `form.errors.<path>`    | Errors emitted by `validateAtPath`, keyed by path and variant-filtered.  |
| `form.meta`             | Aggregates over every field's state.                                     |
| `handleSubmit` argument | The **submit shape**: post-transform output, type-narrowed.              |
| `register(path)`        | Path autocomplete + per-field meta + the storage assigner.               |

The schema is the only thing you write. The library walks it to derive the rest.

## Three shapes, one schema

Attaform distinguishes three views of the same schema:

```ts
const schema = z.object({
  flag: z.boolean().default(true),
  trimmed: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string()),
  ratio: z.string().transform((v) => Number(v) / 100),
})
```

| Surface                           | Shape      | What it answers                                                      |
| --------------------------------- | ---------- | -------------------------------------------------------------------- |
| `form.values` / `form.fields`     | **read**   | What does storage hold now? `flag: boolean`                          |
| `setValue` / `defaultValues`      | **write**  | What may consumers pass in? `flag?: boolean`                         |
| `handleSubmit` / `form.process()` | **submit** | What does a successful parse yield? `flag: boolean`, `ratio: number` |

The same schema produces all three; the surface determines which one you're holding. [How values are stored](/docs/schemas/storage-shape) is the deep dive.

## The default adapter

`attaform/zod` wraps Zod v4, the canonical entry point for new projects. The adapter:

- Walks the schema once at construction; caches structural metadata.
- Implements `AbstractSchema`, the schema-agnostic contract the core consumes.
- Handles `.optional()` / `.nullable()` / `.default()` / `.preprocess()` / `.transform()` / `z.discriminatedUnion` consistently.
- Resolves field metadata via `withMeta` / `fieldMeta` for label, description, placeholder.

```ts
import { useForm, withMeta } from 'attaform/zod'
import { z } from 'zod'

const schema = z.object({
  email: withMeta(z.email(), { label: 'Email', description: 'We use it for receipts.' }),
})

const form = useForm({ schema })
```

For projects still on Zod v3, swap the import to `attaform/zod-v3`; the surface is identical, the parsing engine differs.

## Schema-agnostic core

The core (`attaform`) doesn't import Zod. It consumes any object that implements the `AbstractSchema` contract: 12 required methods plus 2 optional hooks covering identity, defaults, shape introspection, and validation.

Most consumers never touch this; the Zod adapters cover ~99% of cases. Reach for [Custom schema adapters](/docs/reference/custom-adapters) when:

- You're on Valibot, ArkType, Effect-Schema, or another type system the official adapters don't cover.
- You have a hand-rolled validator whose output you want to flow through Attaform's reactive surface.

The contract is small and stable: `fingerprint`, `getDefaultValues`, `validateAtPath`, plus the shape-introspection helpers the proxy needs.

## Refinements vs. transforms

Two kinds of "schema work" with different read-shape behavior:

```ts
// Refinement: runs at validate, doesn't change the shape
z.string().refine((s) => /[a-z]/.test(s), 'Needs a lowercase letter')

// Transform: runs at parse, changes submit shape
z.string().transform((s) => s.toLowerCase())
```

- **Refinements** are visible in `form.errors.<path>` reactively as the field updates; they don't change `form.values.<path>`'s type.
- **Transforms** are deferred to parse. `handleSubmit`'s argument sees the post-transform output, but `form.values.<path>` still holds the pre-transform input.

The split is intentional: refinements drive live UX feedback; transforms produce the wire format. Reading `form.values` doesn't require thinking about whether transforms have run.

## Fingerprinting

Every schema has a structural fingerprint: a short string that changes when the shape changes (adding / removing / renaming a field, changing a leaf type, restructuring nested objects) but stays stable under refinement / transform / metadata tweaks. The fingerprint:

- Keys the persisted draft (so schema changes auto-invalidate stale drafts).
- Catches shared-key mismatches in dev (two `useForm({ key: 'x' })` calls with different schemas warn).

You never compute it explicitly. `schema.fingerprint()` is on the adapter, called by the runtime when needed.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults): how schema `.default()` declarations flow into `form.values`.
- [How values are stored](/docs/schemas/storage-shape): the slim write shape and the three-views model.
- [Optional, nullable, defaulted](/docs/schemas/optional-nullable): the three missing-ness modifiers and what each means at runtime.
