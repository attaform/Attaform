/**
 * Field-metadata write and read API for the Zod v3 adapter.
 *
 * Storage lives in the shared `core/field-meta-store`, where every entry
 * (`attaform/zod`, `attaform/zod-v3`, `attaform/zod-v4`) reads and
 * writes the same `WeakMap`s, so a payload registered through any of
 * them surfaces at lookup whichever adapter runs.
 *
 * **Registration order does not matter.** Register on the schema
 * reference assigned into the parent's shape, or on the inner schema
 * before wrapping:
 *
 *     // equivalent; both hit at lookup time
 *     withMeta(z.string(), { label: 'Email' }).optional()
 *     withMeta(z.string().optional(), { label: 'Email' })
 *
 * The path walker returns the wrapper at a terminal position and peels
 * at intermediate descent, and the resolver tries the walker's schema
 * before the peeled inner, so the two-stage lookup covers leaf and
 * container registrations symmetrically.
 */
import type { z } from 'zod-v3'
import type { FieldMetaPayload } from '../../core/field-meta'
import { getFieldMetaForSchema } from '../../core/field-meta-store'
import { installingFieldMetaStore } from '../../core/walk-field-meta'

/** The `add` / `get` / `has` / `remove` shape of `fieldMeta`, matching
 *  Zod 4's `$ZodRegistry` closely enough to read the same either way. */
type FieldMetaRegistryV3 = {
  /**
   * Register `payload` against `schema`. Returns the registry to
   * mirror Zod 4's `$ZodRegistry.add` chain shape.
   */
  add<S extends z.ZodTypeAny>(schema: S, payload: FieldMetaPayload): FieldMetaRegistryV3
  /**
   * Read the registered payload for a schema, or `undefined` if
   * nothing has been registered.
   */
  get(schema: z.ZodTypeAny): FieldMetaPayload | undefined
  /** True iff a payload has been registered for the schema. */
  has(schema: z.ZodTypeAny): boolean
  /**
   * Drop every registered payload for `schema`. Returns the registry
   * for chaining; idempotent on a never-registered schema.
   */
  remove(schema: z.ZodTypeAny): FieldMetaRegistryV3
}

/**
 * The shared registry an Attaform-aware Zod 3 schema registers field
 * metadata against.
 *
 * ```ts
 * import { fieldMeta } from 'attaform/zod-v3'
 *
 * const email = z.string().email()
 * fieldMeta.add(email, { label: 'Email address' })
 * ```
 *
 * It is backed by the cross-adapter store, so a payload registered here
 * is visible to the v4 adapter and to the unified `attaform/zod` entry,
 * and the reverse. Every `add` also installs the path-walking resolver
 * into the shared store's builder slot, which is what makes the walk's
 * bytes ride this module's import rather than the adapter: a consumer
 * who never registers metadata never ships the walk.
 */
export const fieldMeta = installingFieldMetaStore as unknown as FieldMetaRegistryV3

/**
 * Attach `payload` to `schema` in the shared `fieldMeta` registry and
 * return a chainable CLONE of `schema` carrying the new metadata. Zod 3
 * has no `schema.register()`, so this is its only fluent write API, and
 * it matches `attaform/zod`'s `withMeta()`.
 *
 * It clones rather than mutates because the store keys metadata on the
 * schema reference: calling `withMeta` twice on one instance would
 * overwrite last-write-wins, and a sub-schema reused at several paths,
 * an address shared between pickup and delivery say, could then carry
 * only one payload. Zod 3 exposes no `.clone()`, so the reconstruction
 * goes through `new schema.constructor(schema._def)`. Each call gets a
 * fresh identity and a fresh registry slot, and existing metadata merges
 * through, so chaining accumulates payload fields rather than replacing
 * them.
 *
 * An inner field schema, an object's `.shape.city` for instance, is
 * shared across clones, the def being held by reference, so leaf
 * metadata registers once and surfaces at every path. See this file's
 * header for the two equivalent registration orderings.
 */
export function withMeta<S extends z.ZodTypeAny>(schema: S, payload: FieldMetaPayload): S {
  const existing = getFieldMetaForSchema(schema as object) ?? {}
  // Every ZodSchema subclass's constructor takes a `_def` and produces
  // an instance: same shape, fresh identity.
  const Ctor = schema.constructor as new (def: S['_def']) => S
  const cloned = new Ctor(schema._def)
  installingFieldMetaStore.add(cloned as object, { ...existing, ...payload })
  return cloned
}
