---
title: fields
description: form.fields is a drillable Proxy keyed by schema paths — every leaf surfaces a FieldState with state bits, value reads, validation reads, DOM handles, and schema metadata, all reactive.
metaRows:
  - label: Category
    value: Return property
  - label: Type
    value: FieldStateMap<ReadShape<Schema>>
    kind: code
  - label: Reactive
    value: 'Yes'
  - label: Read shape per leaf
    value: FieldState (22 properties)
    kind: code
---

# `fields`

> One reactive FieldState per leaf — the live snapshot the directive layer keeps in sync as users interact.

::docs-meta-table
::

Type into the email input, blur it, refocus, submit — every cell in the demo's panel updates live. Each `fields.email.<bit>` read is reactive; the schema metadata at the bottom comes from `withMeta(...)` on the schema itself. The [What FieldState carries](#what-fieldstate-carries) section below groups all 22 properties by job.

::docs-demo{slug="fields"}
::

## Drillable Proxy

`form.fields` mirrors `form.values`' shape — a Proxy keyed by schema paths. Reach any leaf:

```ts
const form = useForm({
  schema: z.object({
    profile: z.object({
      name: z.string(),
      email: z.string().email(),
    }),
    age: z.number(),
  }),
})

form.fields.profile.name.touched
form.fields.profile.email.firstError?.message
form.fields.age.dirty
```

Container paths (`form.fields.profile`) descend through the proxy. Call-form (`form.fields('profile')`) returns a FieldState aggregating the descendants — `dirty` is `true` if any leaf under `profile` is dirty, `errors` flattens all descendant errors.

## What FieldState carries

Each leaf exposes a 22-property `FieldState` object. The properties fall into five jobs:

### State bits

The reactive lifecycle of a field — how it got here, what it's doing now.

| Property    | Type              | Meaning                                                                                          |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `pristine`  | `boolean`         | `true` until the value diverges from the original.                                               |
| `dirty`     | `boolean`         | Inverse of `pristine`.                                                                           |
| `focused`   | `boolean \| null` | `true` while the element is focused; `null` while disconnected.                                  |
| `blurred`   | `boolean \| null` | Inverse of `focused` when connected; `null` while disconnected.                                  |
| `touched`   | `boolean`         | `true` after the first blur; survives reset cycles.                                              |
| `connected` | `boolean`         | `true` while at least one element is bound via `v-register`.                                     |
| `blank`     | `boolean`         | `true` while the leaf reads as empty per the [blank predicate](/docs/validation/showing-errors). |
| `updatedAt` | `string \| null`  | ISO timestamp of the last write; `null` until first write.                                       |

### Value reads

The data sitting at this path right now, and what it was at hydration.

| Property   | Type | Meaning                                                        |
| ---------- | ---- | -------------------------------------------------------------- |
| `value`    | `T`  | Current leaf value (same as `form.values.<path>`).             |
| `original` | `T`  | Hydration-time value; `dirty` flips when `value !== original`. |

### Validation reads

The error surface at this path — raw, ergonomic, and gated.

| Property     | Type                           | Meaning                                                                                                           |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `errors`     | `readonly ValidationError[]`   | Every error at this path, schema-declaration order.                                                               |
| `firstError` | `ValidationError \| undefined` | Sugar for `errors[0]`.                                                                                            |
| `valid`      | `boolean`                      | `errors.length === 0 && !validating`.                                                                             |
| `validating` | `boolean`                      | `true` while a per-field validation run is in flight.                                                             |
| `showErrors` | `boolean`                      | The display-time gate — combines errors with the [`shouldShowErrors`](/docs/validation/showing-errors) predicate. |

### DOM reads

Direct handles to the bound elements — for `focus()`, `scrollIntoView()`, and the imperative API the library deliberately doesn't verb.

| Property   | Type                     | Meaning                                    |
| ---------- | ------------------------ | ------------------------------------------ |
| `element`  | `HTMLElement \| null`    | First bound element by registration order. |
| `elements` | `readonly HTMLElement[]` | Every element bound to this path.          |

```ts
form.fields.email.element?.focus()
form.fields.email.element?.scrollIntoView({ block: 'center' })
```

### Schema metadata + identity

Schema-registered presentational hints + the path that produced this FieldState.

| Property      | Type                            | Meaning                                                                          |
| ------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `label`       | `string`                        | Registered label, or a humanized fallback from the path's last segment.          |
| `description` | `string \| undefined`           | Registered description; falls back to `schema.describe('...')` when no override. |
| `placeholder` | `string \| undefined`           | Registered placeholder hint.                                                     |
| `meta`        | `Readonly<FieldMetaPayload>`    | The full registered payload — escape hatch for consumer-augmented keys.          |
| `path`        | `readonly (string \| number)[]` | The path tuple that produced this FieldState.                                    |

Register schema metadata with `withMeta` (works on Zod 3 and Zod 4) or the native `schema.register(fieldMeta, {...})` chain (Zod 4):

```ts
import { withMeta, fieldMeta } from 'attaform/zod'

const schema = z.object({
  email: withMeta(z.string().email(), {
    label: 'Email address',
    placeholder: 'you@example.com',
  }),
})
```

## Reading FieldState in templates

The display-ergonomics pairing — `firstError` + `showErrors` — is the per-field rendering pattern:

```vue
<input v-register="register('email')" />
<p v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</p>
```

`showErrors` is the gate; `firstError` is the message. Read them together at every error site.

## Where to next

- [`errors`](/docs/reading-the-form/errors) — the per-path errors Proxy, the raw array behind `firstError`.
- [`meta`](/docs/reading-the-form/meta) — the form-level aggregation: every FieldState property rolled up, plus 6 submission-state bits.
- [The `v-register` directive](/docs/binding-inputs/v-register) — the binding that drives `touched` / `focused` / `blurred` / `connected`.
- [Showing errors at the right time](/docs/validation/showing-errors) — the predicate behind `showErrors`.
