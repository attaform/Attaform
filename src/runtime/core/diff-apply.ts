import { deleteAtPath, setAtPath } from './path-walker'
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
 * `reconcileArraysInPlace` scopes one extra optimization to the typed array
 * helpers (the writes that carry an `arrayOp` meta hint). When set, a changed
 * key whose old and new values are BOTH arrays is reconciled IN PLACE — the
 * array branch truncates to the new length and reassigns only the indices
 * whose content moved, keeping the array's own reference stable. A reorder
 * (swap / move, no length change) then fires only the two moved indices' deps
 * instead of the array-key dep that re-renders every `form.list` row. The flag
 * is OFF for a direct `setValue(arrayPath, wholeNewArray)`, which replaces the
 * array reference like any other container-target write — so the "reference
 * changes IFF targeted or restructured" contract holds for explicit writes;
 * only the helpers opt into the stable-reference reconcile. Consumers reading
 * an array then subscribe to its length or its elements (or take a deep watch),
 * not its bare reference.
 */
export function applyChangedKeys(
  target: unknown,
  source: unknown,
  reconcileArraysInPlace: boolean
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
      // On an array structural op (arrayOp present), reconcile a changed
      // array-valued key IN PLACE: recurse so the array branch truncates and
      // reassigns only the moved indices, keeping the array's reference stable.
      // `safeOwnRead` returns the reactive proxy for `t[key]` (tracking intact),
      // so the in-place index/length sets fire the right deps. Falls through to
      // a plain reassign for non-array values, a shape mismatch, or a direct
      // container-target write (flag off), which replaces the reference.
      if (reconcileArraysInPlace) {
        const curVal = safeOwnRead(t, key)
        if (
          Array.isArray(curVal) &&
          Array.isArray(nextVal) &&
          applyChangedKeys(curVal, nextVal, reconcileArraysInPlace)
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
 * Apply a `Patch[]` forward to `root`, returning a fresh root with each
 * patch's `newValue` (or `path` deletion) realised. Uses `setAtPath` /
 * `deleteAtPath` from `path-walker.ts`, which are copy-on-write — each
 * step rebuilds only the spine from root to the touched path, leaving
 * sibling subtrees reference-equal with the input. The result is a
 * structurally-shared successor suitable for use as a history snapshot.
 *
 * Patch semantics:
 * - `added` — set the path to `newValue`. Intermediate containers are
 *   created on demand (`setAtPath` handles this).
 * - `removed` — delete the path (array splice / object key deletion).
 * - `changed` — set the path to `newValue`. A root-level `changed`
 *   (path: []) replaces `root` wholesale; this matches `diffAndApply`'s
 *   "object ↔ array mismatch at root" emission.
 *
 * Patches are applied in their emitted order. `diffAndApply` emits
 * array patches in index order, so a sequence like
 * `[changed@1, removed@2]` collapses to the correct final array shape
 * (set then splice).
 */
export function applyPatchesForward(root: unknown, patches: readonly Patch[]): unknown {
  let current = root
  for (const patch of patches) {
    if (patch.path.length === 0) {
      current = patch.kind === 'removed' ? undefined : patch.newValue
      continue
    }
    if (patch.kind === 'removed') {
      current = deleteAtPath(current, patch.path)
    } else {
      current = setAtPath(current, patch.path, patch.newValue)
    }
  }
  return current
}

/**
 * Apply a `Patch[]` in reverse, restoring `root` to its pre-patch state.
 * Walks patches back-to-front and inverts each one's direction:
 * - `added` (forward set) → `deleteAtPath` (remove what was added).
 * - `removed` (forward delete) → `setAtPath` with `oldValue`.
 * - `changed` (forward set newValue) → `setAtPath` with `oldValue`.
 *
 * Reverse traversal matters because `diffAndApply` emits array patches
 * in index order. A forward sequence `[changed@1, removed@2]` applied
 * forward yields the new array; to invert, the splice at index 2 must
 * un-splice FIRST (extending the array back to length 3 by setting
 * index 2 to its `oldValue`), then the `changed@1` patch restores
 * index 1 to its `oldValue`. Going the other direction would leave a
 * hole.
 */
export function applyPatchesInverse(root: unknown, patches: readonly Patch[]): unknown {
  let current = root
  for (let i = patches.length - 1; i >= 0; i--) {
    const patch = patches[i] as Patch
    if (patch.path.length === 0) {
      if (patch.kind === 'added') {
        current = undefined
      } else {
        current = patch.oldValue
      }
      continue
    }
    if (patch.kind === 'added') {
      current = deleteAtPath(current, patch.path)
    } else {
      current = setAtPath(current, patch.path, patch.oldValue)
    }
  }
  return current
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
