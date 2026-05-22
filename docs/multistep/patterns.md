---
title: Patterns
description: Idiomatic wizard patterns. Linear flows, branching graphs, dynamic terminals, per-step persistence, per-step undo. Small primitives composed without library-side magic.
metaRows:
  - label: Linear
    value: 'next: someForm (identity ref)'
    kind: code
  - label: Branching
    value: 'next: { pick, forms }'
    kind: code
  - label: Per-step
    value: persistence + undo follow each form
---

# Patterns

> Each step of a wizard is a regular `useForm` call. The wizard is a thin orchestrator. Branching, dynamic terminals, per-step persistence, and per-step undo all come from the form-level primitives composing through the wizard, not from special wizard knobs.

::docs-meta-table
::

## Linear wizards

The default shape: a chain of identity-ref `next` declarations. `wizard.next()` validates the active step before advancing; `wizard.back()` retreats. Out-of-bounds calls dev-warn and no-op.

```ts
import { useForm, useWizard } from 'attaform/zod'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })
const reviewSchema = z.object({ tos: z.literal(true) })

const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile', next: review })
const account = useForm({ schema: accountSchema, key: 'signup-account', next: profile })

const wizard = useWizard(account)
```

Declare terminal-first, entry-last. `wizard.next()` validates the active form for you, so the template wires straight to it:

```vue
<button v-if="wizard.canAdvance" @click="wizard.next()">Next</button>
```

## Branching wizards

When the active step's parsed values determine which form is next, use the structured `next` shape. The `pick` callback runs against `z.output<typeof schema>`:

```ts
const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const userProfile = useForm({ schema: userProfileSchema, key: 'signup-user', next: review })
const orgProfile = useForm({ schema: orgSchema, key: 'signup-org', next: review })

const accountSchema = z.object({ kind: z.enum(['user', 'organization']) })
const account = useForm({
  schema: accountSchema,
  key: 'signup-account',
  next: {
    pick: (parsed) => (parsed.kind === 'organization' ? orgProfile : userProfile),
    forms: [orgProfile, userProfile] as const,
  },
})

const wizard = useWizard(account)
```

The `forms` tuple is declared `as const` so TypeScript narrows `pick`'s return type to `orgProfile | userProfile | undefined`. The wizard's static analysis walks every declared branch, so `wizard.flow.allForms` enumerates `account`, `orgProfile`, `userProfile`, and `review` regardless of which path the user ends up taking.

Enterprise users skip the consumer-profile step. Reading `parsed.kind` inside `pick` is the type-safe path; the callback receives the form's parsed output, not the raw input.

A branching wizard's `wizard.current` walks the runtime path taken. The browser history stack records each navigation so the back button returns through the visited path, not the static graph order.

## Dynamic terminals with `pick(parsed) → undefined`

A `pick` callback that returns `undefined` flags the current form as a dynamic terminal. The wizard treats the active step as the runtime end of the path even though the static graph could have continued:

```ts
const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const survey = useForm({ schema: surveySchema, key: 'signup-survey', next: review })

const accountSchema = z.object({ email: z.email(), willTakeSurvey: z.boolean() })
const account = useForm({
  schema: accountSchema,
  key: 'signup-account',
  next: {
    pick: (parsed) => (parsed.willTakeSurvey ? survey : undefined),
    forms: [survey] as const,
  },
})
```

Users who decline the survey terminate at `account`; users who opt in walk through `survey` then `review`. The dynamic terminal is computed each time `wizard.next()` or `wizard.handleSubmit` consults `pick`, so a toggle change after the fact is respected on the next navigation.

## Manual jumps with `goTo`

`wizard.goTo(key)` skips the validation gate. Use it when the user explicitly clicked a rail item:

```vue
<button type="button" @click="wizard.goTo(form.key)">Jump to {{ form.key }}</button>
```

`wizard.handleSubmit` catches the upstream validation gaps that `goTo` lets through. Clicking Finish on a step the user jumped to without filling earlier forms walks the runtime path, surfaces every error, and (with `navigateToFirstError: true`, the default) goes back to the first failing step.

## Per-step persistence

Each step is its own `useForm` call, so each step gets its own `persist` config:

```ts
const review = useForm({
  schema: reviewSchema,
  key: 'signup-review',
  // No persist; sensitive consent stays in-memory only
})

const profile = useForm({
  schema: profileSchema,
  key: 'signup-profile',
  next: review,
  persist: 'session', // sessionStorage, separate from account
})

const account = useForm({
  schema: accountSchema,
  key: 'signup-account',
  next: profile,
  persist: 'local', // localStorage, namespaced by key
})

const wizard = useWizard(account)
```

`account` and `profile` survive a refresh; `review` doesn't. The wizard itself doesn't persist. `?step=<key>` in the URL is the wizard's own restore mechanism (see [Browser history](/docs/multistep/history)).

Sensitive-name protection applies per-form: `password` / `creditCard` / `ssn` leaves never persist regardless of the per-step `persist` setting.

## Per-step undo

Same shape: each step gets its own `history` chain:

```ts
const cargo = useForm({
  schema: cargoSchema,
  key: 'cargo',
  history: { limit: 25 }, // undo / redo across the cargo step
})
```

The wizard composes naturally with per-form undo. A keyboard shortcut bound to the active step:

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

`wizard.activeForm` is identity-equal to the matching entry in `wizard.allForms`, so undo / redo dispatch goes to the right form's history.

Each step's history is independent. Undoing in the `cargo` step does not retreat changes made earlier in the `account` step. That matches user expectation: "undo what I just typed here."

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for the navigation surface, `activeForm`, and `handleSubmit`.
- [`injectWizard`](/docs/multistep/inject-wizard) for cross-component access to the wizard handle.
- [Browser history](/docs/multistep/history) for wizard-level URL round-tripping.
- [Per-field opt-in](/docs/persistence/per-field-opt-in) for the per-form persistence story.
- [Undo & redo](/docs/cross-cutting-state/undo-redo) for the per-form history chain.
