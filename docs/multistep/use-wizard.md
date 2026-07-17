---
title: useWizard
description: useWizard turns an ordered list of slots into a reactive wizard. Forms gather data, string keys mark affordance steps, function slots branch, lazy() memoizes. Whole-wizard handleSubmit and URL sync.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'useWizard({ steps, ... })'
    kind: code
  - label: Step slots
    value: 'Form · string · function · lazy()'
    kind: code
  - label: Aggregates
    value: 'allValues · allErrors · forms · statuses'
    kind: code
---

# useWizard

> Compose a reactive wizard from an ordered list of step slots. Each slot holds a form, an affordance key for a screen with no data collection, or a function that picks one or the other at runtime. Attaform threads the same handle through navigation, status aggregation, URL sync, and a `handleSubmit` that validates the whole wizard on every call.

::docs-meta-table
::

A linear three-step wizard. Each step keeps its own `useForm` call, its own schema, and its own reactive surface. The rail highlights `wizard.currentStep`, the progress bar reflects `wizard.progress`, each Next calls `wizard.tryNext()` to gate advance on the active step, and Finish runs `wizard.handleSubmit` over the whole wizard.

::docs-demo{slug="use-wizard" label="Wizard Demo"}
::

## Forms and steps

Attaform separates two concepts that often get conflated in multistep code:

- A **form** is the artifact `useForm` returns: schema, fields, values, errors, submission. The central noun of Attaform.
- A **step** is a position in the wizard's sequence. Steps come in two flavors:
  - A **collection step** holds a form. The wizard gathers data here.
  - An **affordance step** holds a bare string key, no form. The wizard uses it for screens that present rather than collect: a welcome card, a terms-and-conditions panel, a review surface, a confirmation card.

A wizard's `steps` list mixes the two freely. The shape of a typical onboarding flow:

```ts
import { useForm, useWizard } from 'attaform'
import { z } from 'zod'

const shippingSchema = z.object({ address: z.string(), city: z.string() })
const contactSchema = z.object({ email: z.email(), phone: z.string() })
const paymentSchema = z.object({ cardNumber: z.string(), cvv: z.string() })
const billingSchema = z.object({ name: z.string(), address: z.string() })

const shipping = useForm({ schema: shippingSchema, key: 'shipping' })
const contact = useForm({ schema: contactSchema, key: 'contact' })
const payment = useForm({ schema: paymentSchema, key: 'payment' })
const billing = useForm({ schema: billingSchema, key: 'billing' })

const wizard = useWizard({
  steps: ['welcome', shipping, contact, 'shipping-review', payment, billing, 'final-review'],
})
```

Seven positions, four collection steps, three affordance steps. The wizard treats every position uniformly. `wizard.currentStep` walks the list left to right. `wizard.statuses[key]` answers for every step, with affordance steps reading as always-valid so a rail dot or progress fraction doesn't need to special-case them. Under the hood, each affordance step gets a wizard-owned noop form backed by an empty `AbstractSchema` (no fields, validates as `{}`), so affordance positions participate in the same registry, status, and submission machinery as schema-backed forms without the wizard knowing about Zod (or any other adapter).

Affordance steps are a first-class building block, not an edge case. Onboarding flows live or die by the breathing room between dense collection screens: the welcome card that sets expectations, the review surface that lets the user check their work, the congratulations card that confirms a transaction landed. Each one is one string in the `steps` array.

## Step slots

Each entry in `steps` is a **slot**. Four slot kinds compose the list:

```ts
import { useForm, useWizard, lazy } from 'attaform'

const wizard = useWizard({
  steps: [
    shipping, // form slot
    'shipping-review', // affordance slot
    (ctx) => (ctx.forms.contact.values.kind === 'business' ? billing : payment), // function slot
    lazy((ctx) => buildSummaryForm(ctx)), // memoized lazy slot
  ],
})
```

- **Form slot**: a form built with `useForm`. The wizard surfaces it as-is.
- **Affordance slot**: a bare string. Becomes the step's key; the wizard generates a noop form under it.
- **Function slot**: `(ctx) => Form | string | undefined`. Re-evaluates reactively as `ctx.forms.<key>.values` mutate. The picked result replaces the slot's compiled step. Returning `undefined` drops the slot.
- **Lazy slot**: `lazy((ctx) => ...)`. Memoized by the resolver's tracked reactive reads. Re-fires on dep change or `wizard.reset()`. Right shape for resolvers expensive enough that thrash matters.

See [Step slots](/docs/multistep/step-slots) for the full slot reference, including the `ctx` shape and the rules around reactive re-evaluation.

## Options

`useWizard` takes one options bag. `steps` is required; the rest default sensibly for the common URL-synchronized wizard case.

| Option            | Type                                                               | Default             | What it does                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steps`           | `Array<StepSlot>`                                                  | required            | Ordered list of slots that compile into the wizard's step list. See [Step slots](/docs/multistep/step-slots).                                                       |
| `key`             | `string`                                                           | synthetic           | Identifier registered in the per-app registry for [`injectWizard`](/docs/multistep/inject-wizard). Anonymous wizards get a synthetic SSR-stable key under the hood. |
| `defaultStatuses` | `Record<key, FormStatus>` &#124; sync factory &#124; async factory | unset               | Seed payload used while a form's defaults are still resolving. See [Statuses](/docs/multistep/statuses).                                                            |
| `progress`        | `(steps) => number`                                                | valid-step fraction | Override the default `progress` computation. The override is invoked inside a `computed`, so read reactive sources only.                                            |
| `focusFirstError` | `boolean`                                                          | `true`              | On submission failure, jump to the first failing form and run its `applyInvalidSubmitPolicy()` (focus / scroll per the form's `onInvalidSubmit` configuration).     |
| `restore`         | `() => { step? }` &#124; `false`                                   | URL `?step=<key>`   | Source of truth for the active step. Watched reactively; re-applies on URL changes. See [URL sync](/docs/multistep/url-sync).                                       |
| `persist`         | `({ step }) => void` &#124; `false`                                | URL `?step=<key>`   | Destination for the active step. Invoked when `currentStep` changes (diffed to break the restore-persist loop). See [URL sync](/docs/multistep/url-sync).           |

## The wizard handle

`useWizard` returns a reactive handle. Every reactive read is a plain getter, no `.value`. Use the rail of links below to reach the page that covers each surface in depth.

| Member               | What it is                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                | The wizard's identifier (explicit or synthetic).                                                                                                                                                                                             |
| `currentStep`        | The active step's key. Typed `string` when the slot tuple is statically non-empty; `string` &#124; `undefined` when a function slot can drop.                                                                                                |
| `activeForm`         | A live view of the active step's form; operating through it always targets the current step. No longer identity-equal to `wizard.forms[currentStep]` (use that for the raw handle). Narrows in lockstep with `currentStep`.                  |
| `activeIndex`        | Zero-based position of the active step.                                                                                                                                                                                                      |
| `isFinalStep`        | `true` when `activeIndex === count - 1`. Gates the Next-vs-Finish split in templates.                                                                                                                                                        |
| `count`              | `steps.length`. Includes affordance positions.                                                                                                                                                                                               |
| `steps`              | Ordered list of compiled `{ key, form }` slots. See [Step slots](/docs/multistep/step-slots).                                                                                                                                                |
| `forms`              | Record indexable by step key. See [Aggregates](/docs/multistep/aggregates).                                                                                                                                                                  |
| `canAdvance`         | `true` when a next step exists. Pure positional check.                                                                                                                                                                                       |
| `canGoBack`          | `true` when a prior step exists.                                                                                                                                                                                                             |
| `complete`           | Forward-looking: `isFinalStep && every-form-valid`. See [Statuses](/docs/multistep/statuses).                                                                                                                                                |
| `done`               | Monotonic: `true` once a `handleSubmit` succeeds; only `reset()` flips it back. See [Statuses](/docs/multistep/statuses).                                                                                                                    |
| `submitting`         | `true` while a `wizard.handleSubmit` call is in flight. Global re-entrance guard.                                                                                                                                                            |
| `submissionAttempts` | Count of `wizard.handleSubmit` invocations.                                                                                                                                                                                                  |
| `visited`            | Append-only breadcrumb of navigated step keys.                                                                                                                                                                                               |
| `progress`           | Fraction in `[0, 1]`. Defaults to valid-step ratio.                                                                                                                                                                                          |
| `statuses`           | Per-key `FormStatus` proxy. See [Statuses](/docs/multistep/statuses).                                                                                                                                                                        |
| `allValues`          | Namespaced record of each step's values. See [Aggregates](/docs/multistep/aggregates).                                                                                                                                                       |
| `allErrors`          | Namespaced record of each step's validation errors. See [Aggregates](/docs/multistep/aggregates).                                                                                                                                            |
| `next` / `back`      | Positional navigation. Refuses while `submitting`.                                                                                                                                                                                           |
| `goTo`               | Jump to a specific step by key. Dev-warn on unknown keys.                                                                                                                                                                                    |
| `tryNext`            | Validate the active step, advance iff valid; resolves to whether the pin moved. The inline-bindable gated Next. See [handleSubmit](/docs/multistep/handle-submit#gating-advance-per-step).                                                   |
| `handleSubmit`       | Whole-wizard submission handler; never advances. See [handleSubmit](/docs/multistep/handle-submit).                                                                                                                                          |
| `reset`              | Zeros wizard lifecycle, resets every form, returns to `steps[0]`, clears the persisted step, flips `done` back, and re-applies the `defaultStatuses` gate seed.                                                                              |
| `relock`             | Re-seal a cleared gate, contingent on a required `commit` callback: awaits your server-side revoke, re-seals only if it resolves clean, resolves whether it sealed. Never opens a gate. See [gate](/docs/multistep/gate#withdrawing-a-gate). |

## Submission, in one place

`wizard.handleSubmit(onSubmit, onError?)` returns one event handler that validates the entire step list, from any step, and calls `onSubmit` once with every step's values. It never advances; bind it to your Finish button.

```ts
const onFinish = wizard.handleSubmit(async (ctx) => {
  await api.checkout({
    shipping: ctx.get(shipping),
    payment: ctx.get(payment),
  })
})
```

To gate a Next button on the active step's validity, reach for `wizard.tryNext()`:

```ts
await wizard.tryNext() // validate the active step, advance only on a clean pass
```

`wizard.tryNext()` binds straight to a control (`@click="wizard.tryNext()"`) and resolves to whether the pin moved. For custom valid or invalid handling, compose the active form's submit with `next()` instead: `wizard.activeForm.handleSubmit(() => wizard.next())`.

See [handleSubmit](/docs/multistep/handle-submit) for the whole-wizard handler in depth, including the gated-advance composition, `focusFirstError`, re-entrance, error aggregation, and the `ctx` shape.

## Navigation

```ts
await wizard.next() // advance one position
wizard.back() // retreat one position
wizard.goTo('shipping-review') // jump to a specific step by key
```

`next` / `back` / `goTo` are pure positional navigation. None of them validate. To gate an advance on the active step, use `wizard.tryNext()` (or compose `wizard.activeForm.handleSubmit(() => wizard.next())` when you need custom valid or invalid handling). Out-of-bounds calls dev-warn and no-op; mid-submission navigation is blocked until `wizard.submitting` clears. A wizard wired into a checkout or signup never throws on navigation.

## URL sync, on by default

A wizard with no extra options reads its starting step from `?step=<key>` on the URL and writes the active step back as the user navigates. Reloads land on the same step, the browser back / forward buttons walk the flow, and the URL is shareable. On the server, the wizard reads the incoming request's `?step` so deep-links render the right step on the first byte.

```ts
import { useForm, useWizard } from 'attaform'

const wizard = useWizard({
  steps: ['welcome', shipping, payment, 'final-review'],
  // restore: defaults to reading ?step=<key>
  // persist: defaults to writing ?step=<key>
})
```

To rename the param, scope it across multiple wizards on the same page, or wire the state to non-URL storage (localStorage, a broadcast channel, a router state field), pass `restore` and `persist` callbacks. See [URL sync](/docs/multistep/url-sync).

## Cross-component access with `key`

Pass `key` to give the wizard a stable identifier. Any descendant component reaches the same reactive handle through [`injectWizard`](/docs/multistep/inject-wizard) without prop-threading:

```ts
const wizard = useWizard({
  steps: ['welcome', shipping, payment, 'final-review'],
  key: 'checkout',
})
```

Anonymous wizards (option omitted) get a synthetic SSR-stable key under the hood and remain reachable via ambient `injectWizard()` from descendants of the parent that called `useWizard`.

## Degenerate inputs

Conditions that would otherwise crash the surrounding app dev-warn and degrade:

- **Empty `steps` array.** Dev-warns and degrades. `wizard.currentStep` reads as `undefined`, navigation refuses, the surrounding app keeps rendering.
- **Duplicate step keys.** First occurrence wins; later duplicates dev-warn and drop.
- **Same form ref in multiple slots.** First slot keeps the canonical position; later slots dev-warn and drop.
- **`defaultStatuses` with an unknown key.** Ignored; known entries still apply.
- **`restore` returns a key not in the compiled steps.** Dev-warn; the wizard falls back to the first step.

A wizard wired into a signup or checkout never crashes the surrounding app for shapes that are clearly a mistake.

## Where to next

- [Step slots](/docs/multistep/step-slots) for the full slot reference (form, string, function, lazy).
- [`injectWizard`](/docs/multistep/inject-wizard) for cross-component access to the wizard handle.
- [Statuses](/docs/multistep/statuses) for the per-step rollup, `defaultStatuses`, `complete`, and `done`.
- [Aggregates](/docs/multistep/aggregates) for `allValues`, `allErrors`, and `forms`.
- [handleSubmit](/docs/multistep/handle-submit) for the universal submission pipeline.
- [URL sync](/docs/multistep/url-sync) for `restore` / `persist` and the SSR hand-off.
- [Patterns](/docs/multistep/patterns) for branching, review surfaces, per-step persistence and undo.
