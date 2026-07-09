---
title: Installation
description: Install Attaform with one command. Optional setup sections cover the Nuxt module, the Vue 3 plugin, and the Vite plugin.
---

# Installation

> One command. Attaform bootstraps itself.

Install Attaform and Zod, and you're set.

::ui-install-command{:show-quick-start="false"}
::

That's it for most apps. `useForm` and the `v-register` directive are ready to use as soon as the package is installed. Everything below this section is opt-in.

## Optional: Nuxt module

If you're on Nuxt, we recommend installing the module:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
})
```

What this gets you: the form composables as auto-imports (`useForm`, `useWizard`, `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, `lazy`; see [Auto-imports](#auto-imports)), the SSR hydration plumbing, the Vite plugin, and the Attaform tab inside Nuxt DevTools.

## Optional: Vue 3 plugin

For app-wide defaults (`validateOn`, `debounceMs`, etc.) or explicit control over plugin registration on bare Vue 3, install the plugin in your app entry:

```ts
import { createApp } from 'vue'
import { createAttaform } from 'attaform'
import App from './App.vue'

createApp(App)
  .use(createAttaform({ defaults: { debounceMs: 100 } }))
  .mount('#app')
```

What this gets you: `createAttaform({ defaults })` for app-wide settings that every `useForm` call inherits.

## Optional: Vite plugin

If you're on bare Vue 3 + Vite (not Nuxt), add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { attaform } from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

What this gets you: SSR-rendered `v-register` bindings that match the client-rendered output on initial HTML (no flicker between server paint and hydration), and a leaner production bundle (one Zod adapter shipped instead of both).

## Auto-imports

Both the Nuxt module and the Vite plugin can register Attaform's form composables as auto-imports, so a component reaches for them inside `<script setup>` with no `import` line. The set is the same either way: `useForm`, `useWizard`, `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, and `lazy`.

Under Nuxt, the module registers them for you. Toggle the whole set with the `autoImports` option:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
  attaform: {
    autoImports: true, // default; set false to import the composables yourself
  },
})
```

On bare Vue 3 + Vite, feed the same manifest to `unplugin-auto-import`. `attaform/vite` re-exports it as `attaformAutoImportsMap`, ready to drop into the plugin's `imports` array:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import AutoImport from 'unplugin-auto-import/vite'
import vue from '@vitejs/plugin-vue'
import { attaform, attaformAutoImportsMap } from 'attaform/vite'

export default defineConfig({
  plugins: [AutoImport({ imports: ['vue', attaformAutoImportsMap] }), vue(), attaform()],
})
```

Everything outside that set stays an explicit import: the plugin (`createAttaform`), the custom-input composable (`useRegister`), and the bring-your-own-adapter `useAbstractForm` from `attaform/abstract`. A registered auto-import always loses to an explicit or local binding of the same name, so opting out is only needed when you'd rather keep the names out of global scope entirely.

## Optional: Agent skill

Building with an AI coding assistant? Attaform ships an [Agent Skill](/docs/ai-tooling/agent-skill) that teaches it to write idiomatic Attaform: reach for `useForm`, bind with `v-register`, submit through `handleSubmit`. One command drops it into your project:

```sh
npx attaform skill
```

The skill travels inside the package, so it stays in lockstep with the version you have installed. That same page also covers the machine-readable [`llms.txt`](/llms.txt) index and the full-text [`llms-full.txt`](/llms-full.txt) dump you can hand an agent directly.

## Where to next

- [Quick start](/docs/getting-started/quick-start): your first form, end-to-end.
- [Your first schema](/docs/getting-started/your-first-schema): what Attaform reads from a Zod definition.
- [AI tooling](/docs/ai-tooling/agent-skill): the skill, `llms.txt`, and the full-text docs dump for coding assistants.
