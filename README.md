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

**[Try it live →](https://attaform.dev/demos)** Tweak a schema, edit the template, and watch the form rebind in your browser. No install needed.

## Quick start

```bash
npm install attaform zod
```

```vue
<script setup lang="ts">
  import { z } from 'zod'
  import { useForm } from 'attaform' // auto-detects your Zod major

  const schema = z.object({
    username: z.string().min(2, 'At least 2 characters'),
    password: z.string().min(8, 'At least 8 characters'),
  })

  const form = useForm({ schema })

  const onSubmit = form.handleSubmit(async (values) => {
    await fetch('/api/signup', { method: 'POST', body: JSON.stringify(values) })
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

Hand the schema to `useForm`, bind each input with `v-register`, and Attaform owns the values, the coercion, the live errors, and the typed submit payload. That is the whole loop.

**[Full walkthrough →](https://attaform.dev/docs/getting-started/quick-start)** Setting up Nuxt, Vite, or bare Vue? See the [installation guide](https://attaform.dev/docs/getting-started/installation).

## Highlights

- **The schema is the form.** Types, defaults, validation, per-field errors, and the submit payload all flow from one Zod schema. No `any`, no manual type plumbing, on both Zod v3 and v4 from a single `attaform/zod` import. [Why Attaform →](https://attaform.dev/docs/getting-started/why-attaform)
- **`useForm` is the core.** A reactive, fully typed form: read `form.values`, `form.errors`, `form.fields`, and `form.meta` directly, then write with `form.setValue`, `form.reset`, and typed field-array helpers. [The form →](https://attaform.dev/docs/reading-the-form/the-form)
- **`useWizard` for multistep.** Compose forms into a flow with shared navigation, per-step validation, state retained across steps, and deep-link restore. [useWizard →](https://attaform.dev/docs/multistep/use-wizard)
- **SSR-native.** Server-rendered HTML matches the hydrated client with no flash. Auto-wired in Nuxt, one Vite plugin for bare Vue. [SSR in Nuxt →](https://attaform.dev/docs/server-and-ssr/ssr-nuxt)
- **DevTools built in.** Inspect every form on the page, walk its history, and edit values live. No probes to install. [DevTools panel →](https://attaform.dev/docs/devtools-and-debugging/devtools-panel)
- **Secure by construction.** Zero runtime dependencies (no supply-chain surface), prototype-pollution-safe deep writes, and Attaform never throws into your app. [Security policy →](./SECURITY.md)

## Documentation

Full docs live at **[attaform.dev](https://attaform.dev)**.

- [Quick start](https://attaform.dev/docs/getting-started/quick-start): schema, form, submit, in one page.
- [Installation](https://attaform.dev/docs/getting-started/installation): Vue, Nuxt, and Vite setup.
- [Entry points](https://attaform.dev/docs/reference/entry-points): every public export, grouped by subpath.
- [Performance](https://attaform.dev/docs/server-and-ssr/performance): how it scales, when to worry.
- [Troubleshooting](https://attaform.dev/docs/devtools-and-debugging/troubleshooting): common gotchas and fixes.
- [Changelog](./CHANGELOG.md): full release history.

## Status

Pre-1.0. SemVer applies from `v1.0` onward; `0.x` minor bumps may still include breaking changes, each documented in the [changelog](./CHANGELOG.md).

## Security

Found a vulnerability? Please report it privately through the [security policy](./SECURITY.md).

## License

© 2026 [Oswald Chisala](https://www.linkedin.com/in/chisalao/). Released under the [MIT License](./LICENSE).

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
