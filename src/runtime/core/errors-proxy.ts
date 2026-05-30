import type { ValidationError } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { aggregateErrorsAt } from './field-state-api'
import { getAtPath, hasAtPath } from './path-walker'
import {
  canonicalizePath,
  FORM_ERRORS_PATH_KEY,
  isPathPrefix,
  segmentsForPathKey,
  type PathKey,
  type Path,
  type Segment,
} from './paths'
import { isArrayPath, liveKeysAtPath } from './proxy-live-keys'
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
 *   form.errors()                      // root proxy
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
 * Path / value contract preserved: errors at unknown paths return a
 * sub-proxy (descend permissively). `form.errors.bogus` is a proxy,
 * not undefined — readers who want existence checks should use the
 * leaf form (`form.errors.bogus.somePath`) which terminates only at
 * schema-leaves.
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
      // `setFieldErrors` / `setFormErrors`) are the consumer's data
      // — server replies, programmatic warnings, manual marks — and
      // we never silently drop them, even at paths the schema
      // doesn't know about. Per-field reads
      // (`form.fields.<path>.errors`, `state.getErrorsForPath`) and
      // the `form.meta.errors` aggregate are unaffected by this
      // filter.
      //
      // A path ending in `''` at depth >= 1 is the container-self
      // sentinel: it surfaces errors stored at the parent container
      // path (cross-field refines, server-side container marks) plus
      // any literal-`''` leaf errors (rare schema collision). At
      // depth 0 (the root `['']`) the parent would be `[]`, which is
      // canonicalised to the same form-level bucket the root sentinel
      // already addresses, so a single lookup suffices.
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
      const isFormLevel = key === FORM_ERRORS_PATH_KEY
      const active = isFormLevel || hasAtPath(state.form.value, path as ReadonlyArray<Segment>)
      collectAtKey(key, active, merged)
      return merged
    },
    // No leafKeys — at a leaf, the resolved value (the merged array or
    // undefined) IS the terminal.
    materializeContainer: (segments) => materializeErrors(state, segments),
    // Any path ending in `''` is a meaningful terminal at the proxy
    // layer: at root it's the form-level bucket; at depth >= 1 it's
    // the container-self sentinel that surfaces cross-field refines
    // and container-targeted marks. `resolveLeaf` translates `[...,
    // '']` lookups to the parent container path before querying the
    // stores. When a schema legitimately owns a `''` field, the
    // literal leaf and any container-self errors share the slot
    // (errors concatenate) — vanishingly rare, accepted as the
    // ergonomic cost of one unified sentinel convention at every
    // depth.
    isTerminalAt: (segs) => segs.length >= 1 && segs[segs.length - 1] === '',
    // Call-form aggregates: `form.errors(path)` returns a single
    // `ValidationError[]` for any depth (leaf or container) — same
    // shared `aggregateErrorsAt` helper that `form.meta.errors` and
    // `form.fields(path).errors` use, so the three surfaces never
    // drift. Empty results return `undefined`, matching the leaf
    // proxy's pre-existing semantic (`form.errors.email === undefined`
    // when valid) so consumer code that branches on truthiness keeps
    // working — the call-form just extends that semantic to
    // containers and dynamic paths.
    resolveCallTarget: (path) => aggregateErrorsAt(state, path),
    // Enumeration unions the live form-data keys at this path with the
    // first-child segments drawn from every error store. Without the
    // union, `Object.keys(form.errors)` / `{...form.errors}` /
    // `v-for="(errs, k) in form.errors"` silently dropped two
    // important error classes that the dot / call / JSON.stringify
    // surfaces already exposed:
    //
    //   - **Form-level** errors at the synthetic `['']` path (set via
    //     `setFormErrors` or root cross-field refines).
    //   - **Server-only** errors at a key the schema doesn't know
    //     about (`['ghost']`, `['address', 'ghost']`).
    //
    // The union closes that gap so `ownKeys` agrees with the rest of
    // the surface. Active-path filter mirrors `resolveLeaf`:
    // library-produced verdicts (schema + derived-blank) at unreachable
    // paths stay hidden; user-supplied errors are unconditional.
    containerOwnKeys: (segments) => errorAwareContainerKeys(state, segments),
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
 * land in `Object.keys` / spread / iteration. The synthetic root
 * form-level path (`['']`) is exempt from the filter — its slot is
 * the conventional home for `setFormErrors` and root `.refine()`
 * results, and has no live-data home by design.
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
      // Synthetic form-level path is `['']`; tracked under the
      // sentinel PathKey. Only enumerable when materialising at root,
      // and exempt from the active-path filter (no live-data home).
      if (pathKey === FORM_ERRORS_PATH_KEY) {
        if (segments.length === 0) keys.add('')
        continue
      }
      const decoded = segmentsForPathKey(pathKey)
      if (decoded === null) continue
      // Strict descendant: equal-length entries don't contribute a
      // first-child segment to the parent container's enumeration
      // (their slot is the container itself, surfaced via the
      // container-self sentinel and the merged leaf bucket).
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
 * refines, server-side container marks, root form-level entries) land
 * under the `''` sentinel slot at every container depth. Sparse: a
 * container with no self errors and no descendant errors does not
 * appear in the tree; an empty `''` slot never appears.
 *
 * Placement rules per error entry at `fullPath`:
 *
 *   - Synthetic root form-level path (`['']`) — place at `tree['']`
 *     when materialising at root; the prefix check filters it out at
 *     any other container.
 *   - Container-self at the current materialisation root
 *     (`fullPath` exactly equals `containerSegments`) — place at
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
  // matter what `setFieldErrors` / `setFormErrors` hands in, the
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

      // Synthetic root form-level path is the canonical home for
      // root-level errors (hydration failures, root `.refine()`,
      // `setFormErrors`). It's `['']`, exempt from the prefix check
      // and the active-path filter — the empty-string segment never
      // resolves to a real value slot. Only relevant at root
      // materialisation; at any non-root container the prefix check
      // filters it out below.
      const isSyntheticFormLevel = fullPath.length === 1 && fullPath[0] === ''

      // Standard descendant-or-equal check against the materialisation
      // container. Strict descendants AND the container itself
      // (container-self errors) BOTH belong in the tree.
      if (!isSyntheticFormLevel) {
        if (fullPath.length < containerSegments.length) continue
        for (let i = 0; i < containerSegments.length; i++) {
          if (fullPath[i] !== containerSegments[i]) continue entries
        }
      } else if (containerSegments.length !== 0) {
        continue
      }

      // Active-path filter matches `resolveLeaf` semantics so a leaf
      // read and a container materialisation never disagree. Only
      // schema-class stores apply it — user errors stay visible
      // whether or not their path is reachable. The synthetic root
      // form-level path is exempt (no value slot to check).
      if (applyActivePathFilter && !isSyntheticFormLevel && !hasAtPath(state.form.value, fullPath))
        continue

      let placePath: readonly Segment[]
      if (isSyntheticFormLevel) {
        placePath = ['']
      } else {
        const relativePath = fullPath.slice(containerSegments.length)
        if (relativePath.length === 0) {
          // Container-self error at the current materialisation root.
          placePath = ['']
        } else if (state.schema.isLeafAtPath(fullPath as Path)) {
          // Schema leaf — place directly.
          placePath = relativePath
        } else if (state.schema.getSlimPrimitiveTypesAtPath(fullPath as Path).size > 0) {
          // Schema container descendant (known to the schema, non-leaf
          // by `isLeafAtPath`) — place under its own `''` slot so the
          // container-self errors don't clobber descendant leaves.
          placePath = [...relativePath, '']
        } else {
          // Unknown path — not in the schema at all. User-provided
          // error (server reply, manual mark) targeting a key the
          // schema doesn't recognise. Surface as a leaf so consumers
          // can debug what the server returned without the sentinel
          // wrapping their data unexpectedly.
          placePath = relativePath
        }
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
