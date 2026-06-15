import type { z } from 'zod'

/**
 * The Zod v4 schema roots `useForm` accepts. A fixed-shape
 * `z.object({ … })` is the common case; `z.record(K, V)` admits a
 * dictionary form (a homogeneous map with runtime-known keys). Both
 * project to a `GenericForm`-shaped value the form engine drives — an
 * object root descends into its fixed keys, a record root treats its
 * entries as an open, live-keyed container.
 *
 * Other roots (a bare `z.union`, a root `z.array`, primitives,
 * `z.map` / `z.set`) are not form roots; wrap them under a key. The
 * adapter's runtime construction rejects them with a legible error.
 *
 * Widened per feature: the discriminated-union arm
 * (`z.discriminatedUnion`, variant forms) lands alongside its runtime
 * support.
 *
 * `z.ZodObject` MUST keep its `z.ZodRawShape` argument. The unified
 * entry's v4 overload constrains on `SupportedRootSchema & ZodV4Internals`
 * to keep v3 schemas out (see `../unified/types-zod-major.ts`). In a
 * single-major (v3-only) consumer install, the published `.d.mts`
 * resolves this `z` to v3, where bare `z.ZodObject` is missing its
 * required shape argument and degrades to an `any`-like error type;
 * `any` then absorbs the union and `any & ZodV4Internals` collapses back
 * to `any`, so the marker stops excluding v3 schemas and the read slot
 * poisons to `never`. `z.ZodRecord` carries defaults for both arguments,
 * so it stays a concrete type in either major.
 */
export type SupportedRootSchema = z.ZodObject<z.ZodRawShape> | z.ZodRecord
