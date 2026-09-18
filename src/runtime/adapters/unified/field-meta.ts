/**
 * Field-metadata write/read API for the unified `attaform/zod` entry.
 *
 * Storage is shared with both adapters through `core/field-meta-store`,
 * so a payload written here is visible to whichever adapter the unified
 * `useForm` dispatches to at runtime, whatever the Zod major. No
 * `zod` runtime import; the type-only `import type` is erased at
 * build, so `attaform/zod` carries no `z.registry` reference even
 * when consumed by a Zod 3 project without the Vite plugin alias.
 *
 * The native v4 chain `schema.register(fieldMeta, payload)` works too:
 * Zod 4's `.register()` only calls `.add(this, payload)` structurally,
 * which the shared store satisfies.
 */
import type { z } from 'zod'
import type { FieldMetaPayload } from '../../core/field-meta'
import { getFieldMetaForSchema } from '../../core/field-meta-store'
import { installingFieldMetaStore } from '../../core/walk-field-meta'

// `$ZodRegistry` is not surfaced under the classic external entry's `z`
// namespace, but `z.registry()` returns one, so `ReturnType<typeof
// z.registry<T>>` names the registry type without a direct import. The
// `import type` keeps it type-only, so no `z.registry` reaches the
// bundle.
type ZodFieldMetaRegistry = ReturnType<typeof z.registry<FieldMetaPayload>>

/**
 * The shared registry an Attaform-aware Zod schema registers field
 * metadata against, whatever its major. The same instance the v3 and v4
 * adapter entries expose: write in one place, read from any.
 *
 * Cast to Zod 4's `$ZodRegistry<FieldMetaPayload>` so the native
 * `schema.register(fieldMeta, payload)` chain type-checks for v4
 * users; the runtime call only needs `.add` structurally, which the
 * shared store provides.
 *
 * Backed by `installingFieldMetaStore`: every `add` also installs the
 * path-walking resolver into the shared store's builder slot, so the
 * walk's bytes ride this module's import instead of the adapters. A
 * consumer that never registers metadata never ships the walk.
 */
export const fieldMeta = installingFieldMetaStore as unknown as ZodFieldMetaRegistry

/**
 * Attach `payload` to `schema` in the shared registry and return a
 * clone of `schema` so each call gets its own identity (the registry
 * keys on schema reference, so cloning prevents last-write-wins
 * collisions for sub-schemas reused at multiple paths).
 *
 * Works on a Zod 3 or a Zod 4 schema, branching on runtime shape:
 * - Zod 4 schemas expose a public `.clone()` method; we call it.
 * - Zod 3 schemas don't, so we reconstruct via
 *   `new schema.constructor(schema._def)`.
 *
 * Both forms produce a fresh schema with the same effective
 * structure, so the registry slot is unique to this call site.
 */
export function withMeta<S>(schema: S, payload: FieldMetaPayload): S {
  const target = schema as object
  const existing = getFieldMetaForSchema(target) ?? {}
  const cloned = cloneSchema(schema)
  installingFieldMetaStore.add(cloned as object, { ...existing, ...payload })
  return cloned
}

function cloneSchema<S>(schema: S): S {
  const candidate = schema as { clone?: unknown; constructor: unknown; _def: unknown }
  if (typeof candidate.clone === 'function') {
    return (candidate.clone as () => S)()
  }
  // Zod 3 path: reconstruct via constructor + _def (no public
  // `.clone()` on v3).
  const Ctor = candidate.constructor as new (def: unknown) => S
  return new Ctor(candidate._def)
}
