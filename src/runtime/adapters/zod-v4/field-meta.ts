/**
 * Field-metadata write and read API for the Zod v4 adapter.
 *
 * Storage lives in the shared `core/field-meta-store`, where every entry
 * (`attaform/zod`, `attaform/zod-v3`, `attaform/zod-v4`) reads and
 * writes the same `WeakMap`s, so a payload registered through any of
 * them surfaces at lookup whichever adapter runs. The native chain
 * `schema.register(fieldMeta, payload)` works too: Zod 4's `.register`
 * calls `registry.add(this, payload)` and returns the schema, which the
 * shared store satisfies structurally.
 *
 * **Registration order does not matter.** Register on the schema
 * reference assigned into the parent's shape, or on the inner schema
 * before wrapping:
 *
 *     // equivalent; all four hit at lookup time
 *     withMeta(z.string(), { label: 'Email' }).optional()
 *     withMeta(z.string().optional(), { label: 'Email' })
 *     z.string().optional().register(fieldMeta, { label: 'Email' })
 *     z.string().register(fieldMeta, { label: 'Email' }).optional()
 *
 * The path walker returns the wrapper at a terminal position, so
 * `['email']` against `{ email: z.string().optional() }` resolves to
 * `ZodOptional<ZodString>`, and peels at intermediate descent, so
 * `['address', 'street']` goes through `address`'s wrapper to the inner
 * object. The resolver tries the walker's schema before the peeled
 * inner, so the two-stage lookup covers leaf and container
 * registrations symmetrically.
 */
import type { z } from 'zod'
import type { FieldMetaPayload } from '../../core/field-meta'
import { getFieldMetaForSchema } from '../../core/field-meta-store'
import { installingFieldMetaStore } from '../../core/walk-field-meta'

// `$ZodRegistry` is not surfaced under zod's classic external `z`
// namespace, but `z.registry()` returns one, so `ReturnType<typeof
// z.registry<T>>` names the registry type without a direct import. The
// `import type` keeps it type-only, so no `z.registry` reaches the
// bundle.
type ZodFieldMetaRegistry = ReturnType<typeof z.registry<FieldMetaPayload>>

/**
 * The shared registry an Attaform-aware Zod 4 schema registers field
 * metadata against.
 *
 * ```ts
 * import { fieldMeta } from 'attaform/zod'
 *
 * const schema = z.object({
 *   email: z.string().register(fieldMeta, { label: 'Email address' }),
 * })
 * ```
 *
 * One module-scoped instance, shared with the v3 adapter and the
 * unified `attaform/zod` entry, so a `.register()` chain written in one
 * place is read by an adapter in another. Extending `FieldMetaPayload`
 * by declaration merging gives the richer payload type at every
 * `register` / `add` / `get` call site.
 *
 * **One schema instance can carry different metadata per path.** Reuse
 * an address schema at both `pickup` and `delivery` and each keeps its
 * own label, through the native chain included:
 *
 *     z.object({
 *       pickup: addressSchema.register(fieldMeta, { label: 'Pickup address' }),
 *       delivery: addressSchema.register(fieldMeta, { label: 'Delivery address' }),
 *     })
 *     // form.fields('pickup').label   -> 'Pickup address'
 *     // form.fields('delivery').label -> 'Delivery address'
 *
 * The store keeps a parallel list of every registration, and the
 * path-resolver walks the form's schema tree counting per-schema
 * occurrences to pick the right payload per path. Object literals
 * evaluate left to right, so registration order matches tree-walk order
 * and the pairing holds. `withMeta()` never reaches this case at all,
 * since it clones per call.
 *
 * The cast to the registry type is what lets `schema.register(fieldMeta,
 * payload)` type-check at the call site; Zod 4's `.register()` only
 * calls `.add(this, payload)`, so it is sound at runtime. Every `add`
 * also installs the path-walking resolver into the shared store's
 * builder slot, which is what makes the walk's bytes ride this module's
 * import rather than the adapter: a consumer who never registers
 * metadata never ships the walk.
 */
export const fieldMeta = installingFieldMetaStore as unknown as ZodFieldMetaRegistry

/**
 * Attach `payload` to `schema` in the shared `fieldMeta` registry and
 * return a chainable CLONE of `schema` carrying it. It matches
 * `attaform/zod-v3`'s `withMeta()`, so a schema module written with it
 * reads the same under either adapter.
 *
 * For v4-only code prefer the native `schema.register(fieldMeta,
 * payload)`, which registers on the instance you passed and returns
 * that same instance. Reach for `withMeta` when the module has to
 * compile under both adapters, or when one schema instance is reused at
 * several paths and each needs its own payload: the clone per call is
 * what gives each call site its own registry slot.
 */
export function withMeta<S extends z.ZodType>(schema: S, payload: FieldMetaPayload): S {
  // The registry keys on schema reference, so without the clone two
  // registrations on one instance would overwrite last-write-wins and
  // every path would resolve to the most recent payload. Merging the
  // existing payload through is what makes chaining accumulate:
  // `withMeta(withMeta(s, { label }), { description })` keeps both.
  const existing = getFieldMetaForSchema(schema as object) ?? {}
  const cloned = schema.clone() as S
  installingFieldMetaStore.add(cloned as object, { ...existing, ...payload })
  return cloned
}
