# 🙌🏽 Attaform

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Node.js Test Suite](https://github.com/attaform/Attaform/actions/workflows/matrix.yml/badge.svg)](https://github.com/attaform/Attaform/actions/workflows/matrix.yml)
[![OpenSSF Scorecard][scorecard-src]][scorecard-href]
[![OpenSSF Best Practices][cii-src]][cii-href]
[![Nuxt][nuxt-src]][nuxt-href]

A type-safe, schema-driven form library for Vue 3 and Nuxt with first-class Zod support.

> Hand a Zod schema to `useForm` and Attaform turns it into a reactive form, typed end-to-end, with live errors and SSR out of the box.
>
> It scales from the simplest forms to the most comprehensive multistep wizards while keeping the core experience clear and focused.
>
> Because Vue and Nuxt devs deserve nice things, too.

**Try it live.** Tweak a schema, edit the template, and watch the form rebind in the browser at [attaform.com/demos](https://www.attaform.com/demos). No install needed.

## Installation

```bash
npm install attaform zod
```

That's it for client-side rendering. Forms render and validate the moment you call `useForm`; the registry self-installs on first use.

### Going further

**Nuxt 3 / 4.** Add the module:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
})
```

**Bare Vue + SSR.** Add the Vite plugin so server-rendered HTML matches the hydrated client (the plugin injects `:value` / `:checked` bindings at compile time):

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue'
import { attaform } from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

The Vite plugin also rewrites `attaform/zod` imports at build time to `attaform/zod-v3` or `attaform/zod-v4`, so your bundle ships only the adapter you actually use.

**App-wide options.** Install the Vue plugin if you want to set defaults or disable devtools:

```ts
// main.ts
import { createApp } from 'vue'
import { createAttaform } from 'attaform'

createApp(App)
  .use(createAttaform({ defaults: { debounceMs: 100 } }))
  .mount('#app')
```

### Recommended tsconfig

Attaform pairs well with `noUncheckedIndexedAccess: true`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

It catches stale `form.values.contacts[N]` reads at compile time. Nuxt 3 / 4 sets this for you.

> **Try it live.** Skip the install and tweak a schema in your browser at [attaform.com/demos](https://www.attaform.com/demos).

## Quick start

```vue
<script setup lang="ts">
  import { z } from 'zod'
  import { useForm } from 'attaform/zod' // auto-detects Zod major

  const schema = z.object({
    username: z.string().min(2, 'At least 2 characters'),
    password: z.string().min(8, 'At least 8 characters'),
  })

  const form = useForm({ schema, key: 'signup' })

  const onSubmit = form.handleSubmit(async (values) => {
    await $fetch('/api/signup', { method: 'POST', body: JSON.stringify(values) })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <input v-register="form.register('username')" placeholder="Username" />
    <small v-if="form.errors.username?.[0]">{{ form.errors.username[0].message }}</small>

    <input v-register="form.register('password')" type="password" placeholder="Password" />
    <small v-if="form.errors.password?.[0]">{{ form.errors.password[0].message }}</small>

    <button :disabled="form.meta.submitting">Sign up</button>
  </form>
</template>
```

`useForm({ schema, key })` returns a Pinia-style reactive form. Read leaves directly, no `.value`:

- **`form.values`**: current values. `form.values.username`, `form.values.address.city`.
- **`form.errors`**: per-field errors, keyed by dotted path. `form.errors.username?.[0]?.message`.
- **`form.fields`**: per-field flags (`dirty`, `touched`, `errors`, `blank`, …). `form.fields.username.dirty`.
- **`form.meta`**: form-level flags and counters (`submitting`, `valid`, `dirty`, `submissionAttempts`, the flat `meta.errors` aggregate, the per-mount `instanceId`, …).
- **`form.history`**: consolidated undo/redo namespace (`undo()`, `redo()`, `clear()`, `canUndo`, `canRedo`, `size`).
- **`form.register(path)`**: typed two-way binding. Pair with `v-register` on `<input>` / `<textarea>` / `<select>`.
- **`form.handleSubmit(onValid, onInvalid?)`**: runs validation, dispatches. The valid callback receives the strict Zod-inferred type.
- **`form.setValue(path, value)`**, **`form.reset()`**, field-array helpers, persistence: see [Entry points](https://www.attaform.com/docs/reference/entry-points).

> **Try it live.** Tweak this schema, edit the template, and watch the form rebind in the browser at [attaform.com/demos](https://www.attaform.com/demos). No install needed.

## `v-register`: one line, every option

`v-register` stays on the same native `<input>`. Every option you add opts into another runtime feature without touching the template structure.

```vue
<input v-register="form.register('email')" />
```

Typed two-way binding to `form.values.email`, with schema-driven coercion at the directive layer.

```vue
<input v-register="form.register('email', { persist: true })" />
```

Same line. The field now writes through to the form's persistence backend on every keystroke, with the sensitive-name guard catching accidental `password`-style opt-ins.

```vue
<input
  v-register="form.register('email', { persist: true, transforms: [lowercase], multiTab: false })"
/>
```

Same line. Add a sync DOM-input transform, opt out of multi-tab sync, all without touching the markup elsewhere.

## Features

- **Schema-driven types.** Every path, value, and error is inferred from your Zod schema. No `any`, no manual type plumbing.
- **Live validation.** `validateOn: 'change'` by default with synchronous `debounceMs: 0`. `'blur'` and `'submit'` (opt-out) modes available. Async refinements await before submit dispatches.
- **Schema-driven coercion.** String DOM input flows into the schema's typed slot (`string→number`, `string→boolean`) at the directive layer. Default-on; pass `useForm({ coerce: false })` to disable or a custom `CoercionRegistry` to extend.
- **Register transforms.** `form.register('slug', { transforms: [lowercase, dashify] })` runs sync write-time normalization before storage commit.
- **First-class multistep.** `useWizard` composes `useForm` instances into a flow with shared navigation, per-step validation, persistence across steps, and deep-link restore.
- **DevTools panel.** Auto-wired in Nuxt. Walk history, edit values live, inspect every form on the page. No probes to install.
- **Discriminated-union variant memory.** Switching a discriminator (`notify.channel: 'email' → 'sms' → 'email'`) restores the previous variant's typed subtree by default. Pass `useForm({ rememberVariants: false })` to drop on switch.
- **Field arrays.** `append` / `prepend` / `insert` / `remove` / `swap` / `move` / `replace`, fully typed at the call site.
- **Drafts and undo / redo.** Per-field opt-in persistence (`localStorage` / `sessionStorage` / IndexedDB / custom backend) and a bounded undo stack.
- **Multi-tab sync.** Same-keyed `useForm` callsites in same-origin tabs auto-pair over `BroadcastChannel` and mirror every mutation in near real-time. Sensitive paths filtered both directions; HTTPS-or-localhost required.
- **Server errors.** `parseApiErrors(payload, { formKey: form.key })` normalizes any API envelope into the same `ValidationError` shape your template already reads. Pair with `form.setFieldErrors(...)`; user errors survive schema revalidation.
- **Stable error codes.** Every `ValidationError` carries `code: string`. Attaform codes (`atta:`) live on the exported `AttaformErrorCode` enum; adapter codes use a `zod:` prefix; consumers pick their own (`api:`, `auth:`, …).
- **Clearable required fields.** The `unset` sentinel marks a field displayed-empty while storage holds the schema's slim default. Submit fails with `'No value supplied'` for required schemas; `.optional()` / `.nullable()` / `.default(N)` opt out.
- **SSR.** Nuxt handles the payload round-trip automatically; bare Vue uses `renderAttaformState` / `hydrateAttaformState`.

## Documentation

Full docs live at [www.attaform.com](https://www.attaform.com):

- [**Quick start**](https://www.attaform.com/docs/getting-started/quick-start): schema, form, submit, in one page.
- [**Why Attaform**](https://www.attaform.com/docs/getting-started/why-attaform): the convictions behind the design.
- [**Entry points**](https://www.attaform.com/docs/reference/entry-points): every public export, grouped by subpath.
- [**useWizard**](https://www.attaform.com/docs/multistep/use-wizard): multistep flows with shared state and validation.
- [**Performance**](https://www.attaform.com/docs/server-and-ssr/performance): how it scales; when to worry.
- [**Troubleshooting**](https://www.attaform.com/docs/devtools-and-debugging/troubleshooting): common gotchas and fixes.
- [**Changelog**](./CHANGELOG.md): full release history.

## Status

Pre-1.0. SemVer applies from `v1.0` onward; 0.x minor bumps may still include breaking changes, each documented in the [Changelog](./CHANGELOG.md).

## License

MIT; see [LICENSE](./LICENSE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/attaform/latest.svg?style=flat&colorA=020420&colorB=00DC82
[npm-version-href]: https://npmjs.com/package/attaform
[npm-downloads-src]: https://img.shields.io/npm/dm/attaform.svg?style=flat&colorA=020420&colorB=00DC82
[npm-downloads-href]: https://npm.chart.dev/attaform
[license-src]: https://img.shields.io/npm/l/attaform.svg?style=flat&colorA=020420&colorB=00DC82
[license-href]: https://npmjs.com/package/attaform
[scorecard-src]: https://img.shields.io/ossf-scorecard/github.com/attaform/Attaform?label=OpenSSF%20Scorecard&style=flat&colorA=020420&colorB=00DC82
[scorecard-href]: https://securityscorecards.dev/viewer/?uri=github.com/attaform/Attaform
[cii-src]: https://img.shields.io/cii/level/13042?label=OpenSSF%20Best%20Practices&style=flat&colorA=020420&colorB=00DC82
[cii-href]: https://www.bestpractices.dev/projects/13042
[nuxt-src]: https://img.shields.io/badge/Nuxt-020420?logo=nuxt.js
[nuxt-href]: https://nuxt.com
