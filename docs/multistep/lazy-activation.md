---
title: Lazy activation
description: Forms stay dormant until something reaches for them. The activation rule, form.activate() for the explicit kickoff, and the form.ready / form.hydrating / form.hydrateError state machine compose for spinners, error banners, and stale-while-revalidate patterns.
metaRows:
  - label: Trigger
    value: any reactive read or write
  - label: Explicit kickoff
    value: 'form.activate()'
    kind: code
  - label: State signals
    value: 'ready · hydrating · hydrateError'
    kind: code
---

# Lazy activation

> A `useForm` factory does not fire at construction. It fires the first time any consumer reaches for the form's reactive state (template read, script-side computed, set / register / submit call), or when the consumer calls `form.activate()` explicitly. Dormant forms are silent: no fetch, no compute, no log noise.

::docs-meta-table
::

## The activation rule

The rule is "all or nothing, except `form.key`." Any reactive interaction with the form activates its factory. The only non-triggering accessor is the form's identifier.

| API surface                                                                                                                          | Activates? |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `form.values.<path>`, `form.fields.<path>`, `form.meta.<anything>`, `form.errors`                                                    | yes        |
| `form.ready`, `form.hydrating`, `form.hydrateError`                                                                                  | yes        |
| `form.setValue`, `setValues`, `register`, `setFieldErrors`, `addFieldErrors`, `clearFieldErrors`, `setFormErrors`, `clearFormErrors` | yes        |
| `form.handleSubmit`, `validate`, `validateAsync`, `process`                                                                          | yes        |
| `form.reset`, `resetField`, `clear`                                                                                                  | yes        |
| `form.persist`, `clearPersistedDraft`, `toRef`, `history`                                                                            | yes        |
| `form.rehydrate`, `form.activate`                                                                                                    | yes        |
| `<input v-register="form.register('x')" />` mounting                                                                                 | yes        |
| `form.key`                                                                                                                           | no         |

Observing factory state (`form.ready`, `form.hydrating`, `form.hydrateError`) activates the factory deliberately. Reading these implies the consumer is about to gate UI on the answer; firing the factory is the only way to produce a real answer.

The wizard's `wizard.statuses` proxy is the deliberate exception. Reading a step's status does NOT activate it. See [Statuses](/docs/multistep/statuses).

## `form.activate()` for the explicit kickoff

For SSR prefetch, or when the consumer wants to start fetching ahead of the first reactive read:

```ts
import { useForm } from 'attaform/zod'

const userSchema = z.object({ email: z.email(), name: z.string() })
const userForm = useForm({
  schema: userSchema,
  defaultValues: async () => api.fetchUser(),
})
void userForm.activate()
```

`activate()` returns a `Promise<void>` that resolves when the factory settles (or rejects normalised into `hydrateError`). Consumers may ignore the promise (`void form.activate()`) when they don't need to await.

The method is idempotent in the strongest sense: every call against the same form returns the SAME in-flight promise until the factory settles. Two consumers (a parent's `useForm` and a descendant's `injectForm`) calling `activate()` concurrently share one factory run. SSR consumers reading the same store all await the same fetch.

A previously-rejected factory leaves `activate()` as a no-op (the consumer's [`form.rehydrate()`](/docs/schemas/defaults#loading-defaults-asynchronously) is the explicit replay). That keeps a reactive read of `form.hydrateError` from accidentally retrying a broken fetch in an effect loop.

## The lifecycle: three orthogonal signals

`hydrating`, `ready`, and `hydrateError` compose. They are not exclusive states:

| Stage                                | hydrating | ready   | hydrateError |
| ------------------------------------ | --------- | ------- | ------------ |
| Dormant (pre-activation)             | `false`   | `false` | `null`       |
| Activated, factory running           | `true`    | `false` | `null`       |
| Factory resolved                     | `false`   | `true`  | `null`       |
| Factory rejected                     | `false`   | `false` | `Err`        |
| `rehydrate()` from ready, running    | `true`    | `true`  | `null`       |
| Rehydrate resolved from ready        | `false`   | `true`  | `null`       |
| Rehydrate rejected from ready        | `false`   | `true`  | `Err`        |
| `rehydrate()` from rejected, running | `true`    | `false` | `null`       |
| Rehydrate resolved from rejected     | `false`   | `true`  | `null`       |
| Rehydrate rejected from rejected     | `false`   | `false` | `Err`        |

`ready` stays `true` once the form has ever resolved successfully, even through refetches. Stale-while-revalidate (the form has current data AND is fetching new data) reads as `ready: true, hydrating: true, hydrateError: null`.

## Composing the signals in templates

The three signals fall into clean UI patterns:

```vue
<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  const userForm = useForm({
    schema: userSchema,
    defaultValues: async () => api.fetchUser(),
  })
</script>

<template>
  <Spinner v-if="!userForm.ready && userForm.hydrating" />

  <ErrorBanner v-if="!userForm.ready && userForm.hydrateError" :error="userForm.hydrateError" />

  <form v-if="userForm.ready" @submit.prevent="onSubmit">
    <input v-register="userForm.register('email')" />
    <SmallSpinner v-if="userForm.hydrating" />
  </form>
</template>
```

Read each guard left-to-right:

- "Not yet ready, currently fetching" produces the initial load spinner.
- "Not yet ready, fetch failed" produces the initial load error banner.
- "Ready" reaches the main render. Inside it, `userForm.hydrating` flags any refresh-in-flight so a small spinner can hint without disrupting the form.

## Privacy follows activation

A form that no one touches never fires its factory. That is the load-bearing property behind the [SSR privacy invariant](/docs/multistep/ssr): a non-current step of a `useWizard` is not just "skipped on the server." It is genuinely dormant. No fetch fires. No PII fields leave the browser's network tab.

The lazy default is what makes `attaform/vite`'s compile-time `__ssrAccessed` injection meaningful. The transform's whole job is to mark forms whose template references prove "this consumer wants this fetched on the server." Without lazy-by-default, every form would fetch and the transform would have nothing to opt-in to.

## Cross-reference

- [SSR & the privacy invariant](/docs/multistep/ssr) for the server-side implications.
- [Statuses](/docs/multistep/statuses) for the read surface that does NOT activate (`wizard.statuses`).
- [Defaults from the schema](/docs/schemas/defaults) for `rehydrate()` and the async-factory contract.
