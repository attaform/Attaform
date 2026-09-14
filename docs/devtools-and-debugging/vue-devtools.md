---
title: Vue DevTools integration
description: Vite and bare-Vue projects get an Attaform inspector + timeline in the Vue DevTools extension via an optional peer dependency. One inspector node per Vue app on the page.
metaRows:
  - label: Category
    value: Module
  - label: Where
    value: Vue DevTools browser extension
  - label: Peer dep
    value: '@vue/devtools-api (optional)'
    kind: code
  - label: Auto-wired?
    value: yes, when the peer dep is present at runtime
---

# Vue DevTools integration

> For Vite and bare-Vue projects, install one optional peer dep and the Vue DevTools extension shows an **Attaform** inspector + timeline alongside Pinia / Vue Router / components.

::docs-meta-table
::

This page is code-only; the Vue DevTools surface lives in your browser's extension panel, not inside the docs site. Install the extension, open any Vite / bare-Vue Attaform consumer in dev, and pick **Attaform** in the DevTools sidebar to see it.

## Installing

The extension is the same one Vue itself uses; install it once per browser:

```bash
# Chrome / Edge / Firefox web stores
# https://devtools.vuejs.org
```

Then add the peer dep to the project (dev-only):

```bash
npm install -D @vue/devtools-api
```

Attaform auto-wires the inspector + timeline when the dep is present at runtime:

```ts
// main.ts
import { createApp } from 'vue'
import { createAttaform } from 'attaform'
import App from './App.vue'

createApp(App)
  .use(createAttaform()) // devtools: true by default
  .mount('#app')
```

If the peer dep isn't installed at runtime, nothing breaks; the inspector simply doesn't register, and the form library works as usual. Treating the integration as optional means a freshly-cloned project doesn't fail to start just because `@vue/devtools-api` isn't on disk.

## Production builds

Gate the wiring off explicitly in production:

```ts
const attaform = import.meta.env.PROD ? createAttaform({ devtools: false }) : createAttaform()
```

For a zero-overhead production build:

1. Pass `{ devtools: false }` to `createAttaform`.
2. Keep `@vue/devtools-api` in `devDependencies`, not `dependencies`.

The wire-up is code-split, so the chunk isn't pulled in when `devtools: false`; production bundles stay clean even without dropping the peer dep.

## What you see

The extension surfaces most of what the [Nuxt panel](/docs/devtools-and-debugging/devtools-panel) does: form list, editable JSON value tree, schema/user error split, aggregates, and the event timeline. Both render values raw. DevTools is a dev-only surface, and redacting there would be theatre while the same value sits in a breakpoint, a network tab, and a source map.

| Surface              | What it is                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Form list            | One entry per registered form, keyed by `form.key`.                                       |
| Form value           | Editable JSON tree; writes flow through the same store-mutation path.                     |
| Schema / User errors | Split by source.                                                                          |
| Aggregates           | `submitting`, `submissionAttempts`, `departAttempts`, `submitError`, `activeValidations`. |
| Timeline             | `form.change` / `submit.success` / `reset` events with value snapshots.                   |

It appears in the Vue DevTools' inspector list under **Attaform** rather than in the Nuxt DevTools overlay's sidebar. Two differences beyond location: the extension adds `departAttempts` to the aggregates, and it has no per-path Field state section, so the interaction flags for one path are a Nuxt-panel read.

## Multi-app setups

Attaform registers its inspector against the app it was installed on, so each `createAttaform()` call in a micro-frontend setup contributes its own **Attaform** node.

This is the practical advantage over the Nuxt panel for multi-app monorepos: pick the app in the DevTools' app-selector dropdown, the Attaform panel re-binds to that app's forms.

## When to pick which

- **Nuxt project, single app** → [Nuxt DevTools panel](/docs/devtools-and-debugging/devtools-panel). Zero install, dev-only by default.
- **Vite / bare-Vue project** → Vue DevTools extension (this page). One peer dep, extension already useful for unrelated Vue debugging.
- **Multi-app setup (micro-frontend, embedded apps)** → Vue DevTools. Per-app inspection.
- **Both surfaces in one Nuxt project** → both work simultaneously. The Nuxt overlay surfaces the latest `createAttaform` install; the extension surfaces every app.

## Caveats

- **Extension version mismatch.** The Vue DevTools extension and `@vue/devtools-api` evolve in tandem; keep both reasonably current. An outdated extension may not surface newer inspector node types; an outdated peer dep may emit events the extension doesn't render.
- **Privacy across reloads.** The timeline doesn't persist across reloads; reloading the page wipes the visible history. Persistent debug requires copying events out manually.
- **Screen-share hygiene.** Values render raw. Same advice as the browser DevTools console: close before sharing the screen.

## Where to next

- [The Attaform DevTools panel](/docs/devtools-and-debugging/devtools-panel): the Nuxt-native alternative, with a per-path Field state section this one does not have.
- [Troubleshooting](/docs/devtools-and-debugging/troubleshooting): what to look for in the panels when forms misbehave.
