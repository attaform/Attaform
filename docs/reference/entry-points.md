---
title: Entry-point reference
description: Every package subpath Attaform exposes and what ships from each. Import-path picker for adopters, anchor-keyed map of the public surface.
metaRows:
  - label: Category
    value: Reference
  - label: Entry points
    value: 14
  - label: Recommended entry
    value: attaform
    kind: code
  - label: Bring your own adapter
    value: attaform/abstract
    kind: code
---

# Entry-point reference

> Every public export, grouped by the package subpath it ships from. Use this as the "which import line do I need?" lookup; the rest of the docs cover what each surface does.

::docs-meta-table
::

New projects pick `attaform`. The other subpaths cover explicit Zod pins, the bring-your-own-adapter escape hatch, the Nuxt and Vite integrations, the compiler internals, the DevTools panel, and the type-only surface.

## `attaform`: the recommended entry

The default entry, and the one new projects reach for. `useForm` here takes a Zod schema and infers every field type from it. It auto-detects the installed Zod major (v3 or v4) and routes to the matching adapter: under the `attaform/vite` plugin (or `attaform/nuxt`, which installs it) that resolution happens at build time so the bundle ships one adapter, and without a plugin the entry dispatches at runtime instead.

```ts
import { createAttaform, useForm } from 'attaform'
```

The Zod-default form surface:

- `useForm`: the Zod wrapper that infers field types from your schema.
- `useWizard`, `lazy`: the multistep orchestrator and its lazy-step helper.
- `injectForm`, `injectWizard`: reach a provided form or wizard from a descendant component.
- `useRegister`: the composable behind `v-register`, for building custom input components.
- `fieldMeta`, `withMeta`: schema-attached field metadata (label, description, placeholder), backed by a cross-adapter store.
- `unset`, `isUnset`: the blank-anywhere sentinel and its type guard.

On top of that surface, `attaform` re-exports the framework-agnostic toolkit (the plugin, the directive layer, the SSR bridge, the error classes, the path primitives) that every entry carries. It's listed in full under [The framework-agnostic toolkit](#the-framework-agnostic-toolkit).

What `attaform` does NOT ship: the version-specific Zod internals (`zodAdapter`, `kindOf`, `ZodKind`, `assertZodVersion`, `UnsupportedSchemaError`). Those diverge between v3 and v4, so they live only on the pinned `attaform/zod-v3` and `attaform/zod-v4` subpaths.

## `attaform/zod`: the explicit Zod pin

The same surface as `attaform`, named explicitly. It is byte-identical: `attaform` is defined as `attaform/zod` re-exported. Reach for it when you want the import line to name Zod out loud, or when a codebase already standardized on it. New projects don't need the extra characters, and existing `attaform/zod` code keeps working with no change.

```ts
import { useForm } from 'attaform/zod'
```

## `attaform/zod-v3`

The Zod v3 adapter, pinned with no runtime dispatch, for projects still on v3.

```ts
import { useForm, withMeta } from 'attaform/zod-v3'
```

Ships the same form surface as `attaform`, plus the v3 `zodAdapter` and the `isZodSchemaType` guard. Its runtime introspection is leaner than v4's; see [`AbstractSchema`](/docs/schemas/abstract-schema#zod-v3-vs-zod-v4-an-introspection-asymmetry) for the discussion.

## `attaform/zod-v4`

The Zod v4 adapter, pinned explicitly. It's the same adapter `attaform` selects when it detects zod@4, committed at the import instead of by detection.

```ts
import { useForm } from 'attaform/zod-v4'
```

Ships the richer v4 introspection set on top of the shared form surface: `zodAdapter`, `kindOf`, `ZodKind`, `assertZodVersion`, `UnsupportedSchemaError`, and the `PathInput` / `PathOutput` type helpers.

## `attaform/abstract`: bring your own adapter

The schema-agnostic escape hatch. `useAbstractForm` works against any object implementing [`AbstractSchema`](/docs/schemas/abstract-schema): a custom adapter, a non-Zod validation library, or a hand-rolled shape. The Zod entries wrap their schema for you; this entry hands you the unwrapped composable and expects an adapter.

```ts
import { useAbstractForm } from 'attaform/abstract'
```

Ships `useAbstractForm`, the `AbstractSchema` contract type, `FieldMetaPayload`, and the same framework-agnostic toolkit every entry carries. There is deliberately no `useForm` alias here: a same-named wrong-variant export fails deep at the first schema call instead of at the import site, and removing that footgun is the whole reason the escape hatch is its own entry. This is a lower-level surface than the Zod entries; reach for it only when you're integrating a schema library Attaform doesn't ship an adapter for.

## The framework-agnostic toolkit

Every entry re-exports the same schema-agnostic core, so this set is identical whether you import it from `attaform`, `attaform/zod`, or `attaform/abstract`. Pick the entry by which form composable you want; the toolkit rides along.

```ts
import {
  // Plugin + registry
  createAttaform,
  useRegistry,
  // Multistep, injection, custom inputs
  useWizard,
  lazy,
  injectForm,
  injectWizard,
  useRegister,
  // Directive layer
  vRegister,
  assignKey,
  defaultCoercionRules,
  defineCoercion,
  // SSR
  renderAttaformState,
  hydrateAttaformState,
  escapeForInlineScript,
  // The unset sentinel
  unset,
  isUnset,
  // Error classes (every Attaform throw extends AttaformError)
  AttaformError,
  InvalidPathError,
  InvalidUseFormConfigError,
  OutsideSetupError,
  RegistryNotInstalledError,
  ReservedFormKeyError,
  SubmitErrorHandlerError,
  // Validation-error codes
  AttaformErrorCode,
  // Display-state heuristic default
  defaultDisplayState,
  // Path primitives (custom adapters only)
  canonicalizePath,
  parseDottedPath,
  isPathPrefix,
  ROOT_PATH,
  ROOT_PATH_KEY,
  // DevTools shared
  DEVTOOLS_WINDOW_KEY,
} from 'attaform'
```

Also re-exports every public type from `runtime/types/types-api` and `runtime/types/types-core`. See [Types reference](/docs/reference/types) for the full list.

## `attaform/nuxt`

The Nuxt module. Auto-installs the plugin, auto-imports the form composables, and wires the DevTools panel.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
  attaform: {
    defaults: { validateOn: 'change', debounceMs: 100 },
  },
})
```

After installing, `useForm`, `useWizard`, `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, and `lazy` are all global auto-imports (toggle with the module's `autoImports` option). `useAbstractForm`, `createAttaform`, and `useRegister` stay explicit imports by design. See [Installation](/docs/getting-started/installation#auto-imports) for the full setup and [SSR hydration: Nuxt](/docs/server-and-ssr/ssr-nuxt) for the server wiring.

## `attaform/vite`

The Vite plugin. Required under bare Vue + Vite for SSR-correct `v-register` bindings, and the piece that rewrites `attaform` / `attaform/zod` to a single Zod adapter at build time.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { attaform } from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

The same plugin ships for other bundlers at `attaform/rollup`, `attaform/esbuild`, `attaform/webpack`, and `attaform/rspack`. See [SSR hydration: bare Vue](/docs/server-and-ssr/ssr-bare-vue) for the matching server and client wiring.

## `attaform/transforms`

Raw Vue compiler-core node transforms. Use only when wiring a custom bundler pipeline; the Vite plugin already wraps these for the common case.

```ts
import { vRegisterHintTransform, vRegisterPreambleTransform } from 'attaform/transforms'
```

## `attaform/devtools-panel`

The DevTools panel internals. The [Attaform DevTools panel](/docs/devtools-and-debugging/devtools-panel) is auto-wired by `attaform/nuxt`; this entry is exposed for advanced consumers building their own panel hosts.

## `attaform/types`

Type-only subpath. Re-exports every type from the runtime, useful when you want types in a `.d.ts` consumer file without pulling in the runtime barrel:

```ts
import type { UseFormReturnType, FieldState, ValidationError } from 'attaform/types'
```

For runtime imports under typical app code, import directly from `attaform`; the type re-exports there are equivalent.

## Which subpath for which job?

| You want to…                                          | Import from         |
| ----------------------------------------------------- | ------------------- |
| Build a form in a Vue 3 / Nuxt app (Zod v3 or v4)     | `attaform`          |
| Pin the Zod v3 adapter explicitly                     | `attaform/zod-v3`   |
| Pin the Zod v4 adapter explicitly                     | `attaform/zod-v4`   |
| Wire a custom or non-Zod schema library               | `attaform/abstract` |
| Install the Nuxt module                               | `attaform/nuxt`     |
| Install the Vite plugin under bare Vue + Vite         | `attaform/vite`     |
| Reach directive symbols (`vRegister`, `assignKey`, …) | `attaform`          |
| Use SSR helpers (`renderAttaformState`, etc.)         | `attaform`          |
| Catch an Attaform-thrown error by class               | `attaform`          |
| Type-only imports in a `.d.ts` file                   | `attaform/types`    |

## The Zod-default story

`attaform` and `attaform/zod` are the same surface: the barrel re-exports the unified Zod binding, so `useForm` infers your field types from a Zod schema out of the box. The abstraction underneath stays schema-agnostic. `attaform/abstract` exposes it directly through `useAbstractForm`, which takes an `AbstractSchema` adapter instead of a Zod schema, and every Zod entry is a thin typed wrapper over that same core. If you're integrating a schema library Attaform doesn't ship an adapter for, [`AbstractSchema`](/docs/schemas/abstract-schema) is the contract to implement.

## Where to next

- [The schema contract](/docs/schemas/contract): the bridge between the typed entries and the schema-agnostic core.
- [Types reference](/docs/reference/types): every type, grouped by purpose.
- [Errors reference](/docs/reference/errors): every Attaform-thrown error class.
- [`AbstractSchema`](/docs/schemas/abstract-schema): the contract for non-Zod schema libraries.
