# Wizards

`useWizard` composes existing `useForm` instances into a multistep flow with navigation, per-step status, and one aggregate submit. Navigation and submission are separate verbs; keep them separate.

## Step slots

A step slot is one of:

- a `useForm` reference,
- a **bare string**: an always-valid noop step (key = the string), the native primitive for an informational or affordance screen with no schema,
- `null` / `undefined`: filtered out of the flow,
- a **function** returning any of those, for runtime branching,
- a `lazy((ctx) => ...)`-wrapped function, which memoizes its resolution and re-fires only when its own tracked reads change.

`gate(slot)` wraps any of them rather than being a kind of its own: it marks that position a hard prerequisite and leaves how the slot resolves alone. A function slot may return one, so whether a position is a gate can itself be a runtime decision.

```ts
import { useForm, useWizard } from 'attaform'

const account = useForm({ schema: accountSchema, key: 'account' })
const profile = useForm({ schema: profileSchema, key: 'profile' })

const wizard = useWizard({ key: 'onboarding', steps: [account, 'review', profile] })
```

## Navigation vs submission

- **`wizard.tryNext(): Promise<boolean>`** is the gated Next. It validates the active step and advances only on a clean pass, revealing that step's errors in place otherwise. It resolves to whether it advanced, and it is inline-bindable: `@click="wizard.tryNext()"`.
- **`wizard.next()` / `wizard.back()` / `wizard.goTo(key)`** are positional moves with no validation gate. Use them for a Back button or a jump; use `tryNext` for a forward move that should validate. Two exceptions: they refuse while a submit is in flight, and `next()` on an **uncleared `gate()` step behaves as `tryNext()`**, so wiring Next straight to it can never skip the gate's confirmation. Once that gate clears, `next()` is plain navigation again and does not re-submit.
- **`wizard.handleSubmit(onSubmit, onError?)`** validates **every** step from any position and calls `onSubmit` once with all forms' values. It **never advances**. Wire it to the final Submit.

For a forward move that runs a custom callback before advancing, compose the step form's own submit with `next`:

```ts
const onStepDone = account.handleSubmit(async (values) => {
  await saveDraft(values)
  wizard.next()
})
```

`handleSubmit` validating the whole list from any step means there is no "only the last step validates everything" caveat: a user who steps back, edits, and submits from the middle still gets the whole flow validated, and `done` still latches on success. `ctx.isFinal` reports only _where_ the submit fired, never _what_ was validated.

## The submit context

The `onSubmit` callback receives a context, not a bare values object:

```ts
const onComplete = wizard.handleSubmit(async (ctx) => {
  // ctx.values is the aggregate keyed by form key (mirrors wizard.allValues)
  // ctx.get(form) returns one form's typed parsed output
  // ctx.currentKey is the step that fired the submit
  // ctx.isFinal is positional: whether currentKey is the last step
  await fetch('/onboarding', { method: 'POST', body: JSON.stringify(ctx.values) })
})
```

`ctx.get(account)` is the type-safe read for one form: it returns that form's parsed output typed from its schema, which survives across a component graph because the form ref carries its schema.

## Reading aggregate state

The wizard handle exposes the flow's rolled-up state, all reactive:

- `wizard.forms[key]`: the step's own form handle, identity-equal to the `useForm` ref that was slotted in.
- `wizard.allValues` / `wizard.allErrors`: every form's values / aggregate errors, keyed.
- `wizard.activeForm`: a live facade over whichever step is active, so a handler captured once retargets as the pin moves. Not the handle itself: use `wizard.forms[key]` for that.
- `wizard.statuses`: per-form status. Plus `wizard.progress`, `wizard.canAdvance`, `wizard.canGoBack`, `wizard.isFinalStep`, `wizard.visited`.

## A declarative step registry

When steps carry metadata (title, a visibility predicate, persisted keys), drive the whole wizard from one registry rather than scattering the shape. `WizardCtx` is `{ forms, currentKey }` and reactive, so a `when` predicate can branch on live form values and re-evaluate as they change:

```ts
import { useWizard } from 'attaform'
import type { AnyForm, WizardCtx } from 'attaform'

interface StepDef {
  key: string
  title: string
  form: AnyForm | null // null becomes a bare-string noop slot
  when?: (ctx: WizardCtx) => boolean // omitted means always shown
}

const registry: StepDef[] = [
  { key: 'intent', title: 'Get started', form: null },
  { key: 'account', title: 'Your account', form: account },
  { key: 'profile', title: 'Your profile', form: profile },
]

const wizard = useWizard({
  key: 'onboarding',
  steps: registry.map(
    (s) => (ctx: WizardCtx) => ((s.when?.(ctx) ?? true) ? (s.form ?? s.key) : undefined)
  ),
})
```

Everything derives from the registry: the step slots, the titles, any persisted key list. Add, remove, reorder, or gate a step by editing the registry alone. Do not add speculative registry fields with no consumer; add a hook when the second consumer arrives.

## Keyed injection resolves by name and timing

A string key passed to `injectForm('account')` or `injectWizard('onboarding')` is a name in Attaform's app-level registry, not a location in the component tree:

- **Position-independent.** The lookup reaches any component in the app: a sibling branch, a floating toolbar, a teleported modal. Extracting a wrapper or changing how deep a component sits never changes what a key resolves to. The no-key ambient form is the opposite, and is the one that runs on `provide` / `inject`: it reaches descendants of the owning `useForm` only.
- **Time-dependent.** The registry entry appears when the owner's own `useForm({ key })` / `useWizard({ key })` setup runs, and not before.

Together they give one rule: **resolve downward.** Vue runs a parent's setup before its children's, so a descendant reaching an ancestor's keyed form always resolves, while an ancestor reaching a descendant's gets `null`. The stable shape is to **lift a shared form's creation to the coordinating ancestor** (the component that owns the wizard) and reach for it at or below that point. Always chain `?.` on the result, which is `T | null`.
