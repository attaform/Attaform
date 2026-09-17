import type { Path, Segment } from './paths'
import { consumerHas, consumerKeys, readConsumerIndex } from './consumer-code'
import {
  copyConsumerArray,
  isShadowedKey,
  safeAssign,
  safeOwnHas,
  safeOwnRead,
  spreadConsumerRecord,
} from './safe-assign'

/**
 * The minimal slice of `AbstractSchema` the structural-completeness helpers
 * need. Declared inline rather than imported from types-api so this file stays
 * free of cyclic imports: types-api imports types-core, types-core imports
 * neither, and `create-form-store.ts`, which consumes this file, sits between.
 */
export type SchemaForFill = {
  getDefaultAtPath(path: Path): unknown
  /**
   * A number is a tuple's structural length; `null` is everything else, an
   * unbounded array or no array at `path` at all. Definitive. See
   * `AbstractSchema.arrayShapeAtPath`.
   */
  arrayShapeAtPath(path: Path): number | null
  /**
   * Slim primitive set at `path`. `mergeStructural` reads it to tell "consumer
   * omitted this key from a partial", which fills from the schema default,
   * from "consumer explicitly wrote undefined into a path that admits it",
   * which preserves the undefined. An empty set, meaning a path the schema
   * does not know, never contains `'undefined'`, so an unknown path keeps the
   * fill-with-default behaviour. See
   * `AbstractSchema.getSlimPrimitiveTypesAtPath`.
   */
  getSlimPrimitiveTypesAtPath(path: Path): ReadonlySet<string>
  /**
   * How the container at `path` spells its own entry keys. The write walkers
   * consult it at a `Map`, where a new entry must be filed under a key of the
   * declared type and the segment alone cannot say which: an integer-looking
   * segment canonicalises to a number, so a map declared
   * `z.map(z.string(), V)` would take a numeric key for `scores.42` and fail
   * its own parse. See `AbstractSchema.entryKeyKindAtPath`.
   */
  entryKeyKindAtPath(path: Path): 'string' | 'number' | undefined
}

/**
 * Structured-path get and set primitives, for internal callers that speak
 * `Path` rather than dotted strings.
 *
 * `getAtPath` returns `undefined` for any path traversing a non-descendable
 * value (null, a primitive, a function). The distinction is preserved at the
 * target itself: a `null` there comes back as `null`, and only a missing or
 * non-descendable INTERMEDIATE collapses.
 *
 * `setAtPath` is copy-on-write at every level from root to target. A new
 * intermediate container follows its segment type, a numeric segment
 * producing an array and a string one a plain object. Siblings at each level
 * are preserved by reference, so an untouched subtree stays reference-equal
 * for `diffAndApply`'s `Object.is` checks.
 */

const NOT_FOUND: unique symbol = Symbol('NOT_FOUND')

/**
 * The key `map` files `segment` under.
 *
 * A path segment is a string or a non-negative integer, and
 * `normalizeSegment` turns every integer-looking string into the
 * number, so `scores.42` arrives here as `42` whether the consumer
 * wrote the map's key as `'42'` or `42`. Resolving that back:
 *
 * 1. The spelling the map already holds wins, so reading and
 *    overwriting an existing entry never depends on the schema.
 * 2. For a key the map does not hold yet, `declared` decides. It is the
 *    map's own key type, from `entryKeyKindAtPath`; a writer with no schema
 *    in hand passes `undefined` and the segment stands.
 *
 * The reverse direction needs no case: a non-integer-looking segment
 * is already a string, and a number-keyed map's segment is already a
 * number.
 */
function mapKeyForSegment(
  map: ReadonlyMap<unknown, unknown>,
  segment: Segment,
  declared?: 'string' | 'number'
): unknown {
  if (map.has(segment)) return segment
  if (typeof segment !== 'number') return segment
  const asString = String(segment)
  if (map.has(asString)) return asString
  return declared === 'string' ? asString : segment
}

/**
 * Whether a write may rebuild the container at `root` to hold `segment`.
 *
 * Every write is copy-on-write from the root down, and the rebuild knows two
 * shapes: an array for a numeric segment, a plain record for a string one, a
 * `Map` having been handled by its own branch ahead of this. A fresh empty
 * container is the right answer for a slot that is missing, null, or holding a
 * scalar the write replaces. It is the WRONG answer for a slot already holding
 * an object of some other kind, because the rebuild replaces rather than
 * copies and everything the original held is gone.
 *
 * `z.set` is how that is reachable: the schema walker consumes a segment at a
 * set to answer what its members look like, so `tags.0` clears the write gate
 * and a numeric rebuild turns a `Set` of three into an `Array` of one.
 * `entryKeyKindAtPath` is the loud half of the rule, refusing and dev-warning
 * before reaching here, since a set has no addressable entry; this is the
 * quiet half, so a caller arriving some other way leaves the tree alone.
 * Structural rather than a list of refused classes, so a container kind nobody
 * here thought of is covered the same way.
 */
function isRebuildableContainer(root: unknown, segment: Segment): boolean {
  if (root === null || root === undefined || typeof root !== 'object') return true
  return typeof segment === 'number' ? Array.isArray(root) : isPlainRecord(root)
}

/**
 * One step of a read descent.
 *
 * Every read here is of a container the CONSUMER supplied, so any can throw:
 * an index or key may be an accessor, and a Proxy, which `reactive()` returns,
 * traps `in` as readily as a property read. This sits under `getAtPath`, which
 * every FieldState rollup calls during render, so an escape surfaces as the
 * host component's render throwing.
 *
 * The containment is therefore real, but it lives in the CALLERS: one `try`
 * around the whole descent rather than a guarded accessor per segment. That
 * shape is measured. Per-segment guards cost 8% of a one-segment read and 34%
 * of a sixteen-segment one, because each guard is a call into a function
 * holding a `try` and the loop body stops being inlinable. Cost per descent is
 * what a path read can afford; cost per segment is not, and this is the
 * hottest read in Attaform.
 */
function descendStep(value: unknown, segment: Segment): unknown | typeof NOT_FOUND {
  if (value === null || value === undefined) return NOT_FOUND
  if (typeof value !== 'object') return NOT_FOUND
  if (Array.isArray(value)) {
    if (typeof segment !== 'number') return NOT_FOUND
    // Presence-test the index rather than comparing it against `value.length`.
    // On a reactive array `in` hits Vue's `has` trap and tracks only this
    // index, where reading `.length` would subscribe the caller to the array
    // length. Descending into an element must NOT couple the reader to the
    // sibling count: a length read makes every element's value access, and the
    // FieldState rollup on it, re-run on any append or remove, turning an
    // array op into O(N x element-leaves). An out-of-range, negative or hole
    // index is absent, so `in` is false and NOT_FOUND comes back exactly as a
    // bounds comparison would give.
    if (!(segment in value)) return NOT_FOUND
    return value[segment]
  }
  if (value instanceof Map) {
    // A map's entries are real sub-paths: one segment addresses one entry, the
    // shape a record has (#614). `has` before `get` keeps "present and holding
    // undefined" apart from "absent", and on a reactive map both hit Vue's
    // per-key traps, so descending one entry does not subscribe to the size.
    const key = mapKeyForSegment(value, segment)
    if (!value.has(key)) return NOT_FOUND
    return value.get(key)
  }
  const record = value as Record<string, unknown>
  const key = typeof segment === 'number' ? String(segment) : segment
  // Own-property-safe descent for a prototype-shadowed key name
  // (`hasOwnProperty`, `toString`, `__proto__`): `key in record` answers `true`
  // for the inherited member and `record[key]` returns it, or Vue's
  // instrumented `hasOwnProperty` shim through a reactive proxy, when no own
  // data slot exists. The own-descriptor read returns the stored value,
  // NOT_FOUND when purely inherited, and forwards to the raw descriptor on a
  // reactive proxy.
  //
  // That descriptor read bypasses Vue's get trap, so descending a shadowed
  // segment registers NO per-key dependency. Reactivity is carried at the
  // write site instead: a write changing a root-level shadowed key makes
  // `applyFormReplacement` fire the whole-`form` ref through `triggerRef`,
  // while a shadowed key nested under a non-shadowed ancestor rides that
  // ancestor's per-key dep, which the copy-on-write fallback reassigns.
  if (isShadowedKey(key)) {
    if (!safeOwnHas(record, key)) return NOT_FOUND
    return safeOwnRead(record, key)
  }
  if (!(key in record)) return NOT_FOUND
  return record[key]
}

export function getAtPath(root: unknown, path: Path): unknown {
  if (path.length === 0) return root
  try {
    let current: unknown = root
    for (const segment of path) {
      const next = descendStep(current, segment)
      if (next === NOT_FOUND) return undefined
      current = next
    }
    return current
  } catch {
    // A consumer accessor or Proxy trap threw somewhere in the descent.
    // `undefined` is already this function's answer for a path that does not
    // resolve and every caller handles it, so the throw is absorbed into an
    // answer the contract allows rather than escaping into whatever render is
    // reading this path.
    return undefined
  }
}

/**
 * True iff `path` exists in `root` as a descendable chain to a leaf or a
 * defined value. "Exists and holds undefined" is distinct from "missing".
 */
export function hasAtPath(root: unknown, path: Path): boolean {
  if (path.length === 0) return true
  try {
    return hasAtPathUnguarded(root, path)
  } catch {
    // Same containment as `getAtPath`: an existence check is no safer than a
    // read, and `false` is already the answer for a path that is not there.
    return false
  }
}

function hasAtPathUnguarded(root: unknown, path: Path): boolean {
  let current: unknown = root
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as Segment
    const next = descendStep(current, segment)
    if (next === NOT_FOUND) return false
    current = next
  }
  const last = path[path.length - 1] as Segment
  if (current === null || current === undefined) return false
  if (typeof current !== 'object') return false
  if (Array.isArray(current)) {
    // Presence-test the index rather than comparing it against
    // `current.length`, for the reason `descendStep` gives. `hasAtPath` is the
    // active-path gate for errors and field state, so an entry pinned directly
    // at an array-index path must not re-run it on every append or remove just
    // because a sibling changed the length. `in` is also truer to the
    // contract: a never-assigned hole is missing, where a `< length`
    // comparison reports it present.
    return typeof last === 'number' && consumerHas(current, last)
  }
  if (current instanceof Map) {
    return current.has(mapKeyForSegment(current, last))
  }
  const key = typeof last === 'number' ? String(last) : last
  // Own-property existence for a prototype-shadowed name: `key in current`
  // reports `true` for an inherited slot the consumer never wrote. See
  // `descendStep` and `safeOwnHas`.
  if (isShadowedKey(key)) return safeOwnHas(current as Record<string, unknown>, key)
  return consumerHas(current as Record<string, unknown>, key)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === null || proto === Object.prototype
}

const NO_SCHEMA_DEFAULTS: ReadonlySet<string> = new Set()

/**
 * The empty schema: every structural question answers "nothing declared at
 * this path". It lets `setAtPath` run on the schema-aware writer's spine
 * rather than keeping a second copy of it.
 *
 * ONE spine is the point. Every `setValue` goes through
 * `setAtPathWithSchemaFill`, so hardening applied to a separate `setAtPath`
 * body protects a walker nothing calls, and the suite guarding it keeps
 * passing while the live writer assigns through a raw `rec[head]`.
 */
const NO_SCHEMA_FILL: SchemaForFill = {
  getDefaultAtPath: () => undefined,
  arrayShapeAtPath: () => null,
  getSlimPrimitiveTypesAtPath: () => NO_SCHEMA_DEFAULTS,
  entryKeyKindAtPath: () => undefined,
}

export function setAtPath(root: unknown, path: Path, value: unknown): unknown {
  return setAtPathWithSchemaFill(root, NO_SCHEMA_FILL, path, value)
}

export type InPlaceWriteResult = { applied: true; old: unknown } | { applied: false }

const NO_IN_PLACE: InPlaceWriteResult = { applied: false }

/**
 * In-place leaf write preserving ancestor container identity, the fast path
 * behind a single `setValue` keystroke. When the exact leaf slot at `path`
 * exists and holds a non-container value, mutate it directly on the live
 * reactive tree and return the prior value. Every ancestor keeps its object
 * identity, so a by-reference watch on a container stays quiet on a descendant
 * edit while the leaf's own dependency still fires.
 *
 * Returns `{ applied: false }` in every case that is NOT a pure in-place leaf
 * edit, and the caller falls back to copy-on-write `setAtPathWithSchemaFill`
 * plus a first-segment reassign:
 * - an empty `path`, which is a root replacement;
 * - any prototype-shadowed segment, which bypasses reactive get and set
 *   tracking, so its reactivity is carried by the fallback: a non-shadowed
 *   ancestor's reassign for a nested key, or the `triggerRef` that
 *   `applyFormReplacement` fires for a changed root-level shadowed key;
 * - a missing or non-descendable ancestor, or an out-of-range array index,
 *   both structural changes where the container SHOULD get a new reference;
 * - an absent target slot, since adding a key or index is structural;
 * - a container already at the slot, which a container-target write replaces
 *   wholesale, and the contract gives the write target a fresh reference
 *   either way.
 *
 * `root` MUST be the reactive `form.value`, not a raw clone, so the assignment
 * fires Vue's dependency for the written key.
 */
export function tryInPlaceLeafWrite(root: unknown, path: Path, value: unknown): InPlaceWriteResult {
  if (path.length === 0) return NO_IN_PLACE
  try {
    return descendAndWrite(root, path, value)
  } catch {
    // Every read and the final write touch a container the consumer supplied,
    // so any can be an accessor or a Proxy trap that throws. `NO_IN_PLACE` is
    // already the answer for "this write cannot be done in place", and the
    // copy-on-write fallback it sends the caller to walks through the guarded
    // readers, so bailing here is a downgrade in speed, never in correctness.
    return NO_IN_PLACE
  }
}

function descendAndWrite(root: unknown, path: Path, value: unknown): InPlaceWriteResult {
  // Single validated descent: at each level the segment must address an
  // existing slot on a descendable container. A missing or non-descendable
  // node, an out-of-range index, an absent key, or a prototype-shadowed
  // segment that bypasses reactive tracking all mean a structural write, so
  // fall back to copy-on-write.
  let node: unknown = root
  for (let i = 0; i < path.length; i++) {
    const seg = path[i] as Segment
    // A `Map` is never edited in place, unlike the array element one step
    // down. `materializeFormValue` shares a map with the consumer BY
    // REFERENCE, as it does a `Set`, `File`, `Blob` and `Date`, some of which
    // cannot be copied at all, where it deep-copies a plain object or array.
    // So an in-place map write reaches back into the `defaultValues` the
    // consumer still holds, mutating their object and, because `originals` was
    // seeded from that same map, making the entry read `dirty: false` the
    // instant it is edited. Copy-on-write gives the map a fresh identity on
    // the first write and leaves the consumer's original alone.
    if (node instanceof Map) return NO_IN_PLACE
    if (Array.isArray(node)) {
      if (typeof seg !== 'number' || seg < 0 || seg >= node.length) return NO_IN_PLACE
    } else if (isPlainRecord(node)) {
      if (typeof seg !== 'string' || isShadowedKey(seg) || !(seg in node)) return NO_IN_PLACE
    } else {
      return NO_IN_PLACE
    }
    const container = node as Record<string | number, unknown>
    if (i < path.length - 1) {
      node = container[seg]
      continue
    }
    // Leaf step: only an existing non-container slot is editable in place;
    // a container target is replaced wholesale by the fallback.
    const old = container[seg]
    if (isPlainRecord(old) || Array.isArray(old)) return NO_IN_PLACE
    container[seg] = value
    return { applied: true, old }
  }
  return NO_IN_PLACE
}

/**
 * Recursive merge filling consumer-supplied gaps with the schema's prescribed
 * defaults. Every `setValueAtPath` write goes through it, as does a whole-form
 * callback return, so the form stays structurally complete afterwards.
 *
 * - Plain object: every schema-default key absent from `consumer` is filled
 *   from the schema default at that key. A schema-only key recurses into
 *   structural completeness; a consumer-only key survives untouched, for
 *   validation to flag.
 * - Array: each consumer element merges with the SCHEMA element default at
 *   its own index. Length follows the consumer, since padding past it is
 *   `setAtPathWithSchemaFill`'s job.
 * - A `null` consumer wins, being a deliberate clear signal that validation
 *   catches against a non-nullable shape.
 * - An `undefined` consumer falls back to the schema default, undefined
 *   reading as missing. When that default is also undefined the result is
 *   undefined, schema and consumer agreeing.
 * - A primitive, Date, RegExp, Map, Set or class instance is a leaf under
 *   `isPlainRecord`: the consumer wins and nothing recurses.
 *
 * A consumer already structurally complete comes back BY REFERENCE, so the
 * common write allocates nothing.
 */
export function mergeStructural(
  schema: SchemaForFill,
  path: Path,
  consumer: unknown,
  defaultValue: unknown = schema.getDefaultAtPath(path)
): unknown {
  // The recursion shares one mutable scratch path: each level pushes its
  // segment before descending and pops on return, which is what avoids a
  // `[...path, key]` allocation per object key and per array element. Schema
  // adapters read `getDefaultAtPath` synchronously and retain no path, so the
  // live scratch is safe to pass; an adapter that needed to retain one would
  // snapshot inside itself rather than have this allocate per call.
  const scratch: Segment[] = path.slice()
  return mergeStructuralImpl(schema, scratch, consumer, defaultValue)
}

function mergeStructuralImpl(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: unknown,
  defaultValue: unknown
): unknown {
  // A missing consumer falls back to the schema default. When that default is
  // itself `undefined`, the path not existing in the schema, the result is
  // `undefined`.
  //
  // Exception: where the schema's slim primitive set admits `undefined`, as
  // `.optional()` does, an explicit consumer undefined IS the intended value.
  // Otherwise the directive's optional-clear write, the user emptying an
  // `.optional()` input, is substituted with whatever the structural wrappers
  // resolve to, `null` for `.nullable().optional()`, defeating the
  // schema-aware DOM clear.
  if (consumer === undefined) {
    if (schema.getSlimPrimitiveTypesAtPath(scratch).has('undefined')) {
      return undefined
    }
    return defaultValue
  }

  // Null wins: deliberate consumer signal. Schema-validation catches
  // null-vs-non-nullable; runtime doesn't override consumer intent.
  if (consumer === null) return null

  // Array branch: tuple-like against unbounded; see `mergeStructuralArray`.
  if (Array.isArray(consumer)) {
    return mergeStructuralArray(schema, scratch, consumer)
  }

  // Map: recurse into each entry against the schema's value default at that
  // entry's own path, so a partial entry written wholesale gets the structural
  // completion a record entry gets. The key set follows the consumer, since
  // filling absent keys from a default means nothing when every key is data.
  // Returns `consumer` by reference when nothing under it changed.
  if (consumer instanceof Map) {
    return mergeStructuralMap(schema, scratch, consumer)
  }

  // Plain object: fill missing keys from default, recurse on present
  // keys. Consumer-only keys pass through.
  if (isPlainRecord(consumer)) {
    if (!isPlainRecord(defaultValue)) {
      // The default is a non-record, undefined or a leaf, so there is nothing
      // to fill and the consumer wins as-is. Recurse anyway, in case the
      // consumer holds nested keys the schema knows about deeper down.
      return consumer
    }
    // The merge target carries `Object.prototype`, matching `setAtPath`. Object
    // spread uses `CreateDataProperty` per the spec, which bypasses the
    // inherited `__proto__` setter, so a consumer carrying a literal
    // `__proto__` own property survives without reassigning the result's
    // prototype chain.
    //
    // Spread through the guarded helper, because a consumer object can carry a
    // throwing accessor and `{ ...consumer }` invokes every getter. The helper
    // spreads first and falls back to a guarded copy only on a throw, so the
    // happy path is unchanged.
    const out: Record<string, unknown> = spreadConsumerRecord(consumer)
    const filledAny = fillMissingKeysFromDefault(schema, scratch, consumer, defaultValue, out)
    const recursedAny = recurseIntoConsumerKeys(schema, scratch, consumer, defaultValue, out)
    return filledAny || recursedAny ? out : consumer
  }

  // Leaf-ish (a primitive, Date, RegExp, Map, Set or class instance): the
  // consumer wins and nothing recurses.
  return consumer
}

/**
 * Merge a consumer map against the schema, entry by entry. Every entry resolves
 * to the same value schema, so the element default is queried once and reused
 * across keys, the shape `mergeStructuralArray` uses for an unbounded array.
 * Returns the original `consumer` when no entry changed.
 */
function mergeStructuralMap(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: ReadonlyMap<unknown, unknown>
): unknown {
  if (consumer.size === 0) return consumer
  let entryDefault: unknown
  let entryDefaultRead = false
  let out: Map<unknown, unknown> | null = null
  for (const [key, entry] of consumer) {
    // Only a key a segment can spell has a sub-path to complete against. An
    // object- or symbol-keyed entry carries through untouched, as the leaf
    // branch carries any other value.
    if (typeof key !== 'string' && typeof key !== 'number') continue
    scratch.push(key)
    if (!entryDefaultRead) {
      entryDefault = schema.getDefaultAtPath(scratch)
      entryDefaultRead = true
    }
    const merged = mergeStructuralImpl(schema, scratch, entry, entryDefault)
    scratch.pop()
    if (merged === entry) continue
    out ??= new Map(consumer)
    out.set(key, merged)
  }
  return out ?? consumer
}

/**
 * Merge a consumer array against the schema. A tuple-like path, fixed length
 * per `arrayShapeAtPath`, pads the consumer up to the structural length and
 * queries a per-position default; an unbounded array follows the consumer's
 * length and reuses one element default. Returns the original `consumer` when
 * nothing changed.
 */
function mergeStructuralArray(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: readonly unknown[]
): unknown {
  const shape = schema.arrayShapeAtPath(scratch)
  const isTuple = typeof shape === 'number'
  const targetLen = isTuple ? shape : consumer.length
  // Every position of an unbounded array resolves to the same element default,
  // so query once and reuse. A tuple queries per position, each slot carrying
  // its own.
  let cachedElementDefault: unknown
  let cachedElementDefaultRead = false
  let mutated = targetLen > consumer.length
  const out: unknown[] = copyConsumerArray(consumer)
  while (out.length < targetLen) out.push(undefined)
  for (let i = 0; i < targetLen; i++) {
    scratch.push(i)
    let elemDefault: unknown
    if (isTuple) {
      elemDefault = schema.getDefaultAtPath(scratch)
    } else {
      if (!cachedElementDefaultRead) {
        cachedElementDefault = schema.getDefaultAtPath(scratch)
        cachedElementDefaultRead = true
      }
      elemDefault = cachedElementDefault
    }
    const consumerElem = i < consumer.length ? readConsumerIndex(consumer, i) : undefined
    const merged = mergeStructuralImpl(schema, scratch, consumerElem, elemDefault)
    scratch.pop()
    if (merged !== consumerElem) {
      out[i] = merged
      mutated = true
    }
  }
  return mutated ? out : consumer
}

/**
 * Fill the schema-default keys MISSING from `consumer`, meaning absent
 * entirely, into `out`, recursing so each fill produces a structurally
 * complete sub-tree, which covers a nested-object default holding wrappers or
 * unions. An explicit `consumer[key] = undefined` names the slot empty on
 * purpose, distinct from omitting the key, so the schema default does NOT
 * override it. Mutates `out`; returns whether anything was filled.
 */
function fillMissingKeysFromDefault(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: Record<string, unknown>,
  defaultValue: Record<string, unknown>,
  out: Record<string, unknown>
): boolean {
  let mutated = false
  for (const key of Object.keys(defaultValue)) {
    // Own-property check: `'__proto__' in consumer` is always `true` for a
    // regular consumer record, which would falsely declare the consumer wrote
    // there and skip the default-fill for a legitimate `__proto__` field.
    if (!safeOwnHas(consumer, key)) {
      const defAtKey = safeOwnRead(defaultValue, key)
      scratch.push(key)
      const filled = mergeStructuralImpl(schema, scratch, undefined, defAtKey)
      scratch.pop()
      if (filled !== undefined) {
        safeAssign(out, key, filled)
        mutated = true
      }
    }
  }
  return mutated
}

/**
 * Recurse into every consumer-supplied key to catch nested gaps, writing the
 * merged results into `out`. A key whose consumer value is `undefined` is
 * skipped: the caller's spread already kept it, and recursing would re-fill
 * from the schema default, since the leaf branch returns the default for an
 * undefined consumer, erasing the consumer's explicit empty. Mutates `out`;
 * returns whether anything changed.
 */
function recurseIntoConsumerKeys(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: Record<string, unknown>,
  defaultValue: Record<string, unknown>,
  out: Record<string, unknown>
): boolean {
  let mutated = false
  for (const key of consumerKeys(consumer)) {
    const cVal = safeOwnRead(consumer, key)
    if (cVal === undefined) continue
    scratch.push(key)
    const merged = mergeStructuralImpl(schema, scratch, cVal, safeOwnRead(defaultValue, key))
    scratch.pop()
    if (merged !== cVal) {
      safeAssign(out, key, merged)
      mutated = true
    }
  }
  return mutated
}

/**
 * Schema-aware variant of `setAtPath`. Extending past an array's length pads
 * the new positions with the schema's element default rather than `undefined`,
 * and descending into an object whose intermediate property is missing fills
 * that intermediate from the schema's default at its sub-path.
 *
 * `value` has already been through `mergeStructural`: this function handles
 * INTERMEDIATE fill only, and completing the leaf belongs to the caller,
 * typically `setValueAtPath`.
 *
 * Schema lookups happen only at gap sites, so a write to an existing slot is a
 * copy-on-write spread that never touches the schema. A
 * `setValue('posts.21', x)` against an empty array costs one
 * `getDefaultAtPath` for the element default, cached for the call, plus N pad
 * inserts.
 */
export function setAtPathWithSchemaFill(
  root: unknown,
  schema: SchemaForFill,
  fullPath: Path,
  value: unknown
): unknown {
  if (fullPath.length === 0) return value
  return setAtPathWithSchemaFillImpl(root, schema, fullPath, value, 0)
}

function setAtPathWithSchemaFillImpl(
  root: unknown,
  schema: SchemaForFill,
  fullPath: Path,
  value: unknown,
  startIdx: number
): unknown {
  if (startIdx >= fullPath.length) return value

  const head = fullPath[startIdx] as Segment
  const isLeafStep = startIdx === fullPath.length - 1

  if (root instanceof Map) {
    const next = new Map(root)
    const key = mapKeyForSegment(root, head, schema.entryKeyKindAtPath(fullPath.slice(0, startIdx)))
    if (isLeafStep) {
      next.set(key, value)
      return next
    }
    // Fill a missing or non-descendable entry from the schema before
    // recursing, so the levels below start from a structurally complete node
    // rather than a fresh one holding only the keys this path touches. Same
    // semantic as the array and object branches.
    let childRoot = next.get(key)
    if (childRoot === undefined || (childRoot !== null && typeof childRoot !== 'object')) {
      childRoot = schema.getDefaultAtPath(fullPath.slice(0, startIdx + 1))
    }
    next.set(key, setAtPathWithSchemaFillImpl(childRoot, schema, fullPath, value, startIdx + 1))
    return next
  }

  if (!isRebuildableContainer(root, head)) return root

  if (typeof head === 'number') {
    const arr = Array.isArray(root) ? [...root] : []
    const prefix = fullPath.slice(0, startIdx)
    // Pad with element defaults when extending past the length. Tuple against
    // array comes from the schema's definitive `arrayShapeAtPath`, because a
    // value-based heuristic comparing two adjacent defaults by identity is
    // wrong both ways: an array of objects yields a fresh object per call and
    // differs, while a tuple of identical primitives compares equal.
    if (arr.length < head) {
      const scratch: Segment[] = prefix.slice() as Segment[]
      const shape = schema.arrayShapeAtPath(scratch)
      const tupleLike = typeof shape === 'number'
      // Every position of an unbounded array resolves to the same element
      // default, so cache the lookup; a tuple queries per position, so each
      // slot's default lands at its own index.
      let cachedArrayDefault: unknown
      if (!tupleLike) {
        scratch.push(0)
        cachedArrayDefault = schema.getDefaultAtPath(scratch)
        scratch.pop()
      }
      while (arr.length < head) {
        const idx = arr.length
        if (tupleLike) {
          scratch.push(idx)
          arr.push(schema.getDefaultAtPath(scratch))
          scratch.pop()
        } else {
          arr.push(cachedArrayDefault)
        }
      }
    }

    if (isLeafStep) {
      arr[head] = value
      return arr
    }

    // Make the slot at `head` structurally complete BEFORE recursing into the
    // rest of the path. Without the fill, recursion starts from `undefined`
    // and the next level builds a fresh `{}` holding only the keys this path
    // touches, silently dropping every sibling field. Same intermediate-fill
    // semantic as the object branch below.
    let childRoot = arr[head]
    if (childRoot === undefined || (childRoot !== null && typeof childRoot !== 'object')) {
      childRoot = schema.getDefaultAtPath([...prefix, head])
    }
    arr[head] = setAtPathWithSchemaFillImpl(childRoot, schema, fullPath, value, startIdx + 1)
    return arr
  }

  // Object key. Reads and writes at the head segment route through
  // `safeOwnRead` and `safeAssign`, because the segment is a consumer schema's
  // field name and may be spelled `__proto__`. A plain `rec[head] = value`
  // there invokes the setter inherited from `Object.prototype`, silently
  // discarding the write and leaving the field reading back whatever the
  // prototype chain says, where the own-property write lands it as a real data
  // property. The spread above is safe on its own, the spec using
  // `CreateDataProperty`, so only the imperative write needs the guard.
  const rec: Record<string, unknown> = isPlainRecord(root) ? { ...root } : {}
  if (isLeafStep) {
    safeAssign(rec, head, value)
    return rec
  }

  // Intermediate: ensure the child exists, filling from the schema
  // default if missing or non-descendable.
  const existing = safeOwnRead(rec, head)
  let childRoot: unknown
  if (existing === undefined || (existing !== null && typeof existing !== 'object')) {
    const intermPath: Segment[] = [...fullPath.slice(0, startIdx + 1)]
    const intermDefault = schema.getDefaultAtPath(intermPath)
    childRoot = intermDefault
  } else {
    childRoot = existing
  }
  safeAssign(
    rec,
    head,
    setAtPathWithSchemaFillImpl(childRoot, schema, fullPath, value, startIdx + 1)
  )
  return rec
}
