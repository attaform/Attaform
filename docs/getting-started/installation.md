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

What this gets you: `useForm` / `useWizard` / `injectForm` / `useRegister` as auto-imports, the SSR hydration plumbing, the Vite plugin, and the Attaform tab inside Nuxt DevTools.

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

## Where to next

- [Quick start](/docs/getting-started/quick-start): your first form, end-to-end.
- [Your first schema](/docs/getting-started/your-first-schema): what Attaform reads from a Zod definition.
