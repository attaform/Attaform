---
title: Patterns
description: Idiomatic wizard patterns. Linear vs branching flows, conditional steps, per-step persistence, per-step undo. Small primitives composed without library-side magic.
metaRows:
  - label: Linear
    value: 'next() / back() walks forms in order'
  - label: Branching
    value: 'goTo(key) skips ahead based on values'
    kind: code
  - label: Per-step
    value: persistence + undo follow each form
---

# Patterns

> Each step of a wizard is a regular `useForm` call. The wizard is a thin orchestrator. Branching, conditional steps, per-step persistence, and per-step undo all come from the form-level primitives composing through the wizard, not from special wizard knobs.

::docs-meta-table
::

## Linear wizards

The default shape: walk the forms array in order. `wizard.next()` advances; `wizard.back()` retreats. Out-of-bounds calls dev-warn and no-op.

```ts
import { useForm, useWizard } from 'attaform/zod'

const accountSchema = z.object({ email: z.email() })
const profileSchema = z.object({ name: z.string().min(1) })
const reviewSchema = z.object({ tos: z.literal(true) })

const account = useForm({ schema: accountSchema, key: 'signup-account' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile' })
const review = useForm({ schema: reviewSchema, key: 'signup-review' })

const wizard = useWizard([account, profile, review] as const)

function onAccountNext(): void {
  account.handleSubmit(() => wizard.next())()
}
```

Each step gates on its own `form.handleSubmit` to advance: validation fails locally on the active step, then the wizard advances.

## Branching wizards

Use `wizard.goTo(key)` to jump past a step based on the active step's values:

```ts
function onAccountNext(): void {
  account.handleSubmit((data) => {
    if (data.email.endsWith('@enterprise.com')) {
      wizard.goTo('signup-review')
    } else {
      wizard.next()
    }
  })()
}
```

Enterprise users skip the consumer-profile step. Reading `data.email` inside `handleSubmit` is the type-safe path (the callback receives parsed values).

A branching wizard's `wizard.current` still walks the actual visited steps. The browser history stack records each `goTo` push so the back button returns through the visited path, not the array order.

## Conditional steps

Two idiomatic shapes:

### Filter the forms array

If a step doesn't apply for the entire flow, omit it from the array:

```ts
const visible = computed(() =>
  user.value.kind === 'organisation' ? [account, organisation, review] : [account, profile, review]
)
const wizard = useWizard(visible.value as const)
```

This is the right shape when the step's applicability is determined at wizard-construction time. The wizard never sees the omitted form, so `wizard.statuses`, `wizard.allValues`, and `wizard.allErrors` reflect only the visible steps.

### Skip with `goTo`

If applicability depends on values entered during the flow, keep the step in the array and skip it conditionally:

```ts
function onAccountNext(): void {
  account.handleSubmit((data) => {
    if (data.kind === 'organisation') {
      wizard.goTo('signup-organisation')
    } else {
      wizard.goTo('signup-profile')
    }
  })()
}
```

The skipped step's form still exists. The aggregator gates on `defaultsResolved`, so a skipped step contributes `PENDING_STATUS` to `wizard.statuses` and nothing to `wizard.allErrors` until something activates it.

## Per-step persistence

Each step is its own `useForm` call, so each step gets its own `persist` config:

```ts
const account = useForm({
  schema: accountSchema,
  key: 'signup-account',
  persist: 'local', // localStorage, namespaced by key
})

const profile = useForm({
  schema: profileSchema,
  key: 'signup-profile',
  persist: 'session', // sessionStorage, separate from account
})

const review = useForm({
  schema: reviewSchema,
  key: 'signup-review',
  // No persist; sensitive consent stays in-memory only
})

const wizard = useWizard([account, profile, review] as const)
```

`account` and `profile` survive a refresh; `review` doesn't. The wizard itself doesn't persist. `?step=<key>` in the URL is the wizard's own restore mechanism (see [Browser history](/docs/multistep/history)).

Sensitive-name protection applies per-form: `password` / `creditCard` / `ssn` leaves never persist regardless of the per-step `persist` setting.

## Per-step undo

Same shape: each step gets its own `history` chain:

```ts
const cargoForm = useForm({
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

`wizard.activeForm` is identity-equal to the matching entry in `wizard.forms`, so undo / redo dispatch goes to the right form's history.

Each step's history is independent. Undoing in the `cargo` step does not retreat changes made earlier in the `account` step. That matches user expectation: "undo what I just typed here."

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for the navigation surface and `activeForm`.
- [Browser history](/docs/multistep/history) for wizard-level URL round-tripping.
- [Per-field opt-in](/docs/persistence/per-field-opt-in) for the per-form persistence story.
- [Undo & redo](/docs/cross-cutting-state/undo-redo) for the per-form history chain.
