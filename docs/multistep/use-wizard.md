---
title: useWizard
description: useWizard composes multiple useForm calls into a reactive wizard. Active form, statuses per step, aggregate errors, navigation methods, and a progress fraction. Each step keeps its own schema and reactive surface.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'useWizard(forms, options?)'
    kind: code
  - label: Per-step
    value: each form keeps its own schema, history, persistence
  - label: Aggregates
    value: statuses · allErrors · progress
    kind: code
---

# useWizard

> Compose multiple `useForm` calls into a reactive wizard. `useWizard` orchestrates navigation and exposes aggregate status without entangling the per-step schemas.

::docs-meta-table
::

Three small `useForm` calls (account, profile, review) feed into one `useWizard`. The progress bar reflects `wizard.progress` (the fraction of valid steps), the rail highlights `wizard.current`, and each step's form keeps its own schema and reactive surface. Tap **Next** / **Back** to walk the chain; the **Finish** button fires on the last step.

::docs-demo{slug="use-wizard" label="Wizard Demo"}
::

## The composition

```ts
import { useForm, useWizard } from 'attaform/zod'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email(), password: z.string().min(8) })
const profileSchema = z.object({ name: z.string().min(1), city: z.string() })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({
  schema: reviewSchema,
  defaultValues: { tos: false },
  key: 'signup-review',
})

const wizard = useWizard([account, profile, review] as const)
```

Each step is its own form. Schemas, default values, persistence, history, all per-step. The wizard is a thin orchestrator over them; it does not own values, errors, or validation.

## The return shape

```ts
type UseWizardReturnType<Forms> = {
  readonly current: KeysOf<Forms> | undefined
  readonly activeForm: Forms[number] | undefined
  readonly activeIndex: number
  readonly forms: Forms
  readonly count: number
  readonly statuses: WizardStatusesProxy<Statuses<Forms>>
  readonly allValues: AllValues<Forms>
  readonly allErrors: readonly AggregateError[]
  readonly progress: number
  readonly next: (options?: WizardNavOptions) => void
  readonly back: (options?: WizardNavOptions) => void
  readonly goTo: (key: KeysOf<Forms>, options?: WizardNavOptions) => void
}
```

| Member                   | What it is                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `current`                | The active step's key (or `undefined` if the wizard is empty). Reactive via a getter, so templates branch on it directly.  |
| `activeForm`             | The active step's form handle, identity-equal to the matching entry in `forms`. `undefined` when `current` is `undefined`. |
| `activeIndex`            | Zero-based index of the active step. `-1` when the wizard is empty.                                                        |
| `forms`                  | The `forms` array you passed in. Iterate it for a rail or table of contents.                                               |
| `count`                  | Number of participating steps. Handy for "Step N of M" labels.                                                             |
| `statuses`               | Drillable proxy of `FormStatus` per step (`valid`, `dirty`, `submitted`, `errorCount`).                                    |
| `allValues`              | Drillable record of every step's `values` keyed by form key.                                                               |
| `allErrors`              | Cross-step `AggregateError[]` for a wizard-wide summary. Dormant (unactivated) steps contribute nothing.                   |
| `progress`               | Fraction in `[0, 1]`. Count of valid steps divided by total steps, or the consumer's `progress` override.                  |
| `next` / `back` / `goTo` | Navigation. `goTo(key)` jumps to an arbitrary step by its form's key.                                                      |

Every reactive read is a plain getter, no `.value`. `wizard.current`, `wizard.progress`, `wizard.allErrors` stay reactive inside templates and `computed` blocks directly, matching the rest of Attaform (`form.values`, `form.meta`, etc.).

## `statuses`: how to read it

```ts
wizard.statuses // the whole proxy
wizard.statuses() // → { 'signup-account': FormStatus, 'signup-profile': FormStatus, 'signup-review': FormStatus }
wizard.statuses('signup-account') // → FormStatus for one step
wizard.statuses['signup-account'] // → FormStatus (drillable read)
wizard.statuses['signup-account'].valid // → boolean (reactive)
```

The drillable read is the template-friendly form; the callable form is convenient in script for one-off reads.

`FormStatus` carries `valid`, `dirty`, `submitted`, and `errorCount`. The aggregator gates on each form's `defaultsResolved` so reading a status for a not-yet-activated step returns a pending `FormStatus` without firing that step's factory. The rail can render without thrashing.

## Navigation

```ts
wizard.next() // step forward one
wizard.back() // step back one
wizard.goTo('profile') // jump to a specific step by key
```

`WizardNavOptions` carries `replace?: boolean` for history-replace semantics; see [Browser history](/docs/multistep/history) for the round-trip. Omit it for ordinary navigation. Out-of-bounds calls dev-warn and no-op:

- `next()` on the last step.
- `back()` on the first step.
- `goTo(key)` with a key not in the `forms` array.

The wizard never throws on navigation or construction. Wired into someone's checkout, Attaform bends rather than crashing the surrounding app.

## Active form

`wizard.activeForm` is the per-step form handle for the active step, identity-equal to the matching entry in `wizard.forms`. Reach for the active step's reactive surface without indexing by key:

```vue
<script setup lang="ts">
  const wizard = useWizard([account, profile, review] as const)
</script>

<template>
  <form v-if="wizard.activeForm" @submit.prevent="wizard.activeForm.handleSubmit(onSubmit)()">
    <h2>Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}</h2>
    <input v-register="wizard.activeForm.register('email')" />
  </form>
</template>
```

`wizard.activeIndex` pairs with the index for "Step N of M" labels, progress dots, and per-step rails.

## Aggregate errors

`wizard.allErrors` flattens every activated step's errors into one array, in wizard order then per-form order. Each entry carries the originating form's key. Link back to the source field from a wizard-wide summary:

```vue
<template>
  <ul class="wizard-errors">
    <li v-for="err in wizard.allErrors" :key="`${err.formKey}-${err.path.join('.')}`">
      <a :href="`#${err.formKey}`">{{ err.message }}</a>
    </li>
  </ul>
</template>
```

Steps that have not been activated contribute nothing to `allErrors`. That keeps the [privacy invariant](/docs/multistep/ssr#the-stated-invariant) intact: a non-current step with an async `defaultValues` factory will not fire on the server just because the consumer reads the summary list.

## Degenerate inputs

Conditions that used to throw at construction now dev-warn and degrade:

- **Empty `forms` array.** `wizard.count` is `0`, `current` is `undefined`, every navigation method is a no-op with a dev-warn.
- **A form with `key: ''`.** Filtered out of the participating set; dev-warn names the dropped count.
- **Duplicate keys.** First occurrence wins; dev-warn lists the dropped keys.
- **`defaultStatuses` with an unknown key.** The unknown entry is ignored; the known entries still apply.

A wizard wired into someone's signup or checkout never crashes the surrounding app for shapes that are clearly a mistake. The dev-warn surfaces the problem; the wizard either filters the bad input or returns a no-op handle, depending on the case.

## Where to next

- [`injectForm`](/docs/cross-cutting-state/inject-form) for single-form sharing across a tree; orthogonal to multistep.
- [Undo & redo](/docs/cross-cutting-state/undo-redo) works per-step; each form keeps its own history chain.
- [The validation lifecycle](/docs/validation/lifecycle) walks each step's `validate`, `validateAsync`, and `process` paths and how they flow through the wizard's status aggregation.
