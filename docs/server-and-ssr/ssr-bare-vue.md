---
title: 'SSR hydration: bare Vue'
description: Wire renderAttaformState / hydrateAttaformState into your @vue/server-renderer pipeline. Two functions, one inline payload tag, no Nuxt required.
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

# SSR hydration: bare Vue

> Two helper functions bridge the server → client boundary for `@vue/server-renderer` projects. Render the state on the server, escape it for an inline `<script>`, replay it before mount on the client.

::docs-meta-table
::

This page is code-only; bare-Vue SSR runs on a Node server you provide. The end-to-end test at [`test/ssr-bare-vue/round-trip.test.ts`](https://github.com/attaform/Attaform/blob/main/test/ssr-bare-vue/round-trip.test.ts) exercises exactly the pattern below and is the fastest way to read it working.

## Server (`entry-server.ts`)

```ts
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createAttaform, escapeForInlineScript, renderAttaformState } from 'attaform'
import App from './App.vue'

export async function render(url: string) {
  const app = createSSRApp(App)
  // `ssr: true` rather than the `typeof window` heuristic: a server
  // that polyfills window / document would otherwise be detected as a
  // client and skip payload serialisation entirely.
  app.use(createAttaform({ ssr: true }))

  const html = await renderToString(app)

  const attaformState = renderAttaformState(app)
  // escapeForInlineScript encodes every character that could end the
  // script element or be re-read as markup, so the payload can't break
  // out of the <script> tag.
  const payload = escapeForInlineScript(JSON.stringify(attaformState))

  return { html, payload }
}
```

## Server template + injection

The HTML shipped to the browser carries two placeholders: one for the rendered app HTML, one for the inline payload:

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

// Replay the server's form state BEFORE mounting; forms read from
// the hydration bag during setup.
const serialized = (window as { __ATTAFORM_STATE__?: unknown }).__ATTAFORM_STATE__
if (serialized !== undefined) hydrateAttaformState(app, serialized)

app.mount('#app')
```

That's it. Every `useForm` call on the client resolves to the same values the server rendered.

## Why `escapeForInlineScript`

Embedding JSON in an inline `<script>` looks safe, until the JSON contains a literal `</script>` or a U+2028 / U+2029 line separator that breaks JavaScript string parsing. `escapeForInlineScript` rewrites five characters to their `\uXXXX` escapes:

- `<` and `>`, so no sequence in the data can close the script element or open a tag of its own. That covers `</script>` without pattern-matching for it.
- `&`, so nothing in the payload is re-read as an HTML entity.
- U+2028 and U+2029, the two line separators JavaScript string parsing treats as newlines.

The result is still valid JSON: `JSON.parse` on the client round-trips back to the original value, escapes and all. Skip the call and a `notes` field containing `</script>` closes the inline tag mid-payload and breaks the page. Defense in depth: the escape runs unconditionally, even when the data "couldn't" contain those bytes.

## What crosses the wire

Same surfaces as the [Nuxt path](/docs/server-and-ssr/ssr-nuxt):

- `form.values`: whole tree, including nested objects and arrays.
- Schema errors: replayed at hydration, then re-derived by the client's own validation.
- `setErrors` errors: replayed and left alone, so a server rejection survives the boundary.
- `fields`: the whole per-path record: `touched`, `focused`, `blurred`, `connected`, `interacted`, `blurredAfterInteraction`, `updatedAt`.
- `blankPaths`: the "shown empty" state, so a blanked field does not flash its slim default on hydrate.

NOT on the wire:

- History chain (each session walks its own undo timeline).
- In-flight validation. Only settled errors ride the wire, and the client runs its own mount-time pass either way, which re-derives the schema half from the hydrated values and lands on the same errors. A field carrying an [async refinement](/docs/validation/async-refinements) pays for that pass.

## Vite plugin

For bare Vue + Vite, install `attaform/vite` to ensure `v-register` bindings compile correctly under SSR:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { attaform } from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

A native `<input v-register>` renders its value on the server with or without the plugin: the directive's own SSR hook supplies it. What the plugin adds is the rest of the picture. It marks each registered element as connected during the server render, which Vue otherwise skips along with the whole directive lifecycle, so `field.connected` reads `true` on the first paint instead of flipping after hydration. And it reaches inside component hosts: a `<MySelect v-register>` wrapping slotted `<option>`s renders with no `selected` option at all unless the plugin marks it, so the server paints the first option while the form holds a different value, and the client corrects it on hydrate with a mismatch warning to match.

## Common issues

### "The form is empty on the client even though the server rendered values."

- Did you call `hydrateAttaformState(app, payload)` before `app.mount(...)`? It has to land before `setup` runs.
- Does the form's `key` match between server and client? Hard-code it as a string literal. `uuidv4()` or `Math.random()` produces a fresh key per render and breaks the match.

### "The server's rejection disappeared as soon as the user typed."

Check which layer it came from. An error Zod produced on the server is re-derived by the client's validation, so it clears exactly when the value stops being invalid. An error a server route parked with [`form.setErrors`](/docs/submitting/server-side-errors) lives in the user layer, which is never re-derived: it stays until you clear it. Render the message off the error itself, and let each layer decide its own lifetime. Gating it on `!form.fields.<path>.touched` looks like it protects the server's message and does the opposite: from the first interaction onward that field can never show an error again, however wrong the value gets.

### "Hydration mismatch on a component that wraps an input."

Install the `attaform/vite` plugin (see above). A component host is the shape the directive's SSR hook cannot reach on its own, so without the plugin the server renders the wrapper's inner control unmarked and the client marks it, which is the mismatch.

## Where to next

- [SSR hydration: Nuxt](/docs/server-and-ssr/ssr-nuxt): the same round-trip with zero wiring.
- [Performance](/docs/server-and-ssr/performance): what hydration costs at scale.
- [Server-side errors](/docs/submitting/server-side-errors): turn server 4xx responses into reactive form errors with `form.setErrors`.
