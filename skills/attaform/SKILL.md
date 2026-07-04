---
name: attaform
description: Build type-safe, schema-driven forms in Vue 3 and Nuxt with Attaform (first-class Zod). Use when creating, editing, or debugging a form (inputs, validation, submission, multistep wizards, or SSR) in a project that has the `attaform` package installed. Covers the correct import surface, the useForm handle, the v-register directive, reading validation state, handleSubmit, server-error routing, and wizards.
license: MIT
---

# Building forms with Attaform

Attaform turns a Zod schema into a reactive, typed Vue form: one schema declares the shape, the defaults, the validation, and the per-field errors, and Attaform builds the reactive surface around it. Use this skill when writing or editing a form in a project that depends on `attaform`.

This file covers the common case end to end. For depth on one area, load the matching file in `references/` (indexed at the bottom).

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

- **Do not import `useForm` from `attaform/abstract`.** That entry is the bring-your-own-adapter escape hatch: it exports `useAbstractForm`, which needs a schema adapter wired by hand. A Zod project wants `useForm` from `attaform`. This mismatch is the single most common first-try mistake.
- Types come from the same barrel: `import type { AnyForm, WizardCtx, Json, ValidationError } from 'attaform'`.
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
      <input v-register="form.register('password')" type="password" autocomplete="off" />
      <em v-if="form.fields.password.showErrors">{{ form.fields.password.firstError?.message }}</em>
    </label>
    <button :disabled="form.meta.submitting" type="submit">Sign in</button>
  </form>
</template>
```

Prefer an explicit `key` (`useForm({ schema, key: 'sign-in' })`): it makes the form reachable through `injectForm('sign-in')`, survives parent refactors, and reads clearly at the call site. Anonymous `useForm({ schema })` is the fallback for a single throwaway form.

## Rules

- **Use the form handle. Don't destructure.** Keep `const form = useForm(...)` and reach for `form.register(...)`, `form.setValue(...)`, `form.meta`. Destructuring loses the reactive bindings.
- **Bind with `v-register`; never write through `form.values`.** `form.values` is a read view and a callable proxy (`typeof form.values === 'function'`), so `schema.safeParse(form.values)` compiles but fails at runtime. Read `form.meta.valid` for validity; call `form.values()` for a plain snapshot (`form.values('a.b')` for a subtree).
- **Let `handleSubmit` do the work.** It validates, calls `onSubmit` with the parsed values, and focuses the first offending field on an invalid submit. No manual focus and no `novalidate` ceremony.
- **Never disable the submit button on validity.** Let the user click; the failed submit focuses the first error and reveals it. Gate only on `form.meta.submitting` or `!form.meta.dirty`. If a field's only guard was the disabled button, move the requirement into the schema (`.min(1)`, `.refine(...)`). See `references/validation.md`.
- **Read errors through `field.showErrors` and `field.firstError?.message`.** The visibility heuristic lives in `showErrors`; reaching into `field.errors[0]` bypasses it. The async "checking" indicator is `field.showPending`.
- **Route server errors through `form.setErrors(...)` inside the callback.** `setErrors` replaces the whole user-error layer, so call `form.clearErrors()` at the top of the submit for a fresh attempt. See `references/errors.md`.
- **Banners read `form.meta.firstOwnError`,** the form's own error bucket, not `form.errors([])` (the whole-form aggregate). See `references/errors.md`.
- **Accessibility is automatic.** `v-register` keeps `aria-invalid`, `aria-busy`, `aria-required`, and `aria-describedby` in sync and emits them during SSR. Put `form.fields.<path>.aria.errorId` on the error element so `aria-describedby` resolves. Author any ARIA attribute yourself to take it over, or pass `autoAria: false` to opt out.
- **Reach with `?.` on injected forms.** `injectForm()` and `injectWizard()` return `T | null`; chain optional access (`form?.register('email')`) at every consumption site.
- **Put labels on the schema, not the template.** `z.string().register(fieldMeta, { label: 'Email' })`; read it back through `form.fields.email.label` (resolved, with a humanized-path fallback).
- **Native inputs first.** Bind `<input>`, `<select>`, `<textarea>` with `v-register`. Reach for `useRegister` only inside a custom input component. See `references/custom-components.md`.
- **`v-register` alone does binding, SSR value injection, and ARIA.** Do not stack `@change` handlers, reset-signal props, or watchers on top of it. If a control seems to need that scaffolding, the idiomatic shape is being missed.

## Wizards

Compose multiple `useForm` instances under `useWizard`. Navigation and submission are separate verbs: `wizard.tryNext()` is the gated Next (validates the active step, advances on a clean pass), and `wizard.handleSubmit(onSubmit)` validates every step from any position and calls `onSubmit` once with all values, but **never advances**.

```ts
import { useForm, useWizard } from 'attaform'

const account = useForm({ schema: accountSchema, key: 'account' })
const profile = useForm({ schema: profileSchema, key: 'profile' })

const wizard = useWizard({ steps: [account, 'review', profile] })

const onComplete = wizard.handleSubmit(async (ctx) => {
  await fetch('/onboarding', { method: 'POST', body: JSON.stringify(ctx.values) })
})
```

A step is a `useForm` reference, a bare string (an informational step with no schema), `null` / `undefined` (filtered out), or a function returning one of those. Full patterns, the declarative step registry, and the keyed-injection gotchas live in `references/wizards.md`.

## SSR

SSR is automatic under the Nuxt module or the Vite plugin: field values, `checked`, and `selected` are injected into the first paint and ARIA is emitted, with no extra wiring. Confirm any SSR behavior through the real build (curl the rendered HTML), not a bare unit render. The value injection is a build-time compiler transform that a plain Vitest render does not run. See `references/ssr.md`.

## Reference files

Load one when the task reaches its area:

- **`references/wizards.md`**: multistep flows. The declarative step registry, `tryNext` vs `handleSubmit`, using a wizard as a flat multi-form coordinator, and how keyed `injectForm` / `injectWizard` resolve.
- **`references/errors.md`**: routing server and API errors. The `ValidationError` envelope, `setErrors` / `clearErrors`, the own-vs-subtree error axis, banners, and the one-normalizer pattern.
- **`references/custom-components.md`**: wrapping an input or binding a third-party component. `useRegister`, the three orthogonal primitives, attribute fallthrough, and the optional `form-key` prop.
- **`references/ssr.md`**: debugging SSR and hydration. Why the value injection is a build-time transform, how to confirm it faithfully, and the test traps to avoid.
- **`references/validation.md`**: designing the schema. Client-is-UX / server-is-truth, keeping closed sets in sync, and why a clearable edit field is a required string.

## Going deeper

- `llms.txt` (curated index): https://attaform.dev/llms.txt
- `llms-full.txt` (every doc, concatenated): https://attaform.dev/llms-full.txt
- Docs: https://attaform.dev
- Source and issues: https://github.com/attaform/Attaform
