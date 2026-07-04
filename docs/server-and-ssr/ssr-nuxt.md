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

That's the whole setup. Values, errors, and field interaction flags (touched / focused / blurred / connected) survive the server → client round-trip through `nuxtApp.payload`. Need to peek? Open the rendered HTML and look for the Nuxt payload `<script>` block; `attaform` is a top-level key.

## What crosses the wire

| Surface                    | Round-trips? | Notes                                                                   |
| -------------------------- | ------------ | ----------------------------------------------------------------------- |
| `form.values`              | ✅           | Whole tree, including nested objects and arrays.                        |
| `errors`                   | ✅           | Every entry in the error map, keyed by path.                            |
| `fields`                   | ✅           | `touched` / `focused` / `blurred` / `connected` / `updatedAt` per path. |
| `blankPaths`               | ✅           | Numeric-blank state survives the boundary.                              |
| `history` chain            | ❌           | Each tab walks its own undo timeline.                                   |
| Validation in-flight state | ❌           | Re-runs locally on the client.                                          |

The client-side form is identical to the server one; no second round of validation kicks in unless the user interacts.

## Auto-imports

The Nuxt module auto-imports the form composables you reach for inside `<script setup>`: `useForm`, `useWizard`, `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, and `lazy`. No `import` statement needed:

```vue
<script setup lang="ts">
  const form = useForm({ schema, key: 'signup' })
</script>
```

Everything else stays an explicit import from `attaform`: the plugin (`createAttaform`), the custom-input composable (`useRegister`), the `unset` sentinel, and the `defaultDisplayState` reducer.

```vue
<script setup lang="ts">
  import { defaultDisplayState, unset, useRegister } from 'attaform'
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

- Does the form's `key` match between server and client? Hard-code it as a string literal; `uuidv4()` or `Math.random()` produces a fresh key per render and breaks the round-trip lookup.
- Was the form created in `setup`? Forms created in `onMounted` or event handlers aren't in the SSR snapshot.

### "Field errors from the server disappear on first interaction."

By design. Any mutation re-runs validation, which can replace the errors. To keep server-provided errors around until the user dirties the field, gate the display on `form.fields.<path>.touched` or `form.meta.dirty`:

```vue
<small v-if="form.errors.email?.[0] && !form.fields.email.touched">
  {{ form.errors.email[0].message }}
</small>
```

### "Some fields look right, others don't."

Forms created in `onMounted` or event handlers aren't in the SSR snapshot. Create forms during `setup` so the server sees them.

## DevTools panel

The Nuxt module auto-wires the [Attaform DevTools panel](/docs/devtools-and-debugging/devtools-panel) into the Nuxt DevTools sidebar. The panel inspects every registered form including the SSR-rendered ones, useful for confirming the server-rendered shape matches your expectation before the user touches anything.

## Where to next

- [SSR hydration: bare Vue](/docs/server-and-ssr/ssr-bare-vue): the same round-trip without the Nuxt module, when you're not on Nuxt.
- [Performance](/docs/server-and-ssr/performance): what SSR hydration costs in practice.
