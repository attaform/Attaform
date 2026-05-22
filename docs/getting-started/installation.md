---
title: Installation
description: Install Attaform across Vue 3, Nuxt, and Vite — pick the entry that fits your stack, run one command, and the directive auto-registers.
---

# Installation

> One command per stack — the package, the schema adapter, and the Vite plugin where it helps.

## Vue 3

```bash
pnpm add attaform zod
```

Install the plugin once in your app entry; the `v-register` directive auto-registers:

```ts
import { createApp } from 'vue'
import { createAttaform } from 'attaform'
import App from './App.vue'

createApp(App).use(createAttaform()).mount('#app')
```

## Nuxt

The Nuxt module ships the plugin, the Vite plugin, SSR hydration helpers, and the DevTools panel — all wired:

```bash
pnpm add attaform zod
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
})
```

That's it. Auto-imports, runtime, and SSR plugin are installed for you.

## Vite (without Nuxt)

Add the build plugin to your `vite.config.ts` so the `attaform/zod` import gets rewritten to the matching adapter at build time:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { attaform } from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

The plugin trims the production bundle by routing `attaform/zod` to `attaform/zod-v3` or `attaform/zod-v4` depending on the installed Zod major.

## Where to next

- [Quick start](/docs/getting-started/quick-start) — your first form, end-to-end.
- [Your first schema](/docs/getting-started/your-first-schema) — what Attaform reads from a Zod definition.
