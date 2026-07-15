---
title: Step slots
description: Slots fill useWizard's steps array. Form slots gather data, string slots mark affordance screens, function slots branch on live values, and lazy() memoizes a heavy slot by its tracked reads.
metaRows:
  - label: Category
    value: Concept
  - label: Slot kinds
    value: Form · string · function · lazy()
    kind: code
  - label: Compiled shape
    value: '{ key, form }'
    kind: code
  - label: Drop behavior
    value: 'null / undefined slot => drop'
    kind: code
---

# Step slots

> Slots are the entries that fill `useWizard({ steps })`. A flow's shape lives entirely in the array: forms for collection screens, bare strings for affordance screens, functions for runtime branching, and `lazy()` for memoized resolution that re-fires only on its own tracked reactive reads. Each slot compiles into a uniform `{ key, form }` step, so the navigation, status, and submission machinery never has to special-case a kind.

::docs-meta-table
::

The previous page ([`useWizard`](/docs/multistep/use-wizard)) introduced slots at a glance. This page is the deep dive: what each slot kind brings, the `ctx` shape that function and `lazy()` slots receive, and the rules around drop, dedup, and re-evaluation.

The demo below stitches all four kinds into one flow: a `'welcome'` string, a single attendee form, a function slot that branches by role (and returns a bare string for the no-extras path), another function slot that drops when traveling solo, a `lazy()` resolver for the regional pricing form, and a `'review'` string at the end.

::docs-demo{slug="step-slots" label="Slots Demo"}
::

## The four kinds at a glance

```ts
import { useForm, useWizard, lazy } from 'attaform'

const shipping = useForm({ schema: shippingSchema, key: 'shipping' })
const business = useForm({ schema: businessSchema, key: 'business' })
const consumer = useForm({ schema: consumerSchema, key: 'consumer' })

const wizard = useWizard({
  steps: [
    'welcome', // affordance slot (string)
    shipping, // form slot
    (ctx) => (ctx.forms.shipping.values.kind === 'business' ? business : consumer), // function slot
    lazy((ctx) => buildSummaryFormFor(ctx)), // memoized lazy slot
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
- `wizard.handleSubmit` validates the affordance step trivially as `{}`, along with every other step.

The noop form is real: it carries a key, sits in the per-app registry, and participates in `injectForm('welcome')` lookups the same way any other form does. Affordance steps are first-class building blocks, not edge cases.

### When two string slots collide on a key

```ts
useWizard({ steps: ['welcome', shipping, 'welcome'] }) // duplicate 'welcome'
```

First occurrence wins. The second dev-warns and drops. The wizard still navigates without crashing.

## Conditional steps

Any position in the array can be `null` or `undefined`, and the wizard drops it from the compiled list. That lets a step appear or disappear on a condition written inline, with no imperative pre-filtering of the array:

```ts
const wizard = useWizard({
  steps: [account, needsShipping ? shipping : null, payment, isGuest ? null : 'account-review'],
})
```

A literal `null` element evaluates once, when the array is built, so it fits a condition that is fixed for the wizard's life: a plan tier, a feature flag. For a condition that changes as the user works, reach for a [function slot](#function-slots) that returns `null`, so the step's presence tracks the value reactively.

`null` and `undefined` are interchangeable here; both mean "no step." The idiom is `cond ? form : null`, not `cond && form`: a bare `&&` yields `false`, and `false` is not a step (nor is there a step a `true` could stand for), so the wizard accepts only the nullish forms.

A form kept behind a conditional stays fully typed: with `steps: [account, show ? shipping : null]`, `wizard.forms.shipping` still resolves to the concrete `shipping` handle. When every position in the array can drop, `wizard.currentStep` reads as `FormKey | undefined`, since the compiled list might be empty.

## Function slots

A function that picks one of the three slot kinds at runtime: `(ctx) => Form | string | null | undefined`. The wizard re-invokes function slots reactively whenever the reads inside them change, so branching logic stays in sync with live form values.

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

| Return               | Result                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `AnyForm` ref     | The slot compiles to `{ key: form.key, form }`.                                                                                                                                              |
| A `string` key       | The slot resolves to a noop affordance step under that key. New keys are built on the fly; the same key returned twice reuses the same noop. No pre-declaration needed elsewhere in `steps`. |
| `null` / `undefined` | The slot is dropped from the compiled list. Useful for "this branch isn't relevant right now"; the step rail shortens accordingly.                                                           |

### Reactive re-evaluation

Function slots re-evaluate whenever the wizard's compiled list re-evaluates, which includes the case where _another_ slot's deps changed. Keep slot bodies cheap: a branch on `ctx.forms.<key>.values.<path>` is fine; a `fetch(...)` is not (slot evaluation is synchronous, and re-evaluating an expensive lookup on every keystroke is wasted work). Reach for [`lazy()`](#lazy-slots-lazy) when the resolver is heavy and should only re-fire on its own tracked reads.

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

When the user toggles `needsId` off, the middle slot drops. `wizard.count` falls from 3 to 2, and navigation buttons reflect the new positions. If the wizard was sitting on the dropped step, the pin slides forward to the step that took its slot, clamping to the new last step when the dropped one was last, so `wizard.currentStep` and `wizard.activeForm` stay on a live step instead of snapping back to the first.

## Lazy slots (`lazy()`)

### What problem `lazy()` solves

Plain function slots re-evaluate whenever the wizard's compiled list re-evaluates, which happens any time _any_ slot's reactive reads move. That's perfect for the common case: cheap branches on live values reading `ctx.forms.<key>.values.<path>` and returning a form or a string. The wizard re-compiles, the function slot runs again, no harm done.

The pattern stops scaling when a resolver is expensive enough that running it on every wizard mutation produces visible thrash. A factory that builds a region-specific schema from already-loaded config. A heavy validator derived from runtime data. A tenant-specific form layout assembled from server-resolved defaults. Plain function slots re-fire that resolver every time the user toggles _any_ field anywhere in the wizard, because every field edit re-triggers the compiled list.

Resolver bodies are synchronous, so async work belongs upstream: load the source data with Nuxt's `useAsyncData` / `useFetch` (which already transfers the result from server to client), then read the resolved ref inside the lazy resolver to derive a form.

`lazy()` is the opt-in cache for those resolvers. Each lazy slot gets its own memoized `computed`: the resolver fires once on the first compile pass, and the result holds until one of the resolver's _own_ tracked reactive reads changes. Reads elsewhere in the wizard (other slots' deps, navigation churn, sibling form mutations) leave the cache intact. It's the same opt-in memoization Vue's `computed` gives you anywhere else, applied at the slot level.

```ts
// Plain function slot: re-fires every time the compiled list re-evaluates,
// which includes unrelated form edits elsewhere in the wizard.
;(ctx) => buildPricingFor(ctx.forms.account.values.region)

// Lazy slot: re-fires only when `region` actually changes.
lazy((ctx) => buildPricingFor(ctx.forms.account.values.region))
```

### How it works

```ts
import { useForm, useWizard, lazy } from 'attaform'

const wizard = useWizard({
  steps: [
    account,
    lazy((ctx) => buildShippingFormForRegion(ctx.forms.account.values.region)),
    confirm,
  ],
})
```

The `buildShippingFormForRegion(...)` call fires on the first compile pass. When the user later edits `region`, the resolver re-fires because `region` is one of its tracked reactive reads, and the rail swaps to the freshly-built form. Changes to _unrelated_ wizard state (a different form's field, another slot's branch) leave the cache untouched. `wizard.reset()` bumps an internal epoch so every lazy resolver re-fires on the next compile pass, regardless of whether any tracked read moved; that's what makes a reset a true reboot.

```ts
// One-shot resolution: read the snapshot outside the resolver so the
// closure has no reactive deps. Then `lazy()` only re-fires on reset.
const initialRegion = account.values.region
lazy(() => buildShippingFormForRegion(initialRegion))
```

### Resolution semantics

| Return               | Behavior                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `AnyForm` ref     | The form caches at that position. Subsequent reads reuse it until a tracked dep changes or `reset()` invalidates the cache.                             |
| A `string` key       | Resolves to a noop affordance step under that key, building one on the fly if needed. Result caches under the same dep-tracking rules as a form return. |
| `null` / `undefined` | The slot drops from the compiled list. The drop caches; a tracked dep change or `reset()` re-fires the resolver.                                        |

Use `lazy()` when the resolution is expensive enough that thrash matters. For everyday branching on live values, plain function slots are simpler. They re-evaluate freely with the compiled list, and the wizard pays no cache-bookkeeping cost.

## The `ctx` surface

Function slots and `lazy()` resolvers each receive a single `ctx` argument:

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
- **Literal `null` / `undefined` element.** Dropped when the array compiles, so a `cond ? form : null` conditional needs no pre-filtering. See [Conditional steps](#conditional-steps).
- **`null` / `undefined` from a function slot.** The slot drops; subsequent reads of `wizard.steps` reflect the shortened list. Re-running the slot (a reactive read changed) can reintroduce the position. If the dropped slot was the active step, the pin slides forward to the step that took its place.
- **`null` / `undefined` from a `lazy()` slot.** The slot drops. The drop caches; a tracked-dep change or `reset()` re-fires the resolver, and if it returns nullish again, the slot drops again.
- **Function or `lazy()` slot returns a new string key.** The wizard builds a noop affordance step on the fly under that key and threads it into the compiled list, the statuses surface, and the rail. The same key returned by a later slot reuses the same noop (first-build wins). No pre-declaration anywhere in `steps` is required.
- **Empty compiled list.** If every slot drops (including an array that is entirely nullish), `wizard.currentStep` reads as `undefined`, navigation refuses with a dev-warn, and the surrounding app keeps rendering. See [Degenerate inputs](/docs/multistep/use-wizard#degenerate-inputs).

## Where to next

- [`useWizard`](/docs/multistep/use-wizard) for the construction signature and full reactive surface.
- [Statuses](/docs/multistep/statuses) for the per-step rollup that drives a rail.
- [Aggregates](/docs/multistep/aggregates) for `wizard.allValues`, `wizard.allErrors`, and `wizard.forms`.
- [handleSubmit](/docs/multistep/handle-submit) for the universal submission pipeline that handles every slot kind uniformly.
- [Patterns](/docs/multistep/patterns) for branching, review surfaces, and lazy heavy slots in real flows.
