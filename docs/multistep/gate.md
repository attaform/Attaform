---
title: gate
description: gate(step) turns a wizard step into a hard prerequisite. Everything after it stays sealed and frozen until the gate clears on the wrapped form's clean submit, never on intent.
metaRows:
  - label: Category
    value: Concept
  - label: Clears on
    value: a clean submit, or a defaultStatuses seed
  - label: Downstream
    value: frozen + unreachable
  - label: Composes
    value: gate(lazy(s)) === lazy(gate(s))
    kind: code
---

# gate

> `gate(step)` wraps a wizard step so it becomes a hard prerequisite. While the gate is uncleared, every step positioned after it is sealed: frozen at the data layer and unreachable by navigation. The gate is safe by construction. It clears when its form submits clean, the confirmation, never the instant a value goes valid, the intent. That one distinction is the whole reason `gate()` exists.

::docs-meta-table
::

Some steps gather data. Others are a promise the rest of the flow leans on: a terms acceptance, an age check, a consent that makes the downstream steps lawful to collect. Wrap that step in `gate()` and Attaform holds the line for you.

::docs-demo{slug="consent-gate" label="Consent gate"}
::

```ts
import { useForm, useWizard, gate } from 'attaform'

const consentSchema = z.object({ accepted: z.literal(true) })
const consent = useForm({
  schema: consentSchema,
  defaultValues: { accepted: false },
  key: 'consent',
})

const wizard = useWizard({ steps: [gate(consent), shipping, payment] })
```

`gate(consent)` seals `shipping` and `payment` until `consent` is confirmed. Ordering places the gate: put it immediately before what it guards, and everything to its right is gated.

`gate()` is first-class wherever a step goes: drop it straight into `steps` as shown here, or return it from a [function or `lazy()` slot](/docs/multistep/step-slots). A bare `gate(consent)` and a `() => gate(consent)` resolve to the same gated step.

## Confirmation, not intent

A gate clears on a member form's **clean submit**, not the moment a value passes validation. Checking the consent box makes `consent` valid, but the rail stays sealed. Pressing Next (or calling `wizard.tryNext()`) submits the form, and that submit is the confirmation that opens the gate.

This is deliberate, and it is load-bearing. Keying a gate on a leading value signal reads intuitive and is quietly unsafe: a downstream step could start collecting data the instant a box is ticked, before the user has actually committed. So the box can be checked and unchecked all day; the gate does not move until a real submission lands. There is no predicate to get wrong, because `gate()` never hands you one.

## The freeze runs at the data layer

A sealed downstream step is frozen through the same [`disabled`](/docs/cross-cutting-state/disabled) channel a `useForm({ disabled })` uses, so every value write no-ops regardless of origin: `setValue`, a `v-register` directive, a host component. The wizard also refuses to seat the active step on anything past an uncleared gate, so a deep link, the browser back button, or a stray `wizard.goTo(key)` all redirect to the gate.

Both halves matter. The navigation refusal keeps the user from _seeing_ a gated step; the data freeze keeps a gated form from _storing_ anything even if some other code reaches it. The guarantee lives in the data, not in a UI guard, so nothing routes around it.

## Clearing a gate

How a gate clears depends on what it wraps.

A **form gate** (`gate(consent)`) clears when its form submits clean. Wire the step's Next button to `wizard.tryNext()`, which submits the active step and advances once that submit settles, so a gate on the active step clears and advances in a single click. A bare `wizard.next()` on a gate step does the same thing: it cannot skip the confirmation.

An **affordance gate** (`gate('terms')`, a bare string) clears when the user acknowledges it by advancing. Because that acknowledgment is ephemeral, an affordance gate re-prompts every session, which is what you want for a "you have read this" screen.

A form gate can also start **cleared** when the server already recorded this prerequisite for the session. Seed it through the wizard rather than the form: `useWizard({ defaultStatuses: { consent: { gate: 'cleared' } } })` latches the gate cleared at mount, so the flow renders open from the first frame and a deep link into a downstream step is honored. The seed is a deliberate assertion, decoupled from whatever the member form's values happen to be. That decoupling is the point: a prerequisite is confirmed or it is not, and "the values validate" is a separate fact that must not stand in for confirmation.

## Freeze after clear

Once a gate clears, its own form freezes too. Navigating back to a cleared consent step is a read-only review: the checkbox is there, but the user cannot uncheck it, so there is no in-form withdrawal path. `wizard.reset()` reboots the flow and re-gates from scratch, re-applying any `defaultStatuses` seed.

## Withdrawing a gate

A cleared gate stays cleared until you say otherwise, and `wizard.relock(key, commit)` is how you say it. Just as a gate clears when its member form's submit lands clean, a gate re-seals when its `commit` callback resolves clean. Pass the server-side revoke as `commit`; `relock` awaits it and re-seals the gate, re-freezing everything downstream, only if it succeeds:

```ts
// Revoke this session's consent on the server, then re-seal the flow.
const sealed = await wizard.relock('consent', () => api.revokeConsent())
```

The re-seal is contingent, so in both directions the gate reflects server-confirmed truth. If `commit` throws, the revoke did not land, so the gate stays cleared and `relock` resolves `false`; if it resolves, the gate seals and `relock` resolves `true`. The callback is required, which is deliberate friction: a re-seal with no server round-trip would let the client's gate state drift from the server's. For a genuinely client-only re-seal, pass an empty `() => {}` so that choice is explicit.

`relock` only ever seals. There is no imperative counterpart that opens a gate: clearance stays the exclusive result of a clean submit or a `defaultStatuses` seed, so no stray signal can spring one open. Reach for it on a server-side revoke or an optimistic rollback. A call on a key that is not a live gate resolves `false` with a dev-time warning.

## Conditional gates

`gate()` takes no options. A gate that only applies sometimes comes from a function slot, the same slot kind that powers [branching wizards](/docs/multistep/patterns#branching-wizards):

::docs-demo{slug="kyc-gate" label="Conditional gate"}
::

```ts
const wizard = useWizard({
  steps: [transfer, () => (transfer.values.amount > 10_000 ? gate(kyc) : undefined), 'review'],
})
```

A small transfer drops the middle slot entirely (the `undefined` arm), so the flow is two steps with no verification. A large transfer resolves the slot to `gate(kyc)`, and `review` seals until the KYC form is submitted. The threshold is live: raise the amount and the gate appears, lower it and the gate drops, all from one expression.

Because the gate wraps the slot rather than living in a separate policy, the condition and the consequence sit in one place, and there is nothing to keep in sync.

## Composing with lazy

`gate()` and [`lazy()`](/docs/multistep/step-slots#lazy-slots-lazy) compose in either order. `gate(lazy(resolve))` gates a memoized slot; `lazy((ctx) => gate(form))` memoizes a resolver that produces a gate. Both resolve identically, so you can reach for whichever reads clearer at the call site without a second thought about ordering.

## Rendering the lock

Every gated step reports `wizard.statuses[key].locked === true`, so a progress rail can render a sealed step with a lock icon and a disabled button:

```vue
<button
  v-for="step in wizard.steps"
  :key="step.key"
  type="button"
  :disabled="wizard.statuses[step.key]?.locked === true"
  @click="wizard.goTo(step.key)"
>
  {{ step.key }}
</button>
```

The whole-wizard [`wizard.handleSubmit`](/docs/multistep/use-wizard) honors the same guarantee: it refuses to complete while any gate is uncleared, even if every form happens to validate, and routes the attempt to the gate through its `onError` callback.

## Reading the gate role

Alongside `locked`, each step's status carries `wizard.statuses[key].gate`, the step's own role as a prerequisite:

- `null` when the step is not a `gate()`.
- `'uncleared'` while its member form is unconfirmed, so it seals every later step.
- `'cleared'` once confirmed by a clean member submit, or seeded cleared via `defaultStatuses` at mount.

`gate` and `locked` are independent axes. `gate` says whether this step is a prerequisite and whether it is met; `locked` says whether the step is sealed behind an earlier uncleared gate. The first uncleared gate reads `gate: 'uncleared'` with `locked: false` (you have to reach it to clear it), while a later gate stacked behind it reads `gate: 'uncleared'` with `locked: true`.

Because `gate` reflects the wizard's live state, it is the signal to persist. A server can record which prerequisites a session has met:

```ts
for (const step of wizard.steps) {
  if (wizard.statuses[step.key]?.gate === 'cleared') {
    markPrerequisiteMet(step.key)
  }
}
```

To restore that expectation in a later session, seed the wizard with the roles you recorded: `useWizard({ defaultStatuses: { consent: { gate: 'cleared' } } })`. The read and the write share one vocabulary, so a session round-trips through the same `'cleared'` string it reported, and the seed is independent of whatever the member form's values rehydrate to. For a flow that must render open on the first server byte, resolve the seed synchronously in the page's `setup` and pass a plain object; the async factory form of `defaultStatuses` resolves after hydration, so a gate seeded through it opens once the client takes over. For the whole-session round-trip that stores the step, values, and gates from one row, see [Resumable wizards](/docs/multistep/resumable-wizards).

## Where to next

- [Step slots](/docs/multistep/step-slots) for the four slot kinds `gate()` wraps.
- [Patterns](/docs/multistep/patterns) for the hard-prerequisite pattern in context.
- [`disabled`](/docs/cross-cutting-state/disabled) for the data-freeze channel the gate drives.
- [`useWizard`](/docs/multistep/use-wizard) for navigation, `tryNext`, and `handleSubmit`.
- [Resumable wizards](/docs/multistep/resumable-wizards) for persisting the gate role across sessions with no extra tables.
