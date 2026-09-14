---
title: Aggregates
description: wizard.allValues, wizard.allErrors, and wizard.forms expose state for review screens, summary panels, and final-submit aggregation. Each is a record keyed by step key, drillable into the form.
metaRows:
  - label: Category
    value: Reactive surface
  - label: Values
    value: 'wizard.allValues[key]'
    kind: code
  - label: Errors
    value: 'wizard.allErrors[key]: WizardAggregateError[]'
    kind: code
  - label: Forms
    value: 'wizard.forms[key]: typed form handle'
    kind: code
---

# Aggregates

> `wizard.allValues` and `wizard.allErrors` are records keyed by step key, ready for review screens and error-summary panels. `wizard.forms` is the typed record of every form in the compiled list. The three surfaces share one shape and one read pattern: indexable, drillable, and reactive end-to-end.

::docs-meta-table
::

## Reading every step on a review screen

The final step of a wizard often shows everything the user entered, gated behind a confirm-and-submit button. Both cross-step surfaces are keyed by step key, and which one you reach for comes down to whether you are naming a field or handling the whole payload:

```ts
import { useForm, useWizard } from 'attaform'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email(), name: z.string().min(1) })
const profileSchema = z.object({ city: z.string(), country: z.string() })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard({ steps: [account, profile, review] })
```

```vue
<template>
  <section v-if="wizard.currentStep === 'signup-review'">
    <h2>Review</h2>
    <dl>
      <dt>Email</dt>
      <dd>{{ wizard.forms['signup-account'].values.email }}</dd>
      <dt>Name</dt>
      <dd>{{ wizard.forms['signup-account'].values.name }}</dd>
      <dt>City</dt>
      <dd>{{ wizard.forms['signup-profile'].values.city }}</dd>
      <dt>Country</dt>
      <dd>{{ wizard.forms['signup-profile'].values.country }}</dd>
    </dl>
    <label>
      <input v-register="review.register('tos')" type="checkbox" />
      I agree
    </label>
  </section>
</template>
```

Naming a field is a typed read, so it goes through `wizard.forms`, which threads each statically-known slot's schema into the record. `wizard.forms['signup-account'].values.email` is a `string`, and a typo in either the step key or the field name is a compile error. The read is reactive end to end: edits on earlier steps reflect in the review screen without a round trip. Holding the form ref and drilling through it directly (`account.values.email`) types identically, so reach for whichever is in scope.

`wizard.allValues` is the same data shaped for the other job: one namespaced object carrying every step, ready to hand onward or walk generically.

```ts
await api.saveDraft(wizard.allValues) // the whole flow in one payload

for (const [stepKey, values] of Object.entries(wizard.allValues)) {
  logger.debug(stepKey, values)
}
```

Each entry is typed `unknown`, because the wizard does not thread every step's schema through the aggregate. That is the trade: `allValues` stays uniform across steps the compiler cannot see (function and `lazy()` slots resolve at runtime), so it is the surface for handling the payload whole rather than for drilling into a known field. Affordance positions contribute empty objects under their key, so walking the record stays safe even when the flow mixes collection and affordance steps.

## `forms` for typed cross-step access

`wizard.forms` is the typed record of every form in the compiled list. Statically-known form slots contribute their concrete form type to the record; runtime-resolved positions (function slots, `lazy()` slots) fall under the catch-all `AnyForm` signature.

```ts
const wizard = useWizard({ steps: [account, profile, review] })

// account / profile / review keys typed to their concrete form refs:
wizard.forms['signup-account'].values.email // typed string
wizard.forms['signup-profile'].fields.city.showErrors // typed boolean

// Function-slot positions: AnyForm fallback.
wizard.forms['runtime-resolved-key'].values // typed unknown
```

The `forms` record is the right surface for cross-component reads. A floating-finish-button component reaches `wizard.forms[key]` to inspect any step's state, and the form handle that comes back is identity-equal to the original `useForm` ref. Mutations on one are observable on the other.

## `allErrors` for wizard-wide summaries

`wizard.allErrors` is a record keyed by step key. Each value is the flat list of `WizardAggregateError` entries that step has produced:

```ts
type WizardAggregateError = {
  readonly formKey: FormKey
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  readonly code?: string
}

type AllErrors = Readonly<Record<FormKey, readonly WizardAggregateError[]>>
```

Each entry carries `formKey` and `path` so a wizard-wide summary panel can route a click back to the offending field. Empty steps and unresolved steps contribute empty arrays under their key, keeping the record uniform.

For a wizard-wide summary, flatten the record into one array and render the union:

```vue
<script setup lang="ts">
  import { computed } from 'vue'

  const wizard = useWizard({ steps: [account, profile, review] })

  const flatErrors = computed(() => Object.values(wizard.allErrors).flat())
</script>

<template>
  <aside v-if="flatErrors.length > 0" class="error-summary">
    <h3>Fix {{ flatErrors.length }} issue(s) before continuing</h3>
    <ul>
      <li v-for="err in flatErrors" :key="`${err.formKey}-${err.path.join('.')}`">
        <button type="button" @click="wizard.goTo(err.formKey)">
          {{ err.message }} ({{ err.formKey }} · {{ err.path.join('.') }})
        </button>
      </li>
    </ul>
  </aside>
</template>
```

A click on any summary row jumps the wizard to the step that produced the error. The consumer wires the focus / scroll behavior from there (see `wizard.activeForm.focusField()` on the form handle).

For a per-step summary, index into the record directly:

```vue
<template>
  <aside v-if="(wizard.allErrors['signup-profile']?.length ?? 0) > 0">
    <h3>Profile step has {{ wizard.allErrors['signup-profile'].length }} issue(s)</h3>
  </aside>
</template>
```

## What contributes to the aggregates

Each surface walks the compiled step list:

- `allValues[key]` is the form's live `values` proxy. Edits land immediately.
- `allErrors[key]` is the form's `meta.errors`, rebuilt as `WizardAggregateError` entries with `formKey` stamped on. A form whose defaults are still resolving contributes an empty array.
- `forms[key]` is the form handle itself, identity-equal to the original `useForm` ref.

Nothing has to submit for `allErrors` to fill. It mirrors each form's live `meta.errors`, so entries appear on whatever cadence that step's [`validateOn`](/docs/validation/when-validation-runs) sets: under the default `'change'`, a single bad keystroke on step one lands in the aggregate while the user is still typing, with `wizard.submissionAttempts` at zero. Errors you set by hand with `form.setErrors` show up the same way, since `meta.errors` is the merged read.

That makes the aggregate a live picture rather than a submission report, which is what a persistent summary panel wants. If you would rather hold the panel back until the user has actually tried to finish, gate it on `wizard.submissionAttempts > 0` yourself. A [`wizard.handleSubmit`](/docs/multistep/handle-submit) pass still contributes: it validates every step, including ones the user never opened, so it is what fills the aggregate for steps no keystroke has reached.

## `wizard.submissionAttempts` vs per-form attempts

Each form keeps its own `meta.submissionAttempts`, incremented by `wizard.handleSubmit` for every form, since it always validates the whole step list. A gated Next built on `wizard.activeForm.handleSubmit(...)` bumps only the active form. The wizard-level `wizard.submissionAttempts` increments once per `handleSubmit` invocation, regardless of how many forms were involved. For "did the user submit the wizard?" reach for `wizard.submissionAttempts`; for "has the user tried this step?" reach for the form's own `meta.submissionAttempts`.

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for navigation and `activeForm`.
- [Statuses](/docs/multistep/statuses) for the per-step `FormStatus` rollup that feeds rails and progress.
- [handleSubmit](/docs/multistep/handle-submit) for the submission pipeline that populates `allErrors`.
