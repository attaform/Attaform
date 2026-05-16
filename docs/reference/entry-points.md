---
title: Entry-point reference
description: Every package subpath Attaform exposes and what ships from each. Import-path picker for adopters, anchor-keyed map of the public surface.
metaRows:
  - label: Category
    value: Reference
  - label: Subpaths
    value: 9
  - label: Recommended entry
    value: attaform/zod
    kind: code
  - label: Framework-agnostic
    value: attaform
    kind: code
---

# Entry-point reference

> Every public export, grouped by the package subpath it ships from. Use this as the "which import line do I need?" lookup; the rest of the docs cover what each surface does.

::docs-meta-table
::

Nine subpaths. New projects pick `attaform/zod`; the others cover Zod v3 holdouts, framework-agnostic core, Nuxt / Vite integrations, compiler internals, the DevTools panel, and the type-only types subpath.

## `attaform/zod` — the recommended entry

Zod v4 adapter. The canonical entry for new projects.

```ts
import { useForm, withMeta, zodAdapter, fieldMeta } from 'attaform/zod'
```

Ships:

- `useForm` — the typed-Zod wrapper around the framework-agnostic `useForm`.
- `useStepper`, `injectForm`, `useRegister` — same composables, re-exported.
- `zodAdapter` — explicit adapter constructor (most consumers don't need this; `useForm({ schema })` wraps automatically).
- `fieldMeta` / `withMeta` — schema-attached field metadata (label, description, placeholder).
- `kindOf`, `ZodKind`, `assertZodVersion` — runtime Zod-introspection helpers.
- `FieldMetaPayload` — the metadata shape.
- `unset`, `isUnset` — the absent-sentinel.

## `attaform/zod-v3`

Zod v3 adapter for projects still on v3. New projects should use `attaform/zod`.

```ts
import { useForm, withMeta } from 'attaform/zod-v3'
```

Surface matches `attaform/zod` one-for-one — `useForm`, `injectForm`, `useRegister`, `useStepper`, `withMeta`, `fieldMeta`, `unset`. The runtime introspection is leaner (`isZodSchemaType` only); see [Custom schema adapters](/docs/reference/custom-adapters#zod-v3-vs-zod-v4--an-introspection-asymmetry) for the discussion.

## `attaform/zod-v4`

Explicit Zod v4 entry. Currently identical to `attaform/zod` — kept for forward-compat naming. New code should import from `attaform/zod`.

## `attaform` — framework-agnostic core

The schema-agnostic entry. Drop here when:

- You're wiring a custom schema library via [`AbstractSchema`](/docs/reference/custom-adapters).
- You need directive-layer symbols (`vRegister`, `assignKey`, `RegisterTransform`) not re-exported by the typed entries.
- You're writing SSR bootstrap code (`renderAttaformState`, `hydrateAttaformState`, `escapeForInlineScript`).

```ts
import {
  // Plugin + registry
  createAttaform,
  useRegistry,
  // Schema-agnostic composables
  useForm,
  injectForm,
  useStepper,
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
  // Error classes (every library throw extends AttaformError)
  AttaformError,
  AnonPersistError,
  InvalidPathError,
  InvalidUseFormConfigError,
  OutsideSetupError,
  RegistryNotInstalledError,
  ReservedFormKeyError,
  SensitivePersistFieldError,
  StepperLateRegistrationError,
  SubmitErrorHandlerError,
  // Validation-error codes
  AttaformErrorCode,
  // API-error parser
  parseApiErrors,
  PARSE_API_ERRORS_DEFAULTS,
  // Sensitive-name protection
  DEFAULT_SENSITIVE_NAMES,
  // ShouldShowErrors composable default
  defaultShouldShowErrors,
  // Path primitives (custom adapters only)
  canonicalizePath,
  parseDottedPath,
  isPathPrefix,
  ROOT_PATH,
  ROOT_PATH_KEY,
  // DevTools shared
  DEVTOOLS_WINDOW_KEY,
  REDACTED,
  redactSensitiveLeaves,
} from 'attaform'
```

Also re-exports every public type from `runtime/types/types-api` and `runtime/types/types-core` — see [Types reference](/docs/reference/types) for the full list.

## `attaform/nuxt`

The Nuxt module. Auto-installs the plugin, registers auto-imports, wires the DevTools panel.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
  attaform: {
    defaults: { validateOn: 'change', debounceMs: 100 },
  },
})
```

After installing, `useForm`, `injectForm`, `useStepper`, and `useRegister` are global auto-imports. See [SSR hydration — Nuxt](/docs/server-and-ssr/ssr-nuxt) for the full setup.

## `attaform/vite`

The Vite plugin. Required under bare Vue + Vite for SSR-correct `v-register` bindings.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import attaform from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

See [SSR hydration — bare Vue](/docs/server-and-ssr/ssr-bare-vue) for the matching server / client wiring.

## `attaform/transforms`

Raw Vue compiler-core node transforms. Use only when wiring a custom bundler pipeline — the Vite plugin already wraps these for the common case.

```ts
import { vRegisterTransform } from 'attaform/transforms'
```

## `attaform/devtools-panel`

The DevTools panel internals. The [Attaform DevTools panel](/docs/devtools-and-debugging/devtools-panel) is auto-wired by `attaform/nuxt`; this entry is exposed for advanced consumers building their own panel hosts.

## `attaform/types`

Type-only subpath. Re-exports every type from the runtime — useful when you want types in a `.d.ts` consumer file without pulling in the runtime barrel:

```ts
import type { UseFormReturnType, FieldState, ValidationError } from 'attaform/types'
```

For runtime imports under typical app code, import directly from `attaform` — the type re-exports there are equivalent.

## Which subpath for which job?

| You want to…                                          | Import from       |
| ----------------------------------------------------- | ----------------- |
| Build a form in a Vue 3 / Nuxt app on Zod v4          | `attaform/zod`    |
| Build a form in an app stuck on Zod v3                | `attaform/zod-v3` |
| Wire a custom schema library (Valibot, ArkType, …)    | `attaform`        |
| Install the Nuxt module                               | `attaform/nuxt`   |
| Install the Vite plugin under bare Vue + Vite         | `attaform/vite`   |
| Reach directive symbols (`vRegister`, `assignKey`, …) | `attaform`        |
| Use SSR helpers (`renderAttaformState`, etc.)         | `attaform`        |
| Catch a library-thrown error by class                 | `attaform`        |
| Type-only imports in a `.d.ts` file                   | `attaform/types`  |

## The framework-agnostic story

`attaform` (the bare entry) doesn't import Zod. Everything you see in `attaform/zod` is a typed wrapper around `attaform`'s exports — same composables, same return shapes, with Zod-specific inference layered on top. If you ever need to bypass the Zod typing (writing a generic helper that should work across schema libraries), import from `attaform` directly and supply the `Form` generic yourself.

## Where to next

- [The schema contract](/docs/schemas/contract) — the bridge between the typed entries and the framework-agnostic core.
- [Types reference](/docs/reference/types) — every type, grouped by purpose.
- [Errors reference](/docs/reference/errors) — every library-thrown error class.
- [Custom schema adapters](/docs/reference/custom-adapters) — the `AbstractSchema` contract for non-Zod libraries.
