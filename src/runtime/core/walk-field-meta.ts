import type { SchemaIntrospector } from './abstract-schema-factory'
import type { FieldMetaPayload } from './field-meta'
import {
  fieldMetaStore,
  installFieldMetaPathMapBuilder,
  type FieldMetaStore,
} from './field-meta-store'
import { canonicalizePath, type Path, type PathKey } from './paths'

/**
 * Version-specific primitives the field-meta walk consumes. Both
 * adapters already expose all three:
 *
 *   - `intro` — the adapter's `SchemaIntrospector` (kind discriminant +
 *     structural accessors + wrapper unwraps). The walk dispatches on
 *     `intro.kindOf`, which differs per version (v3 returns
 *     `effects` / `pipeline` / `branded`; v4 returns `pipe` / `transform`),
 *     so the switch below handles both vocabularies.
 *   - `peelAllWrappers` — the catch-peeling structural peel
 *     (`peelAllV3Wrappers` on v3, `peelAllWrappers` on v4). Used to reach
 *     a registration that sits on the inner before wrapping, e.g.
 *     `withMeta(z.string(), {...}).optional()`.
 *   - `getFieldMetaList` — reads the adapter's per-instance registration
 *     list. The registry is adapter-local (keyed by schema instance), so
 *     it can't be a shared import.
 *
 * All required: the walk has no sensible default for any of them.
 */
export interface FieldMetaWalkServices<Schema> {
  intro: SchemaIntrospector<Schema>
  peelAllWrappers: (schema: Schema) => Schema
  getFieldMetaList: (schema: Schema) => readonly FieldMetaPayload[]
}

/**
 * The store the public registration surfaces (`withMeta` / `fieldMeta`
 * on every entry) write through. `add` installs `getFieldMetaPathMap`
 * into the store's builder slot before delegating, so the path-walk
 * resolver's bytes ride the consumer's own registration import:
 * registering metadata is the only way a payload can exist, hence the
 * walk is installed before any lookup could need it. Reads and removes
 * delegate straight through — they can't create a payload, so they
 * don't need the walk.
 */
export const installingFieldMetaStore: FieldMetaStore = {
  add(schema, payload) {
    installFieldMetaPathMapBuilder(getFieldMetaPathMap)
    fieldMetaStore.add(schema, payload)
    return installingFieldMetaStore
  },
  get: (schema) => fieldMetaStore.get(schema),
  has: (schema) => fieldMetaStore.has(schema),
  remove: (schema) => {
    fieldMetaStore.remove(schema)
    return installingFieldMetaStore
  },
}

// Per-rootSchema cache of path -> payload maps, shared across adapters.
// Build is a single tree-walk; lookups are O(1) thereafter. Keyed on the
// root schema instance (a given instance belongs to exactly one Zod
// version, so v3 and v4 roots never collide) so entries GC with the form.
const pathMetaCache = new WeakMap<object, Map<PathKey, FieldMetaPayload>>()

/**
 * Build the path -> field-meta-payload map for `rootSchema` by walking
 * the schema tree once. Both adapters' `resolveFieldMetaAtPath` delegate
 * here so the path-keyed disambiguation of shared schemas registered at
 * multiple paths lives in one place.
 *
 * After the walk, "surplus" registrations get absorbed into the schema's
 * last-visited path — covers chains like
 * `withMeta(s, {label}).register(fieldMeta, {desc})` where one path
 * consumes list[0] and list[1] would otherwise go unread.
 */
export function getFieldMetaPathMap<Schema extends object>(
  rootSchema: Schema,
  services: FieldMetaWalkServices<Schema>
): Map<PathKey, FieldMetaPayload> {
  const cached = pathMetaCache.get(rootSchema)
  if (cached !== undefined) return cached
  const map = new Map<PathKey, FieldMetaPayload>()
  const counters = new Map<Schema, number>()
  const lastPathPerSchema = new Map<Schema, PathKey>()
  const inProgress = new WeakSet<object>()
  walkForMeta(rootSchema, [], map, counters, lastPathPerSchema, inProgress, services)
  for (const [schema, lastPath] of lastPathPerSchema) {
    const list = services.getFieldMetaList(schema)
    const consumed = counters.get(schema) ?? 0
    if (list.length <= consumed) continue
    const surplus = list
      .slice(consumed)
      .reduce<FieldMetaPayload>((acc, p) => ({ ...acc, ...p }), {})
    const existing = map.get(lastPath) ?? {}
    map.set(lastPath, { ...existing, ...surplus })
  }
  pathMetaCache.set(rootSchema, map)
  return map
}

/**
 * Pull a payload off `schema`'s registration list, counter-indexed so a
 * schema registered at multiple paths pairs each visit with the next
 * payload in declaration order. Clamp to the last entry — schemas reused
 * MORE times than they're registered (e.g. an array element registered
 * once, visited per-index) all share the single registration.
 */
function consumePayload<Schema>(
  schema: Schema,
  counters: Map<Schema, number>,
  getFieldMetaList: (schema: Schema) => readonly FieldMetaPayload[]
): FieldMetaPayload | undefined {
  const list = getFieldMetaList(schema)
  if (list.length === 0) return undefined
  const idx = counters.get(schema) ?? 0
  const payload = list[Math.min(idx, list.length - 1)]
  counters.set(schema, idx + 1)
  return payload
}

/**
 * Walk the schema tree from `schema`, emitting a payload for each path
 * that has registered metadata. Visits the schema first (terminal-position
 * registration), then the peeled inner if different (inner-then-wrap
 * registration). At each point the FIRST list-payload found wins for that
 * path. `inProgress` bounds recursive `z.lazy(...)` cycles.
 */
function walkForMeta<Schema extends object>(
  schema: Schema,
  path: Path,
  map: Map<PathKey, FieldMetaPayload>,
  counters: Map<Schema, number>,
  lastPathPerSchema: Map<Schema, PathKey>,
  inProgress: WeakSet<object>,
  services: FieldMetaWalkServices<Schema>
): void {
  if (inProgress.has(schema)) return
  inProgress.add(schema)
  try {
    const { intro, peelAllWrappers, getFieldMetaList } = services
    const pathKey = canonicalizePath(path).key
    if (!map.has(pathKey)) {
      const payload = consumePayload(schema, counters, getFieldMetaList)
      if (payload !== undefined) {
        map.set(pathKey, payload)
        lastPathPerSchema.set(schema, pathKey)
      }
    }
    const peeled = peelAllWrappers(schema)
    if (peeled !== schema && !map.has(pathKey)) {
      const payload = consumePayload(peeled, counters, getFieldMetaList)
      if (payload !== undefined) {
        map.set(pathKey, payload)
        lastPathPerSchema.set(peeled, pathKey)
      }
    }
    // Descend by kind. The switch handles both adapters' kind
    // vocabularies; unhandled and leaf kinds fall through to `default`
    // and stop (their own metadata was captured above).
    const kind = intro.kindOf(schema)
    switch (kind) {
      case 'object': {
        for (const [key, child] of Object.entries(intro.getObjectShape(schema))) {
          walkForMeta(child, [...path, key], map, counters, lastPathPerSchema, inProgress, services)
        }
        return
      }
      case 'array': {
        const inner = intro.getArrayElement(schema)
        if (inner !== undefined)
          walkForMeta(inner, [...path, 0], map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'tuple': {
        const items = intro.getTupleItems(schema)
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item !== undefined)
            walkForMeta(item, [...path, i], map, counters, lastPathPerSchema, inProgress, services)
        }
        return
      }
      case 'set': {
        const inner = intro.getSetValueType(schema)
        if (inner !== undefined)
          walkForMeta(inner, [...path, 0], map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'record': {
        const inner = intro.getRecordValueType(schema)
        if (inner !== undefined)
          walkForMeta(inner, [...path, '*'], map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'union': {
        for (const opt of intro.getUnionOptions(schema)) {
          walkForMeta(opt, path, map, counters, lastPathPerSchema, inProgress, services)
        }
        return
      }
      case 'discriminated-union': {
        for (const opt of intro.getDiscriminatedOptions(schema)) {
          walkForMeta(opt, path, map, counters, lastPathPerSchema, inProgress, services)
        }
        return
      }
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'catch': {
        const inner = intro.unwrapInner(schema)
        if (inner !== undefined)
          walkForMeta(inner, path, map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'pipe':
      case 'pipeline': {
        const inner = intro.unwrapPipeIn(schema)
        if (inner !== undefined)
          walkForMeta(inner, path, map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'effects': {
        const inner = intro.unwrapEffectsSource(schema)
        if (inner !== undefined)
          walkForMeta(inner, path, map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'branded': {
        const inner = intro.unwrapBranded(schema)
        if (inner !== undefined)
          walkForMeta(inner, path, map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      case 'lazy': {
        // A throwing lazy getter (a recursive cycle resolved before its
        // target is constructed) must not crash form setup. v3's
        // unwrapLazy already swallows it; the try guards v4's, which
        // rethrows. Either way the inProgress check bounds a true cycle.
        try {
          const inner = intro.unwrapLazy(schema)
          if (inner !== undefined)
            walkForMeta(inner, path, map, counters, lastPathPerSchema, inProgress, services)
        } catch {
          // Treat an unresolvable lazy as a leaf.
        }
        return
      }
      case 'intersection': {
        const left = intro.getIntersectionLeft(schema)
        const right = intro.getIntersectionRight(schema)
        if (left !== undefined)
          walkForMeta(left, path, map, counters, lastPathPerSchema, inProgress, services)
        if (right !== undefined)
          walkForMeta(right, path, map, counters, lastPathPerSchema, inProgress, services)
        return
      }
      default:
        return
    }
  } finally {
    inProgress.delete(schema)
  }
}
