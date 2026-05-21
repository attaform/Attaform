---
title: SSR & the privacy invariant
description: Wizards fire only the current step's async factory on the server. Non-current steps stay dormant regardless of template references. The compile-time transform, the wizard's auto-mark, and form.activate() compose into a stated privacy invariant suitable for regulated-industry consumers.
metaRows:
  - label: Server triggers
    value: 'activate · wizard auto-mark · attaform/vite'
  - label: Wizard skip-list
    value: overrides every other mark for non-current steps
  - label: Active step source
    value: 'getServerActiveStep | URL ?step | forms[0]'
    kind: code
---

# SSR & the privacy invariant

> A wizard composed of three steps with async `defaultValues` factories will fetch one step's data on the server, never three. Non-current steps stay dormant even when their reactive state appears in the rendered template. This is the property that makes `useWizard` safe to wire into government, healthcare, and finance forms whose per-step factories touch sensitive sources.

::docs-meta-table
::

## The stated invariant

An async `defaultValues` factory will not execute on the server unless one of:

1. `form.activate()` is called explicitly in `setup()`, OR
2. The form is the **current step** of a `useWizard`, OR
3. Some component in the rendered tree references the form's reactive state in its template or script-side computeds (via `useForm` or `injectForm`), AND the `attaform/vite` transform is installed.

Non-current steps of a `useWizard` never execute their factories on the server, regardless of template references. The wizard's skip-list overrides every positive trigger above.

That last sentence is the privacy backstop. Even if the transform marks every step's binding as accessed (a template that branches by step would naturally do so), the wizard's non-current-step skip wins.

## Three positive triggers

The three triggers reflect three different consumer intents. The library treats them as equally valid signals that "this form is part of what the server should render."

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
const wizard = useWizard([account, profile, review] as const)
// On the server: account is auto-marked. profile and review are skipped.
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
- Other steps' factories: dormant. The hydration transfer state carries the schema's slim defaults for those keys.
- Client: navigating to a non-current step activates that step's factory on the client (lazy activation handles the rest).

The skip overrides marks even when the consumer explicitly calls `form.activate()` on a non-current step from inside a wizard. The library treats the wizard's privacy contract as load-bearing.

## `getServerActiveStep`

The library is framework-agnostic. It does not import a router or read a session. The consumer reads the request's route, query, header, cookie, or wherever the active step lives, and returns it from a getter:

```ts
import { useRoute } from '#imports' // Nuxt
const route = useRoute()

const wizard = useWizard([account, profile, review] as const, {
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
3. Otherwise the wizard marks `forms[0]`.

The getter runs on both server and client. The consumer's route source must be available on both. Returning a key that doesn't appear in `forms` dev-warns and falls back to `forms[0]`.

## Letting the framework own slow factories

The library does not special-case slow factories. A request timeout, a `<Suspense>` boundary with a fallback, or a Nuxt-level cache header is the framework's job. When the consumer specifically wants client-only fetching for a slow factory:

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

Both compose with the rest of the library without special-casing. The transform's coverage analysis sees the same template either way.

## Transform-uncovered cases

The transform reads one SFC at a time and tracks bindings whose surrounding template references them. Patterns it does not cover:

| Pattern                                            | Why                                                       | Remedy                                              |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `const { register } = useForm(...)`                | No handle name to mark                                    | Save the return in a `form` handle                  |
| `useForm` inside a composable that the SFC imports | Transform sees one SFC at a time                          | Call `form.activate()` in the SFC's `setup()`       |
| `form[someKey].values`                             | Dynamic property access can't prove a reactive read       | Call `form.activate()` for forms the consumer needs |
| Form passed through plain `provide` / `inject`     | Transform sees the upstream call, not the downstream read | Use `injectForm({ key })` so the transform can mark |
| Non-Vite bundlers (Webpack, Rspack, Rollup-plain)  | No transform pass installed                               | Call `form.activate()` for forms that need SSR data |

Uncovered cases degrade to the schema's slim defaults on the server. The client's first interaction activates the factory and the data lands a moment later. No crash, no hydration mismatch, no privacy break.

`form.activate()` is the documented escape hatch. Wiring one explicit call beats every workaround.

## Cross-reference

- [`useWizard`](/docs/multistep/use-wizard) for the navigation surface.
- [Lazy activation](/docs/multistep/lazy-activation) for the activation rule that drives all three positive triggers.
- [SSR hydration with Nuxt](/docs/server-and-ssr/ssr-nuxt) for `attaform/nuxt` setup details.
