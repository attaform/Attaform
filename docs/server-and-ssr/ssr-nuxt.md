---
title: 'SSR hydration: Nuxt'
description: Server-rendered Vue 3 forms round-trip values, errors, and field flags to the client automatically via attaform/nuxt. No hydration flicker, no manual wiring.
metaRows:
  - label: Category
    value: Integration
  - label: Setup
    value: 'modules: [attaform/nuxt]'
    kind: code
  - label: Transport
    value: nuxtApp.payload (top-level key)
  - label: What rides
    value: values · errors · field flags
---

# SSR hydration: Nuxt

> The fastest path to server-rendered form values that don't flicker on hydrate. Install the module, write `useForm` normally, and the round-trip wires itself.

::docs-meta-table
::

This page is code-only; SSR happens at the server runtime, and the docs site can't demo a hydration round-trip without bootstrapping a separate server. The setup is small enough to verify in your own Nuxt project; see [SSR hydration: bare Vue](/docs/server-and-ssr/ssr-bare-vue) for the equivalent without the Nuxt convenience.

## Nothing to wire

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
})
```

```vue
<script setup lang="ts">
  const form = useForm({ schema, key: 'signup' })
</script>
```

That's the whole setup. Values, both error layers, and every per-field interaction flag survive the server → client round-trip through `nuxtApp.payload`. Need to peek? Open the rendered HTML and look for the Nuxt payload `<script>` block; `attaform` is a top-level key.

## What crosses the wire

| Surface              | Round-trips? | Notes                                                                                                                          |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `form.values`        | ✅           | Whole tree, including nested objects and arrays.                                                                               |
| Schema errors        | ✅           | Replayed at hydration, then re-derived by the client's own validation.                                                         |
| `setErrors` errors   | ✅           | Replayed and left alone. The user layer is never re-derived, so a server rejection survives the boundary.                      |
| `fields`             | ✅           | The whole per-path record: `touched`, `focused`, `blurred`, `connected`, `interacted`, `blurredAfterInteraction`, `updatedAt`. |
| `blankPaths`         | ✅           | The "shown empty" state, so a blanked field does not flash its slim default on hydrate.                                        |
| `history` chain      | ❌           | Each tab walks its own undo timeline.                                                                                          |
| In-flight validation | ❌           | Only settled errors ride the wire; anything still pending is run again on the client.                                          |

The replay happens inside `useForm`, before the component renders, so the client's first paint already carries the server's values and errors. What it does not skip is validation: the client runs its normal mount-time pass whether or not a payload was there, re-deriving the schema half from the hydrated values and landing on the same errors. Worth knowing if a field carries an [async refinement](/docs/validation/async-refinements), since that pass calls it.

## Auto-imports

The Nuxt module auto-imports the form composables you reach for inside `<script setup>`: `useForm`, `useWizard`, `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, `lazy`, `gate`, and `useRegister`. No `import` statement needed:

```vue
<script setup lang="ts">
  const form = useForm({ schema, key: 'signup' })
</script>
```

Everything else stays an explicit import from `attaform`: the plugin (`createAttaform`), the `unset` sentinel, and the `defaultDisplayState` reducer.

```vue
<script setup lang="ts">
  import { defaultDisplayState, unset } from 'attaform'
</script>
```

Toggle the whole set with the module's `autoImports` option (default on); see [Installation](/docs/getting-started/installation#auto-imports) for the full list.

## App-wide defaults under Nuxt

The Nuxt module surfaces the same `AttaformDefaults` you'd pass to `createAttaform({ defaults })`:

```ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
  attaform: {
    defaults: {
      validateOn: 'change',
      debounceMs: 100,
      onInvalidSubmit: 'focus-first-error',
    },
  },
})
```

See [App-wide defaults](/docs/cross-cutting-state/app-defaults) for the full option list and merge semantics.

## Common issues

### "The form is empty on the client even though the server rendered values."

- Does the form's `key` match between server and client? Hard-code it as a string literal; `uuidv4()` or `Math.random()` produces a fresh key per render and breaks the round-trip lookup. Leaving `key` off entirely is safe: an anonymous form takes a synthetic key from Vue's `useId`, which the server and the client agree on.
- Was the form created in `setup`? A form created in `onMounted` or in an event handler never exists on the server, so there is nothing in the snapshot to hydrate from. That is also the answer when one form on the page looks right and another comes up empty.
- Is the whole payload being skipped? The envelope carries a version stamp, and a stamp the client does not recognise skips hydration wholesale rather than replaying a shape that may have drifted. A rolling deploy or a stale CDN cache can pair an old server bundle with a new client; dev builds warn with the two versions named.

### "The server's rejection disappeared as soon as the user typed."

Check which layer it came from, because the two behave differently on purpose.

An error Zod produced on the server is re-derived by the client's validation, so it clears exactly when the value stops being invalid, and comes straight back if the next keystroke breaks it again. An error a server route parked with [`form.setErrors`](/docs/submitting/server-side-errors) lives in the user layer, which is never re-derived: it stays until you clear it. So a rejection that vanishes on edit went in as a schema error, and the value is now valid.

Render the message off the error itself, and let each layer decide its own lifetime:

```vue
<small v-if="form.errors.email.length">{{ form.errors.email[0]?.message }}</small>
```

Gating that on `!form.fields.email.touched` looks like it protects the server's message, and it does the opposite: from the first interaction onward the field can never show an error again, however wrong the value gets.

## DevTools panel

In development, the Nuxt module registers the [Attaform DevTools panel](/docs/devtools-and-debugging/devtools-panel) as a tab in the Nuxt DevTools sidebar. The panel inspects every registered form including the SSR-rendered ones, useful for confirming the server-rendered shape matches your expectation before the user touches anything. Production builds drop the tab, and so does a project without Nuxt DevTools installed, where the module skips the registration silently.

## Where to next

- [SSR hydration: bare Vue](/docs/server-and-ssr/ssr-bare-vue): the same round-trip without the Nuxt module, when you're not on Nuxt.
- [Performance](/docs/server-and-ssr/performance): what SSR hydration costs in practice.
