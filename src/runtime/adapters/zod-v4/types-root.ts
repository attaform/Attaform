/**
 * A Zod v4 schema whose core definition matches `Def`, named by the
 * `_zod` internals that classic `zod` and `zod/mini` schemas both carry.
 */
type ZodV4SchemaOf<Def> = { _zod: { def: Def } }

/**
 * Any Zod v4 schema, from `zod` or `zod/mini`. The public signatures that
 * take a v4 schema below the root (`PathInput`, `PathOutput`, `withMeta`)
 * constrain on it, for the reasons `SupportedRootSchema` gives.
 */
export type ZodV4Schema = ZodV4SchemaOf<{ type: string }>

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
 * Each arm is structural on `_zod.def.type`, Zod's core internals, so a
 * `zod/mini` root binds exactly as its classic twin does, and the form
 * types project through `z.input` / `z.output`, which are core's too. A
 * plain union's `def` has no `discriminator`, which keeps it out of the
 * third arm.
 *
 * The alias names nothing from `zod`, and the unified `attaform/zod`
 * entry depends on that. Its published `.d.mts` resolves `zod` against
 * the one major a consumer installed, and in a v3-only install a classic
 * class reference such as `z.ZodObject` degrades to an `any`-like error
 * type, which a v3 schema satisfies: the v4 overload would capture it and
 * collapse its read slot to `never`. No v3 schema carries `_zod`, so this
 * constraint sends every v3 schema to the v3 overload however `zod`
 * resolves. The v3-only bundled-types fixture guards it.
 */
export type SupportedRootSchema =
  | ZodV4SchemaOf<{ type: 'object' }>
  | ZodV4SchemaOf<{ type: 'record' }>
  | ZodV4SchemaOf<{ type: 'union'; discriminator: string }>
