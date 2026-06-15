import type { ValidationError } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { aggregateErrorsAt } from './field-state-api'
import { getAtPath, hasAtPath } from './path-walker'
import {
  ROOT_PATH_KEY,
  canonicalizePath,
  isPathPrefix,
  segmentsForPathKey,
  type PathKey,
  type Path,
  type Segment,
} from './paths'
import { isArrayPath, liveContainerHasKey, liveKeysAtPath } from './proxy-live-keys'
import { safeAssign, safeOwnRead } from './safe-assign'
import { buildSurfaceProxy, type SurfaceProxy } from './surface-proxy'

/**
 * Build the leaf-aware `form.errors` callable Proxy. Drill via dot /
 * bracket OR call dynamically:
 *
 *   form.errors.email                  // readonly ValidationError[] (static leaf)
 *   form.errors.address.city           // readonly ValidationError[] (chained static leaf)
 *   form.errors.address                // proxy for descent only (container)
 *   form.errors('address.city')        // function-call (dynamic / programmatic)
 *   form.errors(['address', 'city'])   // path-array form
 *   form.errors()                      // whole-form aggregate (== meta.errors)
 *   form.errors([])                    // global bucket only (root .refine() / setErrors)
 *
 * Specialises `buildSurfaceProxy` (see surface-proxy.ts) with:
 * - `resolveLeaf`: merges schemaErrors + derivedBlankErrors + userErrors
 *   at the canonical PathKey, FILTERED by `hasAtPath` (the active-path
 *   filter from commit 1fbb8bb stays). Returns `undefined` when no
 *   errors at the path OR the path isn't reachable through the live
 *   form value (e.g. inactive variant of a discriminated union after
 *   a switch). The store-side entries STAY — `form.meta.errors`
 *   exposes the unfiltered aggregate.
 * - `leafKeys`: undefined. The leaf IS the terminal — an array or
 *   undefined. No further proxy wrap.
 *
 * Truthful absence: a key the schema doesn't declare and the data
 * doesn't hold reads `undefined`, not a permissive sub-proxy, so
 * `form.errors.bogus` is `undefined` and an out-of-bounds
 * `form.errors.items[99]` with no error there is `undefined` too. The
 * one exception is a server error parked at a non-schema key: the error
 * stores count as "holding" that key, so `form.errors.ghost` still
 * descends and surfaces the message.
 */
export function buildErrorsProxy<F extends GenericForm>(
  state: FormStore<F, GenericForm>
): SurfaceProxy {
  return buildSurfaceProxy<ValidationError[]>({
    schema: state.schema as unknown as Parameters<typeof buildSurfaceProxy>[0]['schema'],
    resolveLeaf: (path) => {
      // Active-path filter applies to SCHEMA + DERIVED-BLANK errors
      // only: paths whose value is no longer reachable through the
      // live form (e.g. the inactive variant of a DU after a switch)
      // are hidden because they're library-produced verdicts against
      // state that's been replaced. USER errors (set via
      // `setErrors`) are the consumer's data
      // — server replies, programmatic warnings, manual marks — and
      // we never silently drop them, even at paths the schema
      // doesn't know about. Per-field reads
      // (`form.fields.<path>.errors`, `state.getErrorsForPath`) and
      // the `form.meta.errors` aggregate are unaffected by this
      // filter.
      //
      // A length >= 2 path ending in `''` is the container-self
      // sentinel for a depth >= 1 container: it surfaces errors stored
      // at the parent container path (cross-field refines, server-side
      // container marks) plus any literal-`''` leaf errors (rare schema
      // collision). A bare `['']` (length 1) is NOT a sentinel — it's
      // the literal root `''` field, read straight from its own
      // `'[""]'` bucket below. Global errors live at the root `[]` and
      // are reached via the call-form (`errors([])`), never a leaf.
      const isContainerSelfAccess = path.length > 1 && path[path.length - 1] === ''

      const collectAtKey = (key: PathKey, active: boolean, into: ValidationError[]): void => {
        if (active) {
          const s = state.schemaErrors.get(key)
          const b = state.derivedBlankErrors.value.get(key)
          if (s !== undefined) into.push(...s)
          if (b !== undefined) into.push(...b)
        }
        const u = state.userErrors.get(key)
        if (u !== undefined) into.push(...u)
      }

      const merged: ValidationError[] = []
      if (isContainerSelfAccess) {
        const containerPath = path.slice(0, -1) as ReadonlyArray<Segment>
        const containerKey = canonicalizePath(containerPath as Path).key
        const literalKey = canonicalizePath(path as Path).key
        const active = hasAtPath(state.form.value, containerPath)
        collectAtKey(containerKey, active, merged)
        // Skip the literal lookup when canonical keys collide — the
        // root path resolves both to the same form-level bucket and
        // we'd double-count without this guard.
        if (literalKey !== containerKey) collectAtKey(literalKey, active, merged)
        return merged
      }

      const { key } = canonicalizePath(path as Path)
      const active = hasAtPath(state.form.value, path as ReadonlyArray<Segment>)
      collectAtKey(key, active, merged)
      return merged
    },
    // No leafKeys — at a leaf, the resolved value (the merged array or
    // undefined) IS the terminal.
    materializeContainer: (segments) => materializeErrors(state, segments),
    // Any path ending in `''` is a meaningful terminal at the proxy
    // layer. A bare `['']` is the literal root `''` field; at depth
    // >= 1 a trailing `''` is the container-self sentinel that surfaces
    // cross-field refines and container-targeted marks (`resolveLeaf`
    // translates `[..., '']` to the parent container path before
    // querying the stores). When a schema legitimately owns a `''`
    // field, the literal leaf and any container-self errors share the
    // slot (errors concatenate) — vanishingly rare, accepted as the
    // ergonomic cost of one unified sentinel convention at depth >= 1.
    isTerminalAt: (segs) => segs.length >= 1 && segs[segs.length - 1] === '',
    // Call-form aggregates: `form.errors(path)` returns a single
    // `ValidationError[]` for any depth (leaf or container) via the
    // shared `aggregateErrorsAt` helper that `form.meta.errors` and
    // `form.fields(path).errors` also use, so the surfaces never drift.
    //
    // The root is the one carve-out. An EXPLICIT root path
    // (`errors([])`) returns ONLY the global `[]` bucket (root
    // `.refine()`, hydration failures, `setErrors`) via
    // `getErrorsForPath`, giving consumers a dedicated channel for
    // global messages undiluted by field errors. The no-arg `errors()`
    // instead resolves the FULL aggregate through `resolveRootCall`
    // below (identical to `meta.errors`).
    resolveCallTarget: (path) =>
      path.length === 0 ? state.getErrorsForPath([]) : aggregateErrorsAt(state, path),
    // No-arg `errors()` = the whole-form aggregate, matching
    // `meta.errors`. Distinct from `errors([])` (global bucket only);
    // see `resolveCallTarget`.
    resolveRootCall: () => aggregateErrorsAt(state, []),
    // Enumeration unions the live form-data keys at this path with the
    // first-child segments drawn from every error store. Without the
    // union, `Object.keys(form.errors)` / `{...form.errors}` /
    // `v-for="(errs, k) in form.errors"` would silently drop
    // **server-only** errors at a key the schema doesn't know about
    // (`['ghost']`, `['address', 'ghost']`) that the dot / call /
    // JSON.stringify surfaces already expose. Global errors at the root
    // `[]` are NOT a child key and never enumerate here (read them via
    // `errors([])` / `meta.errors`); a literal `''` field enumerates
    // under the key `''` like any other field.
    //
    // The union closes that gap so `ownKeys` agrees with the rest of
    // the surface. Active-path filter mirrors `resolveLeaf`:
    // library-produced verdicts (schema + derived-blank) at unreachable
    // paths stay hidden; user-supplied errors are unconditional.
    containerOwnKeys: (segments) => errorAwareContainerKeys(state, segments),
    // Fast path: a key the live form data holds short-circuits before the
    // O(n) error-store scan, so iterating `form.errors.<array>` over live
    // indices stays linear. The scan still runs for a key with no live
    // home — a server error at a non-schema key (`form.errors.ghost`) —
    // so it keeps surfacing while a genuinely-absent key reads undefined.
    containerHasOwnKey: (segments, key) =>
      liveContainerHasKey(state, segments, key) ||
      errorAwareContainerKeys(state, segments).includes(key),
    isArrayContainer: (segments) => isArrayPath(state, segments),
  })
}

/**
 * Container enumeration that agrees with the other surfaces of
 * `form.errors`. Walks the live form data at the container path AND
 * every error store, surfacing the union of first-child segments as
 * the enumerated keys. Reads happen inside the consumer's active
 * effect, so Vue tracks both the form Ref AND the reactive
 * derived-blank Map: an error appearing at a previously-empty path
 * re-enumerates on the next render.
 *
 * Active-path filter parity with `resolveLeaf`: schema + derived-blank
 * entries at paths the live form value can't reach (inactive DU
 * variants) stay hidden; user-supplied entries are surfaced
 * unconditionally so server errors and manual marks at unknown keys
 * land in `Object.keys` / spread / iteration. Global errors at the
 * root `[]` are root form context, not a child key, so the strict-
 * descendant guard below drops them from enumeration (read them via
 * `errors([])` / `meta.errors`, or find them under the `'[]'` key in the
 * materialised `JSON.stringify` dump); a literal `''` field enumerates
 * under the key `''`.
 */
function errorAwareContainerKeys<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  segments: readonly Segment[]
): readonly string[] {
  const keys = new Set<string>(liveKeysAtPath(state, segments))
  const formValue = state.form.value
  const walk = (
    store: ReadonlyMap<PathKey, ValidationError[]>,
    applyActivePathFilter: boolean
  ): void => {
    for (const [pathKey, errors] of store) {
      if (errors.length === 0) continue
      const decoded = segmentsForPathKey(pathKey)
      if (decoded === null) continue
      // Strict descendant: equal-length entries (the container itself,
      // including the root `[]` bucket) don't contribute a first-child
      // segment to the parent container's enumeration — their slot is
      // the container itself, surfaced via the container-self sentinel
      // and the merged leaf bucket.
      if (decoded.length <= segments.length) continue
      if (!isPathPrefix(segments, decoded)) continue
      // Library-produced verdicts at unreachable paths stay hidden so
      // enumeration agrees with the resolveLeaf filter. User errors
      // pass through to expose unknown server keys.
      if (applyActivePathFilter && !hasAtPath(formValue, decoded)) continue
      const nextSeg = decoded[segments.length] as Segment
      keys.add(typeof nextSeg === 'number' ? String(nextSeg) : nextSeg)
    }
  }
  walk(state.schemaErrors, true)
  walk(state.derivedBlankErrors.value, true)
  walk(state.userErrors, false)
  return [...keys]
}

/**
 * Build a sparse, nested error tree under `containerSegments` for
 * `JSON.stringify(form.errors.<container>)`. Includes every error-
 * bearing path reachable in the live form value (the same active-path
 * filter `resolveLeaf` applies); container-self errors (cross-field
 * refines, server-side container marks) at a depth >= 1 container land
 * under its `''` sentinel slot. Sparse: a container with no self errors
 * and no descendant errors does not appear in the tree; an empty `''`
 * slot never appears.
 *
 * Global errors at the root `[]` (root `.refine()`, hydration failures,
 * `setErrors`) are the root form's own context. They are NEVER the
 * `''` slot — `''` is a plain field key and conflating the two is a hard
 * boundary. When materialising the root container they're surfaced under
 * the root-path key `'[]'` (the same token `errors([])` reads), so a
 * whole-form `JSON.stringify(form.errors)` carries every error the form
 * holds while `''` stays a field slot. When materialising any
 * sub-container they're out of scope and skipped.
 *
 * Placement rules per error entry at `fullPath`:
 *
 *   - Root `[]` bucket — at the root materialisation, place under the
 *     root-path key `'[]'`; at a sub-container materialisation, skip.
 *   - Container-self at the current materialisation root (`fullPath`
 *     exactly equals `containerSegments`, depth >= 1) — place at
 *     `tree['']`.
 *   - Schema leaf descendant — place at the relative path directly.
 *   - Schema container descendant (the path resolves to a non-leaf
 *     node in the schema, i.e. a cross-field refine at that container)
 *     — place at `[...relativePath, '']` so the descendant container's
 *     self errors sit in its own `''` slot.
 *
 * Reactivity contract: every read in this function (the three error
 * stores, the form Ref, the schema's `isLeafAtPath`) happens at call
 * time. JSON.stringify invokes `toJSON` once per stringify call inside
 * the consumer's active effect, so dependency tracking captures every
 * store on every render and re-runs on mutation. The per-path proxy
 * memoisation in `surface-proxy.ts` caches the proxy itself, NOT the
 * materialised object — there is no staleness.
 */
function materializeErrors<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  containerSegments: readonly Segment[]
): Record<string, unknown> | unknown[] {
  // Mirror the live-data shape at the container: array container →
  // array root (array indices place into integer slots, holes
  // serialise as `null`); object container → object root. Without
  // this the placement code would route numeric segments through a
  // string-keyed object, producing `{ "0": {…} }` for an array path
  // and breaking shape parity with `form.values`.
  const liveContainer = getAtPath(state.form.value, containerSegments)
  // Object case carries `Object.prototype` so any consumer reading
  // the materialized tree directly (or via the errors callable Proxy
  // when a third-party walker bypasses Vue's instrumentation) sees a
  // standard prototype chain. The `safeAssign` calls in `placeAt`
  // land a literal `__proto__` segment as an own data property; no
  // matter what `setErrors` hands in, the
  // pollution arrow can't reassign the container's prototype.
  const tree: Record<string, unknown> | unknown[] = Array.isArray(liveContainer) ? [] : {}

  // Two store classes with different visibility rules. Schema +
  // derived-blank: library-produced verdicts; filter out paths the
  // current form value can't reach (inactive DU variants). User:
  // consumer-supplied data (server replies, manual marks); surface
  // every entry regardless of `hasAtPath`, otherwise unknown server
  // keys / form-level messages get silently swallowed.
  const collect = (
    store: ReadonlyMap<PathKey, ValidationError[]>,
    applyActivePathFilter: boolean
  ): void => {
    entries: for (const [pathKey, errors] of store) {
      if (errors.length === 0) continue
      // Cache hit on every keystroke — the store's PathKeys are
      // produced through `canonicalizePath`, which warms the inverse
      // cache. Cold path (corrupt key) returns null and we skip.
      const fullPath = segmentsForPathKey(pathKey)
      if (fullPath === null) continue

      // Root `[]` bucket — global / root `.refine()` / hydration /
      // `setErrors`, the root form's own context. It is NEVER the
      // `''` slot: `''` is a plain field key, and conflating the two is
      // a hard boundary. At the root materialisation, surface global
      // errors under the root-path key `'[]'` (the same token
      // `errors([])` reads) so `JSON.stringify(form.errors)` expresses
      // every error the form holds while `''` stays untouched. At a
      // sub-container materialisation global is out of scope, so skip.
      if (fullPath.length === 0) {
        if (containerSegments.length === 0) placeAt(tree, [ROOT_PATH_KEY], errors)
        continue
      }

      // Standard descendant-or-equal check against the materialisation
      // container. Strict descendants AND the container itself
      // (container-self errors, depth >= 1) BOTH belong in the tree.
      if (fullPath.length < containerSegments.length) continue
      for (let i = 0; i < containerSegments.length; i++) {
        if (fullPath[i] !== containerSegments[i]) continue entries
      }

      // Active-path filter matches `resolveLeaf` semantics so a leaf
      // read and a container materialisation never disagree. Only
      // schema-class stores apply it — user errors stay visible
      // whether or not their path is reachable.
      if (applyActivePathFilter && !hasAtPath(state.form.value, fullPath)) continue

      const relativePath = fullPath.slice(containerSegments.length)
      let placePath: readonly Segment[]
      if (relativePath.length === 0) {
        // Container-self error at the current materialisation root
        // (depth >= 1; the root `[]` bucket was skipped above).
        placePath = ['']
      } else if (state.schema.isLeafAtPath(fullPath as Path)) {
        // Schema leaf — place directly.
        placePath = relativePath
      } else if (state.schema.getSlimPrimitiveTypesAtPath(fullPath as Path).size > 0) {
        // Schema container descendant (known to the schema, non-leaf by
        // `isLeafAtPath`) — place under its own `''` slot so the
        // container-self errors don't clobber descendant leaves.
        placePath = [...relativePath, '']
      } else {
        // Unknown path — not in the schema at all. User-provided error
        // (server reply, manual mark) targeting a key the schema
        // doesn't recognise. Surface as a leaf so consumers can debug
        // what the server returned without the sentinel wrapping their
        // data unexpectedly.
        placePath = relativePath
      }

      placeAt(tree, placePath, errors)
    }
  }

  collect(state.schemaErrors, true)
  collect(state.derivedBlankErrors.value, true)
  collect(state.userErrors, false)
  return tree
}

/**
 * Place `errors` at the relative `path` inside `tree`, allocating
 * intermediate object/array containers as needed (numeric segments
 * produce arrays). When `tree` already has an array at `path`,
 * concatenate so multiple stores' contributions to the same path
 * merge into one array — matches `resolveLeaf`'s
 * `[...schemaErrors, ...blankErrors, ...userErrors]` ordering.
 */
function placeAt(
  tree: Record<string, unknown> | unknown[],
  path: readonly Segment[],
  errors: ValidationError[]
): void {
  if (path.length === 0) return
  let cursor: Record<string, unknown> | unknown[] = tree
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as Segment
    const nextSeg = path[i + 1] as Segment
    const key = typeof seg === 'number' ? String(seg) : seg
    const cursorRecord = cursor as Record<string, unknown>
    // `safeOwnRead` here is load-bearing: a literal `__proto__`
    // segment on a freshly-allocated `{}` tree node would otherwise
    // resolve via the inherited accessor to `Object.prototype` and
    // skip the allocation branch, leaking the prototype as the
    // descent cursor for the next iteration's write.
    let child = safeOwnRead(cursorRecord, key)
    if (child === null || child === undefined || typeof child !== 'object') {
      // Intermediate containers mirror `materializeErrors`' tree root.
      // Numeric next-segments still produce arrays so the live-shape
      // mirror (object root → object containers, array root → array
      // containers) is preserved. `safeAssign` at the parent slot lands
      // a literal `__proto__` key as an own data property, with no
      // path to `Object.prototype`.
      child = typeof nextSeg === 'number' ? [] : {}
      safeAssign(cursorRecord, key, child)
    }
    cursor = child as Record<string, unknown> | unknown[]
  }
  const lastSeg = path[path.length - 1] as Segment
  const lastKey = typeof lastSeg === 'number' ? String(lastSeg) : lastSeg
  const cursorRecord = cursor as Record<string, unknown>
  const existing = safeOwnRead(cursorRecord, lastKey)
  safeAssign(cursorRecord, lastKey, Array.isArray(existing) ? [...existing, ...errors] : errors)
}
