---
title: Aggregates
description: wizard.allValues and wizard.allErrors expose cross-step values and a flat error list for review screens, summary panels, and final-submit aggregation. Dormant steps contribute nothing, so a summary read stays cheap and the wizard's render-efficiency floor holds.
metaRows:
  - label: Values
    value: 'wizard.allValues[key]'
    kind: code
  - label: Errors
    value: 'wizard.allErrors (flat AggregateError[])'
    kind: code
  - label: Dormant steps
    value: contribute nothing
---

# Aggregates

> `wizard.allValues` exposes every step's `values` proxy under its key for cross-step review screens. `wizard.allErrors` flattens every activated step's errors into one array carrying its `formKey` so a wizard-wide summary can link back to the source field.

::docs-meta-table
::

## `allValues` for review screens

The final step of a wizard often shows everything the user entered, gated behind a confirm-and-submit button. `wizard.allValues` is the cross-step read surface:

```ts
import { useForm, useWizard } from 'attaform/zod'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email(), name: z.string().min(1) })
const profileSchema = z.object({ city: z.string(), country: z.string() })
const reviewSchema = z.object({ tos: z.literal(true) })

const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile', next: review })
const account = useForm({ schema: accountSchema, key: 'signup-account', next: profile })

const wizard = useWizard(account)
```

```vue
<template>
  <section v-if="wizard.current === 'signup-review'">
    <h2>Review</h2>
    <dl>
      <dt>Email</dt>
      <dd>{{ wizard.allValues['signup-account'].email }}</dd>
      <dt>Name</dt>
      <dd>{{ wizard.allValues['signup-account'].name }}</dd>
      <dt>City</dt>
      <dd>{{ wizard.allValues['signup-profile'].city }}</dd>
      <dt>Country</dt>
      <dd>{{ wizard.allValues['signup-profile'].country }}</dd>
    </dl>
    <label>
      <input v-register="review.register('tos')" type="checkbox" />
      I agree
    </label>
  </section>
</template>
```

`wizard.allValues['signup-account'].email` proxies to the underlying form's `values.email`. The proxy is reactive: edits on earlier steps reflect in the review screen without a roundtrip.

Drilling into a step's values activates that step's `defaultValues` factory. `wizard.allValues` is the right surface for review screens because reading it expresses real consumer intent (the user is about to see this data).

## `allErrors` for wizard-wide summaries

`wizard.allErrors` is the flat list of every activated step's validation errors. Each entry carries:

```ts
type AggregateError = {
  readonly formKey: FormKey
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  readonly code?: string
}
```

Sort order: BFS order from the wizard's entry, then each form's internal error order. The shape is purpose-built for wizard-wide summary panels:

```vue
<template>
  <aside v-if="wizard.allErrors.length > 0" class="error-summary">
    <h3>Fix {{ wizard.allErrors.length }} issue(s) before continuing</h3>
    <ul>
      <li v-for="err in wizard.allErrors" :key="`${err.formKey}-${err.path.join('.')}`">
        <button type="button" @click="wizard.goTo(err.formKey)">
          {{ err.message }} ({{ err.formKey }} · {{ err.path.join('.') }})
        </button>
      </li>
    </ul>
  </aside>
</template>
```

A click on any summary row jumps the wizard to the step that produced the error. The consumer wires the focus / scroll behavior from there.

## Dormant steps contribute nothing

`wizard.allErrors` deliberately skips steps whose forms have not been activated. A non-current step with an async `defaultValues` factory does **not** fire on the server just because the consumer reads the summary list:

```ts
const wizard = useWizard(account)
// On the server, only account's factory has fired.
// wizard.allErrors only includes errors from account, not profile or review.
```

That keeps the [activation rule](/docs/multistep/ssr#the-activation-rule) in force. A summary panel rendered on the server reports the current step's errors without disturbing dormant steps, so a 40-step wizard still pays for one fetch per request.

On the client, navigating to a step activates that step's factory and its errors join the aggregate naturally.

## `FormStatus.submitted` is success-only

Each step's `FormStatus` mirrors that form's `meta.submitted`, which flips `true` only after a `handleSubmit` callback resolves without throwing. Failed submits (validation failure or callback rejection) leave it `false`. For "the user has tried this step," read each form's `meta.submissionAttempts > 0` directly. The wizard-level "user clicked Finish" signal lives on `wizard.submissionAttempts` and `wizard.complete`; see [`useWizard`](/docs/multistep/use-wizard).

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for navigation and `activeForm`.
- [Statuses](/docs/multistep/statuses) for the per-step `FormStatus` rollup that feeds rails and progress.
- [Lazy activation](/docs/multistep/lazy-activation) for why reading `allErrors` doesn't fire dormant factories.
