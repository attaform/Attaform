---
title: handleSubmit
description: wizard.handleSubmit(onSubmit, onError?) returns one handler that validates the whole wizard and calls onSubmit once with every step's values. It never advances; gate a step with wizard.tryNext().
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
    value: '(errors: WizardAggregateError[]) => void | Promise<void>'
    kind: code
---

# `handleSubmit`

> `wizard.handleSubmit(onSubmit, onError?)` returns one event handler that validates the entire step list, no matter which step is active, and calls `onSubmit` once with every step's parsed values. It never advances the wizard. Gating a Next button on the active step's validity is a one-line composition, so submission and navigation stay separate verbs.

::docs-meta-table
::

## `handleSubmit` submits the whole wizard

`wizard.handleSubmit` returns an event handler. It validates every step in parallel, and on a clean pass calls `onSubmit` once with the full values map. Bind it to your Finish button, or any submit-everything action:

```vue
<script setup lang="ts">
  import { useForm, useWizard } from 'attaform'

  const wizard = useWizard({ steps: [shipping, payment, review] })

  const onFinish = wizard.handleSubmit(async (ctx) => {
    await api.checkout({
      shipping: ctx.get(shipping),
      payment: ctx.get(payment),
    })
  })
</script>

<template>
  <form @submit="onFinish">
    <!-- step body -->
    <button :disabled="wizard.submitting" type="submit">Finish</button>
  </form>
</template>
```

Because it validates the whole wizard from any step, you can call it the moment every step is filled, whether or not the user has walked to the last one. The handler accepts an optional `Event` and calls `preventDefault()` when one is passed, so `@submit` and `@click` both work. Bare imperative calls (`onFinish()` with no event) are fine too; the handler just skips the prevent step.

A clean finish latches `wizard.done`, and that is the flag to render a confirmation from. It stays `true` until `wizard.reset()`, so the state survives a user wandering back through the steps to look at what they sent. Nothing else on the wizard changes: the pin stays where it is, and each step's `submitted` stays as its own `handleSubmit` left it, because a whole-wizard pass validates each form rather than submitting it.

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

- `ctx.values` is the namespaced parsed payload, keyed by step key, carrying every step (since `handleSubmit` validates them all). Affordance steps contribute an empty record.
- `ctx.get(formRef)` is the typed accessor: pass a form ref, get back the parsed output narrowed to that form's schema. The handy shape when you have already closed over the form refs at construction.
- `ctx.currentKey` is the key of the step that fired this submission.
- `ctx.isFinal` is `true` when `currentKey` is the last position in `wizard.steps`. It is positional information only: it tells you where the submit fired, never what got validated. A user who steps back, edits, and submits from the middle sees `isFinal === false`, and the whole wizard is still processed.

```ts
const onFinish = wizard.handleSubmit(async (ctx) => {
  const order = await api.checkout({
    shipping: ctx.get(shipping),
    payment: ctx.get(payment),
  })
  router.push(`/orders/${order.id}`)
})
```

## Gating advance per step

`wizard.handleSubmit` submits; navigation is a separate verb. `wizard.next()`, `wizard.back()`, and `wizard.goTo()` move the pin without validating, with one exception: `next()` on an uncleared [`gate()`](/docs/multistep/gate) step submits instead, so the gate's confirmation cannot be stepped around. To advance a step only when it is valid, reach for `wizard.tryNext()`:

```vue
<template>
  <button type="button" @click="wizard.tryNext()">Next</button>
</template>
```

`wizard.tryNext()` validates the active step, advances only on a clean pass, and reveals the step's errors in place when it fails. No captured handler and no setup `const`: it binds straight to the button. To advance unconditionally (an autosave-style flow that defers the error waterfall to the final submit), call `wizard.next()` directly.

The choice of verb is the blocking policy: `wizard.tryNext()` for a blocking Next, `wizard.next()` for a non-blocking one. There is no mode flag and no `{ validate }` option to remember.

`tryNext()` resolves to whether the pin moved, so it doubles as the seam for post-advance work. Moving focus to the new step is the common one: the pin flips synchronously, but the new step's DOM lands a tick later, so await `nextTick()` before reaching for the element (and give a heading or container focus target `tabindex="-1"`, since those are not focusable on their own).

```ts
if (await wizard.tryNext()) {
  await nextTick()
  heading.value?.focus()
}
```

### Custom valid or invalid handling

`tryNext()` is the shorthand for composing the active step's own submit with `next()`. When you want custom valid or invalid callbacks (a toast, an analytics ping, a different advance target), compose them directly:

```ts
const onNext = wizard.activeForm.handleSubmit(
  () => wizard.next(),
  (errors) => toast.error(`${errors.length} to fix before continuing.`)
)
```

`wizard.activeForm` is a live view of the current step, so this one `const`, captured once, is correct on every step: it validates whichever step is active when invoked and advances only on a clean pass.

> `wizard.handleSubmit`, `wizard.activeForm.handleSubmit`, and `wizard.tryNext()` are one verb at three reaches: submit every step, submit the active step, or submit-and-advance the active step. Reach for the wizard's when you want the whole thing, the active form's (or `tryNext`) when you want to gate one step.

## Error aggregation with `onError`

The optional `onError` callback receives every error the submission produced, flat, across every step:

```ts
const onFinish = wizard.handleSubmit(
  async (ctx) => {
    await api.checkout(ctx.values)
  },
  (errors) => {
    toast.error(`${errors.length} issue(s) before you can finish.`, {
      description: errors.map((e) => `${e.formKey}: ${e.message}`).join('\n'),
    })
  }
)
```

Each error is a `WizardAggregateError`, carrying `formKey`, `path`, `message`, and an optional `code`. Because `handleSubmit` validates the whole wizard, the list spans every failing step at once, not just the active one. Four things land in it:

- **Validation errors**, from every step, each stamped with the step it came from.
- **Errors the callback set** with `form.setErrors`, the server-rejection path. They route through `onError` exactly like a validation failure, and `wizard.done` never latches.
- **Activation failures**, such as a form whose async `defaultValues` rejected.
- **Uncleared [`gate()`](/docs/multistep/gate) steps**, one entry per gate, coded `atta:gate-not-cleared` and pathed at `[]`. A gate blocks the finish even when every form validates, since a gate opens on a confirming submit and not on validity. Validation errors sort ahead of gate entries, so `errors[0]` is a real field error when there is one.

For wizard-wide error summaries that persist between submissions, drive them off [`wizard.allErrors`](/docs/multistep/aggregates#allerrors-for-wizard-wide-summaries) instead.

## `focusFirstError`

When a submission produces errors, the wizard jumps to the first failing form and invokes its `applyInvalidSubmitPolicy()`, which honors that form's own `focusOnInvalidSubmit` choice. The behavior is on by default; opt out by passing `focusFirstError: false` on the wizard:

```ts
const wizard = useWizard({
  steps: [shipping, payment, review],
  focusFirstError: false,
})
```

With the focus jump disabled, the wizard stays where it is and leaves navigation to the consumer's `onError` callback. Useful when you have built a custom error-summary panel that owns the click-to-jump behavior.

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

## When a callback throws

A rejection you expected is not a throw. A server that says no is `form.setErrors(...)` on the relevant step and a plain `return`: those errors route through `onError`, `wizard.done` never latches, and the flow stays where it is.

A throw is for the unexpected, and it lands on `wizard.submitError` as a real `Error`:

```vue
<script setup lang="ts">
  import { useWizard } from 'attaform'

  const wizard = useWizard({ steps: [shipping, payment, review] })
  const onFinish = wizard.handleSubmit(async (ctx) => {
    await api.checkout(ctx.values) // a network drop or a 500 throws
  })
</script>

<template>
  <p v-if="wizard.submitError" role="alert">
    Something went wrong: {{ wizard.submitError.message }}. Try again.
  </p>
</template>
```

The handler parks it rather than re-throwing, and that is deliberate. It is bound to DOM events, where a rejected promise has nowhere to go but `window`'s `unhandledrejection`, which reads as a phantom crash for a failure you have already handled. So the returned handler always resolves, `wizard.submitting` clears through the `finally`, and navigation is never left stranded. A `submitError` you never render is an error nobody sees, so render it.

It clears at the next submit's entry and on `wizard.reset()`. An `onError` callback that throws lands here too, wrapped so the cause is preserved.

## Degenerate inputs

- **Empty steps list.** `handleSubmit` dev-warns and resolves no-op. `onSubmit` and `onError` are never invoked.
- **Re-entrant submission.** The second call dev-warns and resolves no-op; the first call continues to settle.
- **No `Event` argument.** Imperative calls (`onFinish()` with no event) work the same as `<form @submit>`; the `preventDefault` step is skipped.
- **A throwing callback.** The handler resolves rather than rejecting, and the error parks on `wizard.submitError`. See [When a callback throws](#when-a-callback-throws).

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and the full wizard handle.
- [Aggregates](/docs/multistep/aggregates) for `wizard.allValues` and `wizard.allErrors`, which mirror the data `ctx.values` carries.
- [Statuses](/docs/multistep/statuses) for the per-step `FormStatus` rollup, including why a whole-wizard finish latches `wizard.done` rather than any step's `submitted`.
- [Patterns](/docs/multistep/patterns) for branching flows and the gated-advance composition in context.
