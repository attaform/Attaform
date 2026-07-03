/**
 * `attaform` — framework-agnostic core entry.
 *
 * Consumers under bare Vue 3:
 *
 *   import { createApp } from 'vue'
 *   import { createAttaform, useForm } from 'attaform'
 *   import { attaform as attaformVite } from 'attaform/vite'
 *
 *   createApp(App).use(createAttaform()).mount('#app')
 *
 * Consumers under Nuxt don't touch this file — the Nuxt module (`./nuxt`
 * subpath) installs everything automatically.
 *
 * For schema-library integrations (Zod v3 today; Valibot / ArkType /
 * custom later), import from the matching subpath:
 *
 *   import { useForm, zodAdapter } from 'attaform/zod-v3'
 */

// The abstract useForm — works against any AbstractSchema implementation.
// Zod-typed wrappers live at `/zod` (v4) and `/zod-v3`; this entry is the
// schema-agnostic core.
export { useAbstractForm as useForm } from './runtime/composables/use-abstract-form'

// Schema-agnostic surface + framework-agnostic core (plugin, registry,
// serialize, directive, coercion, paths, devtools, errors, display, and
// all core types) — single source under `runtime/_shared-exports.ts`,
// re-exported verbatim from every entry.
export * from './runtime/_shared-exports'

// Abstract-only public type: the multi-schema-lib contract a custom
// adapter implements. The zod entries reference it internally but don't
// re-export it — it's exclusive to the abstract surface.
export type { AbstractSchema } from './runtime/types/types-api'

// `FieldMetaPayload` rides alongside the per-entry `fieldMeta` /
// `withMeta`; re-exported here so consumers augmenting field metadata
// have the interface available from the barrel.
export type { FieldMetaPayload } from './runtime/types/types-api'
