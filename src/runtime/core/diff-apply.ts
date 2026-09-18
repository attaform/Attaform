/**
 * Structural diff/apply walker. The state layer emits per-leaf patches
 * through it when `setValue` replaces a subtree, at a cost that scales
 * with the changed subtree rather than the form's whole leaf count.
 *
 * A "leaf" is anything that is not a plain object, array or spellable map:
 * strings, numbers, booleans, null, undefined, Date, Set, class instances,
 * functions. That is the right boundary for a form, which has no business
 * walking into a `Date` or a `File`.
 *
 * Every key read goes through `readConsumerProp` / `readConsumerIndex`.
 * Both sides of a diff are values the consumer wrote, and an accessor that
 * throws on one of them would escape `setValue` / `reset` into the host
 * app (#608).
 */
import { consumerKeys, readConsumerIndex, readConsumerProp } from './consumer-code'
import { isPathPrefix, mapSegmentKeys, pathsEqual } from './paths'
import type { Path, Segment } from './paths'
import { safeAssign, safeOwnRead } from './safe-assign'

/** One leaf-level difference between the two sides of a diff. */
export type Patch =
  | { readonly kind: 'added'; readonly path: Path; readonly newValue: unknown }
  | { readonly kind: 'removed'; readonly path: Path; readonly oldValue: unknown }
  | {
      readonly kind: 'changed'
      readonly path: Path
      readonly oldValue: unknown
      readonly newValue: unknown
    }

/**
 * True for plain objects (own prototype `Object.prototype` or null),
 * arrays, and the maps every one of whose keys a path segment can spell.
 * Set, Date, class instances and functions are opaque leaf values.
 *
 * A map is descendable because its entries are real paths (#614), and the
 * diff is what puts them in `originals`: with no per-entry baseline,
 * `form.fields.scores.ann.dirty` reads `false` the moment after the entry
 * is edited, and the leaf walks built on `originals` (`form.list`, the
 * container dirty rollup) never see the entry at all. A map holding a key
 * no segment can spell (an object, a symbol) has no addressable entries,
 * so it stays one atomic value, which is also what `entryKeyKindAtPath`
 * answers for it.
 *
 * A `Set` stays a leaf because its members are not paths: a member is its
 * own key, so there is nothing under it to address.
 */
function isDescendable(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return true
  if (value instanceof Map) return mapSegmentKeys(value) !== null
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === null || proto === Object.prototype
}

function appendSegment(prefix: Path, segment: Segment): Path {
  const next: Segment[] = new Array<Segment>(prefix.length + 1)
  for (let i = 0; i < prefix.length; i++) {
    const s = prefix[i]
    // prefix indices are in-range by construction; the cast satisfies
    // noUncheckedIndexedAccess at no runtime cost.
    next[i] = s as Segment
  }
  next[prefix.length] = segment
  return next
}

/**
 * Walk `oldValue` and `newValue` in lockstep, calling `visit(patch)` for every
 * leaf that differs. Identical values (by `Object.is`) produce no patches.
 *
 * Root replacement (when `prefix` is empty and both values are descendable
 * but of different shapes, e.g. object → array) emits a single `'changed'`
 * patch with `path: []`. Callers handling root patches should clear all
 * dependent state.
 */
export function diffAndApply(
  oldValue: unknown,
  newValue: unknown,
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  if (Object.is(oldValue, newValue)) return

  const oldIsDescendable = isDescendable(oldValue)
  const newIsDescendable = isDescendable(newValue)

  // Missing (undefined) <-> descendable: recurse into the descendable side
  // so every leaf emits an atomic 'added' / 'removed' patch, the
  // granularity per-field metadata needs at form init and on a dynamic
  // field addition. Any other shape mismatch (primitive <-> object,
  // array <-> object) is an atomic replacement.
  if (oldValue === undefined && newIsDescendable) {
    walkNewDescendable(newValue, prefix, visit)
    return
  }

  if (oldIsDescendable && newValue === undefined) {
    walkOldDescendable(oldValue, prefix, visit)
    return
  }

  if (oldIsDescendable && newIsDescendable) {
    const oldIsMap = oldValue instanceof Map
    const newIsMap = newValue instanceof Map
    if (oldIsMap && newIsMap) {
      diffMapsLockstep(oldValue, newValue, prefix, visit)
      return
    }
    if (oldIsMap !== newIsMap) {
      // A map replaced by a plain object (or the reverse) is a shape
      // change at this node, not a per-entry edit.
      visit({ kind: 'changed', path: prefix, oldValue, newValue })
      return
    }

    const oldIsArray = Array.isArray(oldValue)
    const newIsArray = Array.isArray(newValue)

    if (oldIsArray && newIsArray) {
      diffArraysLockstep(oldValue, newValue, prefix, visit)
      return
    }

    if (!oldIsArray && !newIsArray) {
      diffObjectsLockstep(
        oldValue as Record<string, unknown>,
        newValue as Record<string, unknown>,
        prefix,
        visit
      )
      return
    }

    // object <-> array mismatch at this node. Treat as a full replacement.
    visit({ kind: 'changed', path: prefix, oldValue, newValue })
    return
  }

  if (oldIsDescendable && !newIsDescendable) {
    visit({ kind: 'changed', path: prefix, oldValue, newValue })
    return
  }

  if (!oldIsDescendable && newIsDescendable) {
    visit({ kind: 'changed', path: prefix, oldValue, newValue })
    return
  }

  // Both leaves; they differ (Object.is returned false above).
  if (oldValue === undefined) {
    visit({ kind: 'added', path: prefix, newValue })
    return
  }
  if (newValue === undefined) {
    visit({ kind: 'removed', path: prefix, oldValue })
    return
  }
  visit({ kind: 'changed', path: prefix, oldValue, newValue })
}

/**
 * Walk a descendable `newValue` whose old counterpart was `undefined`,
 * emitting an atomic `'added'` patch for every leaf through the recursive
 * `diffAndApply`. A hot-path helper, kept at module level so no closure is
 * allocated per recursion; `prefix` and `visit` thread through explicitly.
 */
function walkNewDescendable(
  newValue: Record<string, unknown> | readonly unknown[],
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  if (Array.isArray(newValue)) {
    for (let i = 0; i < newValue.length; i++) {
      diffAndApply(undefined, readConsumerIndex(newValue, i), appendSegment(prefix, i), visit)
    }
  } else if (newValue instanceof Map) {
    for (const [key, entry] of newValue) {
      diffAndApply(undefined, entry, appendSegment(prefix, key as Segment), visit)
    }
  } else {
    const rec = newValue as Record<string, unknown>
    for (const k of consumerKeys(rec)) {
      diffAndApply(undefined, readConsumerProp(rec, k), appendSegment(prefix, k), visit)
    }
  }
}

/**
 * Mirror of `walkNewDescendable` for the removal direction: walk a
 * descendable `oldValue` whose new counterpart is `undefined`, emitting an
 * atomic `'removed'` patch for every leaf.
 */
function walkOldDescendable(
  oldValue: Record<string, unknown> | readonly unknown[],
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  if (Array.isArray(oldValue)) {
    for (let i = 0; i < oldValue.length; i++) {
      diffAndApply(readConsumerIndex(oldValue, i), undefined, appendSegment(prefix, i), visit)
    }
  } else if (oldValue instanceof Map) {
    for (const [key, entry] of oldValue) {
      diffAndApply(entry, undefined, appendSegment(prefix, key as Segment), visit)
    }
  } else {
    const rec = oldValue as Record<string, unknown>
    for (const k of consumerKeys(rec)) {
      diffAndApply(readConsumerProp(rec, k), undefined, appendSegment(prefix, k), visit)
    }
  }
}

/**
 * Diff two maps in lockstep over the union of their keys, recursing per
 * entry. A key present on one side only reads as `undefined` on the
 * other, so an added or dropped entry surfaces as an `'added'` /
 * `'removed'` leaf patch, exactly as an object key does.
 *
 * A key spelled `'42'` on one side and `42` on the other is the same path,
 * and reconciling that here would leave the two sides disagreeing about
 * which spelling the entry has. Both maps come from the same schema, whose
 * declared key type fixes the spelling (`entryKeyKindAtPath`), so a write
 * cannot produce the case; a consumer who hand-builds one of each sees the
 * entry replaced rather than edited, the truthful reading of two keys.
 */
function diffMapsLockstep(
  oldMap: ReadonlyMap<unknown, unknown>,
  newMap: ReadonlyMap<unknown, unknown>,
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  for (const [key, entry] of newMap) {
    diffAndApply(oldMap.get(key), entry, appendSegment(prefix, key as Segment), visit)
  }
  for (const [key, entry] of oldMap) {
    if (newMap.has(key)) continue
    diffAndApply(entry, undefined, appendSegment(prefix, key as Segment), visit)
  }
}

/**
 * Diff two arrays in lockstep over the longer length, recursing per
 * index. Out-of-range slots on the shorter side read as `undefined`, so
 * length changes surface as `'added'` / `'removed'` leaf patches.
 */
function diffArraysLockstep(
  oldArr: readonly unknown[],
  newArr: readonly unknown[],
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  const max = Math.max(oldArr.length, newArr.length)
  for (let i = 0; i < max; i++) {
    diffAndApply(
      readConsumerIndex(oldArr, i),
      readConsumerIndex(newArr, i),
      appendSegment(prefix, i),
      visit
    )
  }
}

/**
 * Diff two plain objects in lockstep: recurse on every key present in
 * either side (old keys first, then new-only keys) so additions and
 * removals both surface. A `seen` set dedupes the two passes.
 *
 * Reads stay plain. A prototype-shadowed key (`__proto__`, `toString`) on
 * only one side resolves the inherited member on the other, so it surfaces
 * as a change rather than an appearance. Naming the own-property reader
 * anywhere in this function costs ~8% of a 500-leaf write, and
 * `commitWritePatches` absorbs the consequence for free by seeding an
 * absence baseline for any patched path it has no baseline for, not for
 * `added` patches alone.
 */
function diffObjectsLockstep(
  oldRec: Record<string, unknown>,
  newRec: Record<string, unknown>,
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  const seen = new Set<string>()
  for (const k of consumerKeys(oldRec)) {
    seen.add(k)
    diffAndApply(
      readConsumerProp(oldRec, k),
      readConsumerProp(newRec, k),
      appendSegment(prefix, k),
      visit
    )
  }
  for (const k of consumerKeys(newRec)) {
    if (seen.has(k)) continue
    diffAndApply(
      readConsumerProp(oldRec, k),
      readConsumerProp(newRec, k),
      appendSegment(prefix, k),
      visit
    )
  }
}

/**
 * Apply `source`'s changes to `target` by reassigning only the top-level
 * keys whose subtrees CONTENT-differ. Which keys changed comes from
 * `patches`, the caller's single `diffAndApply(target, source, [], ...)`
 * pass over the same pair, rather than a second structural walk here, so
 * every write pays exactly one content diff. Content, not `Object.is`, is
 * the right gate: reactive proxies and copy-on-write spreads routinely
 * produce reference-different but content-equal subtrees, and reassigning
 * one fires Vue's property dep and re-triggers every deep watch on it.
 *
 * `patches` carries absolute paths and must be the content diff of exactly
 * this `(target, source)` pair, scoped at or under `currentPath` (the root
 * call passes the full list with `currentPath: []`; the recursion filters
 * per child). A patch landing AT `currentPath` is the container-level
 * shape mismatch the diff emits for an object ↔ array flip, which is the
 * un-reconcilable case.
 *
 * Returns `true` on success, `false` when `target` and `source` have
 * incompatible shapes (object ↔ array, or one side not a descendable
 * container), where the caller must fall back to wholesale replacement.
 *
 * Why this matters: Vue re-creates the reactive proxy for an object-typed
 * Ref every time the Ref's value is reassigned wholesale
 * (`form.value = next`), and that re-creation fires every deep watch
 * transitively bound to the Ref, including watches whose own subtree is
 * identity-equal across the swap. When such a watch reacts by writing back
 * to the form (the canonical "same as pickup address" mirror), it re-fires
 * synchronously on its own write and the browser tab freezes. So
 * `form.value`'s identity stays stable across writes and only the children
 * whose CONTENT changed are updated: a deep watch on a sibling subtree
 * sees no dep change and stays quiet, while the touched child gets a new
 * reference so computeds and directive bindings on THAT path re-evaluate.
 *
 * An old subtree reassigned here is left unmutated, and nothing depends on
 * that: a consumer needing a frozen view (a history snapshot, the
 * `setValue((prev) => ...)` callback arg) takes its own
 * `structuralSnapshot` deep clone. The single-leaf `setValue` fast path
 * (`applyTargetedWrite`) mutates the leaf slot in place to preserve
 * ancestor container identity; this first-segment reassign serves container
 * and whole-form replacements.
 *
 * `arrayOpPath` opts the typed array helpers into one further
 * optimization. A write carrying an `arrayOp` meta hint passes the mutated
 * array's canonical path and every other caller passes `null`. When
 * non-null, a changed key whose old and new values are BOTH descendable
 * containers is reconciled IN PLACE: the recursion holds that container's
 * reference stable and descends, threading `currentPath` so each level
 * knows where it sits. That keeps EVERY ancestor container on the path to
 * the mutated array stable at any depth, the objects of an
 * `address.contacts` chain and the ancestor array elements of a nested
 * repeater (`append('sections.0.questions', q)`) alike, so a helper op
 * touches only the genuinely changed leaves and length and a `form.list`
 * over an untouched container does not re-render.
 *
 * The array branch is reached only through that recursion, so `arrayOpPath`
 * is non-null there, and it splits on whether `currentPath` IS the mutated
 * array:
 *   - the MUTATED array (`pathsEqual(currentPath, arrayOpPath)`): truncate
 *     to the new length and reference-assign only the changed indices.
 *     Reference-assign is what relocates a swapped or moved element into
 *     its new slot with its object identity intact (subtree, focus and
 *     per-element state riding along), so this branch must NOT recurse
 *     into elements.
 *   - an ANCESTOR array: a descendant write never changes this array's
 *     length, only the one element leading to the mutated array. Recurse
 *     that element in place, guarded by `isPathPrefix` so untouched
 *     siblings keep their references, and reference-assign anything else.
 *
 * With `arrayOpPath` at `null` (every non-helper write: an explicit
 * setValue, reset, undo / redo, hydration, DU reshape) the object branch
 * reassigns each changed key wholesale and never recurses, so a
 * container-target write replaces the reference like any other. The
 * "reference changes IFF targeted or restructured" contract therefore
 * holds for explicit writes, and only the helpers opt into the
 * stable-reference reconcile. A consumer reading a container subscribes to
 * its length, keys or elements, or takes a deep watch, not its reference.
 */
export function applyChangedKeys(
  target: unknown,
  source: unknown,
  arrayOpPath: Path | null,
  currentPath: Path,
  patches: readonly Patch[]
): boolean {
  if (!isDescendable(target) || !isDescendable(source)) return false
  // A map write is copy-on-write, so the new map is already a fresh object
  // holding every carried-over entry by reference. Bailing makes the caller
  // reference-assign it wholesale, which is both the correct result and the
  // one the in-place reconcile below could not produce: its object branch
  // reads keys off `Object.keys`, and a map has none.
  if (target instanceof Map || source instanceof Map) return false
  const targetIsArray = Array.isArray(target)
  const sourceIsArray = Array.isArray(source)
  if (targetIsArray !== sourceIsArray) return false

  // The unique child segments where target and source differ in CONTENT,
  // read off the caller's patch list at this node's depth. A patch landing
  // AT this node (path length === depth) is the diff's container-level
  // shape-mismatch marker, so tell the caller to wholesale-replace. No
  // mutation has happened by that point.
  const depth = currentPath.length
  const changedFirstSegments = new Set<Segment>()
  for (const patch of patches) {
    if (patch.path.length === depth) return false
    changedFirstSegments.add(patch.path[depth] as Segment)
  }

  if (targetIsArray) {
    const t = target as unknown[]
    const s = source as readonly unknown[]
    // `arrayOpPath === null` cannot reach here: the array branch is entered
    // only by recursion from the object branch, which recurses only when
    // arrayOpPath is non-null. Folding it into the mutated-array case says
    // so and narrows arrayOpPath to non-null inside the `else`.
    if (arrayOpPath === null || pathsEqual(currentPath, arrayOpPath)) {
      // This IS the array the op mutated. Truncate to the new length and
      // reference-assign the changed indices, which relocates a swapped or
      // moved element into its new slot with its object identity intact, so
      // its subtree, focus and per-element state ride along. Recursing here
      // would content-copy and break that identity.
      if (t.length > s.length) t.length = s.length
      for (const idx of changedFirstSegments) {
        const i = typeof idx === 'number' ? idx : Number(idx)
        // Skip slots the length cut already dropped. On a shrink diffAndApply
        // emits a 'removed' patch at every truncated index, so those land in
        // `changedFirstSegments`, and reassigning `s[i]` (undefined) would
        // re-grow the array with a trailing hole. Survivors and grown slots
        // are in range.
        if (i >= s.length) continue
        t[i] = s[i]
      }
    } else {
      // An ANCESTOR array on the path to the mutated array. A descendant
      // write never changes this array's length, only the single element
      // leading to the mutated array, so recurse THAT element in place and
      // keep its reference, leaving siblings and their subtrees stable.
      // `isPathPrefix` picks the one on-path element and anything else
      // reference-assigns. No length change here, so no truncation.
      for (const idx of changedFirstSegments) {
        const i = typeof idx === 'number' ? idx : Number(idx)
        if (i >= s.length) continue
        const childPath = appendSegment(currentPath, i)
        const curEl = t[i]
        const nextEl = s[i]
        if (
          isPathPrefix(childPath, arrayOpPath) &&
          isDescendable(curEl) &&
          isDescendable(nextEl) &&
          applyChangedKeys(
            curEl,
            nextEl,
            arrayOpPath,
            childPath,
            patches.filter((p) => isPathPrefix(childPath, p.path))
          )
        ) {
          continue
        }
        t[i] = nextEl
      }
    }
  } else {
    const t = target as Record<string, unknown>
    const s = source as Record<string, unknown>
    const sourceKeys = new Set(Object.keys(s))
    for (const k of Object.keys(t)) {
      if (!sourceKeys.has(k)) delete t[k]
    }
    for (const k of changedFirstSegments) {
      const key = String(k)
      const nextVal = safeOwnRead(s, key)
      // On an array helper op (arrayOpPath non-null), reconcile a changed
      // container-valued key IN PLACE: recurse, so the array branch handles
      // the array and any nested object on the path keeps its own reference
      // rather than the whole subtree being reassigned. An array nested
      // under an object chain (`append('address.contacts', x)`) therefore
      // keeps `address`'s reference too, and `form.list('address.contacts')`
      // is the only list that re-renders. `safeOwnRead` hands back the
      // reactive proxy for `t[key]` with tracking intact, so the in-place
      // sets fire the right deps. Falls through to a plain reassign for a
      // leaf value, a shape mismatch (the recurse returned false), or a
      // non-helper write, which replaces the reference.
      if (arrayOpPath !== null) {
        const curVal = safeOwnRead(t, key)
        const childPath = appendSegment(currentPath, key)
        if (
          isDescendable(curVal) &&
          isDescendable(nextVal) &&
          applyChangedKeys(
            curVal,
            nextVal,
            arrayOpPath,
            childPath,
            patches.filter((p) => isPathPrefix(childPath, p.path))
          )
        ) {
          continue
        }
      }
      safeAssign(t, key, nextVal)
    }
  }
  return true
}

/**
 * Stable structural snapshot of a value. Walks plain objects, arrays and
 * maps recursively and passes non-recursable values (primitives, Date,
 * RegExp, Set, functions, class instances) through unchanged.
 *
 * setValue's callback path uses it so the `prev` handed to a consumer's
 * `(prev) => next` lambda is frozen in time rather than a live reference
 * into `form.value` that would mutate once the surrounding setValue
 * commits its in-place merge. Consumers routinely cache `prev` in a
 * closure or a test variable, and without the clone those caches would
 * drift to the post-setValue state.
 */
export function structuralSnapshot<T>(value: T): T {
  if (!isDescendable(value)) return value
  if (value instanceof Map) {
    // Snapshot as a `Map`, not the plain object the key walk below would
    // produce. A map's entries are paths, so it is descendable for the
    // diff's sake, and rebuilding it as `{}` would hand a
    // `setValue((prev) => ...)` callback a `prev` whose shape does not
    // match what it reads back from `form.values`.
    const out = new Map<unknown, unknown>()
    for (const [k, v] of value) out.set(k, structuralSnapshot(v))
    return out as unknown as T
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      out[i] = structuralSnapshot(value[i])
    }
    return out as unknown as T
  }
  const src = value as Record<string, unknown>
  // The snapshot container carries `Object.prototype`, so consumer code
  // walking `prev` with `.hasOwnProperty(...)`, `in` or `Object.keys` gets
  // the shape it expects. Per key, `safeOwnRead` resolves a literal
  // `__proto__` to its own data slot rather than through the inherited
  // accessor, and `safeAssign` then defines it as an own data property on
  // `out` rather than routing through the inherited setter. Every other
  // key takes the plain branch.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    safeAssign(out, k, structuralSnapshot(safeOwnRead(src, k)))
  }
  return out as unknown as T
}
