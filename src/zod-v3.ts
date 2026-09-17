/**
 * `attaform/zod-v3`, the explicit Zod v3 adapter subpath.
 *
 * Pin this when you want the v3 adapter regardless of what other
 * tooling resolves. The bundle ships one adapter with no runtime
 * dispatch, which matters on non-Vite bundlers, where the unified
 * `attaform/zod` entry's runtime fallback would ship both.
 *
 * Most Vite consumers should import `attaform/zod` instead: the
 * `attaform/vite` plugin rewrites that import to this subpath at build
 * time when zod@^3 is detected, for the same lean bundle with less
 * ceremony.
 *
 * Requires `zod@^3`. The adapter assumes v3 internals (`_def.typeName`,
 * `.unwrap()`, `.innerType()`), so importing it against zod@4 fails
 * fast with a version-mismatch error.
 *
 *   import { useForm } from 'attaform/zod-v3'
 *   import { z } from 'zod'
 *
 *   const form = useForm({
 *     schema: z.object({ email: z.string().email() }),
 *     key: 'signup',
 *   })
 */

export { useForm } from './runtime/composables/use-form'
// `injectForm` ships from here too, for discoverability alongside
// `useForm`; the helper itself is schema-agnostic.
export * from './runtime/_shared-exports'
export { zodAdapter } from './runtime/adapters/zod-v3'
export { isZodSchemaType } from './runtime/adapters/zod-v3/helpers'
export type {
  TypeWithNullableDynamicKeys,
  ZodTypeWithInnerType,
} from './runtime/adapters/zod-v3/types-zod'
export type { UnwrapZodRoot } from './runtime/adapters/zod-v3/types-zod-adapter'
export { fieldMeta, withMeta } from './runtime/adapters/zod-v3/field-meta'
export type { FieldMetaPayload } from './runtime/core/field-meta'
