---
title: SSR hydration — bare Vue
description: Wire renderAttaformState / hydrateAttaformState into your @vue/server-renderer pipeline — two functions, one inline payload tag, no Nuxt required.
metaRows:
  - label: Category
    value: Integration
  - label: Render
    value: renderAttaformState(app)
    kind: code
  - label: Hydrate
    value: hydrateAttaformState(app, payload)
    kind: code
  - label: Inline escape
    value: escapeForInlineScript(payload)
    kind: code
---

# SSR hydration — bare Vue

> Two helper functions bridge the server → client boundary for `@vue/server-renderer` projects. Render the state on the server, escape it for an inline `<script>`, replay it before mount on the client.

::docs-meta-table
::

This page is code-only — bare-Vue SSR runs on a Node server you provide. The end-to-end test at [`test/ssr-bare-vue/round-trip.test.ts`](https://github.com/attaform/attaform/blob/main/test/ssr-bare-vue/round-trip.test.ts) exercises exactly the pattern below and is the fastest way to read it working.

## Server (`entry-server.ts`)

```ts
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createAttaform, escapeForInlineScript, renderAttaformState } from 'attaform'
import App from './App.vue'

export async function render(url: string) {
  const app = createSSRApp(App)
  app.use(createAttaform())

  const html = await renderToString(app)

  const attaformState = renderAttaformState(app)
  // escapeForInlineScript keeps </script> and U+2028 / U+2029
  // separators out of the inline payload so it can't break out of
  // the <script> tag.
  const payload = escapeForInlineScript(JSON.stringify(attaformState))

  return { html, payload }
}
```

## Server template + injection

The HTML shipped to the browser carries two placeholders — one for the rendered app HTML, one for the inline payload:

```html
<body>
  <div id="app"><!--app-html--></div>
  <!--app-payload-->
  <script type="module" src="/src/entry-client.ts"></script>
</body>
```

The request handler swaps both in:

```ts
import fs from 'node:fs/promises'
import { render } from './entry-server'

app.use('*', async (req, res) => {
  const template = await fs.readFile('index.html', 'utf-8')
  const { html, payload } = await render(req.originalUrl)
  const final = template
    .replace('<!--app-html-->', html)
    .replace('<!--app-payload-->', `<script>window.__ATTAFORM_STATE__ = ${payload};</script>`)
  res.status(200).set({ 'Content-Type': 'text/html' }).end(final)
})
```

## Client (`entry-client.ts`)

```ts
import { createSSRApp } from 'vue'
import { createAttaform, hydrateAttaformState } from 'attaform'
import App from './App.vue'

const app = createSSRApp(App)
app.use(createAttaform())

// Replay the server's form state BEFORE mounting — forms read from
// the hydration bag during setup.
const serialized = (window as { __ATTAFORM_STATE__?: unknown }).__ATTAFORM_STATE__
if (serialized !== undefined) hydrateAttaformState(app, serialized)

app.mount('#app')
```

That's it. Every `useForm` call on the client resolves to the same values the server rendered.

## Why `escapeForInlineScript`

Embedding JSON in an inline `<script>` looks safe — until the JSON contains a literal `</script>` or a U+2028 / U+2029 line separator that breaks JavaScript string parsing. `escapeForInlineScript`:

- Replaces `</script>` with `<\/script>`.
- Escapes U+2028 / U+2029 as ` ` / ` `.
- Leaves the JSON valid for `JSON.parse` on the client.

Skip it and a `notes` field containing `</script>` would close the inline tag mid-payload, breaking the page. Defense in depth: the escape runs unconditionally, even when the data "couldn't" contain those bytes.

## What crosses the wire

Same surfaces as the [Nuxt path](/docs/server-and-ssr/ssr-nuxt):

- `form.values` — whole tree, including nested objects and arrays.
- `errors` — every entry in the error map, keyed by path.
- `fields` — `touched` / `focused` / `blurred` / `connected` / `updatedAt` per path.
- `blankPaths` — numeric-blank state survives the boundary.

NOT on the wire:

- History chain (each session walks its own undo timeline).
- Validation in-flight state (re-runs locally on hydrate).

## Vite plugin

For bare Vue + Vite, install `attaform/vite` to ensure `v-register` bindings compile correctly under SSR:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import attaform from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

The plugin rewrites `v-register` directives to a SSR-correct form so the directive's element-tracking machinery matches between server and client renders. Without it, the directive can emit hydration mismatches on first paint.

## Common issues

### "The form is empty on the client even though the server rendered values."

- Did you call `hydrateAttaformState(app, payload)` before `app.mount(...)`? It has to land before `setup` runs.
- Does the form's `key` match between server and client? Hard-code it as a string literal. `uuidv4()` or `Math.random()` produces a fresh key per render and breaks the match.

### "Field errors from the server disappear on first interaction."

By design. Any mutation re-runs validation. Gate the display on `form.fields.<path>.touched` or `form.meta.dirty` to keep server-provided errors visible until the user touches the field.

### "Hydration mismatch on a `<input v-register>` element."

Install the `attaform/vite` plugin (see above). The runtime renders consistent attributes on server and client, but the directive's element-tracking emits identity markers that the compiler needs help to align between SSR and hydration phases.

## Where to next

- [SSR hydration — Nuxt](/docs/server-and-ssr/ssr-nuxt) — the same round-trip with zero wiring.
- [Performance](/docs/server-and-ssr/performance) — what hydration costs at scale.
- [`parseApiErrors`](/docs/server-and-ssr/parse-api-errors) — turn server 4xx responses into reactive form errors.
