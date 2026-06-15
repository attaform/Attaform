import type { z } from 'zod-v3'

/**
 * The Zod v3 schema roots `useForm` accepts. Mirror of the v4
 * `SupportedRootSchema`, expressed in v3's type vocabulary: a
 * fixed-shape `z.object({ … })`, a `z.record(K, V)` dictionary form, or
 * a `z.discriminatedUnion(disc, [...])` variant form.
 *
 * Other roots (a bare `z.union`, a root `z.array`, primitives,
 * `z.map` / `z.set`) are not form roots; wrap them under a key. The
 * adapter's runtime construction rejects them with a legible error.
 *
 * The discriminated-union arm is written with v3's parameter order
 * (`<Discriminator, Options>`), the reverse of v4's; both classes
 * require their arguments, so the arm stays fully applied to avoid the
 * single-major `any`-collapse the v4 alias documents.
 */
export type SupportedRootSchema =
  | z.ZodObject<z.ZodRawShape>
  | z.ZodRecord<z.ZodTypeAny, z.ZodTypeAny>
  | z.ZodDiscriminatedUnion<string, readonly z.ZodDiscriminatedUnionOption<string>[]>
