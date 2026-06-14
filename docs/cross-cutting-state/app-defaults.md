---
title: App-wide defaults
description: createAttaform sets app-level defaults (validateOn, debounceMs, history, coercion) that every useForm in the app inherits. Per-form options always win the merge.
metaRows:
  - label: Category
    value: Plugin
  - label: Bare Vue
    value: app.use(createAttaform({ defaults }))
    kind: code
  - label: Nuxt
    value: nuxt.config.ts → attaform.defaults
    kind: code
  - label: Resolution
    value: per-form > app-level > library default
---

# App-wide defaults

> One plugin call sets the defaults every `useForm` in the app inherits. Set the convention once, override per-form when a particular surface needs something different.

::docs-meta-table
::

This page is code-only; `createAttaform` runs at app boot, before any form mounts. The demos throughout the rest of the docs implicitly use Attaform's built-in defaults (`validateOn: 'change'`, `debounceMs: 0`, etc.); this page shows how to set your own.

## Setup

### Bare Vue 3

```ts
// main.ts
import { createApp } from 'vue'
import { createAttaform } from 'attaform'
import App from './App.vue'

createApp(App)
  .use(
    createAttaform({
      defaults: {
        debounceMs: 100,
        onInvalidSubmit: 'focus-first-error',
      },
    })
  )
  .mount('#app')
```

### Nuxt 3 / 4

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
  attaform: {
    defaults: {
      debounceMs: 100,
      onInvalidSubmit: 'focus-first-error',
    },
  },
})
```

The Nuxt module surfaces the same `AttaformDefaults` type under `attaform.defaults` in your `nuxt.config.ts`; no separate `createAttaform` call needed.

## Resolution order

Per-form > app-level > library default. Per-form always wins.

```text
useForm({ … })  >  createAttaform({ defaults })  >  library default
```

## Merge semantics

Every option resolves independently. Set anything once at the app level, override anything per-form without losing the rest:

```ts
// Plugin side
createAttaform({
  defaults: { validateOn: 'change', debounceMs: 100 },
})

// useForm calls
useForm({ schema })
// → validateOn: 'change', debounceMs: 100 (both inherited)

useForm({ schema, validateOn: 'blur' })
// → validateOn: 'blur'; debounceMs is dropped
//   (the TS-level ValidateOnConfig discriminated union rejects
//    debounceMs when validateOn isn't 'change'; paired with 'blur'
//    is a compile-time error)

useForm({ schema, debounceMs: 25 })
// → validateOn: 'change' (app-level), debounceMs: 25 (per-form wins)
```

`validateOn` and `debounceMs` are flat top-level fields. The `ValidateOnConfig` discriminated union enforces that `debounceMs` is only valid when `validateOn` is `'change'` (or omitted); pairing it with `'blur'` / `'submit'` doesn't compile.

## What's supported

`AttaformDefaults` covers the form-shaping options:

```ts
type AttaformDefaults = {
  strict?: boolean
  validateOn?: 'change' | 'blur' | 'submit'
  debounceMs?: number
  onInvalidSubmit?: 'none' | 'focus-first-error' | 'scroll-to-first-error' | 'both'
  history?: true | { max?: number }
  rememberVariants?: boolean
  coerce?: boolean | CoercionRegistry
  getDisplayState?: GetDisplayState
  maxRecursionDepth?: number
}
```

`getDisplayState` resolves `field.displayState` and its `show*` projections: the centralized "what should this field surface right now?" reducer, returning one of idle, pending, error, or success. Set it once at the app level so every form follows the same convention. To keep the default behavior but retune the anti-flash spinner timing, pass `makeDefaultDisplayState({ showDelay, minVisible })`. See [Display state and showing errors](/docs/validation/showing-errors) for the full contract.

## What's NOT supported (and why)

- `schema`: per-form by definition; a cross-form schema doesn't make sense.
- `key`: per-form identity.
- `defaultValues`: per-form initial values.

## Per-form `defaultValues`

Global defaults shape options like `strict` and `validateOn`. Per-form initial values live on each `useForm({ defaultValues })` call.

Three patterns:

```ts
import { unset } from 'attaform/zod'

// 1. Plain values: explicit defaults flow into storage and the form
//    is not blank for those leaves.
useForm({ schema, defaultValues: { email: 'me@example.com', count: 10 } })

// 2. Omit defaultValues entirely: every NUMERIC primitive leaf
//    (number, bigint) is auto-marked blank at construction. Storage
//    holds the schema's slim defaults; the form displays empty;
//    `form.errors.<path>` reactively carries 'No value supplied' for
//    required schemas. Strings and booleans are NOT auto-marked
//    because their slim defaults match what the DOM shows natively.
useForm({ schema })

// 3. Mark any path as `unset`: leaf, container, or the whole form.
//    The runtime writes the schema's slim value at the path and adds
//    every primitive descendant to form.blankPaths.
useForm({ schema, defaultValues: { email: unset, count: 10 } })
useForm({ schema, defaultValues: { profile: unset } }) // container
useForm({ schema, defaultValues: unset }) // root
```

`unset` works in `setValue('profile', unset)` and `reset({ email: unset })` identically: same semantic at every position.

## Alternative: userland wrapper

If you need defaults but don't want to touch the plugin (third-party component library, opting in only for some forms), wrap `useForm` in your project:

```ts
// composables/useAppForm.ts
import { useForm as attaformUseForm } from 'attaform/zod'
import type { z } from 'zod'

export function useAppForm<S extends z.ZodObject>(opts: Parameters<typeof attaformUseForm<S>>[0]) {
  return attaformUseForm({
    validateOn: 'change',
    debounceMs: 100,
    ...opts,
  })
}
```

Fully equivalent for the consumer; every `useAppForm` call gets your defaults; per-form options still win via the spread. The plugin-level approach is idiomatic for first-party apps; the wrapper is right when you can't (or shouldn't) influence the plugin config from your call site.

## Where to next

- [Display state and showing errors](/docs/validation/showing-errors): set the `getDisplayState` predicate app-wide for a consistent feel across forms.
- [When validation runs](/docs/validation/when-validation-runs): `validateOn` and `debounceMs` defaults shape every form in the app.
