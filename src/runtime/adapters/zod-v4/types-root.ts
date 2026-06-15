import type { z } from 'zod'

/**
 * The Zod v4 schema roots `useForm` accepts. A fixed-shape
 * `z.object({ … })` is the common case; `z.record(K, V)` admits a
 * dictionary form (a homogeneous map with runtime-known keys);
 * `z.discriminatedUnion(disc, [...])` admits a variant form (one of
 * several object shapes, picked by a discriminator). Each projects to
 * a `GenericForm`-shaped value the form engine drives: an object root
 * descends into its fixed keys, a record root treats its entries as an
 * open live-keyed container, a variant root lifts the active variant's
 * keys into one addressable surface.
 *
 * Other roots (a bare `z.union`, a root `z.array`, primitives,
 * `z.map` / `z.set`) are not form roots; wrap them under a key. The
 * adapter's runtime construction rejects them with a legible error.
 *
 * `z.ZodObject` MUST keep its `z.ZodRawShape` argument, and the
 * discriminated-union arm MUST stay fully applied. The unified entry's
 * v4 overload constrains on `SupportedRootSchema & ZodV4Internals` to
 * keep v3 schemas out (see `../unified/types-zod-major.ts`). In a
 * single-major (v3-only) consumer install, the published `.d.mts`
 * resolves this `z` to v3, where a bare or under-applied Zod class is
 * missing its required arguments and degrades to an `any`-like error
 * type; `any` then absorbs the union and `any & ZodV4Internals`
 * collapses back to `any`, so the marker stops excluding v3 schemas and
 * the read slot poisons to `never`. `z.ZodRecord` carries defaults for
 * both arguments, so it stays concrete in either major.
 * `z.ZodDiscriminatedUnion` does NOT (v3 requires both arguments, and
 * its parameter order is the reverse of v4's), so the arm is written
 * fully applied; the v3-only bundled-types fixture guards it.
 */
export type SupportedRootSchema =
  | z.ZodObject<z.ZodRawShape>
  | z.ZodRecord
  | z.ZodDiscriminatedUnion<readonly z.ZodObject<z.ZodRawShape>[], string>
