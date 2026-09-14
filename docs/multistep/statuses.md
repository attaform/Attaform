---
title: Statuses
description: wizard.statuses is a per-step FormStatus rollup (valid, dirty, submitted, errorCount, locked, gate) for rails, locks, and summaries. Read it drillably, snapshot it, or seed it with defaultStatuses.
metaRows:
  - label: Category
    value: Reactive surface
  - label: Shape
    value: '{ valid, dirty, submitted, errorCount, locked, gate }'
    kind: code
  - label: Read patterns
    value: 'drillable · callable · called with a key'
  - label: Seeding
    value: 'defaultStatuses (object, sync factory, async factory)'
    kind: code
---

# Statuses

> `wizard.statuses` is a per-step `FormStatus` rollup that mirrors each form's `meta`. Read it drillably for templates, call it for a snapshot, or seed it up-front with `defaultStatuses` for resume flows that need to render filled rails before per-form data lands.

::docs-meta-table
::

## The `FormStatus` shape

```ts
type FormStatus = {
  readonly valid: boolean
  readonly dirty: boolean
  readonly submitted: boolean
  readonly errorCount: number
  readonly locked: boolean
  readonly gate: 'cleared' | 'uncleared' | null
}
```

The first four track the per-step form's `meta`, so a step's status flips when its meta does. They are deliberately small: they're what step indicators, navigation gates, and submit summaries reach for.

The last two are the wizard's own, and they overlay whatever the four `meta` scalars resolve to:

- `locked` is `true` when the step sits behind an earlier uncleared [`gate()`](/docs/multistep/gate), so it is sealed. That is the boolean a rail binds to `:disabled`.
- `gate` is the step's own role as a prerequisite: `null` unless the step compiles to a `gate()`, then `'uncleared'` until its member form submits clean and `'cleared'` after.

The two are independent axes. The first uncleared gate reads `gate: 'uncleared'` with `locked: false`, because you have to reach a gate to clear it.

One thing `submitted` does not track: a whole-wizard [`wizard.handleSubmit`](/docs/multistep/handle-submit) leaves every step's `submitted` alone. It validates each form rather than submitting it, so the flag stays `false` even on a clean finish. `wizard.done` is the read for "the wizard finished"; `submitted` answers the narrower "did this step's own `handleSubmit` succeed".

## Reading patterns

`wizard.statuses` is both a drillable record and a callable accessor. Same data, three call shapes:

```ts
import { useForm, useWizard } from 'attaform'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })

const wizard = useWizard({ steps: [account, profile] })

wizard.statuses // drillable record
wizard.statuses() // { 'signup-account': FormStatus, 'signup-profile': FormStatus }
wizard.statuses('signup-account') // FormStatus for one step
wizard.statuses['signup-account'] // FormStatus for one step (drillable)
wizard.statuses['signup-account'].valid // boolean
```

The drillable form is the template-friendly read; the callable form is convenient in script for one-off reads or destructured snapshots.

## Status rails

The classic use case is a step indicator: one dot per form, painted with its current state. `wizard.steps` walks the compiled positions; `wizard.statuses[step.key]` reads each one's status:

```vue
<script setup lang="ts">
  import { useForm, useWizard } from 'attaform'

  const wizard = useWizard({ steps: [account, profile, review] })
</script>

<template>
  <ol class="wizard-rail">
    <li v-for="step in wizard.steps" :key="step.key">
      <span
        class="dot"
        :class="{
          done: wizard.statuses[step.key].valid,
          dirty: wizard.statuses[step.key].dirty,
          current: wizard.currentStep === step.key,
        }"
      />
      {{ step.key }}
    </li>
  </ol>
</template>
```

Affordance steps (bare-string slots) carry an always-valid status, so the rail can paint every position without special-casing them. See [Step slots](/docs/multistep/step-slots) for the affordance-slot story.

## Seeding with `defaultStatuses`

Resume flows (e-commerce checkouts reopened mid-purchase, partially-completed onboarding, draft restore) often need to render filled rails before any per-form data has loaded. The `defaultStatuses` option seeds `wizard.statuses` up-front. Three shapes mirror the `defaultValues` trichotomy.

A plain object for compile-time-known seeds:

```ts
const wizard = useWizard({
  steps: [account, profile, review],
  defaultStatuses: {
    'signup-account': { valid: true, dirty: false, submitted: true, errorCount: 0 },
    'signup-profile': { valid: false, dirty: true, submitted: false, errorCount: 1 },
    'signup-review': { valid: false, dirty: false, submitted: false, errorCount: 0 },
  },
})
```

A sync factory for seeds derived from synchronous state (a draft snapshot in a Pinia store, a URL parameter, a cookie):

```ts
const wizard = useWizard({
  steps: [account, profile, review],
  defaultStatuses: () => buildStatusesFromDraft(draftStore.snapshot),
})
```

An async factory for seeds that need a server round-trip (saved flow state, a server-rendered status payload):

```ts
const wizard = useWizard({
  steps: [account, profile, review],
  defaultStatuses: async () => fetchSavedFlowStatuses(userId),
})
```

The seed fills in until the real form data lands. Resolution priority per step:

1. The step's form has `defaultsResolved === true` (its async / sync defaults have settled). Status derives from `form.meta`.
2. The step is an affordance (noop form). The built-in always-valid status renders.
3. The step has a seed entry from `defaultStatuses`. The seed value renders.
4. Otherwise, a pending status renders (`valid: false, dirty: false, submitted: false, errorCount: 0`).

`locked` and `gate` sit outside that ladder. Both are derived live from the wizard's gate state and overlaid on whichever branch resolves, so a sealed step reads `locked: true` whether its status came from `meta`, from the seed, or from the pending sentinel.

A seed entry is a `FormStatusSeed`, which is looser than the `FormStatus` you read back. Every field is optional, and an omitted one falls back to the pending sentinel rather than to the form's live meta, so seed the fields you actually know. `locked` is not accepted at all, since it is derived. `gate` is accepted but write-only: `{ gate: 'cleared' }` latches a gate cleared once at construction, and every later read comes from the live overlay. See [`gate`](/docs/multistep/gate#reading-the-gate-role) for that round trip.

Unknown keys in the seed object dev-warn at construction; the wizard ignores them. Known keys still apply, so a partial seed is fine.

## Reacting to status changes

`wizard.statuses` is reactive, so Vue's `watch` is the right tool for one-off side effects (analytics, autosave, a celebration toast when the last step flips valid). The status proxy plugs into Vue's reactivity the same way `form.meta` does:

```ts
import { watch } from 'vue'
import { useForm, useWizard } from 'attaform'

const wizard = useWizard({ steps: [account, profile, review] })

watch(
  () => wizard.statuses['signup-profile'].valid,
  (isValid) => {
    if (isValid) analytics.track('profile_complete', { user: userId })
  }
)
```

For a whole-wizard sweep, watch the callable form and diff against the previous snapshot:

```ts
watch(
  () => wizard.statuses(),
  (next, prev) => {
    for (const [key, status] of Object.entries(next)) {
      if (status.valid && !prev[key]?.valid) {
        analytics.track('step_valid', { key })
      }
    }
  },
  { deep: true }
)
```

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the wizard's full reactive surface.
- [Aggregates](/docs/multistep/aggregates) for `wizard.allValues` and `wizard.allErrors`.
- [handleSubmit](/docs/multistep/handle-submit) for the submission pipeline that flips per-form `submitted`.
