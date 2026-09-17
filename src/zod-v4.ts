/**
 * `attaform/zod-v4`, the explicit Zod v4 adapter subpath.
 *
 * Pin this when you want the v4 adapter regardless of what other
 * tooling resolves. The bundle ships one adapter with no runtime
 * dispatch, which matters on non-Vite bundlers, where the unified
 * `attaform/zod` entry's runtime fallback would ship both.
 *
 * Most Vite consumers should import `attaform/zod` instead: the
 * `attaform/vite` plugin rewrites that import to this subpath at build
 * time when zod@^4 is detected, for the same lean bundle with less
 * ceremony.
 *
 * Requires `zod@^4`. Importing it with zod@3 installed throws a clear
 * version-mismatch error from the adapter at the first schema parse.
 *
 *   import { useForm } from 'attaform/zod-v4'
 *   import { z } from 'zod'
 *
 *   const form = useForm({
 *     schema: z.object({ email: z.email() }),
 *     key: 'signup',
 *   })
 */

export { useForm, zodAdapter } from './runtime/adapters/zod-v4'
export type { PathInput, PathOutput } from './runtime/adapters/zod-v4'
export { assertZodVersion, kindOf } from './runtime/adapters/zod-v4/introspect'
export type { ZodKind } from './runtime/adapters/zod-v4/introspect'
// `injectForm` ships from here too, for discoverability alongside
// `useForm`; the helper itself is schema-agnostic.
export * from './runtime/_shared-exports'
export { fieldMeta, withMeta } from './runtime/adapters/zod-v4/field-meta'
export type { FieldMetaPayload } from './runtime/core/field-meta'
