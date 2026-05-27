---
title: fields
description: form.fields is a drillable Proxy keyed by schema paths. Every leaf surfaces a FieldState with state bits, value reads, validation reads, DOM handles, and schema metadata, all reactive.
metaRows:
  - label: Category
    value: Return property
  - label: Type
    value: FieldStateMap<ReadShape<Schema>>
    kind: code
  - label: Reactive
    value: 'Yes'
  - label: Read shape per leaf
    value: FieldState (29 properties)
    kind: code
---

# `fields`

> A reactive Proxy keyed by schema paths. Every leaf surfaces a 29-property FieldState: state bits, value reads, validation reads, DOM handles, and schema metadata, all in one snapshot the form keeps in sync as users interact.

::docs-meta-table
::

`form.fields.<path>` is the per-leaf companion to [`form.values.<path>`](/docs/reading-the-form/values). Where `values` answers "what's at this path?", `fields` answers everything else: has the user touched it, is it focused, is it dirty, what errors does it carry, should we be showing them yet, which DOM element is bound. Type into the email input, blur it, refocus, submit. Every cell in the demo's panel updates live, and the schema metadata at the bottom comes from `withMeta(...)` on the schema itself.

::docs-demo{slug="fields" label="Field State Demo"}
::

## Drillable Proxy

`form.fields` mirrors `form.values`' shape: a Proxy keyed by schema paths. Reach any leaf:

```ts
const schema = z.object({
  profile: z.object({
    name: z.string(),
    email: z.email(),
  }),
  age: z.number(),
})

const form = useForm({ schema })

form.fields.profile.name.touched
form.fields.profile.email.firstError?.message
form.fields.age.dirty
```

Container paths (`form.fields.profile`) descend through the proxy. Call-form (`form.fields('profile')`) returns a FieldState aggregating the descendants. `dirty` is `true` if any leaf under `profile` is dirty; `errors` flattens all descendant errors.

## What FieldState carries

Each leaf exposes a 29-property `FieldState` object. The properties fall into five jobs:

### State bits

The reactive lifecycle of a field: how it got here, what it's doing now.

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

The error surface at this path: raw, ergonomic, and gated.

| Property       | Type                                          | Meaning                                                                                             |
| -------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `errors`       | `readonly ValidationError[]`                  | Every error at this path, schema-declaration order.                                                 |
| `firstError`   | `ValidationError \| undefined`                | Sugar for `errors[0]`.                                                                              |
| `valid`        | `boolean`                                     | `errors.length === 0 && !validating`.                                                               |
| `validating`   | `boolean`                                     | `true` while a per-field validation run is in flight.                                               |
| `displayState` | `'idle' \| 'pending' \| 'error' \| 'success'` | The single display-state verdict, resolved by [`getDisplayState`](/docs/validation/showing-errors). |
| `showErrors`   | `boolean`                                     | `displayState === 'error'`. The display-time error gate.                                            |
| `showPending`  | `boolean`                                     | `displayState === 'pending'`. An async check is in flight.                                          |
| `showSuccess`  | `boolean`                                     | `displayState === 'success'`. The field has passed.                                                 |
| `showIdle`     | `boolean`                                     | `displayState === 'idle'`. Nothing to surface yet.                                                  |

### DOM reads

Direct handles to the bound elements for imperative work: `focus()`, `scrollIntoView()`, measure positions, attach observers, anything Attaform deliberately doesn't wrap behind helpers.

| Property   | Type                     | Meaning                                    |
| ---------- | ------------------------ | ------------------------------------------ |
| `element`  | `HTMLElement \| null`    | First bound element by registration order. |
| `elements` | `readonly HTMLElement[]` | Every element bound to this path.          |

```ts
form.fields.email.element?.focus()
form.fields.email.element?.scrollIntoView({ block: 'center' })
```

### Schema metadata + identity

Schema-registered presentational hints, the path that produced this FieldState, the stable DOM ids for wiring labels and assistive-tech references, and the element identity key for iterating array elements.

| Property      | Type                            | Meaning                                                                                                                                                                        |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label`       | `string`                        | Registered label, or a humanized fallback from the path's last segment.                                                                                                        |
| `description` | `string \| undefined`           | Registered description; falls back to `schema.describe('...')` when no override.                                                                                               |
| `placeholder` | `string \| undefined`           | Registered placeholder hint.                                                                                                                                                   |
| `meta`        | `Readonly<FieldMetaPayload>`    | The full registered payload; escape hatch for consumer-augmented keys.                                                                                                         |
| `path`        | `readonly (string \| number)[]` | The path tuple that produced this FieldState.                                                                                                                                  |
| `id`          | `string`                        | Stable, SSR-safe DOM id for this field, unique across every mount on the page.                                                                                                 |
| `aria`        | `{ errorId, descriptionId }`    | Satellite ids derived from `id` for wiring error and description elements.                                                                                                     |
| `key`         | `string`                        | Allocated identity token while the field is an array element, empty otherwise. Follows the element across reorders; the `:key` for [`form.list`](/docs/reading-the-form/list). |

Register schema metadata with `withMeta` (works on Zod 3 and Zod 4) or the native `schema.register(fieldMeta, {...})` chain (Zod 4):

```ts
import { withMeta } from 'attaform/zod'

const schema = z.object({
  email: withMeta(z.email(), {
    label: 'Email address',
    placeholder: 'you@example.com',
  }),
})
```

## Reading FieldState in templates

The display-ergonomics pairing of `firstError` plus `showErrors` is the per-field rendering pattern:

```vue
<input v-register="form.register('email')" />
<p v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</p>
```

`showErrors` is the gate; `firstError` is the message. Read them together at every error site.

## Where to next

- [`form.list`](/docs/reading-the-form/list): iterate an array as one FieldState per element, keyed by `key` so a `v-for` survives reorders.
- [`values`](/docs/reading-the-form/values): the value half of every FieldState, lifted to a form-wide Proxy.
- [`errors`](/docs/reading-the-form/errors): the per-path errors Proxy, the raw array behind `firstError`.
- [`meta`](/docs/reading-the-form/meta): the form-level aggregation, every FieldState property rolled up, plus 7 form-only reads.
- [The `v-register` directive](/docs/binding-inputs/v-register): the binding that drives `touched`, `focused`, `blurred`, and `connected`.
- [Display state and showing errors](/docs/validation/showing-errors): the predicate behind `displayState`.
- [The `blank` field-state bit](/docs/validation/blank): the lifecycle behind the `blank` cell.
- [The form](/docs/reading-the-form/the-form): every other reactive read on `form` itself.
