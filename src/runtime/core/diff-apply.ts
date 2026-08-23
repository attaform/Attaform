import { isPathPrefix, pathsEqual } from './paths'
import type { Path, Segment } from './paths'
import { safeAssign, safeOwnRead } from './safe-assign'

/**
 * Structural diff/apply walker. Used by the state layer to emit per-leaf
 * patches when `setValue` replaces a subtree. Cost scales with the
 * size of the changed subtree, not the full form's leaf count.
 *
 * "Leaves" are anything that's not a plain object or array: strings, numbers,
 * booleans, null, undefined, Date, Map, Set, class instances, functions, etc.
 * For forms, this is the right boundary — we don't want to walk into a `Date`
 * or a `File` value.
 */

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
 * True for plain objects (own prototype === Object.prototype or null) and
 * arrays. Deliberately rejects Map, Set, Date, class instances, functions —
 * those are treated as opaque leaf values.
 */
function isDescendable(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return true
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === null || proto === Object.prototype
}

function appendSegment(prefix: Path, segment: Segment): Path {
  const next: Segment[] = new Array<Segment>(prefix.length + 1)
  for (let i = 0; i < prefix.length; i++) {
    const s = prefix[i]
    // prefix indices are always in-range by construction; the nullish fallback
    // placates noUncheckedIndexedAccess without adding runtime overhead.
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

  // Missing (undefined) <-> descendable: recurse into the descendable side so
  // every leaf emits an atomic 'added' / 'removed' patch. Populating
  // per-field metadata during form init / dynamic field additions relies on
  // this granularity. Other shape mismatches (primitive <-> object, array <->
  // object) are treated as atomic replacements.
  if (oldValue === undefined && newIsDescendable) {
    walkNewDescendable(newValue, prefix, visit)
    return
  }

  if (oldIsDescendable && newValue === undefined) {
    walkOldDescendable(oldValue, prefix, visit)
    return
  }

  if (oldIsDescendable && newIsDescendable) {
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
 * emitting an atomic `'added'` patch for every leaf (via the recursive
 * `diffAndApply`). Hot-path helper — module-level so no closure is
 * allocated per recursion; `prefix` + `visit` thread through explicitly.
 */
function walkNewDescendable(
  newValue: Record<string, unknown> | readonly unknown[],
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  if (Array.isArray(newValue)) {
    for (let i = 0; i < newValue.length; i++) {
      diffAndApply(undefined, newValue[i], appendSegment(prefix, i), visit)
    }
  } else {
    const rec = newValue as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      diffAndApply(undefined, rec[k], appendSegment(prefix, k), visit)
    }
  }
}

/**
 * Mirror of `walkNewDescendable` for the removal direction: walk a
 * descendable `oldValue` whose new counterpart is `undefined`, emitting
 * an atomic `'removed'` patch for every leaf.
 */
function walkOldDescendable(
  oldValue: Record<string, unknown> | readonly unknown[],
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  if (Array.isArray(oldValue)) {
    for (let i = 0; i < oldValue.length; i++) {
      diffAndApply(oldValue[i], undefined, appendSegment(prefix, i), visit)
    }
  } else {
    const rec = oldValue as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      diffAndApply(rec[k], undefined, appendSegment(prefix, k), visit)
    }
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
    diffAndApply(oldArr[i], newArr[i], appendSegment(prefix, i), visit)
  }
}

/**
 * Diff two plain objects in lockstep: recurse on every key present in
 * either side (old keys first, then new-only keys) so additions and
 * removals both surface. A `seen` set dedupes the two passes.
 */
function diffObjectsLockstep(
  oldRec: Record<string, unknown>,
  newRec: Record<string, unknown>,
  prefix: Path,
  visit: (patch: Patch) => void
): void {
  const seen = new Set<string>()
  for (const k of Object.keys(oldRec)) {
    seen.add(k)
    diffAndApply(oldRec[k], newRec[k], appendSegment(prefix, k), visit)
  }
  for (const k of Object.keys(newRec)) {
    if (seen.has(k)) continue
    diffAndApply(oldRec[k], newRec[k], appendSegment(prefix, k), visit)
  }
}

/**
 * Apply `source`'s changes to `target` by reassigning only the
 * top-level keys whose subtrees CONTENT-differ. Uses `diffAndApply`'s
 * structural walk (not `Object.is`) to decide which keys changed,
 * because reactive proxies and copy-on-write spreads routinely produce
 * reference-different but content-equal subtrees that we don't want
 * to reassign — reassigning fires Vue's property dep and re-triggers
 * deep watches on that subtree.
 *
 * Returns `true` on success. Returns `false` when `target` and
 * `source` have incompatible shapes (e.g. object ↔ array, or one
 * side isn't a descendable container) — the caller must fall back
 * to wholesale replacement.
 *
 * **Why** (subtle but load-bearing):
 *
 * Vue's reactive proxy for an object-typed Ref gets re-created every
 * time the Ref's value is reassigned wholesale (`form.value = next`).
 * That re-creation fires every deep watch transitively bound to the
 * Ref — even watches whose underlying sub-tree is identity-equal
 * across the swap. When one of those watches reacts by writing back
 * to the form (the canonical "same as pickup address" mirror
 * pattern), the watch re-fires synchronously on its own write and
 * the browser tab freezes.
 *
 * The cure is to keep `form.value`'s identity stable across writes
 * and update only the children whose CONTENT actually changed. Deep
 * watches on sibling subtrees see no dep change and stay quiet; the
 * touched child gets a new reference, so reactive consumers tracking
 * THAT path (computeds, directive bindings, etc.) re-evaluate
 * correctly.
 *
 * Old subtree references that get reassigned here are left unmutated,
 * but nothing depends on that: the consumers that need a frozen view
 * (history snapshots, the `setValue((prev) => …)` callback arg) take
 * their own `structuralSnapshot` deep-clone. The single-leaf `setValue`
 * fast path (`applyTargetedWrite`) deliberately mutates the leaf slot in
 * place, preserving ancestor container identity; this first-segment
 * reassign is retained for container and whole-form replacements.
 *
 * `arrayOpPath` opts the typed array helpers into one extra optimization: the
 * writes that carry an `arrayOp` meta hint pass the mutated array's (canonical)
 * path, every other caller passes `null`. When non-null, a changed key whose old
 * and new values are BOTH descendable containers (a plain object or an array) is
 * reconciled IN PLACE — the recursion keeps that container's own reference stable
 * and descends, threading `currentPath` so each level knows where it sits. This
 * keeps EVERY ancestor container on the path to the mutated array stable at any
 * depth: the objects of an `address.contacts` chain AND the ancestor array
 * elements of a nested repeater (`append('sections.0.questions', q)`) alike. So a
 * helper op touches only the genuinely-changed leaves / length, and a `form.list`
 * over any untouched container does not re-render.
 *
 * The array branch (reached only via this recursion, so `arrayOpPath` is non-null
 * there) splits on whether `currentPath` IS the mutated array:
 *   - the MUTATED array (`pathsEqual(currentPath, arrayOpPath)`): truncate to the
 *     new length and reference-assign only the changed indices. Reference-assign
 *     is what relocates a swapped / moved element to its new slot while keeping
 *     its object identity (its subtree, focus, per-element state all ride along),
 *     so this branch must NOT recurse into elements.
 *   - an ANCESTOR array (not equal): a descendant write never changes this
 *     array's length, only the one element leading to the mutated array. Recurse
 *     that element in place (guarded by `isPathPrefix`, so untouched siblings
 *     keep their references); reference-assign anything else defensively.
 *
 * When `arrayOpPath` is `null` (every non-helper write: an explicit setValue,
 * reset, undo / redo, cross-tab merge, hydration, DU reshape) the object branch
 * reassigns each changed key wholesale and never recurses, so a container-target
 * write replaces the reference like any other — the "reference changes IFF
 * targeted or restructured" contract holds for explicit writes; only the helpers
 * opt into the stable-reference reconcile. Consumers reading a container then
 * subscribe to its length / keys / elements (or take a deep watch), not its bare
 * reference.
 */
export function applyChangedKeys(
  target: unknown,
  source: unknown,
  arrayOpPath: Path | null,
  currentPath: Path
): boolean {
  if (!isDescendable(target) || !isDescendable(source)) return false
  const targetIsArray = Array.isArray(target)
  const sourceIsArray = Array.isArray(source)
  if (targetIsArray !== sourceIsArray) return false

  // Find the unique first segments where target and source differ in
  // CONTENT. A root-level patch (path.length === 0) signals an
  // un-recoverable shape mismatch: tell the caller to wholesale-replace.
  // Tracking a sentinel inside `changedFirstSegments` itself rather
  // than a separate flag — keeps eslint's narrowing from declaring
  // the flag dead code (the visitor callback is opaque to its flow
  // analysis).
  const ROOT_SENTINEL = Symbol.for('attaform.applyChangedKeys.rootMismatch')
  const changedFirstSegments = new Set<string | number | symbol>()
  diffAndApply(target, source, [], (patch) => {
    if (patch.path.length === 0) {
      changedFirstSegments.add(ROOT_SENTINEL)
      return
    }
    changedFirstSegments.add(patch.path[0] as string | number)
  })
  if (changedFirstSegments.has(ROOT_SENTINEL)) return false

  if (targetIsArray) {
    const t = target as unknown[]
    const s = source as readonly unknown[]
    // `arrayOpPath === null` can't actually reach here — the array branch is
    // only entered by recursion from the object branch, which recurses only
    // when arrayOpPath is non-null. Folding it into the mutated-array case both
    // documents that and narrows arrayOpPath to non-null inside the `else`.
    if (arrayOpPath === null || pathsEqual(currentPath, arrayOpPath)) {
      // This IS the array the op mutated. Truncate to the new length and
      // reference-assign the changed indices: that relocates a swapped / moved
      // element to its new slot while preserving its object identity, so its
      // subtree / focus / per-element state ride along. Recursing here instead
      // would content-copy and break that identity.
      if (t.length > s.length) t.length = s.length
      for (const idx of changedFirstSegments) {
        if (typeof idx === 'symbol') continue
        const i = typeof idx === 'number' ? idx : Number(idx)
        // Skip slots the length cut already dropped. On a shrink, diffAndApply
        // emits a 'removed' patch at every truncated index, so those land in
        // `changedFirstSegments`; reassigning `s[i]` (undefined) would re-grow
        // the array with a trailing hole. Survivors and grown slots are in range.
        if (i >= s.length) continue
        t[i] = s[i]
      }
    } else {
      // An ANCESTOR array on the path to the mutated array. A descendant write
      // never changes this array's length, only the single element leading to
      // the mutated array — recurse THAT element in place (keeping its
      // reference) so its siblings and their subtrees stay stable. `isPathPrefix`
      // selects the one on-path element; anything else reference-assigns
      // defensively (no length change, so no truncation here).
      for (const idx of changedFirstSegments) {
        if (typeof idx === 'symbol') continue
        const i = typeof idx === 'number' ? idx : Number(idx)
        if (i >= s.length) continue
        const childPath = appendSegment(currentPath, i)
        const curEl = t[i]
        const nextEl = s[i]
        if (
          isPathPrefix(childPath, arrayOpPath) &&
          isDescendable(curEl) &&
          isDescendable(nextEl) &&
          applyChangedKeys(curEl, nextEl, arrayOpPath, childPath)
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
      if (typeof k === 'symbol') continue
      const key = String(k)
      const nextVal = safeOwnRead(s, key)
      // On an array helper op (arrayOpPath non-null), reconcile a changed
      // container-valued key IN PLACE: recurse so the array branch handles the
      // array and any nested object on the path keeps its own reference, instead
      // of reassigning the whole subtree. This makes an array nested under an
      // object chain (`append('address.contacts', x)`) keep `address`'s reference
      // too, so `form.list('address.contacts')` is the only list that re-renders.
      // `safeOwnRead` returns the reactive proxy for `t[key]` (tracking intact),
      // so the in-place sets fire the right deps. Falls through to a plain
      // reassign for a leaf value, a shape mismatch (the recurse returns false),
      // or a non-helper write (arrayOpPath null), which replaces the reference.
      if (arrayOpPath !== null) {
        const curVal = safeOwnRead(t, key)
        if (
          isDescendable(curVal) &&
          isDescendable(nextVal) &&
          applyChangedKeys(curVal, nextVal, arrayOpPath, appendSegment(currentPath, key))
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
 * Stable structural snapshot of a value. Walks plain objects + arrays
 * recursively; non-recursable values (primitives, Date, RegExp, Map,
 * Set, functions, class instances) pass through unchanged.
 *
 * Used by setValue's callback path so the `prev` arg passed to a
 * consumer's `(prev) => next` lambda is a frozen-in-time snapshot —
 * not a live reference into `form.value` that would silently mutate
 * once the surrounding setValue commits its in-place merge. Consumers
 * routinely cache `prev` in a closure or a test variable; without this
 * clone, those caches would silently drift to the post-setValue state.
 */
export function structuralSnapshot<T>(value: T): T {
  if (!isDescendable(value)) return value
  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      out[i] = structuralSnapshot(value[i])
    }
    return out as unknown as T
  }
  const src = value as Record<string, unknown>
  // Snapshot container carries `Object.prototype` so consumer code
  // walking `prev` with `.hasOwnProperty(...)` / `in` / Object.keys
  // gets the shape it expects. The per-key `safeOwnRead` resolves
  // a literal `__proto__` key to its own data slot rather than
  // through the inherited accessor; `safeAssign` then defines it as
  // an own data property on `out` instead of routing through the
  // inherited setter. Every other key takes the plain branch.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    safeAssign(out, k, structuralSnapshot(safeOwnRead(src, k)))
  }
  return out as unknown as T
}
