/**
 * `attaform`, the default entry. Re-exports the schema-agnostic core
 * plus the unified Zod binding, so it is structurally identical to
 * `attaform/zod`: `useForm` auto-detects the installed Zod major and
 * routes to the matching adapter.
 *
 *   import { createApp } from 'vue'
 *   import { createAttaform, useForm } from 'attaform'
 *   import { z } from 'zod'
 *
 *   createApp(App).use(createAttaform()).mount('#app')
 *
 *   const form = useForm({ schema: z.object({ ... }), key: 'signup' })
 *
 * Under Nuxt, `attaform/nuxt` installs the plugin and auto-imports this
 * surface, so consumers never touch this file.
 *
 * Explicit pins live at sibling subpaths:
 * - `attaform/zod`: the same unified Zod entry, named explicitly.
 * - `attaform/zod-v3`, `attaform/zod-v4`: pin one adapter, no runtime
 *   dispatch.
 * - `attaform/abstract`: the schema-agnostic `useAbstractForm`, for
 *   custom or non-Zod adapters.
 */

export * from './runtime/_shared-exports'
export * from './runtime/_zod-binding'
