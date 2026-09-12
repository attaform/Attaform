/**
 * Shared field-metadata storage. Both Zod adapters (v3 and v4) and the
 * unified `attaform/zod` entry read from the same `WeakMap`s so a
 * payload written via any entry's `withMeta` / `fieldMeta.add` is
 * visible to whichever adapter actually runs at lookup time.
 *
 * No `zod` runtime import — pure JavaScript primitives. The previous
 * v4 adapter built `fieldMeta` via `z.registry<FieldMetaPayload>()`,
 * which left a `z.registry` namespace reference reachable from
 * `attaform/zod`'s module graph; bundlers analysing a `zod@^3` consumer
 * resolved that against zod 3's exports map (no `registry` export) and
 * emitted an `IMPORT_IS_UNDEFINED` warning. Lifting storage here drops
 * that reference entirely so the unified entry behaves cleanly on any
 * Zod major.
 *
 * The native v4 chain `schema.register(fieldMeta, payload)` still
 * works against this shim — Zod 4's `.register()` only calls
 * `registry.add(this, payload)` and returns the schema; structural
 * matching is enough.
 *
 * Two parallel maps:
 * - `store` — last-write-wins single payload per schema reference.
 *   Backs `fieldMeta.get(schema)` and the adapter's
 *   `getFieldMetaAtPath` single-payload fallback.
 * - `lists` — every registration in order, per schema reference.
 *   Backs the v4 adapter's path-walker disambiguation when the same
 *   schema instance is bound at multiple form paths.
 */

import { crossCopyState } from './cross-copy-state'
import type { FieldMetaPayload } from './field-meta'
import type { PathKey } from './paths'
import type { FieldMetaWalkServices } from './walk-field-meta'

/**
 * Minimal registry shape the shared store satisfies — `.add` / `.get`
 * / `.has` / `.remove`. Cast to `z.$ZodRegistry<FieldMetaPayload>` at
 * the v4 adapter's re-export so the native `schema.register(fieldMeta,
 * payload)` chain type-checks; the v3 adapter exports it as its own
 * registry-shaped surface.
 */
export type FieldMetaStore = {
  add(schema: object, payload: FieldMetaPayload): FieldMetaStore
  get(schema: object): FieldMetaPayload | undefined
  has(schema: object): boolean
  remove(schema: object): FieldMetaStore
}

/**
 * Everything the field-meta surface keeps between a registration and a
 * lookup, held in one instance per process. Both halves of this had to
 * move off module scope (#577): the maps because Nuxt's `shared/`
 * slice and the page that reads them are compiled into separate
 * graphs, so `.register(fieldMeta, ...)` wrote one pair of maps and
 * the resolver read another; the builder slot because a write to a
 * module-scoped `let` with no reader in its own graph is a dead store,
 * and Rollup dropped the install call together with the whole walk.
 * See `cross-copy-state` for the full reasoning. Exported so the
 * cross-copy regression test can assert the slot's shape.
 */
export type FieldMetaState = {
  /** Last-write-wins single payload per schema reference. */
  store: WeakMap<object, FieldMetaPayload>
  /** Every registration in order, per schema reference. */
  lists: WeakMap<object, FieldMetaPayload[]>
  /** The installed path-map walk; see `installFieldMetaPathMapBuilder`. */
  pathMapBuilder: FieldMetaPathMapBuilder | null
}

const state = crossCopyState<FieldMetaState>(Symbol.for('attaform:field-meta-state'), () => ({
  store: new WeakMap<object, FieldMetaPayload>(),
  lists: new WeakMap<object, FieldMetaPayload[]>(),
  pathMapBuilder: null,
}))

const registry: FieldMetaStore = {
  add(schema, payload) {
    state.store.set(schema, payload)
    const list = state.lists.get(schema) ?? []
    list.push(payload)
    state.lists.set(schema, list)
    return registry
  },
  get(schema) {
    return state.store.get(schema)
  },
  has(schema) {
    return state.store.has(schema)
  },
  remove(schema) {
    state.store.delete(schema)
    state.lists.delete(schema)
    return registry
  },
}

/**
 * The shared registry every Attaform-aware Zod schema can register
 * field metadata against, regardless of Zod major. One module-scoped
 * instance — every adapter entry re-exports this same object so
 * writes from one entry are visible at lookup through any other.
 */
export const fieldMetaStore: FieldMetaStore = registry

/**
 * Last-write-wins payload lookup for a schema reference. Returns
 * `undefined` if nothing has been registered.
 */
export function getFieldMetaForSchema(schema: object): FieldMetaPayload | undefined {
  return state.store.get(schema)
}

/**
 * Read every payload registered against `schema` in registration
 * order. Empty list when nothing has been registered. Used by the
 * adapters' path-resolvers to disambiguate per occurrence when one
 * schema instance is bound at multiple form paths.
 */
export function getFieldMetaListForSchema(schema: object): readonly FieldMetaPayload[] {
  return state.lists.get(schema) ?? []
}

/**
 * Signature of `getFieldMetaPathMap` — the tree-walking path → payload
 * resolver in `walk-field-meta`. Held here as an installable slot so
 * the walker's bytes ride the REGISTRATION surface (`withMeta` /
 * `fieldMeta.add`) instead of the adapter modules: an app that never
 * registers field metadata never ships the walk, and the resolvers
 * fall back to `.describe()` / humanize.
 */
export type FieldMetaPathMapBuilder = <Schema extends object>(
  rootSchema: Schema,
  services: FieldMetaWalkServices<Schema>
) => Map<PathKey, FieldMetaPayload>

/**
 * Install the path-map walk. The registration surfaces call this on
 * every metadata write (idempotent — always the same function), which
 * is what guarantees the walk is present before any lookup could need
 * it: registering is the only way a payload can exist.
 */
export function installFieldMetaPathMapBuilder(builder: FieldMetaPathMapBuilder): void {
  state.pathMapBuilder = builder
}

/**
 * Build the path → payload map for `rootSchema` through the installed
 * walk, or `undefined` when no registration surface has ever run — in
 * which case nothing was registered and there is no map to build.
 * Callers fall back to the schema-keyed single-payload lookup and the
 * `.describe()` / humanize resolution.
 */
export function buildFieldMetaPathMap<Schema extends object>(
  rootSchema: Schema,
  services: FieldMetaWalkServices<Schema>
): Map<PathKey, FieldMetaPayload> | undefined {
  const builder = state.pathMapBuilder
  return builder === null ? undefined : builder(rootSchema, services)
}
