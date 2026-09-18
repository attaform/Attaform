/**
 * `attaform/zod`, the unified Zod entry. Auto-detects the consumer's
 * installed Zod major and routes to the matching adapter two ways:
 *
 * - **Build-time alias, recommended.** With the `attaform/vite` plugin,
 *   or `attaform/nuxt`, which installs it, an `attaform/zod` import is
 *   rewritten at build time to `attaform/zod-v3` or `attaform/zod-v4`
 *   against the installed Zod version, so the bundle ships one adapter.
 * - **Runtime dispatch, the fallback.** Without the Vite plugin, on
 *   other bundlers or plain ESM, `useForm` checks the schema's shape at
 *   runtime and routes from there. The bundle ships both adapters, at a
 *   modest but real size cost. For a lean bundle on a non-Vite bundler,
 *   import `attaform/zod-v3` or `attaform/zod-v4` directly.
 *
 *   import { useForm } from 'attaform/zod'
 *   import { z } from 'zod'
 *
 *   const form = useForm({
 *     schema: z.object({
 *       username: z.string().min(2, 'At least 2 characters'),
 *       password: z.string().min(8, 'At least 8 characters'),
 *     }),
 *     key: 'signup',
 *   })
 *
 * `fieldMeta` and `withMeta` are backed by a shared cross-adapter store,
 * so a write from this entry is visible at lookup whichever adapter
 * runs at call time, and `withMeta` branches on schema shape to apply
 * the right cloning strategy per major.
 *
 * NOT exposed here, because they diverge between majors: `zodAdapter`,
 * `assertZodVersion`, `kindOf`, `ZodKind`. Use the explicit subpath.
 */

export * from './runtime/_shared-exports'
export * from './runtime/_zod-binding'
