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
 */
export type SupportedRootSchema = z.ZodObject | z.ZodRecord
