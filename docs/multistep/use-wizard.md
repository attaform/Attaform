---
title: Multi-step flows
description: useStepper composes multiple useForm instances into a wizard — current step, statuses per form, aggregate errors, navigation methods, and a progress fraction. Each step keeps its own schema and reactive surface.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'useStepper(forms, options?)'
    kind: code
  - label: Per-step
    value: each form keeps its own schema, history, persistence
  - label: Aggregates
    value: statuses · allErrors · progress
    kind: code
---

# Multi-step flows

> Compose multiple `useForm` instances into a wizard — `useStepper` orchestrates navigation and exposes aggregate status without entangling the per-step schemas.

::docs-meta-table
::

Three small `useForm` calls — account, profile, review — feed into one `useStepper`. The progress bar reflects `stepper.progress` (the fraction of valid steps), the rail highlights `stepper.current`, and each step's form keeps its own schema and reactive surface. Tap **Next** / **Back** to walk the chain; the **Finish** button fires on the last step.

::docs-demo{slug="use-stepper" label="Stepper Demo"}
::

## The composition

```ts
import { useForm, useStepper } from 'attaform/zod'
import { z } from 'zod'

const account = useForm({
  schema: z.object({ email: z.email(), password: z.string().min(8) }),
  key: 'signup-account',
})

const profile = useForm({
  schema: z.object({ name: z.string().min(1), city: z.string() }),
  key: 'signup-profile',
})

const review = useForm({
  schema: z.object({ tos: z.literal(true) }),
  defaultValues: { tos: false },
  key: 'signup-review',
})

const stepper = useStepper([account, profile, review] as const)
```

Each step is its own form — schemas, default values, persistence, history, all per-step. The stepper is a thin orchestrator over them; it does not own values, errors, or validation.

## The return shape

```ts
type UseStepperReturnType<Forms> = {
  readonly current: Readonly<Ref<KeysOf<Forms>>>
  readonly forms: Forms
  readonly count: number
  readonly statuses: StepperStatusesProxy<Statuses<Forms>>
  readonly allValues: AllValues<Forms>
  readonly allErrors: Readonly<Ref<readonly AggregateError[]>>
  readonly progress: Readonly<Ref<number>>
  readonly next: (options?: StepperNavOptions) => void
  readonly back: (options?: StepperNavOptions) => void
  readonly goTo: (key: KeysOf<Forms>, options?: StepperNavOptions) => void
}
```

| Member                   | What it is                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `current`                | `Ref` of the current step's key. The discriminator templates branch on.                        |
| `forms`                  | The original `forms` array — useful for iterating in a rail / TOC.                             |
| `count`                  | Number of steps. Handy for "Step N of M" labels.                                               |
| `statuses`               | Drillable proxy of `FormStatus` per step (`isValid`, `isDirty`, `isSubmitted`, `errorCount`).  |
| `allValues`              | Drillable record of every step's `values` keyed by form key.                                   |
| `allErrors`              | Cross-step `AggregateError[]` — `{ formKey, path, message, code? }` for a wizard-wide summary. |
| `progress`               | Fraction in `[0, 1]` — count of valid steps divided by total steps.                            |
| `next` / `back` / `goTo` | Navigation. `goTo(key)` jumps to an arbitrary step by its form's key.                          |

## `statuses` — three call forms

```ts
stepper.statuses // the whole proxy
stepper.statuses() // → { account: FormStatus, profile: FormStatus, review: FormStatus }
stepper.statuses('account') // → FormStatus for account
stepper.statuses.account // → FormStatus for account (drillable read)
stepper.statuses.account.isValid // → boolean (reactive)
```

The drillable read is the template-friendly form; the callable form is convenient in script for one-off reads.

## Navigation

```ts
stepper.next() // step forward one
stepper.back() // step back one
stepper.goTo('profile') // jump to a specific step by key
```

`StepperNavOptions` is currently a placeholder — pass `{}` or omit it. Out-of-bounds calls log a dev-mode warning and are no-ops:

- `next()` on the last step.
- `back()` on the first step.
- `goTo(key)` with a key not in the `forms` array.

## Aggregate errors

`stepper.allErrors` flattens every step's errors into one array, in stepper order then per-form order. Each entry carries the originating form's key — link back to the source field from a wizard-wide summary:

```vue
<template>
  <ul class="wizard-errors">
    <li v-for="err in stepper.allErrors" :key="`${err.formKey}-${err.path.join('.')}`">
      <a :href="`#${err.formKey}`">{{ err.message }}</a>
    </li>
  </ul>
</template>
```

## Construction-time errors

Three things throw at construction (typo / wiring safety, not runtime):

- **Empty `forms` array** — a stepper with zero steps is meaningless.
- **A form with `key: ''`** — every step needs a non-empty key for status routing.
- **Duplicate keys** — each step needs a distinct key.

`defaultStatuses` with an unknown key (typo against the `forms` array) throws at construction too.

## Where to next

- [`injectForm`](/docs/cross-cutting-state/inject-form) — single-form sharing across a tree; orthogonal to multi-step.
- [Undo & redo](/docs/cross-cutting-state/undo-redo) — works per-step; each form keeps its own history chain.
- [The validation lifecycle](/docs/validation/lifecycle) — each step's `validate` / `validateAsync` / `process` flows through the stepper's status aggregation.
