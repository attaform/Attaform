---
title: The `blank` field-state bit
description: A storage / display side-channel for numeric inputs. Storage holds `0` while the user sees empty; `blankPaths` tracks the divergence so submit doesn't lie.
metaRows:
  - label: Category
    value: Field-state
  - label: Auto-marks
    value: numeric primitives only (number, bigint)
  - label: Manual opt-in
    value: unset sentinel (any path)
    kind: code
  - label: Error code
    value: atta:no-value-supplied
    kind: code
---

# The `blank` field-state bit

> A storage / display side-channel for cleared numeric inputs. Storage holds `0`, the user sees empty, and the form doesn't silently submit `0` for an unfilled required field.

::docs-meta-table
::

The demo shows four fields with different schemas. Watch the `blank` column and the `errors` column as you type. The numeric field starts blank-marked even though `values.age === 0`; the required string field uses the schema's refinement instead; the loose string field never raises an error; and the `unset`-defaulted country starts blank-marked deliberately, clearing as soon as you type.

::docs-demo{slug="blank-field-state" label="Blank State Demo"}
::

## Why it exists

The whole library obeys one principle: **`errors = f(schema, state)`**. Storage plus the schema tell you whether the form is valid, except for one case.

Numeric inputs lie. A `<input type="number">` whose value the user has just cleared shows `''` in the DOM, but the slim shape requires a number, so storage holds `0`. The schema can't tell the difference between "user typed `0`" and "user supplied nothing": both produce `0` in storage. Without a side-channel, the runtime would either:

- Trust storage and silently submit `0` for an unfilled required field (the public-housing-form footgun: "Income? `$0`. Approved.").
- Re-define `0` as "definitely blank," which loses the case where the user actually meant `0`.

`blankPaths` is the side-channel. It's a reactive `Set<PathKey>` recording paths where the runtime knows storage and the visible display diverge. The schema author writes `z.number()` and gets the "empty input" signal back without inventing a sentinel value.

## When `blank` auto-marks

The runtime auto-marks **numeric leaves only**. The asymmetry is real:

| Type      | Storage slim default | DOM "empty" | Need the side-channel?                |
| --------- | -------------------- | ----------- | ------------------------------------- |
| `number`  | `0`                  | `''`        | **Yes**: storage and display diverge. |
| `bigint`  | `0n`                 | `''`        | **Yes**: same reason.                 |
| `string`  | `''`                 | `''`        | No, they match byte-for-byte.         |
| `boolean` | `false`              | unchecked   | No, they match.                       |

For strings and booleans the schema sees what the user sees. Require non-empty strings via `z.string().min(1)`: the refinement error fires the moment storage is `''`, schema speaking.

## Lifecycle (numeric)

```text
form mounts (no defaults)
  → blankPaths.add('income')
  → form.errors.income = [{ code: 'atta:no-value-supplied', … }]
  → form.fields.income.blank === true

user types "5"
  → blankPaths.delete('income')
  → form.errors.income = undefined
  → form.fields.income.blank === false

user clears the input (backspace)
  → directive sees el.value === ''
  → blankPaths.add('income')
  → form.errors.income re-appears reactively
  → form.fields.income.blank === true

user types "0"
  → blankPaths stays empty (the value is intentional)
  → form.errors.income stays undefined
```

`errors = f(schema, state)` holds at every step: `state` includes `(form.value, blankPaths)`, and the function recomputes whenever either changes.

## Lifecycle (string)

```text
form mounts (no defaults)
  → blankPaths empty (strings don't auto-mark)
  → form.errors.email = undefined          (z.string() accepts '')
  → form.fields.email.blank === false

user types "hi" then deletes
  → blankPaths still empty
  → form.errors.email still undefined      (z.string() still accepts '')
  → form.fields.email.blank === false
```

If the schema is `z.string().min(1)` instead, the lifecycle is the same on `blankPaths`, but `form.errors.email` carries a refinement error whenever storage is `''`, because that's the schema speaking. The blank channel stays out of it.

## Explicit opt-in at any path: the `unset` sentinel

Sometimes you do want a string or boolean leaf to start blank: a "please choose" indicator on a checkbox, a deferred-fill text field. That's an explicit consumer signal, not runtime inference. Use the `unset` sentinel:

```ts
import { unset, useForm } from 'attaform/zod'

useForm({
  schema: z.object({ agreed: z.boolean(), note: z.string() }),
  defaultValues: { agreed: unset, note: unset },
})

// Or imperatively:
form.setValue('agreed', unset)
form.reset({ note: unset })
```

`unset` works at every position the consumer can address: primitive leaves, containers, arrays, tuples, records, discriminated unions, optional / nullable wrappers, and the root. Container `unset` recurses through the schema's slim subtree and adds every primitive descendant to `blankPaths` in one call:

```ts
form.setValue('profile', unset) // marks profile.name, profile.age, etc.
form.reset({ cargo: unset }) // DU stub, marks the discriminator path
form.reset(unset) // root: marks every primitive leaf in the schema
```

Combined with required schemas, the sentinel surfaces a `atta:no-value-supplied` error reactively at each marked path: same lifecycle as the numeric auto-mark case, just driven by consumer intent rather than runtime inference. See [the `unset` page](/docs/writing-and-mutating/unset) for the position-by-position contract.

## How to read `blank` in your UI

The library never renders. It exposes the signal; your component decides what to do.

```vue
<script setup lang="ts">
  const form = useForm({ schema })
</script>

<template>
  <input v-register="form.register('income')" />

  <!-- show errors only after the user has touched the field -->
  <p v-if="form.errors.income && form.fields.income.touched" class="error">
    {{ form.errors.income[0].message }}
  </p>

  <!-- separately, an "unanswered" hint that distinguishes from errors -->
  <span v-if="form.fields.income.blank" class="hint">Required, please enter a number</span>
</template>
```

Reading `form.errors.income` directly gives you whatever the schema and the blank channel produced. Reading `form.fields.income.blank` gives you the raw "did the user supply something?" bit, useful for pre-error indicators or progress meters.

## Submit-time integration

`handleSubmit` checks `blankPaths` against the schema before running the success callback:

- If `blankPaths` is non-empty AND the schema requires those paths, submission fails. The success callback never runs, `meta.submissionAttempts` ticks, and `meta.submitError` carries the aggregate.
- If `blankPaths` is non-empty but the schema accepts the empty case (`.optional()`, `.nullable()`, `.default(x)`), submission proceeds.

The `atta:no-value-supplied` error surfaces in `form.errors.<path>` and in `form.meta.errors`: same shape as a schema-emitted error, distinct `code` for filtering.

## `blank` and persistence

Persistence treats `blankPaths` as first-class state. The persisted envelope includes the set, so a cleared numeric field stays visually empty after a reload (storage holds the slim default; the displayed-empty state survives). Without this, a "Score: " field a user cleared would resurrect as "0" after refresh, which is incorrect for the UX.

## `blank` and history

Every history position captures the `blankPaths` set at the time of the snapshot. Undoing a "type a number, then clear it" sequence restores both the value AND the blank bit. The field reads as empty the way it did before the undo.

## Where to next

- [Defaults from the schema](/docs/schemas/defaults): auto-mark interacts with `defaultValues`; explicit values turn it off.
- [`unset`](/docs/writing-and-mutating/unset): flag any path blank in `defaultValues`, `setValue`, or `reset`.
- [Showing errors at the right time](/docs/validation/showing-errors): `firstError` includes the `no-value-supplied` entry; `shouldShowErrors` decides when to render it.
