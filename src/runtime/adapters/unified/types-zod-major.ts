/**
 * Type-level Zod-major discriminator for the unified `attaform/zod`
 * entry. The runtime dispatch (`use-form.ts`'s impl) already routes on
 * the schema's shape via `isZodV4SchemaShape`; this is the type-level
 * mirror so the overloads and projection helpers discriminate the same
 * way.
 *
 * Why a structural marker instead of `z.ZodObject`: the unified entry's
 * overloads constrain on `z.ZodObject`, but the published `.d.mts`
 * resolves `z` against whichever single Zod major the consumer
 * installed. In a v3-only install `z.ZodObject` is v3's `ZodObject`
 * (and, lacking its required type arguments, degrades to an `any`-like
 * error type under `skipLibCheck`), so a v3 schema satisfies the v4
 * overload's constraint and binds it — collapsing the read slot to
 * `never`. A Zod v4 schema carries the `_zod` internals brand; a v3
 * schema never does.
 * Intersecting a v4-only constraint or conditional branch with this
 * marker keeps it unreachable for a v3 schema regardless of how `zod`
 * resolves, so v3 schemas fall through to the v3 overload.
 *
 * Distinct from `core/zod-shape.ts`'s runtime `ZodV4Shape` (which reads
 * the public `def` getter): at the type level the stable v4 brand is
 * `_zod.def`, the same internals `StorageShape` (v4) already reads.
 *
 * Pairing requirement: a v4 overload/branch must constrain on
 * `z.ZodObject<z.ZodRawShape> & ZodV4Internals`, NOT bare
 * `z.ZodObject & ZodV4Internals`. In a v3-only install `z.ZodObject`
 * with no type argument is `ZodObject<T, ...>` missing its required
 * arguments — an error type that behaves like `any` under
 * `skipLibCheck`, so `any & ZodV4Internals` collapses back to `any` and
 * the marker stops excluding v3 schemas. Supplying `z.ZodRawShape`
 * keeps it a concrete object type in both majors, so the intersection
 * stays meaningful.
 */
export type ZodV4Internals = { _zod: { def: unknown } }
