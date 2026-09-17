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
 * The minimal slice of `AbstractSchema` the structural-completeness
 * helpers need. Declared inline (not imported from types-api) so this
 * file stays free of cyclic imports — types-api imports types-core,
 * types-core does not import types-api, and this file is consumed by
 * core/create-form-store.ts which sits between the two.
 */
export type SchemaForFill = {
  getDefaultAtPath(path: Path): unknown
  /**
   * Distinguish tuple (number — structural length) from everything
   * else (null: unbounded array, or no array at `path` at all). The
   * answer is definitive. See `AbstractSchema.arrayShapeAtPath` for
   * the full contract.
   */
  arrayShapeAtPath(path: Path): number | null
  /**
   * Slim primitive set at `path`. Used by `mergeStructural` to
   * distinguish "consumer omitted this key from a partial" (fill from
   * schema default) from "consumer explicitly wrote undefined into a
   * path that admits undefined" (preserve undefined). An empty set
   * (path unknown to the schema) never contains `'undefined'`, so
   * unknown paths keep the fill-with-default behavior.
   * See `AbstractSchema.getSlimPrimitiveTypesAtPath` for the full
   * contract.
   */
  getSlimPrimitiveTypesAtPath(path: Path): ReadonlySet<string>
  /**
   * How the container at `path` spells its own entry keys. The write
   * walkers consult it at a `Map`, where a new entry has to be filed
   * under a key of the declared type and the segment alone cannot say
   * which: an integer-looking segment canonicalises to a number, so a
   * map declared `z.map(z.string(), V)` would otherwise take a numeric
   * key for `scores.42` and fail its own parse. See
   * `AbstractSchema.entryKeyKindAtPath` for the full contract.
   */
  entryKeyKindAtPath(path: Path): 'string' | 'number' | undefined
}

/**
 * Structured-path get/set primitives. Replace `lodash-es/get` and
 * `lodash-es/set` for internal callers that speak `Path` rather than
 * dotted strings.
 *
 * Semantics:
 * - `getAtPath` returns `undefined` for any path that traverses through
 *   a non-descendable value (null, primitive, function). This preserves
 *   distinctions: `null` at the exact target is returned as `null`, not
 *   as `undefined`; only missing / non-descendable intermediates collapse.
 * - `setAtPath` is copy-on-write at every level from root to target. New
 *   intermediate containers are created according to the segment type:
 *   numeric segments produce arrays, string segments produce plain objects.
 *   Sibling values at each level are preserved by reference (structural
 *   sharing), so the non-touched subtrees stay reference-equal for
 *   downstream `Object.is` checks in `diffAndApply`.
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
 * 2. For a key the map does not hold yet, `declared` decides — it is
 *    the map's own key type, via `entryKeyKindAtPath`. A writer with
 *    no schema in hand passes `undefined` and the segment stands.
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
 * Whether a write may rebuild the container at `root` to hold
 * `segment`.
 *
 * Every write is copy-on-write from the root down, and the rebuild
 * knows two shapes: an array for a numeric segment, a plain record for
 * a string one (a `Map` is handled ahead of this, by its own branch).
 * Starting from a fresh empty container is the right answer for a slot
 * that is missing, null, or holds a scalar the write is replacing. It
 * is the wrong answer for a slot already holding an object of some
 * OTHER kind: the rebuild does not copy that object, it replaces it,
 * and everything the original held is gone.
 *
 * `z.set` is how that was reachable. The schema walker consumes a
 * segment at a set to answer what its members look like, so `tags.0`
 * cleared the write gate, and the numeric rebuild turned a `Set` of
 * three into an `Array` of one. `entryKeyKindAtPath` is the loud half
 * of the rule now (a set has no addressable entry, so the gate refuses
 * and dev-warns before reaching here); this is the quiet half, so a
 * caller that arrives some other way leaves the tree alone instead of
 * destroying it. Structural rather than a list of refused classes, so
 * a container kind nobody here thought of is covered the same way.
 */
function isRebuildableContainer(root: unknown, segment: Segment): boolean {
  if (root === null || root === undefined || typeof root !== 'object') return true
  return typeof segment === 'number' ? Array.isArray(root) : isPlainRecord(root)
}

/**
 * One step of a read descent.
 *
 * Every read here is of a container the CONSUMER supplied, so any of
 * them can throw: an index or key may be an accessor, and a Proxy (which
 * `reactive()` returns, so this is not hypothetical) traps `in` as
 * readily as a property read. This sits under `getAtPath`, which every
 * FieldState rollup calls during render, so an escape surfaces as the
 * host component's render throwing — the one thing library code must
 * never cause.
 *
 * The containment is therefore real, but it lives in the CALLERS, one
 * `try` around the whole descent rather than a guarded accessor per
 * segment. That shape was measured: per-segment guards cost 8% of a
 * one-segment read and 34% of a sixteen-segment one, because each guard
 * is a call into a function holding a `try` and the loop body stops
 * being inlinable. Cost per descent is what a path read can afford;
 * cost per segment is not, and this is the hottest read in the library.
 */
function descendStep(value: unknown, segment: Segment): unknown | typeof NOT_FOUND {
  if (value === null || value === undefined) return NOT_FOUND
  if (typeof value !== 'object') return NOT_FOUND
  if (Array.isArray(value)) {
    if (typeof segment !== 'number') return NOT_FOUND
    // Presence-test the index rather than comparing it against `value.length`.
    // On a reactive array the `in` check tracks only this index's dependency
    // (Vue's `has` trap), whereas reading `.length` would subscribe the caller
    // to the array length. Descending into an element must NOT couple the
    // reader to the sibling count: a length read here makes every element's
    // value access (and the FieldState rollup built on it) re-run on any
    // append / remove, turning an array op into O(N x element-leaves). An
    // out-of-range, negative, or hole index is absent, so `in` is false and we
    // return NOT_FOUND exactly as the bounds comparison did.
    if (!(segment in value)) return NOT_FOUND
    return value[segment]
  }
  if (value instanceof Map) {
    // A map's entries are real sub-paths: one segment addresses one
    // entry, the same shape a record has (#614). `has` before `get`
    // keeps "present and holding undefined" distinct from "absent",
    // and on a reactive map both hit Vue's per-key traps, so a reader
    // descending one entry does not subscribe to the map's size.
    const key = mapKeyForSegment(value, segment)
    if (!value.has(key)) return NOT_FOUND
    return value.get(key)
  }
  const record = value as Record<string, unknown>
  const key = typeof segment === 'number' ? String(segment) : segment
  // Own-property-safe descent for prototype-shadowed key names
  // (`hasOwnProperty`, `toString`, `__proto__`, …): `key in record`
  // answers `true` for the inherited member and `record[key]` returns
  // it (or, through a Vue reactive proxy, Vue's instrumented
  // `hasOwnProperty` shim) when no own data slot exists. The own-
  // descriptor read returns the stored value (NOT_FOUND when purely
  // inherited) and forwards to the raw descriptor on a reactive proxy.
  //
  // That descriptor read bypasses Vue's reactive get-trap, so a reader
  // descending a shadowed segment registers NO per-key dependency on it.
  // Reactivity is carried at the write site instead: when a write changes a
  // root-level shadowed key, `applyFormReplacement` fires the whole-`form`-
  // ref explicitly (`triggerRef`); a shadowed key nested under a non-
  // shadowed ancestor rides that ancestor's per-key dep, which the copy-on-
  // write fallback reassigns. See create-form-store's `applyFormReplacement`.
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
    // `undefined` is already this function's answer for a path that does
    // not resolve, and every caller handles it, so the throw is absorbed
    // into an answer the contract already allows rather than escaping
    // into whatever render is reading this path.
    return undefined
  }
}

/**
 * Returns true iff `path` exists in `root` as a descendable chain to a leaf
 * or to a defined value. Distinguishes "exists and is undefined" (rare but
 * possible with explicit assignment) from "missing".
 */
export function hasAtPath(root: unknown, path: Path): boolean {
  if (path.length === 0) return true
  try {
    return hasAtPathUnguarded(root, path)
  } catch {
    // Same containment as `getAtPath`: an existence check is no safer
    // than a read, and `false` is what this function already answers for
    // a path that is not there.
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
    // Presence-test the index rather than comparing it against `current.length`,
    // for the same reason `descendStep` does: `in` hits Vue's `has` trap and
    // tracks only this index, whereas a `.length` read would subscribe the caller
    // to the array length. `hasAtPath` is the active-path gate for errors and
    // field-state (errors-proxy, the field-state orphan check); an entry pinned
    // directly at an array-index path (`rows.3`) must not re-run that gate on
    // every append / remove just because a sibling changed the length. `in` is
    // also truer to this function's own contract: a never-assigned hole is
    // "missing", which the `< length` comparison wrongly reported as present.
    return typeof last === 'number' && consumerHas(current, last)
  }
  if (current instanceof Map) {
    return current.has(mapKeyForSegment(current, last))
  }
  const key = typeof last === 'number' ? String(last) : last
  // Own-property existence for prototype-shadowed names — `key in
  // current` would report `true` for an inherited slot the consumer
  // never wrote (see descendStep / safeOwnHas).
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
 * The empty schema: every structural question answers "nothing declared
 * at this path". It lets `setAtPath` run on the schema-aware writer's
 * spine instead of keeping a second copy of it.
 *
 * Keeping two was the actual defect. The prototype-pollution hardening
 * landed on `setAtPath`, and `setAtPath` then stopped being the writer
 * the form uses — every `setValue` goes through
 * `setAtPathWithSchemaFill`, which was still assigning through a raw
 * `rec[head]`. The suite guarding the hardening kept passing because it
 * pointed at the walker nobody calls. One spine cannot drift from
 * itself.
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
 * In-place leaf write that preserves ancestor container identity — the
 * fast path behind a single `setValue` keystroke. When the exact leaf
 * slot at `path` already exists and currently holds a non-container
 * value, mutate that slot directly on the live (reactive) tree and
 * return the prior value. Every ancestor container keeps its object
 * identity, so a by-reference watch on a container stays quiet on a
 * descendant edit while the leaf's own reactive dependency still fires.
 *
 * Returns `{ applied: false }` — caller must fall back to the
 * copy-on-write `setAtPathWithSchemaFill` + first-segment reassign — in
 * every case that is NOT a pure in-place leaf edit:
 * - empty `path` (root replacement),
 * - any prototype-shadowed segment (`__proto__`, `hasOwnProperty`, …):
 *   those bypass reactive `get`/`set` tracking, so their reactivity is
 *   carried by the copy-on-write fallback — a non-shadowed ancestor's
 *   reassign for a nested key, or the explicit `triggerRef` that
 *   `applyFormReplacement` fires for a changed root-level shadowed key,
 * - a missing / non-descendable ancestor, or an out-of-range array index
 *   (a structural change — the container SHOULD get a new reference),
 * - an absent target slot (adding a key/index is structural), or
 * - a container currently at the slot (a container-target write replaces
 *   the slot wholesale, same as the fallback — and the contract gives the
 *   write target a fresh reference either way).
 *
 * `root` MUST be the reactive `form.value` (not a raw clone) so the
 * assignment fires Vue's dependency for the written key.
 */
export function tryInPlaceLeafWrite(root: unknown, path: Path, value: unknown): InPlaceWriteResult {
  if (path.length === 0) return NO_IN_PLACE
  try {
    return descendAndWrite(root, path, value)
  } catch {
    // Every read and the final write below touch a container the
    // consumer supplied, so any of them can be an accessor or a Proxy
    // trap that throws. `NO_IN_PLACE` is already the answer for "this
    // write cannot be done in place", and the copy-on-write fallback it
    // sends the caller to walks through the guarded readers. Bailing
    // here is therefore a downgrade in speed, never in correctness.
    return NO_IN_PLACE
  }
}

function descendAndWrite(root: unknown, path: Path, value: unknown): InPlaceWriteResult {
  // Single validated descent: at each level the segment must address an
  // existing slot on a descendable container. A missing/non-descendable
  // node, an out-of-range index, an absent key, or a prototype-shadowed
  // segment (which bypasses reactive tracking) means a structural /
  // non-fast-path write → fall back to copy-on-write.
  let node: unknown = root
  for (let i = 0; i < path.length; i++) {
    const seg = path[i] as Segment
    // A `Map` is never edited in place, unlike the array element one
    // step down. `materializeFormValue` shares a map with the consumer
    // BY REFERENCE (as it does a `Set`, `File`, `Blob` and `Date` —
    // some of them cannot be copied at all), where it deep-copies a
    // plain object or an array. So an in-place map write would reach
    // straight back into the `defaultValues` the consumer still holds,
    // mutating their object and, because `originals` was seeded from
    // that same map, making the entry read `dirty: false` right after
    // being edited. Copy-on-write gives the map a fresh identity on
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
 * Recursive merge that fills consumer-supplied gaps with the schema's
 * prescribed defaults. The runtime calls this on every `setValueAtPath`
 * write (and on whole-form callback returns) so the form remains
 * structurally complete after the write.
 *
 * Semantics:
 * - Plain object: every schema-default key not present in `consumer`
 *   is filled with the schema default's value at that key. Schema-only
 *   keys recurse into structural completeness; consumer-only keys (not
 *   in the schema) survive untouched (validation flags them).
 * - Array: each consumer element is merged with the SCHEMA element
 *   default (looked up via `schema.getDefaultAtPath([...path, i])`).
 *   Length follows the consumer — padding past the consumer's length
 *   is `setAtPathWithSchemaFill`'s job, not this function's.
 * - `null` consumer wins (a deliberate "clear" signal — validation
 *   catches misuse against non-nullable shapes).
 * - `undefined` consumer falls back to the schema default (treats
 *   undefined as "missing"). When the schema default is also
 *   undefined the result is undefined — schema and consumer agree.
 * - Primitives, Date, RegExp, Map, Set, class instances: consumer
 *   wins; no recursion (these are leaves under `isPlainRecord`).
 *
 * Idempotent short-circuit: when consumer is structurally complete
 * relative to defaults the function returns `consumer` by reference,
 * so common-case writes (consumer already complete) allocate nothing.
 */
export function mergeStructural(
  schema: SchemaForFill,
  path: Path,
  consumer: unknown,
  defaultValue: unknown = schema.getDefaultAtPath(path)
): unknown {
  // Internal recursion uses a single mutable scratch path: each level
  // pushes its segment before descending and pops on return. Eliminates
  // the per-recursion `[...path, key]` / `[...path, i]` allocation
  // that previously fired on every object key + every array element.
  // Schema adapters (zod / standard-schema) read `getDefaultAtPath`
  // synchronously and don't retain the path, so passing the live
  // scratch is safe; if a future adapter needed retention, snapshot
  // inside that adapter rather than allocating per-call here.
  const scratch: Segment[] = path.slice()
  return mergeStructuralImpl(schema, scratch, consumer, defaultValue)
}

function mergeStructuralImpl(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: unknown,
  defaultValue: unknown
): unknown {
  // Consumer is missing — fall back to the schema default. When the
  // schema default itself is `undefined` (path doesn't exist in the
  // schema), the result is `undefined` and we don't fight it.
  //
  // Exception: when the schema's slim primitive set at this path
  // admits `undefined` (e.g. `.optional()`), an explicit consumer
  // undefined IS the intended value — preserve it. Otherwise the
  // directive's optional-clear write (the user emptied an
  // `.optional()` input) would get substituted with whatever the
  // structural wrappers' default resolves to (`null` for
  // `.nullable().optional()`), defeating the schema-aware DOM-clear
  // mapping.
  if (consumer === undefined) {
    if (schema.getSlimPrimitiveTypesAtPath(scratch).has('undefined')) {
      return undefined
    }
    return defaultValue
  }

  // Null wins: deliberate consumer signal. Schema-validation catches
  // null-vs-non-nullable; runtime doesn't override consumer intent.
  if (consumer === null) return null

  // Array branch: tuple-like (fixed length) vs unbounded array — see
  // mergeStructuralArray.
  if (Array.isArray(consumer)) {
    return mergeStructuralArray(schema, scratch, consumer)
  }

  // Map: recurse into each entry against the schema's value default at
  // that entry's own path, so a partial entry written wholesale gets
  // the same structural completion a record entry gets. The map's key
  // set follows the consumer — filling absent keys from a default has
  // no meaning when every key is data. Returns `consumer` by reference
  // when nothing under it changed, so the common write allocates
  // nothing.
  if (consumer instanceof Map) {
    return mergeStructuralMap(schema, scratch, consumer)
  }

  // Plain object: fill missing keys from default, recurse on present
  // keys. Consumer-only keys pass through.
  if (isPlainRecord(consumer)) {
    if (!isPlainRecord(defaultValue)) {
      // Default is non-record (or undefined / leaf) — nothing to fill;
      // consumer wins as-is. Recurse just in case consumer holds nested
      // keys that the schema knows about at deeper paths (rare).
      return consumer
    }
    // Merge target carries `Object.prototype`, matching `setAtPath` and
    // `mergeDeep` elsewhere in the runtime. Object spread uses
    // `CreateDataProperty` per the spec, which bypasses the inherited
    // `__proto__` setter so a consumer carrying a literal `__proto__`
    // own property survives the spread without reassigning the result's
    // prototype chain.
    // Spread via the guarded helper: a consumer object can carry an
    // accessor that throws, and `{ ...consumer }` invokes every getter.
    // The helper spreads first and only falls back to a guarded copy if
    // that throws, so the per-write happy path is unchanged.
    const out: Record<string, unknown> = spreadConsumerRecord(consumer)
    const filledAny = fillMissingKeysFromDefault(schema, scratch, consumer, defaultValue, out)
    const recursedAny = recurseIntoConsumerKeys(schema, scratch, consumer, defaultValue, out)
    return filledAny || recursedAny ? out : consumer
  }

  // Leaf-ish (primitives, Date, RegExp, Map, Set, class instances) —
  // consumer wins, no recursion.
  return consumer
}

/**
 * Merge a consumer map against the schema, entry by entry. Every entry
 * resolves to the same value schema, so the element default is queried
 * once and reused across keys — the same shape `mergeStructuralArray`
 * uses for an unbounded array. Returns the original `consumer` when no
 * entry changed.
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
    // Only a key a segment can spell has a sub-path to complete
    // against. An object- or symbol-keyed entry is carried through
    // untouched, exactly as the leaf branch carries any other value.
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
 * Merge a consumer array against the schema. Tuple-like paths (fixed
 * length via `arrayShapeAtPath`) pad the consumer up to the structural
 * length and query a per-position default; unbounded arrays follow the
 * consumer's length and reuse one element default across positions.
 * Returns the merged array, or the original `consumer` when nothing
 * changed.
 */
function mergeStructuralArray(
  schema: SchemaForFill,
  scratch: Segment[],
  consumer: readonly unknown[]
): unknown {
  const shape = schema.arrayShapeAtPath(scratch)
  const isTuple = typeof shape === 'number'
  const targetLen = isTuple ? shape : consumer.length
  // Unbounded array: every position resolves to the same element
  // default — query once and reuse. Tuples query per-position
  // since each slot carries its own default.
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
 * Fill the schema-default keys MISSING from `consumer` (key not present
 * at all) into `out`, recursing so each fill produces a
 * structurally-complete sub-tree (covers nested-object defaults that
 * themselves contain wrappers / unions). An explicit
 * `consumer[key] = undefined` means the consumer named the slot empty on
 * purpose — distinct from omitting the key — so the schema default does
 * NOT override it. Mutates `out` in place; returns whether anything was
 * filled.
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
    // Own-property check — `'__proto__' in consumer` would always be
    // `true` for a regular consumer record, falsely declaring "consumer
    // wrote here" and skipping the default-fill for a legitimate
    // `__proto__` schema field.
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
 * Recurse into every consumer-supplied key to catch nested gaps, writing
 * merged results into `out`. Keys whose consumer value is `undefined`
 * are skipped — the caller's spread already kept them, and recursing
 * would re-fill from the schema default (the leaf branch returns the
 * default for an undefined consumer), erasing the consumer's explicit
 * empty. Mutates `out` in place; returns whether anything changed.
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
 * Schema-aware variant of `setAtPath`. When extending past array
 * length, pads new positions with the schema's element default
 * instead of `undefined`. When descending into an object whose
 * intermediate property is missing, fills the intermediate with
 * the schema's default at that sub-path.
 *
 * `value` is the already-mergeStructural'd target value — this
 * function only handles INTERMEDIATE fill. The caller (typically
 * `setValueAtPath` on the form store) is responsible for completing
 * the leaf.
 *
 * Performance: schema lookups happen only at gap sites. The common
 * case (write to existing slot) does a copy-on-write spread without
 * touching the schema. Misuse (`setValue('posts.21', x)` against an
 * empty array) costs `getDefaultAtPath` once for the array element
 * default (cached via `lastArrayDefault`/`lastArrayPathPrefix` for
 * the duration of the call) and N pad inserts.
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
    // Intermediate step: fill a missing / non-descendable entry from
    // the schema before recursing, so the levels below start from a
    // structurally complete node instead of building a fresh one that
    // holds only the keys this path touches. Same semantic the array
    // and object branches apply.
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
    // Pad with element defaults if extending past length. Tuple-vs-
    // array detection comes from the schema's definitive
    // `arrayShapeAtPath` — a value-based heuristic (compare two
    // adjacent defaults via Object.is) gives wrong answers for arrays
    // of objects (each call yields a fresh object, identity differs)
    // AND for tuples of identical primitives (Object.is(0, 0) === true).
    if (arr.length < head) {
      const scratch: Segment[] = prefix.slice() as Segment[]
      const shape = schema.arrayShapeAtPath(scratch)
      const tupleLike = typeof shape === 'number'
      // For unbounded arrays, every position resolves to the same
      // element default — cache the lookup once. For tuples, query
      // per-position so each slot's default lands at its own index.
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

    // Intermediate step: ensure the slot at `head` is structurally
    // complete BEFORE recursing into the rest of the path. Without
    // this fill, recursion starts from `undefined` and the next level
    // builds a fresh `{}` populated only by the keys the path
    // actually touches — sibling fields (other Person keys, other
    // Address keys) get silently dropped. Same intermediate-fill
    // semantic the object branch applies a few lines below.
    let childRoot = arr[head]
    if (childRoot === undefined || (childRoot !== null && typeof childRoot !== 'object')) {
      childRoot = schema.getDefaultAtPath([...prefix, head])
    }
    arr[head] = setAtPathWithSchemaFillImpl(childRoot, schema, fullPath, value, startIdx + 1)
    return arr
  }

  // Object key. Reads and writes at the head segment route through
  // `safeOwnRead` / `safeAssign`, because the segment is a consumer
  // schema's field name and may be spelled `__proto__`. A plain
  // `rec[head] = value` there invokes the setter inherited from
  // `Object.prototype`, which silently discards the write and leaves the
  // field reading back as whatever the prototype chain says; the
  // own-property write lands it as a real data property instead. The
  // spread above is already safe on its own (the spec uses
  // `CreateDataProperty`, which bypasses the accessor), so it needs no
  // guard — only the imperative write does.
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
