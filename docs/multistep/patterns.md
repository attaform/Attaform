---
title: Patterns
description: Idiomatic wizard patterns. Linear flows, branching with function slots, dynamic terminals, per-step persistence, per-step undo. Small primitives composed through the steps array without library-side magic.
metaRows:
  - label: Category
    value: Patterns
  - label: Linear
    value: 'steps: [a, b, c]'
    kind: code
  - label: Branching
    value: '(ctx) => pickedForm | string | undefined'
    kind: code
  - label: Per-step
    value: persistence + undo follow each form
---

# Patterns

> Each step of a wizard is a regular `useForm` call. The wizard is a thin orchestrator over the `steps` array. Linear flows, branching graphs, dynamic terminals, per-step persistence, and per-step undo all compose through the same primitives the rest of Attaform exposes, without special wizard knobs.

::docs-meta-table
::

## Linear wizards

The default shape: a list of forms in reading order. `wizard.next()` validates the active step before advancing; `wizard.back()` retreats. Out-of-bounds calls dev-warn and no-op.

```ts
import { useForm, useWizard } from 'attaform/zod'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard({ steps: [account, profile, review] })
```

`wizard.next()` validates the active form for you, so the template wires straight to it:

```vue
<button v-if="wizard.canAdvance" @click="wizard.next()">Next</button>
```

Mix in affordance steps (bare strings) wherever the flow benefits from a screen that presents rather than collects:

```ts
const wizard = useWizard({
  steps: ['welcome', account, profile, 'review-summary', review, 'congrats'],
})
```

See [Step slots](/docs/multistep/step-slots) for the affordance-slot story.

## Branching wizards

When the next step depends on a live value on an earlier form, use a function slot. The slot is a `(ctx) => Form | string | undefined` callback that re-evaluates reactively as its tracked reads change:

```ts
import { useForm, useWizard } from 'attaform/zod'
import { z } from 'zod'

const accountSchema = z.object({ kind: z.enum(['user', 'organization']) })
const userProfileSchema = z.object({ name: z.string().min(1) })
const orgSchema = z.object({ orgName: z.string().min(1), seats: z.number().int().positive() })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const userProfile = useForm({ schema: userProfileSchema, key: 'signup-user' })
const orgProfile = useForm({ schema: orgSchema, key: 'signup-org' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard({
  steps: [
    account,
    (ctx) =>
      ctx.forms['signup-account'].values.kind === 'organization' ? orgProfile : userProfile,
    review,
  ],
})
```

When the user picks `'organization'` on the account step, the function slot resolves to `orgProfile`. Toggling back to `'user'` swaps the resolved form. `wizard.steps`, `wizard.forms`, `wizard.statuses`, and the progress rail all follow along.

For typed reads, close over the original form ref instead of routing through `ctx.forms`:

```ts
const wizard = useWizard({
  steps: [
    account,
    () => (account.values.kind === 'organization' ? orgProfile : userProfile), // typed!
    review,
  ],
})
```

`account.values.kind` carries the Zod-derived `'user' | 'organization'` type through the predicate, where `ctx.forms['signup-account'].values.kind` reads as `unknown`. Both work at runtime; the closed-over ref keeps the IDE happy.

## Dynamic terminals

A function slot that returns `undefined` drops its position from the compiled list. Combine that with a terminal step to get a wizard that ends early on a live condition:

```ts
const accountSchema = z.object({ email: z.email(), willTakeSurvey: z.boolean() })
const surveySchema = z.object({ rating: z.number().int().min(1).max(5) })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const survey = useForm({ schema: surveySchema, key: 'signup-survey' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard({
  steps: [account, () => (account.values.willTakeSurvey ? survey : undefined), review],
})
```

Users who decline the survey see two steps (`account`, `review`); users who opt in see three (`account`, `survey`, `review`). The function slot re-evaluates whenever `willTakeSurvey` flips, so a late toggle is respected on the next navigation. `wizard.count`, `wizard.isFinalStep`, and the progress rail recompute against the live list.

For heavier branching (a slot whose resolver is expensive enough that re-evaluating on every wizard mutation produces visible thrash), reach for [`lazy()`](/docs/multistep/step-slots#lazy-slots-lazy) instead.

## Manual jumps with `goTo`

`wizard.goTo(key)` skips the validation gate. Use it when the user explicitly clicked a rail item:

```vue
<button type="button" @click="wizard.goTo(step.key)">Jump to {{ step.key }}</button>
```

`wizard.handleSubmit` catches the upstream validation gaps that `goTo` lets through. Clicking Finish on a step the user jumped to without filling earlier forms validates everything, surfaces every error, and (with `focusFirstError: true`, the default) jumps the wizard back to the first failing step.

## Per-step persistence

Each step is its own `useForm` call, so each step gets its own `persist` config. The wizard composes naturally with whatever you wire on each form:

```ts
const account = useForm({
  schema: accountSchema,
  key: 'signup-account',
  persist: 'local', // localStorage, namespaced by key
})

const profile = useForm({
  schema: profileSchema,
  key: 'signup-profile',
  persist: 'session', // sessionStorage, separate scope from account
})

const review = useForm({
  schema: reviewSchema,
  key: 'signup-review',
  // No persist; consent stays in-memory only
})

const wizard = useWizard({ steps: [account, profile, review] })
```

`account` and `profile` survive a refresh; `review` doesn't. The wizard itself doesn't persist field state; what _it_ persists is the active step, via `?step=<key>` on the URL by default (see [URL sync](/docs/multistep/url-sync)). The two stories compose: per-form persistence keeps the field values, the wizard-level URL sync keeps the navigation cursor.

Sensitive-name protection applies per-form: `password`, `creditCard`, `ssn`, and friends never persist regardless of the per-step `persist` setting. See [Sensitive-name protection](/docs/persistence/sensitive-names).

## Per-step undo

Same composition: each step gets its own `history` chain.

```ts
const cargo = useForm({
  schema: cargoSchema,
  key: 'cargo',
  history: true, // unlimited undo / redo across the cargo step
})

const billing = useForm({
  schema: billingSchema,
  key: 'billing',
  history: { max: 25 }, // capped chain
})

const wizard = useWizard({ steps: [cargo, billing] })
```

A keyboard shortcut bound to the active step:

```vue
<script setup lang="ts">
  function onKeydown(event: KeyboardEvent) {
    if (!wizard.activeForm) return
    if (event.metaKey && event.key === 'z') {
      event.shiftKey ? wizard.activeForm.history.redo() : wizard.activeForm.history.undo()
    }
  }
</script>

<template>
  <div @keydown="onKeydown">
    <!-- step content -->
  </div>
</template>
```

`wizard.activeForm` is identity-equal to the form in `wizard.forms[wizard.currentStep]`, so undo / redo dispatches to the right chain.

Each step's history is independent: undoing on the `cargo` step doesn't retreat changes the user made on `billing`. That matches the user's mental model: "undo what I just typed here," not "undo the entire flow."

## Cross-component access

Pass a `key` to `useWizard` so a deep-tree component (a floating finish button, a sticky progress rail) can reach the same wizard without prop-threading:

```ts
const wizard = useWizard({
  steps: [account, profile, review],
  key: 'signup',
})
```

A descendant component reaches it via `injectWizard('signup')`. See [`injectWizard`](/docs/multistep/inject-wizard) for the cross-component story (ambient resolution, keyed lookup, null-on-miss).

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the navigation surface, `activeForm`, and `handleSubmit`.
- [Step slots](/docs/multistep/step-slots) for the four slot kinds (form, string, function, `lazy()`).
- [`injectWizard`](/docs/multistep/inject-wizard) for cross-component access to the wizard handle.
- [URL sync](/docs/multistep/url-sync) for wizard-level `?step=<key>` round-tripping.
- [Per-field opt-in](/docs/persistence/per-field-opt-in) for the per-form persistence story.
- [Undo & redo](/docs/cross-cutting-state/undo-redo) for the per-form history chain.
