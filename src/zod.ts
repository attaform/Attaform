/**
 * `attaform/zod` — the unified Zod entry. Auto-detects the consumer's
 * installed Zod major and routes to the matching adapter:
 *
 * - **Build-time alias (recommended).** With the `attaform/vite`
 *   plugin (or `attaform/nuxt`, which installs it), `attaform/zod`
 *   imports are rewritten at build time to either `attaform/zod-v3`
 *   or `attaform/zod-v4` based on the consumer's installed Zod
 *   version. The bundle ships a single adapter — same DX, smaller
 *   payload.
 *
 * - **Runtime dispatch (fallback).** Without the Vite plugin (other
 *   bundlers, plain ESM consumption), this entry's `useForm` checks
 *   the schema's shape at runtime and routes to the v3 or v4
 *   adapter. The bundle ships both adapters; the size cost is
 *   modest but real. Power users who want a lean bundle on non-Vite
 *   bundlers should reach for `attaform/zod-v3` or `attaform/zod-v4`
 *   directly.
 *
 * Usage:
 *
 *   import { useForm } from 'attaform/zod'
 *   import { z } from 'zod'
 *
 *   const { register, handleSubmit, errors } = useForm({
 *     schema: z.object({
 *       username: z.string().min(2, 'At least 2 characters'),
 *       password: z.string().min(8, 'At least 8 characters'),
 *     }),
 *     key: 'signup',
 *   })
 *
 * Surface:
 * - `useForm` — runtime-dispatching wrapper.
 * - `injectForm`, `useRegister`, `unset` / `isUnset`,
 *   `AttaformErrorCode` — schema-agnostic; identical across adapters.
 * - `fieldMeta`, `withMeta` — backed by a shared cross-adapter store
 *   so writes from this entry are visible at lookup whether the v3
 *   or v4 adapter runs at call time. `withMeta` runtime-branches on
 *   schema shape so the right cloning strategy applies for each
 *   major.
 *
 * Surfaces NOT exposed here (use the explicit subpath):
 * - `UnsupportedSchemaError`, `zodAdapter`, `assertZodVersion`,
 *   `kindOf`, `ZodKind` — diverge between v3 and v4.
 */

// Schema-agnostic core (plugin, registry, serialize, directive,
// coercion, paths, devtools, errors, display, wizard / register /
// inject / error-code / unset, and all core types) — single source
// under `runtime/_shared-exports.ts`.
export * from './runtime/_shared-exports'
// The unified Zod binding (dispatching `useForm`, `fieldMeta` /
// `withMeta`, the `useForm` projection types, `PathInput` / `PathOutput`)
// — single source under `runtime/_zod-binding.ts`, shared verbatim with
// the bare `attaform` barrel.
export * from './runtime/_zod-binding'
