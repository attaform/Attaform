---
title: Entry-point reference
description: Every package subpath Attaform exposes and what ships from each. Import-path picker for adopters, anchor-keyed map of the public surface.
metaRows:
  - label: Category
    value: Reference
  - label: Entry points
    value: 15
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

New projects pick `attaform`. The other subpaths cover explicit Zod pins, the bring-your-own-adapter escape hatch, the `v-register` delivery entry, the undo/redo plugin, the Nuxt and Vite integrations, the four other bundler plugins, the compiler internals, and the DevTools panel.

## `attaform`: the recommended entry

The default entry, and the one new projects reach for. `useForm` here takes a Zod schema and infers every field type from it. It reaches the right Zod major (v3 or v4) on its own, by one of two routes. Under the `attaform/vite` plugin (or `attaform/nuxt`, which installs it) the import is rewritten at build time against the version you have installed, so the bundle ships one adapter. Without a plugin the entry dispatches at runtime instead, on the shape of the schema it was handed rather than on what is installed, and carries both adapters to do it.

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

What `attaform` does NOT ship: the version-specific Zod internals (`zodAdapter`, `kindOf`, `ZodKind`, `assertZodVersion`). Those diverge between v3 and v4, so they live only on the pinned `attaform/zod-v3` and `attaform/zod-v4` subpaths.

## `attaform/zod`: the explicit Zod pin

The same surface as `attaform`, named explicitly. It is byte-identical: `attaform` is defined as `attaform/zod` re-exported. Reach for it when you want the import line to name Zod out loud, or when a codebase already standardized on it. New projects don't need the extra characters, and existing `attaform/zod` code keeps working with no change.

```ts
import { useForm } from 'attaform/zod'
```

## `attaform/zod-v3`

The Zod v3 adapter, pinned with no runtime dispatch. The entry for a project on v3, and the one that keeps the v4 adapter out of a bundle the Vite plugin never sees.

```ts
import { useForm, withMeta } from 'attaform/zod-v3'
```

Ships the same form surface as `attaform`, plus the v3 `zodAdapter` and the `isZodSchemaType` guard. Its runtime introspection is leaner than v4's; see [`AbstractSchema`](/docs/schemas/abstract-schema#zod-v3-vs-zod-v4-an-introspection-asymmetry) for the discussion.

## `attaform/zod-v4`

The Zod v4 adapter, pinned explicitly. It's the same adapter `attaform` routes v4 schemas to, committed at the import instead of resolved for you. On tooling the Vite plugin does not cover, that commitment is also what keeps the other adapter out of the bundle.

```ts
import { useForm } from 'attaform/zod-v4'
```

Ships the richer v4 introspection set on top of the shared form surface: `zodAdapter`, `kindOf`, `ZodKind`, `assertZodVersion`, and the `PathInput` / `PathOutput` type helpers.

## `attaform/abstract`: bring your own adapter

The schema-agnostic escape hatch. `useAbstractForm` works against any object implementing [`AbstractSchema`](/docs/schemas/abstract-schema): a custom adapter, a non-Zod validation library, or a hand-rolled shape. The Zod entries wrap their schema for you; this entry hands you the unwrapped composable and expects an adapter.

```ts
import { useAbstractForm } from 'attaform/abstract'
```

Ships `useAbstractForm`, the `AbstractSchema` contract type, `FieldMetaPayload`, and the same framework-agnostic toolkit every entry carries. There is deliberately no `useForm` alias here: a same-named wrong-variant export fails deep at the first schema call instead of at the import site, and removing that footgun is the whole reason the escape hatch is its own entry. This is a lower-level surface than the Zod entries; reach for it only when you're integrating a schema library Attaform doesn't ship an adapter for.

## `attaform/directive`: the `v-register` delivery entry

The directive and its app-level installer, on their own subpath so an app that never renders `v-register` never ships its DOM machinery. Most projects never import it: the Vite plugin and the Nuxt module bind `v-register` into each compiled template automatically. Everywhere else (a webpack-family bundler, a no-build page, runtime-compiled templates), one line per app delivers it:

```ts
import { installVRegister } from 'attaform/directive'

installVRegister(app)
```

Ships `installVRegister`, plus the directive objects `vRegister` and `vRegisterFile` for advanced integrations that bind them locally (a `<script setup>` binding or a manual `withDirectives` render function). When no delivery ran, Vue's own development warning `Failed to resolve directive: register` names the miss.

## `attaform/history`: the undo/redo plugin

The history runtime, on its own subpath so a form that never opts in never ships it. Create the plugin and pass it via `useForm({ history })`:

```ts
import { historyPlugin } from 'attaform/history'

const form = useForm({ schema, history: historyPlugin({ max: 200 }) })
```

Ships `historyPlugin` and its types (`HistoryPlugin`, `HistoryPluginOptions`). One plugin instance is a reusable configuration — pass it to several forms and every one keeps its own independent chain. The [Undo & redo](/docs/cross-cutting-state/undo-redo) page covers the `form.history` namespace it unlocks.

## The framework-agnostic toolkit

Every entry re-exports the same schema-agnostic core, so this set is identical whether you import it from `attaform`, `attaform/zod`, or `attaform/abstract`. Pick the entry by which form composable you want; the toolkit rides along.

```ts
import {
  // Plugin + registry
  createAttaform,
  useRegistry,
  createRegistry,
  getRegistryFromApp,
  kAttaformRegistry,
  // Multistep, injection, custom inputs
  useWizard,
  lazy,
  gate,
  injectForm,
  injectWizard,
  useRegister,
  // Directive layer
  vRegister,
  assignKey,
  isRegisterValue,
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
  // Display-state heuristic default, and the knobs to retune it
  defaultDisplayState,
  makeDefaultDisplayState,
  DEFAULT_TIMINGS,
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

After installing, `useForm`, `useWizard`, `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, `lazy`, `gate`, and `useRegister` are all global auto-imports (toggle with the module's `autoImports` option). `useAbstractForm`, `createAttaform`, `unset`, and `isUnset` stay explicit imports by design. See [Installation](/docs/getting-started/installation#auto-imports) for the full setup and [SSR hydration: Nuxt](/docs/server-and-ssr/ssr-nuxt) for the server wiring.

## `attaform/vite`

The Vite plugin. The piece that binds `v-register` into each compiled template that uses it, keeps SSR-rendered `v-register` bindings byte-identical with the client render, and rewrites `attaform` / `attaform/zod` to a single Zod adapter at build time. Under bare Vue + Vite, this is the one-plugin setup for the whole compile-time story.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { attaform } from 'attaform/vite'

export default defineConfig({
  plugins: [vue(), attaform()],
})
```

See [SSR hydration: bare Vue](/docs/server-and-ssr/ssr-bare-vue) for the matching server and client wiring.

## `attaform/rollup`, `attaform/esbuild`, `attaform/webpack`, `attaform/rspack`

The adapter rewrite, for the other four bundlers. Each takes the same call as the Vite plugin:

```ts
// webpack.config.mjs
import { attaform } from 'attaform/webpack'

export default {
  plugins: [attaform()],
}
```

What they do **not** do is the compile-time template work, which is `@vitejs/plugin-vue`-specific: no `v-register` binding, and no SSR marking. Deliver the directive with [`attaform/directive`](#attaformdirective-the-v-register-delivery-entry), and if you server-render, wire [`attaform/transforms`](#attaformtransforms) into your Vue compiler yourself.

## `attaform/transforms`

Raw Vue compiler-core node transforms. Use only when wiring a custom bundler pipeline; `attaform/vite` already installs these for the common case, and the bundler plugins above do not (they only do the adapter rewrite).

All five, in the order the Vite plugin installs them:

```ts
import {
  redundantBindingWarnTransform,
  componentBridgeTransform,
  inputTextAreaNodeTransform,
  vRegisterPreambleTransform,
  vRegisterHintTransform,
} from 'attaform/transforms'
```

The order carries two hard constraints. `redundantBindingWarnTransform` has to run before the two that rewrite the value channel, because it reads what you wrote in the template and those two replace it with what they inject. `vRegisterPreambleTransform` has to run before `vRegisterHintTransform`, because the preamble captures each `v-register` expression before the hint wraps it, and reversing them wraps an already-wrapped expression twice.

Wiring a subset is the trap worth naming. `componentBridgeTransform` and `inputTextAreaNodeTransform` are the two that bake `value` / `checked` / `selected` into the server-rendered HTML for component-wrapped inputs; leave them out and those fields render unset on the server and correct themselves on hydrate. `vRegisterHintTransform` is what marks registered elements connected during the server render, which Vue otherwise skips along with the whole directive lifecycle.

## `attaform/devtools-panel`

The DevTools panel internals. The [Attaform DevTools panel](/docs/devtools-and-debugging/devtools-panel) is auto-wired by `attaform/nuxt`; this entry is exposed for advanced consumers building their own panel hosts.

## One import line, two builds

Every runtime subpath above ships twice in the published package. The production flavor is the default resolution target: development-only diagnostics are already stripped from it when Attaform is built, so production bundles ship lean with zero bundler configuration. The development flavor carries the full diagnostic surface (the misuse warnings, warning call-site capture, and the DevTools bridge) and is selected automatically through the `development` export condition, which Vite's dev server, webpack's development mode, and Nuxt's dev tooling all set out of the box.

Two consequences worth knowing:

- A toolchain that never sets the `development` condition resolves the production flavor everywhere. Attaform behaves identically; the development-time warnings simply stay silent. Importing straight from a browser CDN lands in the same place.
- The Node-side tooling subpaths (`attaform/nuxt`, `attaform/vite`, the bundler plugins, `attaform/transforms`) are single-flavor: they run inside your build, not in your app bundle, so there is nothing to strip.

## Which subpath for which job?

| You want to…                                          | Import from                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Build a form in a Vue 3 / Nuxt app (Zod v3 or v4)     | `attaform`                                                                   |
| Pin the Zod v3 adapter explicitly                     | `attaform/zod-v3`                                                            |
| Pin the Zod v4 adapter explicitly                     | `attaform/zod-v4`                                                            |
| Wire a custom or non-Zod schema library               | `attaform/abstract`                                                          |
| Install the Nuxt module                               | `attaform/nuxt`                                                              |
| Install the Vite plugin under bare Vue + Vite         | `attaform/vite`                                                              |
| Ship one Zod adapter from a non-Vite bundler          | `attaform/webpack`, `attaform/rspack`, `attaform/rollup`, `attaform/esbuild` |
| Wire the template transforms into your own compiler   | `attaform/transforms`                                                        |
| Deliver `v-register` without a build plugin           | `attaform/directive`                                                         |
| Enable undo/redo (`historyPlugin`)                    | `attaform/history`                                                           |
| Reach directive symbols (`vRegister`, `assignKey`, …) | `attaform`                                                                   |
| Use SSR helpers (`renderAttaformState`, etc.)         | `attaform`                                                                   |
| Catch an Attaform-thrown error by class               | `attaform`                                                                   |
| Type-only imports in a `.d.ts` file                   | `attaform`                                                                   |

## The Zod-default story

`attaform` and `attaform/zod` are the same surface: the barrel re-exports the unified Zod binding, so `useForm` infers your field types from a Zod schema out of the box. The abstraction underneath stays schema-agnostic. `attaform/abstract` exposes it directly through `useAbstractForm`, which takes an `AbstractSchema` adapter instead of a Zod schema, and every Zod entry is a thin typed wrapper over that same core. If you're integrating a schema library Attaform doesn't ship an adapter for, [`AbstractSchema`](/docs/schemas/abstract-schema) is the contract to implement.

## Where to next

- [The schema contract](/docs/schemas/contract): the bridge between the typed entries and the schema-agnostic core.
- [Types reference](/docs/reference/types): every type, grouped by purpose.
- [Errors reference](/docs/reference/errors): every Attaform-thrown error class.
- [`AbstractSchema`](/docs/schemas/abstract-schema): the contract for non-Zod schema libraries.
