---
title: useWizard
description: useWizard takes an entry form and walks its declared next links to discover every reachable step. Active form, statuses per step, aggregate errors, navigation methods, handleSubmit with a path-walking validator, a complete signal, and a flow namespace for sitemaps and diagnostics.
metaRows:
  - label: Category
    value: Composable
  - label: Signature
    value: 'useWizard(entryForm, options?)'
    kind: code
  - label: Graph source
    value: 'useForm({ next })' per step
    kind: code
  - label: Aggregates
    value: statuses · allErrors · progress
    kind: code
---

# useWizard

> Compose a graph of `useForm` calls into a reactive wizard. Each form declares its successor via `useForm({ next })`, and `useWizard(entryForm)` walks the graph from there to discover every reachable step, drive navigation, aggregate status, and validate the runtime path on submit.

::docs-meta-table
::

Three small forms chain via `next:` declarations: `account` → `profile` → `review`. `useWizard(account)` walks the chain from the entry form and discovers every reachable step. The progress bar reflects `wizard.progress`, the rail highlights `wizard.current`, and each step keeps its own schema and reactive surface. Tap **Next** / **Back** to walk the chain; the **Finish** button fires on the last step.

::docs-demo{slug="use-wizard" label="Wizard Demo"}
::

## Forms self-describe their position

```ts
import { useForm, useWizard } from 'attaform/zod'
import { z } from 'zod'

const accountSchema = z.object({ email: z.email(), password: z.string().min(8) })
const profileSchema = z.object({ name: z.string().min(1), city: z.string() })
const reviewSchema = z.object({ tos: z.literal(true) })

const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile', next: review })
const account = useForm({ schema: accountSchema, key: 'signup-account', next: profile })

const wizard = useWizard(account)
```

Each step is its own form. Schemas, default values, persistence, and history live per-step; the wizard is a thin orchestrator on top.

### Bottom-up declaration

Declare the terminal form first, the entry form last. The chain reads as "review is terminal; profile flows to review; account flows to profile; the wizard starts at account." TypeScript's temporal dead zone catches a forward reference at compile time, so the convention is enforced by the compiler.

Top-down readers can split each form into its own module and let `import` order drive evaluation. Either layout produces the same reachable graph.

## Branching with `next: { pick, forms }`

A form that routes to one of several successors uses the structured `next` shape. The `pick` callback runs against the form's parsed output (the `z.output` of its schema) and returns one of the declared `forms`:

```ts
const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const userProfile = useForm({ schema: userProfileSchema, key: 'signup-user', next: review })
const adminProfile = useForm({ schema: adminSchema, key: 'signup-admin', next: review })

const accountSchema = z.object({ role: z.enum(['admin', 'user']) })
const account = useForm({
  schema: accountSchema,
  key: 'signup-account',
  next: {
    pick: (parsed) => (parsed.role === 'admin' ? adminProfile : userProfile),
    forms: [adminProfile, userProfile] as const,
  },
})

const wizard = useWizard(account)
```

A few invariants worth keeping in mind:

- `pick(parsed)` receives the schema's parsed output, so the callback is type-safe against the form's `z.output<typeof accountSchema>`. No defensive coding for unparsed input.
- The `forms` tuple is declared `as const` so TypeScript narrows `pick`'s return type to `(typeof forms)[number] | undefined`. Without `as const`, the tuple widens to `AnyForm[]` and the narrowing collapses.
- Returning `undefined` from `pick` flags a dynamic terminal at this moment. The wizard treats the current step as the runtime terminal.
- `pick` is called on navigation and during `wizard.handleSubmit`'s walk, never at construction. Keep it free of side effects.

## The return shape

```ts
type UseWizardReturnType = {
  // Identity
  readonly key: string | undefined

  // Navigation
  readonly current: string | undefined
  readonly activeForm: AnyForm | undefined
  readonly activeIndex: number
  readonly entryForm: AnyForm
  readonly allForms: readonly AnyForm[]
  readonly count: number

  // State signals (reactive getters)
  readonly canAdvance: boolean
  readonly canGoBack: boolean
  readonly complete: boolean
  readonly submitting: boolean
  readonly submissionAttempts: number

  // Aggregates
  readonly statuses: WizardStatusesProxy
  readonly allValues: Record<string, unknown>
  readonly allErrors: readonly AggregateError[]
  readonly progress: number

  // Methods
  readonly next: (options?: WizardNavOptions) => Promise<void>
  readonly back: (options?: WizardNavOptions) => void
  readonly goTo: (key: string, options?: WizardNavOptions) => void
  readonly handleSubmit: (
    onSubmit: WizardOnSubmit,
    onError?: WizardOnError
  ) => (event?: Event) => Promise<void>
  readonly reset: () => void

  // Flow introspection
  readonly flow: WizardFlow
}
```

| Member                   | What it is                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                    | The wizard's identifier for [`injectWizard`](/docs/multistep/inject-wizard). `undefined` when no `key` is passed in options.             |
| `current`                | The active step's key (or `undefined` for a degenerate wizard). Reactive via a getter, so templates branch on it directly.               |
| `activeForm`             | The active step's form handle, identity-equal to the matching entry in `allForms`. `undefined` when `current` is `undefined`.            |
| `activeIndex`            | Zero-based index of the active step within `allForms` (BFS order). `-1` when `current` is `undefined`.                                   |
| `entryForm`              | The form passed to `useWizard(entryForm)`. Identity-equal to the argument; immutable for the wizard's lifetime.                          |
| `allForms`               | BFS-ordered, deduped list of every form reachable from the entry form. Iterate it for a rail, sitemap, or "Step N of M" label.           |
| `count`                  | `allForms.length`.                                                                                                                       |
| `canAdvance`             | `true` when the active form has a non-empty `next` declaration. Graph-structural; reflects the static graph, not the validation state.   |
| `canGoBack`              | `true` when a prior step exists in BFS order (`activeIndex > 0`).                                                                        |
| `complete`               | `true` once `wizard.handleSubmit`'s callback resolves without throwing. Flips back to `false` when any walked-path form becomes dirty.   |
| `submitting`             | `true` while a `wizard.handleSubmit` call is in flight (path walk + callback).                                                           |
| `submissionAttempts`     | Count of `wizard.handleSubmit` invocations (success or failure).                                                                         |
| `statuses`               | Drillable proxy of `FormStatus` per step (`valid`, `dirty`, `submitted`, `errorCount`).                                                  |
| `allValues`              | Drillable record of every step's `values` keyed by form key.                                                                             |
| `allErrors`              | Cross-step `AggregateError[]` for a wizard-wide summary. Dormant (unactivated) steps contribute nothing.                                 |
| `progress`               | Fraction in `[0, 1]`. Count of valid forms divided by total, or the consumer's `progress` override.                                      |
| `next` / `back` / `goTo` | Navigation. `next()` is async because it validates the current step before advancing.                                                    |
| `handleSubmit`           | Returns a submit handler that walks the runtime path, validates every form along the way, then calls the consumer's `onSubmit`.          |
| `reset`                  | Zeros wizard lifecycle and calls `form.reset()` on every reachable form.                                                                 |
| `flow`                   | Introspection namespace: `entryForm`, `tree`, `allForms`, `visited`, `diagnose()`. The structured hand-off for sitemaps and diagnostics. |

Every reactive read is a plain getter, no `.value`. `wizard.current`, `wizard.progress`, `wizard.allErrors` stay reactive inside templates and `computed` blocks directly, matching the rest of Attaform (`form.values`, `form.meta`, etc.).

## `statuses`: how to read it

```ts
wizard.statuses // the whole proxy
wizard.statuses() // → { 'signup-account': FormStatus, 'signup-profile': FormStatus, 'signup-review': FormStatus }
wizard.statuses('signup-account') // → FormStatus for one step
wizard.statuses['signup-account'] // → FormStatus (drillable read)
wizard.statuses['signup-account'].valid // → boolean (reactive)
```

The drillable read is the template-friendly form; the callable form is convenient in script for one-off reads.

`FormStatus` carries `valid`, `dirty`, `submitted`, and `errorCount`. The aggregator gates on each form's `defaultsResolved` so reading a status for a not-yet-activated step returns a pending `FormStatus` without firing that step's factory. The rail can render without thrashing.

## Navigation

```ts
await wizard.next() // validate active step, then advance one
wizard.back() // step back one
wizard.goTo('signup-profile') // jump to a specific step by key
```

`wizard.next()` validates the active form before advancing. An invalid form short-circuits: `next()` resolves without changing `current`, and the form's `applyInvalidSubmitPolicy()` runs to focus or scroll to the first error (per the form's own `onInvalidSubmit` option). `wizard.goTo(key)` does NOT validate; it is the explicit "the user clicked a rail item" hand-off, and `wizard.handleSubmit` catches premature jumps when the user clicks Finish.

`WizardNavOptions` carries `replace?: boolean` for history-replace semantics; see [Browser history](/docs/multistep/history) for the round-trip. Omit it for ordinary navigation. Out-of-bounds calls dev-warn and no-op:

- `next()` at a terminal step.
- `back()` on the first step.
- `goTo(key)` with a key not in the reachable set.

Mid-submission navigation is also blocked: `next` / `back` / `goTo` dev-warn and no-op while `wizard.submitting === true`.

The wizard never throws on navigation. Wired into someone's checkout, Attaform bends rather than crashing the surrounding app.

## Submission with `handleSubmit`

`wizard.handleSubmit(onSubmit, onError?)` returns a submit handler. On invocation it walks the runtime path from the entry form, validates each form along the way, then calls `onSubmit` with the aggregated context:

```vue
<script setup lang="ts">
  import { useForm, useWizard } from 'attaform/zod'

  const review = useForm({ schema: reviewSchema, key: 'signup-review' })
  const profile = useForm({ schema: profileSchema, key: 'signup-profile', next: review })
  const account = useForm({ schema: accountSchema, key: 'signup-account', next: profile })

  const wizard = useWizard(account)

  const finish = wizard.handleSubmit(
    async (ctx) => {
      await api.signup({
        account: ctx.get(account),
        profile: ctx.get(profile),
        review: ctx.get(review),
      })
    },
    (errors) => {
      console.log('Errors across the runtime path', errors)
    }
  )
</script>

<template>
  <button v-if="wizard.canAdvance" @click="wizard.next()">Next</button>
  <button v-else @click="finish">Finish</button>
</template>
```

The same `canAdvance` flag gates the Next-vs-Finish split. No consumer-side completeness check needed.

### The `ctx` shape

```ts
type WizardSubmitContext = {
  readonly values: Record<string, unknown>
  readonly get: <F extends AnyForm>(form: F) => F['values']
  readonly path: readonly AnyForm[]
}
```

- `ctx.values` is the loose-keyed aggregate of every walked form's parsed output. Use it for "POST everything to the backend" wiring.
- `ctx.get(formRef)` returns the form's parsed output, typed by its schema. Works across the wizard's reachable set and also with forms reached through [`injectForm`](/docs/cross-cutting-state/inject-form), since the form ref carries its own schema info.
- `ctx.path` is the ordered runtime path from the entry form to terminal, with branching `pick(parsed)` callbacks resolved against the current parsed values. Iterate it for per-form audit logs or sequential POSTs.

### What `handleSubmit` actually does

1. Sets `wizard.submitting = true`. Per-form `meta.submitting` does NOT flip during the walk; subscribe to `wizard.submitting` for wizard-scoped submitting state.
2. Walks the path starting from the entry form. For each form: activates (await async `defaultValues`), then validates. Activation failure surfaces as a synthetic `ValidationError` with `code: 'atta:activation-failed'` and the walk continues so every problem reaches the consumer.
3. For a single-target `next`, the walk is sequential: errors aggregate and the walk continues to terminal even when an upstream form is invalid.
4. For a branching `next` with the current form **valid**, `pick(parsed)` chooses one branch and the walk recurses on it.
5. For a branching `next` with the current form **invalid**, every declared `forms` subgraph is walked in parallel (`Promise.all`), so prerequisites for every reachable path surface at once without serial latency.
6. Builds `ctx = { values, get, path }` from the runtime path and either calls `onSubmit(ctx)` (all forms valid) or `onError(errors)` (any invalid). On success, `wizard.complete = true`.
7. On failure with `navigateToFirstError: true` (the default), the wizard calls `goTo(firstFailedKey)` then `firstFailedForm.applyInvalidSubmitPolicy()`. The DOM swap lands before the focus call.
8. Always: `wizard.submissionAttempts` increments and `wizard.submitting` returns to `false`.

`wizard.complete` flips back to `false` the first time any walked-path form's `meta.dirty` flips `true`. Editing after a successful submit reads as "ready to submit again."

### Re-entrancy is safe

Double-clicking Finish triggers exactly one walk. The second invocation dev-warns and resolves to a no-op promise while the first is still in flight. The same guard protects `onSubmit` callbacks that call `wizard.handleSubmit` recursively.

## Active form

`wizard.activeForm` is the per-step form handle for the active step, identity-equal to the matching entry in `wizard.allForms`. Reach for the active step's reactive surface without indexing by key:

```vue
<template>
  <form v-if="wizard.activeForm" @submit.prevent="wizard.activeForm.handleSubmit(onSubmit)()">
    <h2>Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}</h2>
    <input v-register="wizard.activeForm.register('email')" />
  </form>
</template>
```

`wizard.activeIndex` pairs with the index for "Step N of M" labels, progress dots, and per-step rails.

## Aggregate errors

`wizard.allErrors` flattens every activated step's errors into one array, in BFS order then per-form order. Each entry carries the originating form's key. Link back to the source field from a wizard-wide summary:

```vue
<template>
  <ul class="wizard-errors">
    <li v-for="err in wizard.allErrors" :key="`${err.formKey}-${err.path.join('.')}`">
      <a :href="`#${err.formKey}`">{{ err.message }}</a>
    </li>
  </ul>
</template>
```

Steps that have not been activated contribute nothing to `allErrors`. That keeps the [activation rule](/docs/multistep/ssr#the-activation-rule) in force: a non-current step with an async `defaultValues` factory will not fire on the server just because the consumer reads the summary list.

## Static analysis at construction

`useWizard(entryForm)` walks the reachable graph BFS-first and surfaces structural anomalies up front:

- **Cycle.** A form whose chain leads back to itself throws at `useWizard(entryForm)` construction. Consumers who want intentional re-entry use `wizard.goTo()` rather than declaring a cycle.
- **Missing terminal.** Every path from entry should reach a terminal (no `next`, or branching with an empty `forms` array). Hard error if no terminal is reachable.
- **Unreachable form.** A form constructed in scope that no chain from entry reaches. Dev-warn.
- **Empty `forms` in branching `next`.** Dev-warn; treated as a terminal.
- **Out-of-`forms` `pick` return.** Runtime throw at the navigation site (TypeScript should catch this at compile time; the runtime check fires only when consumers escape via `any`).
- **Single-step wizard.** Entry has no `next`. Valid; one-time dev note.

Construction-time warnings show up in `wizard.flow.diagnose()` for diagnostic panels.

## Cross-component access with `key`

Pass `key` to register the wizard handle in the per-app registry. Any descendant component can reach the same reactive handle through [`injectWizard`](/docs/multistep/inject-wizard) without prop-threading:

```ts
// Parent SFC
const wizard = useWizard(account, { key: 'signup-wizard' })
```

```ts
// Any descendant SFC
const wizard = injectWizard('signup-wizard')
if (!wizard) return
wizard.next()
```

Anonymous wizards (no `key`) are still reachable via ambient `injectWizard()` from descendants of the parent that called `useWizard`. See [`injectWizard`](/docs/multistep/inject-wizard) for the full lookup contract.

## Degenerate inputs

Conditions that would otherwise crash the surrounding app dev-warn and degrade:

- **Empty reachable set.** A wizard whose entry has no schema-valid graph reads as `count: 0`, `current: undefined`, navigation no-ops with a dev-warn.
- **A form with `key: ''`.** Filtered out of the participating set; dev-warn names the dropped count.
- **Duplicate keys in the reachable graph.** First occurrence wins; dev-warn lists the dropped keys.
- **`defaultStatuses` with an unknown key.** The unknown entry is ignored; the known entries still apply.
- **`getServerActiveStep` returning a key not in the reachable set.** Dev-warn; the wizard falls back to the entry form's `key`.

A wizard wired into someone's signup or checkout never crashes the surrounding app for shapes that are clearly a mistake.

## Where to next

- [`injectWizard`](/docs/multistep/inject-wizard) for cross-component access to the wizard handle.
- [`injectForm`](/docs/cross-cutting-state/inject-form) for single-form sharing across a tree; orthogonal to multistep.
- [Browser history](/docs/multistep/history) for the `?step=<key>` round-trip.
- [Statuses](/docs/multistep/statuses) for the per-step `FormStatus` rollup that feeds rails and progress.
- [Aggregates](/docs/multistep/aggregates) for `allValues` and `allErrors`.
- [Lazy activation](/docs/multistep/lazy-activation) for why dormant steps stay quiet.
- [SSR & render efficiency](/docs/multistep/ssr) for server-side step selection and the activation rule.
