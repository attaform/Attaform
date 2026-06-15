import type { z } from 'zod-v3'

/**
 * The Zod v3 schema roots `useForm` accepts. Mirror of the v4
 * `SupportedRootSchema`, expressed in v3's type vocabulary: a
 * fixed-shape `z.object({ … })` or a `z.record(K, V)` dictionary form.
 *
 * Other roots (a bare `z.union`, a root `z.array`, primitives,
 * `z.map` / `z.set`) are not form roots; wrap them under a key. The
 * adapter's runtime construction rejects them with a legible error.
 *
 * Widened per feature: the discriminated-union arm lands alongside its
 * runtime support.
 */
export type SupportedRootSchema =
  | z.ZodObject<z.ZodRawShape>
  | z.ZodRecord<z.ZodTypeAny, z.ZodTypeAny>
