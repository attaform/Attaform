---
title: Step slots
description: Slots are the entries that fill useWizard's steps array. Four kinds compose the list freely. Form slots gather data, string slots mark affordance screens, function slots branch on live values, and defer() opts heavy slots into sticky lazy resolution. Each slot compiles into the same uniform { key, form } shape so navigation, status aggregation, and submission read uniformly across the whole flow.
metaRows:
  - label: Category
    value: Concept
  - label: Slot kinds
    value: Form · string · function · defer()
    kind: code
  - label: Compiled shape
    value: '{ key, form }'
    kind: code
  - label: Drop behavior
    value: 'function slot returns undefined => drop'
    kind: code
---

# Step slots

> Slots are the entries that fill `useWizard({ steps })`. A flow's shape lives entirely in the array: forms for collection screens, bare strings for affordance screens, functions for runtime branching, and `defer()` for sticky one-shot resolution. Each slot compiles into a uniform `{ key, form }` step, so the navigation, status, and submission machinery never has to special-case a kind.

::docs-meta-table
::

The previous page ([`useWizard`](/docs/multistep/use-wizard)) introduced slots at a glance. This page is the deep dive: what each slot kind brings, the `ctx` shape that function and `defer()` slots receive, and the rules around drop, dedup, and re-evaluation.

The demo below stitches all four kinds into one flow: a `'welcome'` string, a single attendee form, a function slot that branches by role (and returns a bare string for the no-extras path), another function slot that drops when traveling solo, a `defer()` resolver for the regional pricing form, and a `'review'` string at the end.

::docs-demo{slug="step-slots" label="Slots Demo"}
::

## The four kinds at a glance

```ts
import { useForm, useWizard, defer } from 'attaform/zod'

const shipping = useForm({ schema: shippingSchema, key: 'shipping' })
const business = useForm({ schema: businessSchema, key: 'business' })
const consumer = useForm({ schema: consumerSchema, key: 'consumer' })

const wizard = useWizard({
  steps: [
    'welcome', // affordance slot (string)
    shipping, // form slot
    (ctx) => (ctx.forms.shipping.values.kind === 'business' ? business : consumer), // function slot
    defer((ctx) => fetchSummaryFormFor(ctx)), // sticky lazy slot
    'congrats', // affordance slot
  ],
})
```

Five positions, all uniform downstream. `wizard.currentStep`, `wizard.statuses[key]`, and `wizard.handleSubmit` operate the same whether the active step came from a form ref or a string. The slot kind shapes _how_ the position resolves, not _what_ it produces.

## Form slots

A form built with `useForm` slotted directly into the array. The wizard surfaces it as-is: the form's `key`, schema, fields, values, and submission pipeline are reachable through `wizard.forms[form.key]`, `wizard.statuses[form.key]`, `wizard.allValues[form.key]`, and friends.

```ts
const shipping = useForm({ schema: shippingSchema, key: 'shipping' })
const payment = useForm({ schema: paymentSchema, key: 'payment' })

const wizard = useWizard({ steps: [shipping, payment] })
```

The same form ref can be shared with anything else in the app (props, `injectForm`, a different wizard). The wizard ref-counts each form for its lifetime; tearing down the wizard releases the consumer count without disposing forms that other components still hold.

## Affordance slots (string)

A bare string. The wizard generates a noop form under that key, backed by an empty `AbstractSchema` that always validates as `{}`. Affordance positions never collect data: welcome cards, terms-and-conditions panels, review surfaces, and confirmation cards each occupy one string in the array.

```ts
const wizard = useWizard({
  steps: ['welcome', shipping, payment, 'order-review', 'confirmation'],
})
```

Every downstream surface treats the string slot identically to a form slot:

- `wizard.steps[i]` reads as `{ key: 'welcome', form: <noopForm> }`.
- `wizard.statuses['welcome']` reads as `{ valid: true, errorCount: 0, ... }`.
- `wizard.allValues['welcome']` is the empty record `{}`.
- `wizard.handleSubmit` on an affordance step validates as `{}` and advances.

The noop form is real: it carries a key, sits in the per-app registry, and participates in `injectForm('welcome')` lookups the same way any other form does. Affordance steps are first-class building blocks, not edge cases.

### When two string slots collide on a key

```ts
useWizard({ steps: ['welcome', shipping, 'welcome'] }) // duplicate 'welcome'
```

First occurrence wins. The second dev-warns and drops. The wizard still navigates without crashing.

## Function slots

A function that picks one of the three slot kinds at runtime: `(ctx) => Form | string | undefined`. The wizard re-invokes function slots reactively whenever the reads inside them change, so branching logic stays in sync with live form values.

```ts
const account = useForm({ schema: accountSchema, key: 'account' })
const business = useForm({ schema: businessSchema, key: 'business' })
const consumer = useForm({ schema: consumerSchema, key: 'consumer' })

const wizard = useWizard({
  steps: [
    account,
    (ctx) => (ctx.forms.account.values.kind === 'business' ? business : consumer),
    'confirmation',
  ],
})
```

When the user picks `'business'` on the account step, the branching slot resolves to `business`. Switching back to `'consumer'` swaps the resolved form. `wizard.steps`, `wizard.forms`, and the progress rail follow along.

### Return values

| Return           | Result                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `AnyForm` ref | The slot compiles to `{ key: form.key, form }`.                                                                                                                                              |
| A `string` key   | The slot resolves to a noop affordance step under that key. New keys are built on the fly; the same key returned twice reuses the same noop. No pre-declaration needed elsewhere in `steps`. |
| `undefined`      | The slot is dropped from the compiled list. Useful for "this branch isn't relevant right now"; the step rail shortens accordingly.                                                           |

### Reactive re-evaluation

Function slots evaluate on every read of their reactive dependencies. Keep slot bodies cheap: a branch on `ctx.forms.<key>.values.<path>` is fine; a `fetch(...)` is not (slot evaluation is synchronous, and re-evaluating an expensive lookup on every keystroke punishes the user). Reach for [`defer()`](#deferred-slots-defer) when the resolution is heavy or one-shot.

### Dropping a slot keeps navigation honest

```ts
const wizard = useWizard({
  steps: [
    account,
    (ctx) => (ctx.forms.account.values.needsId ? idVerification : undefined),
    confirm,
  ],
})
```

When the user toggles `needsId` off, the middle slot drops. `wizard.count` falls from 3 to 2; `wizard.activeIndex` and `wizard.currentStep` re-anchor; navigation buttons reflect the new positions.

## Deferred slots (`defer()`)

Wrap a function slot in `defer((ctx) => ...)` to opt that specific position into sticky resolution: the slot resolves once on the first compile pass and the result sticks across subsequent re-evaluations. Right shape for expensive lookups, async-derived forms, or branches that should commit on first resolution rather than thrash.

```ts
import { useForm, useWizard, defer } from 'attaform/zod'

const wizard = useWizard({
  steps: [
    account,
    defer((ctx) => buildShippingFormForRegion(ctx.forms.account.values.region)),
    confirm,
  ],
})
```

The `buildShippingFormForRegion(...)` call fires once on the first compile pass and never again. If the user later edits `region`, the deferred slot does NOT re-evaluate; the original resolution stays committed across navigation. The one event that does re-fire `defer()` resolvers is `wizard.reset()`, which clears the sticky cache so a wizard reboot truly resolves from scratch, including the expensive one-shot lookups.

### Resolution semantics

| Return           | Behavior                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| An `AnyForm` ref | The form sticks at that position. Subsequent reads reuse it.                                                                       |
| A `string` key   | Resolves to a noop affordance step under that key, building one on the fly if needed. The result sticks across re-evaluations.     |
| `undefined`      | The slot drops. `reset()` clears the sticky cache so the resolver re-fires on the next compile pass; otherwise the drop is sticky. |

Use `defer()` when the resolution is expensive enough that thrash matters. For everyday branching on live values, plain function slots are simpler and more reactive.

## The `ctx` surface

Function slots and `defer()` resolvers each receive a single `ctx` argument:

```ts
type WizardCtx = {
  readonly forms: Readonly<Record<FormKey, WizardCtxForm>>
  readonly currentKey: FormKey | undefined
}

type WizardCtxForm = AnyForm & {
  readonly values: Readonly<Record<string, unknown>>
}
```

- `ctx.forms.<key>` is the projection over every form reachable through a top-level slot. Reads are loose-typed (`unknown`), since the wizard does not generically thread each form's schema through this surface. For typed access, close over the original form ref:

  ```ts
  const account = useForm({ schema: accountSchema, key: 'account' })

  const wizard = useWizard({
    steps: [
      account,
      (ctx) => (account.values.kind === 'business' ? business : consumer), // typed!
      // not: ctx.forms.account.values.kind  (loose-typed)
    ],
  })
  ```

  Both forms work at runtime. The closed-over ref keeps the schema type intact through the predicate, which IDEs and review-flag tooling appreciate.

- `ctx.currentKey` is the key of the step currently active. Reads as `undefined` on the first compile pass before activation lands, so guard with `!== undefined` when the slot's decision depends on position.

## The compiled step shape

Each surviving slot compiles to a `CompiledStep`:

```ts
type CompiledStep = {
  readonly key: FormKey
  readonly form: AnyForm
}
```

`wizard.steps[i]` reads as `{ key, form }`. The list is ordered, dedupes by form key (first occurrence wins), and drops any slot whose resolver returned `undefined`. The compiled list is what every downstream surface walks: navigation, the progress rail, statuses, aggregates.

```ts
for (const step of wizard.steps) {
  console.log(step.key, step.form.meta.valid)
}
```

## Drop and dedup semantics

A few rules govern how the source slot list compiles down to the final step list:

- **Duplicate keys.** Two slots producing the same step key (string slot vs form ref, or two functions returning the same form): first occurrence wins. Later duplicates dev-warn and drop. Keeps `wizard.steps` linearly addressable.
- **`undefined` from a function slot.** The slot drops; subsequent reads of `wizard.steps` reflect the shortened list. Re-running the slot (a reactive read changed) can reintroduce the position.
- **`undefined` from a `defer()` slot.** The slot drops. `reset()` clears the sticky cache so the resolver re-fires on the next compile pass; if it returns `undefined` again, the slot drops again.
- **Function or `defer()` slot returns a new string key.** The wizard builds a noop affordance step on the fly under that key and threads it into the compiled list, the statuses surface, and the rail. The same key returned by a later slot reuses the same noop (first-build wins). No pre-declaration anywhere in `steps` is required.
- **Empty compiled list.** If every slot drops at runtime, `wizard.currentStep` reads as `undefined`, navigation refuses with a dev-warn, and the surrounding app keeps rendering. See [Degenerate inputs](/docs/multistep/use-wizard#degenerate-inputs).

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and full reactive surface.
- [Statuses](/docs/multistep/statuses) for the per-step rollup that drives a rail.
- [Aggregates](/docs/multistep/aggregates) for `wizard.allValues`, `wizard.allErrors`, and `wizard.forms`.
- [handleSubmit](/docs/multistep/handle-submit) for the universal submission pipeline that handles every slot kind uniformly.
- [Patterns](/docs/multistep/patterns) for branching, review surfaces, and lazy heavy slots.
