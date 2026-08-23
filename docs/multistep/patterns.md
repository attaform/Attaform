---
title: Patterns
description: Idiomatic wizard patterns. Linear flows, branching function slots, dynamic terminals, active-step persistence, per-step undo. Small primitives composed through the steps array, no library-side magic.
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
    value: undo follows each form
---

# Patterns

> Each step of a wizard is a regular `useForm` call. The wizard is a thin orchestrator over the `steps` array. Linear flows, branching graphs, dynamic terminals, active-step persistence, and per-step undo all compose through the same primitives the rest of Attaform exposes, without special wizard knobs.

::docs-meta-table
::

## Linear wizards

The default shape: a list of forms in reading order. `wizard.next()` advances and `wizard.back()` retreats; neither validates (navigation and submission are separate verbs). Out-of-bounds calls dev-warn and no-op.

```ts
import { useForm, useWizard } from 'attaform'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard({ steps: [account, profile, review] })
```

To advance only when the active step is valid, reach for `wizard.tryNext()`. It validates the active step and advances on a clean pass, binding straight to the button:

```vue
<button v-if="wizard.canAdvance" @click="wizard.tryNext()">Next</button>
```

For custom valid or invalid handling, compose the active step's submit with `next()` instead. `wizard.activeForm` is a live view of the current step, so one `const` captured here stays correct on every step:

```ts
const onNext = wizard.activeForm.handleSubmit(() => wizard.next())
```

For a non-blocking flow (autosave, deferring the error waterfall to the final submit), wire the button to plain `wizard.next()` instead.

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
import { useForm, useWizard } from 'attaform'
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

## Hard prerequisites

Some steps are not just data to gather, they are a gate: a terms acceptance, an eligibility check, a consent every later step depends on. Wrap the step in [`gate()`](/docs/multistep/gate) and Attaform seals everything after it until the gate clears.

::docs-demo{slug="consent-gate" label="Consent gate"}
::

```ts
const consentSchema = z.object({ accepted: z.literal(true) })
const consent = useForm({
  schema: consentSchema,
  defaultValues: { accepted: false },
  key: 'consent',
})

const wizard = useWizard({ steps: [gate(consent), shipping, payment] })
```

A gate clears on the wrapped form's clean submit, never the moment a value goes valid, so checking the consent box does not open the rail: confirming it does. Until then every downstream step is frozen through the [`disabled`](/docs/cross-cutting-state/disabled) data freeze and unreachable, so a deep link, the browser back button, or a stray `goTo` all redirect to the gate. The guarantee lives in the data, not in a navigation guard, so nothing routes around it. See [`gate`](/docs/multistep/gate) for the full model: conditional gates, affordance gates, and restoring a confirmed prerequisite through `defaultStatuses`.

## Persisting the active step

What the wizard persists is the active step, via `?step=<key>` on the URL by default (see [URL sync](/docs/multistep/url-sync)). A refresh lands the user back on the step they were on, with the navigation cursor intact.

```ts
const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard({ steps: [account, profile, review] })
```

## Per-step undo

Same composition: each step gets its own `history` chain.

```ts
import { historyPlugin } from 'attaform/history'

const cargo = useForm({
  schema: cargoSchema,
  key: 'cargo',
  history: historyPlugin(), // default 128-position chain for the cargo step
})

const billing = useForm({
  schema: billingSchema,
  key: 'billing',
  history: historyPlugin({ max: 25 }), // tighter cap
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

`wizard.activeForm` is a live view of the current step's form, so undo / redo always dispatches to the active chain. It is no longer identity-equal to `wizard.forms[wizard.currentStep]`; reach for that record when you need a specific step's raw handle.

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
- [Undo & redo](/docs/cross-cutting-state/undo-redo) for the per-form history chain.
