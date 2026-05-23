---
title: SSR & render efficiency
description: useWizard fires only the current step's async factory on the server. Non-current steps stay quiet regardless of template references. The compile-time transform, the wizard's auto-mark, and form.activate() compose into a single activation rule, render only what's seen.
metaRows:
  - label: Server triggers
    value: 'activate · wizard auto-mark · attaform/vite'
  - label: Wizard skip-list
    value: overrides every other mark for non-current steps
  - label: Active step source
    value: 'getServerActiveStep | URL ?step | flow.entryForm'
    kind: code
---

# SSR & render efficiency

> A wizard with three steps fetches one step's data on the server, never three. A wizard with forty steps still fetches one. Non-current steps stay quiet even when their reactive state appears in the rendered template. Attaform ships only what the user actually sees.

::docs-meta-table
::

## The activation rule

An async `defaultValues` factory will not execute on the server unless one of:

1. `form.activate()` is called explicitly in `setup()`, OR
2. The form is the **current step** of a `useWizard`, OR
3. Some component in the rendered tree references the form's reactive state in its template or script-side computeds (via `useForm` or `injectForm`), AND the `attaform/vite` transform is installed.

Non-current steps of a `useWizard` never execute their factories on the server, regardless of template references. The wizard's skip-list overrides every positive trigger above.

That last sentence is the render-efficiency floor. Even when the transform marks every step's binding as accessed (a template that branches by step would naturally do so), the wizard's non-current-step skip wins. A 40-step wizard saves 39 fetches per request.

## Three positive triggers

The three triggers reflect three different consumer intents. Attaform treats them as equally valid signals that "this form is part of what the server should render."

### 1. Explicit `form.activate()`

For forms that the wizard doesn't own (standalone `useForm` calls outside a wizard, sibling forms on the same page), the consumer signals server-side intent directly:

```ts
import { useForm } from 'attaform/zod'
import { z } from 'zod'

const userSchema = z.object({ email: z.email() })
const userForm = useForm({
  schema: userSchema,
  defaultValues: async () => api.fetchUser(),
})
void userForm.activate()
```

`activate()` is idempotent. Multiple consumers (parent `useForm`, descendant `injectForm`) sharing the same key share one factory run via a shared activation promise. The hook waits for the resolved values before render begins.

### 2. Wizard auto-mark of the current step

When `useWizard` constructs on the server, it marks the active step's form for prefetch synchronously. The consumer needs no extra wiring; the wizard's UX contract ("current step is what the user sees") earns the mark on its own:

```ts
const review = useForm({ schema: reviewSchema, key: 'signup-review' })
const profile = useForm({ schema: profileSchema, key: 'signup-profile', next: review })
const account = useForm({ schema: accountSchema, key: 'signup-account', next: profile })

const wizard = useWizard(account)
// On the server, account is auto-marked. profile and review stay quiet.
```

`getServerActiveStep` (below) is how the consumer tells the wizard which step is current on each request.

### 3. Compile-time `__ssrAccessed` from `attaform/vite`

For forms whose reactive state the surrounding `<template>` reads (the most common pattern), the `attaform/vite` plugin's SFC transform injects `__ssrAccessed: true` into the call's options at build time. The runtime registry enqueues the key on the SSR prefetch queue, and the `onServerPrefetch` hook fires the factory:

```vue
<!-- ProductPage.vue -->
<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  const productForm = useForm({
    schema: productSchema,
    defaultValues: async () => api.fetchProduct(),
  })
</script>

<template>
  <input v-register="productForm.register('name')" />
</template>
```

The build emits:

```ts
const productForm = useForm({
  __ssrAccessed: true, // injected by the transform
  schema: productSchema,
  defaultValues: async () => api.fetchProduct(),
})
```

Consumers never write `__ssrAccessed` directly. It's an internal mark whose presence is the transform's signal to the runtime.

## The skip-list backstop

Non-current steps of a `useWizard` are added to the registry's skip set on the server, regardless of any positive trigger that might have fired for the same key. A template that conditionally branches across all three steps (so the transform marks all three forms) still produces:

- `wizard.activeForm` factory: fires on the server, payload bakes into hydration.
- Other steps' factories: quiet. The hydration transfer state carries the schema's slim defaults for those keys.
- Client: navigating to a non-current step activates that step's factory on the client (lazy activation handles the rest).

The skip overrides marks even when the consumer explicitly calls `form.activate()` on a non-current step from inside a wizard. Attaform treats the wizard's render-efficiency contract as load-bearing.

## `getServerActiveStep`

Attaform is framework-agnostic. It does not import a router or read a session. The consumer reads the request's route, query, header, cookie, or wherever the active step lives, and returns it from a getter:

```ts
import { useRoute } from '#imports' // Nuxt
const route = useRoute()

const wizard = useWizard(account, {
  getServerActiveStep: () => {
    const step = route.query.step
    if (typeof step === 'string')
      return step as 'signup-account' | 'signup-profile' | 'signup-review'
    return undefined
  },
})
```

The wizard consults `getServerActiveStep()` **before** deciding which form's factory to mark for prefetch. The fallback chain:

1. `getServerActiveStep()` returns a known key. The wizard marks that form.
2. Returns `undefined` and the request URL carries `?step=<key>` (matched against `history.param`). The wizard marks that form.
3. Otherwise the wizard marks `flow.entryForm` (the entry form passed to `useWizard`).

The getter runs on both server and client. The consumer's route source must be available on both. Returning a key that doesn't appear in the reachable graph dev-warns and falls back to `flow.entryForm`.

## Letting the framework own slow factories

Attaform does not special-case slow factories. A request timeout, a `<Suspense>` boundary with a fallback, or a Nuxt-level cache header is the framework's job. When the consumer specifically wants client-only fetching for a slow factory:

```ts
const reportForm = useForm({
  schema: reportSchema,
  defaultValues: async () => api.fetchExpensiveReport(),
})
if (import.meta.client) void reportForm.activate()
```

Or wrap the consuming component:

```vue
<ClientOnly>
  <ExpensiveReport />
</ClientOnly>
```

Both compose with the rest of Attaform without special-casing. The transform's coverage analysis sees the same template either way.

## Transform-uncovered cases

The transform reads one SFC at a time and tracks bindings whose surrounding template references them. Patterns it does not cover:

| Pattern                                            | Why                                                       | Remedy                                              |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `const { register } = useForm(...)`                | No handle name to mark                                    | Save the return in a `form` handle                  |
| `useForm` inside a composable that the SFC imports | Transform sees one SFC at a time                          | Call `form.activate()` in the SFC's `setup()`       |
| `form[someKey].values`                             | Dynamic property access can't prove a reactive read       | Call `form.activate()` for forms the consumer needs |
| Form passed through plain `provide` / `inject`     | Transform sees the upstream call, not the downstream read | Use `injectForm({ key })` so the transform can mark |
| Non-Vite bundlers (Webpack, Rspack, Rollup-plain)  | No transform pass installed                               | Call `form.activate()` for forms that need SSR data |

Uncovered cases degrade to the schema's slim defaults on the server. The client's first interaction activates the factory and the data lands a moment later. No crash, no hydration mismatch, no surprise fetch.

`form.activate()` is the documented escape hatch. Wiring one explicit call beats every workaround.

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for the navigation surface.
- [Lazy activation](/docs/multistep/lazy-activation) for the activation rule that drives all three positive triggers.
- [SSR hydration with Nuxt](/docs/server-and-ssr/ssr-nuxt) for `attaform/nuxt` setup details.
