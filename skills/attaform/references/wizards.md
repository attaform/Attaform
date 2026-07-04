# Wizards

`useWizard` composes existing `useForm` instances into a multistep flow with navigation, per-step status, and one aggregate submit. Navigation and submission are separate verbs; keep them separate.

## Step slots

A step slot is one of:

- a `useForm` reference,
- a **bare string**: an always-valid noop step (key = the string), the native primitive for an informational or affordance screen with no schema,
- `null` / `undefined`: filtered out of the flow,
- a **function** returning any of those, for runtime branching,
- a `lazy((ctx) => ...)`-wrapped function, which memoizes its resolution and re-fires only when its own tracked reads change.

```ts
import { useForm, useWizard } from 'attaform'

const account = useForm({ schema: accountSchema, key: 'account' })
const profile = useForm({ schema: profileSchema, key: 'profile' })

const wizard = useWizard({ key: 'onboarding', steps: [account, 'review', profile] })
```

## Navigation vs submission

- **`wizard.tryNext(): Promise<boolean>`** is the gated Next. It validates the active step and advances only on a clean pass, revealing that step's errors in place otherwise. It resolves to whether it advanced, and it is inline-bindable: `@click="wizard.tryNext()"`.
- **`wizard.next()` / `wizard.back()` / `wizard.goTo(key)`** are positional moves with no validation gate. Use them for a Back button or a jump; use `tryNext` for a forward move that should validate.
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
  // ctx.values     — aggregate keyed by form key (mirrors wizard.allValues)
  // ctx.get(form)  — typed parsed output for one form ref
  // ctx.currentKey — the step that fired the submit
  // ctx.isFinal    — positional: is currentKey the last step?
  await fetch('/onboarding', { method: 'POST', body: JSON.stringify(ctx.values) })
})
```

`ctx.get(account)` is the type-safe read for one form: it returns that form's parsed output typed from its schema, which survives across a component graph because the form ref carries its schema.

## Reading aggregate state

The wizard handle exposes the flow's rolled-up state, all reactive:

- `wizard.forms[key]` — the live form handle for a step (a facade typed as a form).
- `wizard.allValues` / `wizard.allErrors` — every form's values / aggregate errors, keyed.
- `wizard.activeForm` — the currently active step's form facade.
- `wizard.statuses` — per-form status; `wizard.progress`, `wizard.canAdvance`, `wizard.canGoBack`, `wizard.isFinalStep`, `wizard.visited`.

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

## Keyed injection resolves by tree and timing

A string key passed to `injectForm('account')` or `injectWizard('onboarding')` _reads_ like a global address but resolves by the **caller's component-tree position and mount timing**, not as a global lookup:

- `provide` / `inject` is descendant-only, so a form created in a **leaf** is unreachable from an **ancestor**.
- A keyed form is not resolvable until the creating component's `setup` has run, so mount order matters.

The consequence: a purely structural refactor can silently break a lookup. The stable shape is to **lift a shared form's creation to the coordinating ancestor** (the component that owns the wizard) and have leaves `injectForm(key)` it downward by a prop key. Always chain `?.` on the result, which is `T | null`.
