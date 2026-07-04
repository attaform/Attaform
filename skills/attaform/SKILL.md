---
name: attaform
description: Build type-safe, schema-driven forms in Vue 3 and Nuxt with Attaform (first-class Zod). Use when creating, editing, or debugging a form (inputs, validation, submission, multistep wizards, or SSR) in a project that has the `attaform` package installed. Covers the correct import surface, the useForm handle, the v-register directive, reading validation state, handleSubmit, server-error routing, and wizards.
license: MIT
---

# Building forms with Attaform

Attaform turns a Zod schema into a reactive, typed Vue form: one schema declares the shape, the defaults, the validation, and the per-field errors, and Attaform builds the reactive surface around it. Use this skill when writing or editing a form in a project that depends on `attaform`.

## Imports

Everything comes from the `attaform` barrel:

```ts
import {
  useForm,
  useWizard,
  injectForm,
  injectWizard,
  useRegister,
  fieldMeta,
  withMeta,
  lazy,
} from 'attaform'
```

- **Do not import `useForm` from `attaform/abstract`.** That entry is the bring-your-own-adapter escape hatch: it exports `useAbstractForm`, which needs a schema adapter wired by hand. A Zod project wants `useForm` from `attaform`. (This mismatch is the single most common first-try mistake.)
- `attaform/zod` is the same surface named explicitly; `attaform/zod-v3` and `attaform/zod-v4` pin a Zod major. Any of these works; default to `attaform`.
- In **Nuxt** with the module installed (`attaform/nuxt`), this surface auto-imports and the `v-register` directive is registered globally, so a component needs no import lines at all. In **plain Vite**, add the Attaform plugin from `attaform/vite` plus the auto-import preset it exports.

## Build a form

Three moves: hoist the schema, hand it to `useForm`, bind each input with `v-register`. Submit through `form.handleSubmit`.

```vue
<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters'),
  })

  const form = useForm({ schema, key: 'sign-in' })

  const onSubmit = form.handleSubmit(async (values) => {
    await fetch('/api/sign-in', { method: 'POST', body: JSON.stringify(values) })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <label>
      Password
      <input type="password" v-register="form.register('password')" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <button :disabled="form.meta.submitting" type="submit">Sign in</button>
  </form>
</template>
```

Prefer an explicit `key` (`useForm({ schema, key: 'sign-in' })`): it makes the form reachable through `injectForm('sign-in')`, survives parent refactors, and reads clearly at the call site. Anonymous `useForm({ schema })` is the fallback for a single throwaway form.

## Rules

- **Use the form handle. Don't destructure.** Keep the `const form = useForm(...)` handle and reach for `form.register(...)`, `form.setValue(...)`, `form.meta`. Destructuring loses the reactive bindings and the central noun.
- **Bind with `v-register`; never write through `form.values`.** Inputs write back through the directive, which also injects SSR values and keeps ARIA in sync. `form.values` is a read view, and it is a callable proxy (so `typeof form.values === 'function'`): `schema.safeParse(form.values)` compiles but fails at runtime with "expected object, received function". To check validity read `form.meta.valid`; for a plain snapshot call `form.values()` (or `form.values('a.b')` for a subtree).
- **Let `handleSubmit` do the work.** It validates, calls `onSubmit` with the parsed values, and on an invalid submit focuses the first offending field (client-invalid fields and server errors set via `setErrors` alike). No manual focus call and no `novalidate` ceremony are needed.
- **Never disable the submit button on validity.** Let the user click; the failed submit focuses the first error and reveals it, which is clearer than a disabled button (which also drops out of the tab order for keyboard and screen-reader users). Gate only on `form.meta.submitting` (a submit in flight) or `!form.meta.dirty` (an edit form with nothing to save). If a field's only guard was the disabled button, move the requirement into the schema (`.min(1)`, `.refine(...)`) so `handleSubmit` actually fails on it.
- **Read errors through `field.showErrors` and `field.firstError?.message`.** The visibility heuristic lives in `showErrors` (reward-early, punish-late); reaching into `field.errors[0]` directly bypasses it. The async "checking" indicator is `field.showPending`.
- **Route server errors through `form.setErrors(...)` inside the callback.** `setErrors` replaces the whole user-error layer, so call `form.clearErrors()` at the top of the submit for a fresh attempt. If the backend emits Attaform's `ValidationError` shape (`{ message, path, code, data }`), pass it straight in; do not build a translation layer.
- **Banners read `form.meta.firstOwnError`,** the form's own error bucket, not `form.errors([])` (which is the whole-form aggregate and would surface field errors in the summary).
- **Accessibility is automatic.** `v-register` keeps `aria-invalid`, `aria-busy`, `aria-required`, and `aria-describedby` in sync and emits them during SSR. Put `form.fields.<path>.aria.errorId` on the error element so `aria-describedby` resolves. Author any ARIA attribute yourself to take that one over, or pass `autoAria: false` to opt out.
- **Reach with `?.` on injected forms.** `injectForm()` and `injectWizard()` return `T | null`; chain optional access (`form?.register('email')`) at every consumption site.
- **Put labels on the schema, not the template.** `z.string().register(fieldMeta, { label: 'Email' })`; read it back through `form.fields.email.label` (resolved, with a humanized-path fallback when nothing is registered).
- **Native inputs first.** Bind `<input>`, `<select>`, `<textarea>` with `v-register`. Reach for `useRegister` only inside a custom input component that wraps a native control.
- **`v-register` alone does binding, SSR value injection, and ARIA.** Do not stack `@change` handlers, reset-signal props, or watchers on top of it. If a control seems to need that scaffolding, the idiomatic shape is being missed.

## Wizards

Compose multiple `useForm` instances under `useWizard`:

```ts
import { useForm, useWizard } from 'attaform'

const account = useForm({ schema: accountSchema, key: 'account' })
const profile = useForm({ schema: profileSchema, key: 'profile' })

const wizard = useWizard({ steps: [account, 'review', profile] })

const onComplete = wizard.handleSubmit(async (ctx) => {
  await fetch('/onboarding', { method: 'POST', body: JSON.stringify(ctx.values) })
})
```

- A step is a `useForm` reference, a **bare string** (an informational or affordance step with no schema and no `useForm`), `null` / `undefined` (filtered out), or a function returning one of those.
- **`wizard.tryNext()`** is the gated Next: it validates the active step and advances only on a clean pass, revealing that step's errors in place otherwise. Bind it straight to a button (`@click="wizard.tryNext()"`).
- **`wizard.handleSubmit(onSubmit)`** validates every step from any position and calls `onSubmit` once with every form's values. It **never advances**; wire it to the final Submit. Navigation and submission are separate verbs.
- Reach a step form from a descendant with `injectForm('account')`. Keyed lookup resolves by component-tree position and mount timing, not as a global address, so create the form in the coordinating ancestor and inject it downward rather than in a leaf.

## SSR

SSR is automatic under the Nuxt module or the Vite plugin: field values, `checked`, and `selected` are injected into the first paint and ARIA is emitted, with no extra wiring. Confirm any SSR behavior through the real build (curl the rendered HTML), not a bare unit render: the value injection is a build-time compiler transform that a plain Vitest render does not run, so an isolated render can false-negative.

## Going deeper

- `llms.txt` (curated index): https://attaform.dev/llms.txt
- `llms-full.txt` (every doc, concatenated): https://attaform.dev/llms-full.txt
- Docs: https://attaform.dev
- Source and issues: https://github.com/attaform/Attaform
