---
title: unset (the blank-anywhere sentinel)
description: Pass the unset sentinel at any path in defaultValues, setValue, or reset. The runtime writes the schema's slim value (recursively for containers) and joins every primitive descendant to form.blankPaths, so the bound input renders empty.
metaRows:
  - label: Category
    value: Export
  - label: From
    value: attaform · attaform/zod · attaform/zod-v3 · attaform/zod-v4
    kind: code
  - label: Use
    value: defaultValues, setValue, reset
    kind: code
  - label: Read state
    value: form.blankPaths, form.fields(path).blank
    kind: code
---

# `unset`

> A consumer-side shorthand for "this path starts blank." The runtime writes the schema's slim value at that path, joins every primitive descendant to `form.blankPaths`, and the bound input renders empty until the user types.

::docs-meta-table
::

The demo carries a primitive leaf (`email`) and a container (`profile` with `name` + `age`). Click `setValue('email', unset)` to flag the leaf blank, or `setValue('profile', unset)` to flag the whole container blank. The panel shows storage (always concrete, never the sentinel) and the live `blankPaths` set.

::docs-demo{slug="unset" label="Unset Demo"}
::

## What `unset` does

`unset` is a sentinel symbol exported from every entry point. Pass it as a value in `defaultValues`, `setValue`, or `reset`. The runtime translates it into two effects at the targeted path:

1. **Storage** receives the schema's slim concrete. For primitive leaves that's `''`, `0`, `0n`, `false`. For `.optional()` wrappers it's `undefined`; for `.nullable()` it's `null`. For container paths the runtime recurses: an object writes a shape with every leaf at its slim, an array writes `[]`, a tuple writes its slim positions, a record writes `{}`, a discriminated union writes `{ <discriminatorKey>: '' }` with no variant body.
2. **`form.blankPaths`** gains every primitive descendant under the target. The `v-register` directive reads from the same set when binding the DOM input, so the field renders empty even though storage holds a concrete value.

Reads through `form.values.<path>` always see the slim value. Storage never holds the sentinel symbol.

## Where `unset` can land

The sentinel works at every position the consumer can address:

```ts
import { unset, useForm } from 'attaform/zod'

const schema = z.object({
  email: z.string(),
  profile: z.object({ name: z.string(), age: z.number() }),
  tags: z.array(z.string()),
  cargo: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('boat'), length: z.number() }),
    z.object({ kind: z.literal('truck'), payload: z.number() }),
  ]),
})

const form = useForm({
  schema,
  defaultValues: {
    email: unset, // primitive leaf
    profile: unset, // container, marks profile.name and profile.age
    tags: unset, // array, writes []
    cargo: unset, // DU, writes { kind: '' } stub, no variant body
  },
  key: 'demo',
})
```

The same value works on every imperative write:

```ts
form.setValue('profile', unset) // re-blank the whole profile sub-tree
form.setValue('cargo', unset) // reset cargo to a no-variant-selected state
form.reset({ tags: unset, email: unset }) // baseline that re-applies on reset()
```

Root-level `unset` is admitted too. `defaultValues: unset` or `form.reset(unset)` walks the whole schema, marking every primitive descendant blank. Useful for "the user must touch every field" workflows where presence carries audit weight: a housing application form that needs to record "client manually set income to 0" separately from "income defaulted to 0."

## Container behavior, in detail

| Position                       | Storage write                          | `blankPaths` adds                         |
| ------------------------------ | -------------------------------------- | ----------------------------------------- |
| Primitive leaf                 | Schema's slim primitive                | The leaf path                             |
| Bare object                    | Recursive slim subtree                 | Every primitive descendant under the path |
| Array / tuple / record         | `[]` / slim tuple / `{}`               | The container path itself                 |
| Discriminated union container  | `{ <discriminatorKey>: <kind-blank> }` | The discriminator's path                  |
| `.optional()` wrapper          | `undefined`                            | The wrapper path                          |
| `.nullable()` wrapper          | `null`                                 | The wrapper path                          |
| Date / RegExp / Map / Set leaf | The schema's slim concrete             | The leaf path                             |

The container path itself does NOT enter `form.blankPaths`. `form.fields('profile').blank` derives reactively from the conjunction "every primitive descendant is blank," so an empty container reads blank by vacuous truth, and one descendant filled flips the container's blank false automatically.

## Reading the blank state

`form.values.<path>` returns concrete storage. Read the displayed-empty state through `form.fields`:

```ts
form.fields.email.blank // true after setValue('email', unset)
form.fields('profile').blank // true when every descendant of profile is blank
```

`form.blankPaths.value` carries the full set as `ReadonlySet<PathKey>` for callers that want the whole list (persistence, debug overlays). The `v-register` directive reads the same signals and renders the DOM empty.

## Required schemas raise `no-value-supplied`

A required leaf sitting in `form.blankPaths` surfaces an error in `form.errors`:

```ts
const schema = z.object({ income: z.number() }) // required
const form = useForm({ schema, defaultValues: { income: unset } })

form.errors.income // [{ code: 'atta:no-value-supplied', … }]
form.fields('income').blank // true
```

`.optional()`, `.nullable()`, and `.default(N)` schemas accept the empty case. Those leaves still sit in `form.blankPaths` (the directive needs the signal to render the input empty), but no error fires. See [the `blank` field-state bit](/docs/validation/blank) for the full lifecycle.

## Cross-entry availability

`unset` and `isUnset` ship from every entry point: `attaform`, `attaform/zod`, `attaform/zod-v3`, `attaform/zod-v4`. The `Unset` type is exported alongside for explicit type annotations:

```ts
import { unset, isUnset, type Unset } from 'attaform/zod'

function maybeBlank(v: string | Unset): string | undefined {
  return isUnset(v) ? undefined : v
}
```

`isUnset` is a type guard for explicit narrowing of `value: T | Unset` payloads (input parameters, `setValue` callbacks). It is NOT a `form.values` check: storage never holds the symbol, so `isUnset(form.values.<path>)` always returns `false`.

## Where to next

- [The `blank` field-state bit](/docs/validation/blank): the storage / display side-channel `unset` plugs into.
- [`setValue` patterns](/docs/writing-and-mutating/set-value): the imperative write surface.
- [Defaults from the schema](/docs/schemas/defaults): how schema-declared defaults and `unset` interact at mount time.
