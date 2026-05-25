---
title: handleSubmit
description: wizard.handleSubmit(onSubmit, onError?) returns one event handler that fits every step. Intermediate calls validate the active form and advance; the final call validates every form in parallel and stays put. Same context shape on every step, with isFinal as the only differentiator.
metaRows:
  - label: Category
    value: Submission
  - label: Signature
    value: 'wizard.handleSubmit(onSubmit, onError?)'
    kind: code
  - label: Context
    value: '{ values, get(form), currentKey, isFinal }'
    kind: code
  - label: Error handler
    value: '(errors: AggregateError[]) => void | Promise<void>'
    kind: code
---

# `handleSubmit`

> `wizard.handleSubmit(onSubmit, onError?)` returns one event handler that fits every Next-and-Finish button in the wizard. Intermediate calls validate the active form and advance on success; the final call validates every form in parallel, calls `onSubmit` once, and stays on the terminal step. `isFinal` on the context is the only difference the consumer needs to switch on.

::docs-meta-table
::

## The same handler binds to every button

`wizard.handleSubmit` returns an event handler. Bind it once and reuse it for every Next button, every Finish button, and any submit-via-keyboard path:

```vue
<script setup lang="ts">
  import { useForm, useWizard } from 'attaform/zod'

  const wizard = useWizard({ steps: [shipping, payment, review] })

  const onSubmit = wizard.handleSubmit(async (ctx) => {
    if (!ctx.isFinal) return
    await api.checkout({
      shipping: ctx.get(shipping),
      payment: ctx.get(payment),
    })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <!-- step body -->
    <button :disabled="wizard.submitting" type="submit">
      {{ wizard.isFinalStep ? 'Finish' : 'Next' }}
    </button>
  </form>
</template>
```

The handler accepts an optional `Event` argument and calls `preventDefault()` when one is passed, so `@submit` and `@click` both work. Bare imperative calls (`onSubmit()` with no event) are also fine; the handler just skips the prevent step.

## The submit context

The `onSubmit` callback receives one `ctx` argument:

```ts
type WizardSubmitContext = {
  readonly values: Readonly<Record<FormKey, unknown>>
  readonly get: <F extends AnyForm>(form: F) => F extends { readonly values: infer V } ? V : unknown
  readonly currentKey: FormKey
  readonly isFinal: boolean
}
```

- `ctx.values` is the namespaced parsed payload, keyed by step key. Mirrors `wizard.allValues` for forms that validated successfully on this call. Affordance steps contribute an empty record.
- `ctx.get(formRef)` is the typed accessor: pass a form ref, get back the parsed output narrowed to that form's schema. The handy shape when you've already closed over the form refs at construction.
- `ctx.currentKey` is the key of the step that fired this submission.
- `ctx.isFinal` is `true` when `currentKey` is the last position in `wizard.steps`. Use it to fork between "advance to the next step" (nothing to do here) and "actually call the API."

```ts
const onSubmit = wizard.handleSubmit(async (ctx) => {
  if (!ctx.isFinal) {
    // Intermediate steps: wizard has already advanced; track a step-complete
    // event and let the user keep going.
    analytics.track('wizard_step_complete', { step: ctx.currentKey })
    return
  }
  // Final step: validate-everything passed, run the actual mutation.
  const order = await api.checkout({
    shipping: ctx.get(shipping),
    payment: ctx.get(payment),
  })
  router.push(`/orders/${order.id}`)
})
```

## Intermediate vs final

The two calls do different work:

- **Intermediate call** (`ctx.isFinal === false`). Validates the active form only. On success, the wizard advances to the next compiled step _before_ `onSubmit` runs, so any side effect in the callback fires from the new step. On failure, the wizard stays put and `onError` fires.
- **Final call** (`ctx.isFinal === true`). Validates every form in parallel. On success, `onSubmit` runs once and `wizard.done` flips to `true` (monotonic, only `reset()` flips it back). On failure, the wizard stays on the terminal step and `onError` fires.

The two paths share one handler and one context shape, so the consumer never has to choose between "fire the mutation now" and "fire it later" until the `if (!ctx.isFinal) return` guard at the top of the callback.

## Error aggregation with `onError`

The optional `onError` callback receives every error the submission produced, flat:

```ts
const onSubmit = wizard.handleSubmit(
  async (ctx) => {
    if (!ctx.isFinal) return
    await api.checkout(ctx.values)
  },
  (errors) => {
    toast.error(`${errors.length} issue(s) before you can finish.`, {
      description: errors.map((e) => `${e.formKey}: ${e.message}`).join('\n'),
    })
  }
)
```

Each error carries `formKey`, `path`, `message`, and an optional `code`. The list combines validation errors from every form processed on this call with any activation failures (e.g., a form whose async `defaultValues` rejected). For wizard-wide error summaries that persist between submissions, drive them off [`wizard.allErrors`](/docs/multistep/aggregates#allerrors-for-wizard-wide-summaries) instead.

## `focusFirstError`

When a submission produces errors, the wizard jumps to the first failing form and invokes its `applyInvalidSubmitPolicy()` (focus / scroll per the form's own `onInvalidSubmit` configuration). The behavior is on by default; opt out by passing `focusFirstError: false` on the wizard:

```ts
const wizard = useWizard({
  steps: [shipping, payment, review],
  focusFirstError: false,
})
```

With the focus jump disabled, the wizard stays on the terminal step and leaves navigation to the consumer's `onError` callback. Useful when you've built a custom error-summary panel that owns the click-to-jump behavior.

## `wizard.submitting` for re-entrance

`wizard.handleSubmit` guards against re-entrant calls: while a prior submission is still in flight (the `onSubmit` promise hasn't settled), subsequent calls dev-warn and resolve no-op. The `submitting` flag is the gate:

```vue
<template>
  <button :disabled="wizard.submitting" type="submit">
    {{ wizard.submitting ? 'Submitting…' : 'Finish' }}
  </button>
</template>
```

Disabling the button is belt-and-braces; the wizard refuses re-entry on its own. The flag also gates navigation: `wizard.next()`, `wizard.back()`, and `wizard.goTo()` all refuse while `submitting` is true so an in-flight submit can't be torn out from underneath itself.

## Degenerate inputs

- **Empty steps list.** `handleSubmit` dev-warns and resolves no-op. `onSubmit` and `onError` are never invoked.
- **Re-entrant submission.** The second call dev-warns and resolves no-op; the first call continues to settle.
- **No `Event` argument.** Imperative calls (`onSubmit()` with no event) work the same as `<form @submit.prevent>`; the `preventDefault` step is skipped.

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the full wizard handle.
- [Aggregates](/docs/multistep/aggregates) for `wizard.allValues` and `wizard.allErrors`, which mirror the data `ctx.values` carries.
- [Statuses](/docs/multistep/statuses) for the per-step `FormStatus` rollup that flips `submitted: true` when the callback resolves.
- [Patterns](/docs/multistep/patterns) for branching flows that lean on `wizard.handleSubmit` for the final-step validation sweep.
