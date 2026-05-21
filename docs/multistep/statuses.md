---
title: Statuses
description: wizard.statuses exposes per-step FormStatus (valid, dirty, submitted, errorCount) without activating dormant forms. Seed statuses up-front for resumable wizards and observe changes via onStatusChange.
metaRows:
  - label: Shape
    value: '{ valid, dirty, submitted, errorCount }'
    kind: code
  - label: Read patterns
    value: drillable, callable, called with a key
  - label: Pre-resolve
    value: defaultStatuses + onStatusChange
    kind: code
---

# Statuses

> `wizard.statuses` is a per-step `FormStatus` surface that mirrors `form.meta` for each participating step. Reading a step's status never activates that step's `defaultValues` factory, so the wizard's rail and progress UI render without firing dormant work.

::docs-meta-table
::

## The `FormStatus` shape

```ts
type FormStatus = {
  readonly valid: boolean
  readonly dirty: boolean
  readonly submitted: boolean
  readonly errorCount: number
}
```

Each field tracks the per-step form's `meta`. A step's status flips when its meta does. The four scalars are deliberately small — they're what step indicators, navigation gates, and submit summaries reach for.

## Three call forms

```ts
import { useForm, useWizard } from 'attaform/zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const wizard = useWizard([account, profile] as const)

wizard.statuses // the whole proxy
wizard.statuses() // { 'signup-account': FormStatus, 'signup-profile': FormStatus }
wizard.statuses('signup-account') // FormStatus for one step
wizard.statuses['signup-account'] // FormStatus for one step (drillable)
wizard.statuses['signup-account'].valid // boolean
```

The drillable form is the template-friendly read; the callable form is convenient in script for one-off reads or destructured snapshots.

## Status rails without thrashing

Reading `wizard.statuses['signup-profile'].valid` does NOT activate the `signup-profile` form. The aggregator gates on each form's `defaultsResolved`:

```vue
<script setup lang="ts">
  const wizard = useWizard([account, profile, review] as const)
</script>

<template>
  <ol class="wizard-rail">
    <li v-for="form in wizard.forms" :key="form.key">
      <span
        class="dot"
        :class="{
          done: wizard.statuses[form.key].valid,
          dirty: wizard.statuses[form.key].dirty,
        }"
      />
      {{ form.key }}
    </li>
  </ol>
</template>
```

A step that has not yet been activated reports the pending sentinel (`valid: false`, `dirty: false`, `submitted: false`, `errorCount: 0`) instead of firing its `defaultValues` factory. The rail can render every step's dot without forcing every step's async data to load.

See [lazy activation](/docs/multistep/lazy-activation) for the full activation rule.

## Seeding statuses up-front (`defaultStatuses`)

For resumable wizards (server-sent step status, draft-restore flows, e-commerce checkouts that reopen mid-flow), `defaultStatuses` seeds `wizard.statuses[key]` BEFORE the per-form meta becomes live. Three shapes mirror `defaultValues`:

```ts
import { useWizard } from 'attaform/zod'

const wizard = useWizard([account, profile, review] as const, {
  defaultStatuses: {
    'signup-account': { valid: true, dirty: false, submitted: true, errorCount: 0 },
    'signup-profile': { valid: false, dirty: true, submitted: false, errorCount: 1 },
    'signup-review': { valid: false, dirty: false, submitted: false, errorCount: 0 },
  },
})
```

Or a sync factory:

```ts
const wizard = useWizard([account, profile, review] as const, {
  defaultStatuses: () => buildStatusesFromDraft(draftStore.snapshot),
})
```

Or an async factory:

```ts
const wizard = useWizard([account, profile, review] as const, {
  defaultStatuses: async () => fetchSavedFlowStatuses(userId),
})
```

Resolution priority per step:

1. The step's form has `defaultsResolved === true` (its async / sync default settled). Status derives from `form.meta`.
2. The step has a seed entry from `defaultStatuses`. The seed value renders.
3. Otherwise, the pending sentinel renders.

Unknown keys in the seed object dev-warn and are ignored. Known keys still apply.

## Reacting to changes (`onStatusChange`)

`onStatusChange` fires whenever a participating form's `valid`, `dirty`, `submitted`, or `errorCount` materially changes. The handler receives the new status and the form whose status changed:

```ts
const wizard = useWizard([account, profile, review] as const, {
  onStatusChange: (status, form) => {
    analytics.track('wizard_step_status', {
      key: form.key,
      valid: status.valid,
      errorCount: status.errorCount,
    })
  },
})
```

Fire-and-forget. A returned promise is not awaited. The handler is naturally dampened: identical writes don't re-fire.

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for navigation and `activeForm`.
- [Aggregates](/docs/multistep/aggregates) for `allValues` and `allErrors`.
- [Lazy activation](/docs/multistep/lazy-activation) for why dormant forms stay quiet.
