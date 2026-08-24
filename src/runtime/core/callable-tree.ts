import { computed, readonly, toRaw, type ComputedRef, type Ref } from 'vue'
import type { ValidationError } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { cellEntriesFor } from './errors'
import { aggregateErrorsAt, type FieldState } from './field-state-api'
import { getAtPath, hasAtPath, isPlainRecord } from './path-walker'
import {
  ROOT_PATH_KEY,
  canonicalizePath,
  isPathPrefix,
  segmentsForPathKey,
  type Path,
  type PathKey,
  type Segment,
} from './paths'
import { isArrayPath, liveContainerHasKey, liveKeysAtPath } from './proxy-live-keys'
import { makeReadonlyCoercion, warnReadOnly } from './proxy-readonly-helpers'
import { isShadowedKey, safeAssign, safeOwnRead } from './safe-assign'

/**
 * The callable-tree layer: one module building the three read surfaces
 * (`form.values`, `form.errors`, `form.fields`) as callable readonly
 * Proxies. Shared node machinery for the two schema-aware surfaces
 * (errors / fields); the values surface is a thin callable over Vue's
 * native `readonly`.
 *
 * Surface contract (pinned in surface-contract-pins.test.ts):
 *
 * - Only the ROOT is callable (function target + `apply` trap); every
 *   non-root container is a plain object / Array target, so a node
 *   call throws like any non-function and `Array.isArray` holds on
 *   array-shaped paths (Vue's `renderList` takes its indexed branch).
 * - Truthful descend gate: a key that is neither a surface-declared
 *   terminal, a declared field of a FIXED object, nor a key the
 *   container currently holds reads `undefined` — no phantom nodes.
 *   Fixed-object gating matters because an open container's element
 *   schema matches ANY segment, so schema presence can't arbitrate
 *   there; open containers rely on live keys alone.
 * - Live enumeration: `Object.keys` / spread / `v-for` reflect the
 *   live form data (the errors surface unions in error-store keys so
 *   server errors at unknown keys stay enumerable).
 * - Coercion: `toJSON` / `toString` / `valueOf` / `Symbol.toPrimitive`
 *   resolve to the surface's materialiser at every node, so
 *   `JSON.stringify` and template interpolation never see a proxy.
 * - Writes are warn-and-noop at every node (strict-mode callers must
 *   not throw; the readonly contract is the absence of mutation).
 * - Per-path node memoisation, keyed by canonical path + live shape,
 *   so repeated reads return the same Proxy and a variant flip that
 *   swaps the shape at a path mints a freshly-targeted node.
 *
 * Schema fields literally named after built-ins (`toString`,
 * `valueOf`, `hasOwnProperty`, `call`, `apply`, `bind`) are not
 * reachable through dot access on these surfaces (sign-off 8); the
 * call form (`surface(path)`) addresses any path regardless of name.
 */

/**
 * Tests an integer-like string without leading zeros; mirrors
 * `INTEGER_SEGMENT` in paths.ts so proxy descent produces the same
 * canonical segments as a dotted-string call.
 */
const INTEGER_SEGMENT = /^(?:0|[1-9]\d*)$/

function keyToSegment(key: string): Segment {
  return INTEGER_SEGMENT.test(key) ? Number(key) : key
}

/**
 * Vue probes these reactivity sigils as string keys on any object it
 * meets inside an effect. `__v_skip` opts the proxy out of reactive
 * wrapping (the reads inside the traps do the dependency tracking);
 * the rest must read `undefined` rather than descending into phantom
 * child nodes.
 */
function vueSigilRead(key: string): boolean | undefined {
  if (key === '__v_skip') return true
  if (
    key === '__v_isReactive' ||
    key === '__v_isReadonly' ||
    key === '__v_isShallow' ||
    key === '__v_isRef' ||
    key === '__v_raw'
  ) {
    // Distinguish "handled, value undefined" from "not a sigil".
    return false
  }
  return undefined
}

/** Public runtime shape of a built surface; per-surface types in types-api narrow it. */
export type CallableSurface = ((path?: string | Path) => unknown) & Record<string, unknown>

/**
 * Per-surface configuration for the shared schema-aware node builder.
 * Every hook is required — the two surfaces supply all of them, and
 * the trap layer carries no fallback branches.
 */
type TreeSpec = {
  readonly schema: {
    isLeafAtPath(path: readonly Segment[]): boolean
    isFixedObjectAtPath(path: readonly Segment[]): boolean
    getSlimPrimitiveTypesAtPath(path: readonly Segment[]): ReadonlySet<unknown>
  }
  /** Terminal value at a leaf (or surface-declared terminal) path. */
  readonly leaf: (segs: readonly Segment[]) => unknown
  /** Non-leaf paths that still terminate (the errors `''` sentinel). */
  readonly isTerminal: (segs: readonly Segment[]) => boolean
  /** JSON-friendly materialisation of the container at `segs`. */
  readonly materialize: (segs: readonly Segment[]) => unknown
  /** Enumerable keys of the container at `segs` (live, reactive). */
  readonly ownKeys: (segs: readonly Segment[]) => readonly string[]
  /** O(1) membership agreeing with `ownKeys`. */
  readonly hasOwn: (segs: readonly Segment[], key: string) => boolean
  /** Whether the live value at `segs` is array-shaped right now. */
  readonly isArrayAt: (segs: readonly Segment[]) => boolean
  /** Call-form resolution (`surface(path)`; no-arg calls pass `[]`). */
  readonly call: (segs: Path) => unknown
  /** Surface name for the warn-and-noop messages. */
  readonly surface: string
}

function buildTree(spec: TreeSpec): CallableSurface {
  const containerCache = new Map<string, CallableSurface>()
  // Per-path "schema has a field here" memo for the fixed-object gate.
  const existsCache = new Map<string, boolean>()

  function schemaHasPath(segs: readonly Segment[]): boolean {
    const cacheKey = JSON.stringify(segs)
    const cached = existsCache.get(cacheKey)
    if (cached !== undefined) return cached
    const result = spec.schema.getSlimPrimitiveTypesAtPath(segs).size > 0
    existsCache.set(cacheKey, result)
    return result
  }

  function descend(segs: readonly Segment[]): unknown {
    if (spec.schema.isLeafAtPath(segs)) return spec.leaf(segs)
    if (spec.isTerminal(segs)) return spec.leaf(segs)
    return containerAt(segs)
  }

  function containerAt(segments: readonly Segment[]): CallableSurface {
    // Shape participates in the cache key: a variant switch that swaps
    // the live shape at this path mints a freshly-targeted proxy on the
    // next read, while a closed flip round-trip returns the original.
    // Held references keep their minted target (proxy targets are
    // immutable) but every trap re-evaluates live state per call, so
    // `held.length` / `Object.keys(held)` / descent track reality;
    // only host-level checks (`Array.isArray`, `typeof`) stay pinned.
    const isArrayLike = spec.isArrayAt(segments)
    const cacheKey = `${JSON.stringify(segments)}+${isArrayLike ? 'A' : 'O'}`
    const existing = containerCache.get(cacheKey)
    if (existing !== undefined) return existing

    const isFixedObject = spec.schema.isFixedObjectAtPath(segments)
    const isRoot = segments.length === 0
    const {
      toString: containerToString,
      valueOf: containerValueOf,
      toJSON: containerToJSON,
      toPrimitive: containerToPrimitive,
    } = makeReadonlyCoercion(() => spec.materialize(segments))

    const target: CallableSurface = isRoot
      ? ((() => {}) as unknown as CallableSurface)
      : isArrayLike
        ? ([] as unknown as CallableSurface)
        : ({} as unknown as CallableSurface)
    const proxy = new Proxy(target, {
      apply(_, __, args: unknown[]): unknown {
        // Root-only by construction: non-root targets are not callable.
        const arg = args[0] as string | Path | undefined
        if (arg === undefined) return spec.call(segments as Path)
        return spec.call(canonicalizePath(arg).segments)
      },
      get(_, key: string | symbol): unknown {
        if (typeof key === 'symbol') {
          // `Symbol.toPrimitive` short-circuits OrdinaryToPrimitive's
          // `toString` → `valueOf` walk, which would otherwise descend
          // and return non-primitives.
          if (key === Symbol.toPrimitive) return containerToPrimitive
          return Reflect.get(target, key)
        }
        const sigil = vueSigilRead(key)
        if (sigil !== undefined) return sigil ? true : undefined
        if (key === 'toJSON') return containerToJSON
        // Array-shaped containers: live `length` drives `renderList`
        // and native iteration. The gate re-checks live shape so a held
        // object-target proxy tracks a flip into an array.
        const arrayNow = isArrayLike || spec.isArrayAt(segments)
        if (key === 'length' && arrayNow) return spec.ownKeys(segments).length
        // Array.prototype pass-through for non-integer keys on
        // array-shaped paths (`.map`, `.forEach`, `.slice`, …). The
        // methods read `this[i]` / `this.length` back through this
        // trap; mutators are reachable but the write traps no-op them.
        if (arrayNow && typeof keyToSegment(key) === 'string' && key in Array.prototype) {
          return Reflect.get(Array.prototype, key)
        }
        // Direct method-call coercion; a schema field with one of these
        // names is not dot-reachable (sign-off 8) — use the call form.
        if (key === 'toString') return containerToString
        if (key === 'valueOf') return containerValueOf
        // The real method, routed through this proxy's descriptor trap,
        // so `surface.hasOwnProperty(k)` agrees with `Object.keys`.
        if (key === 'hasOwnProperty') return Object.prototype.hasOwnProperty
        const childSegs = [...segments, keyToSegment(key)]
        // Truthful descend gate — see the module docblock.
        if (
          spec.isTerminal(childSegs) ||
          (isFixedObject && schemaHasPath(childSegs)) ||
          spec.hasOwn(segments, key)
        ) {
          return descend(childSegs)
        }
        return undefined
      },
      has(_, key: string | symbol): boolean {
        if (typeof key === 'symbol') return Reflect.has(target, key)
        // Conservatively true — whether a path resolves is answered by
        // the read (which returns `undefined` past the gate).
        return true
      },
      ownKeys: () => {
        const liveKeys = spec.ownKeys(segments)
        // Array targets carry a non-configurable own `length`; the
        // Proxy invariant requires it in the trap result. It is
        // non-enumerable, so `Object.keys` filters it back out.
        if (isArrayLike) return ['length', ...liveKeys]
        return [...liveKeys]
      },
      getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
        if (typeof key !== 'string') return undefined
        if (isArrayLike && key === 'length') {
          return {
            configurable: false,
            enumerable: false,
            value: spec.ownKeys(segments).length,
            writable: true,
          }
        }
        if (!spec.ownKeys(segments).includes(key)) return undefined
        return {
          configurable: true,
          enumerable: true,
          value: descend([...segments, keyToSegment(key)]),
          writable: false,
        }
      },
      set: (_, key) => {
        warnReadOnly(spec.surface, 'write', key)
        return true
      },
      deleteProperty: (_, key) => {
        warnReadOnly(spec.surface, 'delete', key)
        return true
      },
      defineProperty: (_, key) => {
        warnReadOnly(spec.surface, 'define', key)
        return true
      },
    })
    containerCache.set(cacheKey, proxy)
    return proxy
  }

  return containerAt([])
}

// ---------------------------------------------------------------------------
// form.errors
// ---------------------------------------------------------------------------

/**
 * Build the `form.errors` surface. Leaf reads merge the path's schema +
 * derived-blank + user buckets (active-path filter on the library-
 * produced classes only); a trailing-`''` path is the container-self
 * sentinel; the call form aggregates a subtree via `aggregateErrorsAt`;
 * enumeration unions live form keys with error-store keys; `toJSON`
 * materialises the sparse error tree through a per-container memoised
 * computed.
 */
export function buildErrorsSurface<F extends GenericForm>(
  state: FormStore<F, GenericForm>
): CallableSurface {
  // Lazily-allocated computed per materialised container path: the
  // sparse tree rebuilds when a store / the form value changes, not on
  // every stringify. Deps (error stores, form Ref, schema queries) are
  // read inside the computed, so tracking is unchanged.
  const treeCache = new Map<string, ComputedRef<unknown>>()
  const materialize = (segments: readonly Segment[]): unknown => {
    const cacheKey = JSON.stringify(segments)
    let tree = treeCache.get(cacheKey)
    if (tree === undefined) {
      const frozen = [...segments]
      tree = computed(() => materializeErrors(state, frozen))
      treeCache.set(cacheKey, tree)
    }
    return tree.value
  }

  const resolveLeaf = (path: readonly Segment[]): ValidationError[] => {
    // A length >= 2 path ending in `''` is the container-self sentinel
    // for a depth >= 1 container: it surfaces errors stored at the
    // parent container path (cross-field refines, server-side container
    // marks) plus any literal-`''` leaf errors. A bare `['']` is the
    // literal root `''` field, read from its own bucket. Global errors
    // live at the root `[]` and are reached via `meta.ownErrors`.
    const isContainerSelfAccess = path.length > 1 && path[path.length - 1] === ''

    const collectAtKey = (key: PathKey, active: boolean, into: ValidationError[]): void => {
      const cell = state.errorCells.get(key)
      if (active) {
        const b = state.derivedBlankErrors.value.get(key)
        if (cell !== undefined) into.push(...cell.schema)
        if (b !== undefined) into.push(...b)
      }
      // User errors are consumer data (server replies, manual marks) —
      // never silently dropped, even at unreachable paths.
      if (cell !== undefined) into.push(...cell.user)
    }

    const merged: ValidationError[] = []
    if (isContainerSelfAccess) {
      const containerPath = path.slice(0, -1) as ReadonlyArray<Segment>
      const containerKey = canonicalizePath(containerPath as Path).key
      const literalKey = canonicalizePath(path as Path).key
      const active = hasAtPath(state.form.value, containerPath)
      collectAtKey(containerKey, active, merged)
      // Skip the literal lookup when canonical keys collide — the root
      // path resolves both to the same bucket and we'd double-count.
      if (literalKey !== containerKey) collectAtKey(literalKey, active, merged)
      return merged
    }

    const { key } = canonicalizePath(path as Path)
    const active = hasAtPath(state.form.value, path as ReadonlyArray<Segment>)
    collectAtKey(key, active, merged)
    return merged
  }

  return buildTree({
    schema: state.schema,
    leaf: resolveLeaf,
    // Any path ending in `''` is a meaningful terminal: the literal
    // root `''` field at length 1, the container-self sentinel deeper.
    isTerminal: (segs) => segs.length >= 1 && segs[segs.length - 1] === '',
    materialize,
    ownKeys: (segments) => errorAwareContainerKeys(state, segments),
    // Live-data fast path first; the store scan keeps server errors at
    // non-schema keys reachable while a genuinely-absent key stays out.
    hasOwn: (segments, key) =>
      liveContainerHasKey(state, segments, key) ||
      errorAwareContainerKeys(state, segments).includes(key),
    isArrayAt: (segments) => isArrayPath(state, segments),
    // `errors()` / `errors([])` / `errors(path)` are all the subtree
    // aggregate — the same helper `meta.errors` reads, so the surfaces
    // never drift.
    call: (path) => aggregateErrorsAt(state, path),
    surface: 'form.errors',
  })
}

/**
 * Container enumeration for `form.errors`: the union of live form-data
 * keys at the path and the first-child segments of every error-store
 * entry beneath it. Active-path filter mirrors leaf reads — library-
 * produced verdicts (schema + blank) at unreachable paths stay hidden;
 * user-supplied entries surface unconditionally. Equal-length entries
 * (the container's own bucket, including root `[]`) contribute no
 * child key. Two-class iteration preserves schema → blank → user order.
 */
function errorAwareContainerKeys<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  segments: readonly Segment[]
): readonly string[] {
  const keys = new Set<string>(liveKeysAtPath(state, segments))
  const formValue = state.form.value
  const walk = (
    store: Iterable<readonly [PathKey, readonly ValidationError[]]>,
    applyActivePathFilter: boolean
  ): void => {
    for (const [pathKey, errors] of store) {
      if (errors.length === 0) continue
      const decoded = segmentsForPathKey(pathKey)
      if (decoded === null) continue
      if (decoded.length <= segments.length) continue
      if (!isPathPrefix(segments, decoded)) continue
      if (applyActivePathFilter && !hasAtPath(formValue, decoded)) continue
      const nextSeg = decoded[segments.length] as Segment
      keys.add(typeof nextSeg === 'number' ? String(nextSeg) : nextSeg)
    }
  }
  walk(cellEntriesFor(state.errorCells, 'schema'), true)
  walk(state.derivedBlankErrors.value, true)
  walk(cellEntriesFor(state.errorCells, 'user'), false)
  return [...keys]
}

/**
 * Build the sparse nested error tree under `containerSegments` for
 * `JSON.stringify(form.errors.<container>)`. Placement per entry at
 * `fullPath`:
 *
 * - Root `[]` bucket — at the root materialisation, under the
 *   root-path key `'[]'` (never the `''` slot: `''` is a plain field
 *   key and conflating the two is a hard boundary); at a sub-container
 *   materialisation, out of scope.
 * - Container-self at the materialisation root (depth >= 1) — `tree['']`.
 * - Schema leaf descendant — at the relative path.
 * - Schema container descendant (a cross-field refine there) — at
 *   `[...relativePath, '']` so its self errors keep their own slot.
 * - Unknown path (user error at a key the schema doesn't know) — at
 *   the relative path, as a leaf.
 *
 * Sparse: a container with no self and no descendant errors does not
 * appear. Active-path filter matches leaf reads (schema-class stores
 * only). The tree mirrors the live shape at the root (array container →
 * array root) so shape parity with `form.values` holds.
 */
function materializeErrors<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  containerSegments: readonly Segment[]
): Record<string, unknown> | unknown[] {
  const liveContainer = getAtPath(state.form.value, containerSegments)
  const tree: Record<string, unknown> | unknown[] = Array.isArray(liveContainer) ? [] : {}

  const collect = (
    store: Iterable<readonly [PathKey, readonly ValidationError[]]>,
    applyActivePathFilter: boolean
  ): void => {
    entries: for (const [pathKey, errors] of store) {
      if (errors.length === 0) continue
      const fullPath = segmentsForPathKey(pathKey)
      if (fullPath === null) continue

      if (fullPath.length === 0) {
        if (containerSegments.length === 0) placeAt(tree, [ROOT_PATH_KEY], errors)
        continue
      }

      if (fullPath.length < containerSegments.length) continue
      for (let i = 0; i < containerSegments.length; i++) {
        if (fullPath[i] !== containerSegments[i]) continue entries
      }

      if (applyActivePathFilter && !hasAtPath(state.form.value, fullPath)) continue

      const relativePath = fullPath.slice(containerSegments.length)
      let placePath: readonly Segment[]
      if (relativePath.length === 0) {
        placePath = ['']
      } else if (state.schema.isLeafAtPath(fullPath as Path)) {
        placePath = relativePath
      } else if (state.schema.getSlimPrimitiveTypesAtPath(fullPath as Path).size > 0) {
        placePath = [...relativePath, '']
      } else {
        placePath = relativePath
      }

      placeAt(tree, placePath, errors)
    }
  }

  collect(cellEntriesFor(state.errorCells, 'schema'), true)
  collect(state.derivedBlankErrors.value, true)
  collect(cellEntriesFor(state.errorCells, 'user'), false)
  return tree
}

/**
 * Place `errors` at the relative `path` inside `tree`, allocating
 * intermediate containers (numeric segments produce arrays) and
 * concatenating when multiple stores land at one path. `safeOwnRead` /
 * `safeAssign` keep a literal `__proto__` segment an own data property
 * with no route to `Object.prototype`.
 */
function placeAt(
  tree: Record<string, unknown> | unknown[],
  path: readonly Segment[],
  errors: readonly ValidationError[]
): void {
  if (path.length === 0) return
  let cursor: Record<string, unknown> | unknown[] = tree
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as Segment
    const nextSeg = path[i + 1] as Segment
    const key = typeof seg === 'number' ? String(seg) : seg
    const cursorRecord = cursor as Record<string, unknown>
    let child = safeOwnRead(cursorRecord, key)
    if (child === null || child === undefined || typeof child !== 'object') {
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

// ---------------------------------------------------------------------------
// form.fields
// ---------------------------------------------------------------------------

/**
 * The FieldState key set exposed at a field view. At a leaf path,
 * reads of these keys terminate against the per-path computed's
 * reactive prop; container paths do NOT inject them via dot access
 * (the container's rolled-up state is the call form). Shared with the
 * build-form-api meta forests.
 */
export const FIELD_STATE_KEYS: ReadonlySet<string> = new Set<keyof FieldState<unknown>>([
  'value',
  'original',
  'pristine',
  'dirty',
  'focused',
  'blurred',
  'touched',
  'interacted',
  'blurredAfterInteraction',
  'connected',
  'element',
  'elements',
  'updatedAt',
  'errors',
  'ownErrors',
  'validating',
  'valid',
  'transforming',
  'busy',
  'transformError',
  'displayState',
  'showErrors',
  'showPending',
  'showSuccess',
  'showIdle',
  'firstError',
  'firstOwnError',
  'path',
  'id',
  'aria',
  'key',
  'blank',
  'disabled',
  'label',
  'description',
  'placeholder',
  'meta',
])

/**
 * Build the `form.fields` surface over an existing field-state
 * accessor (the same memoised accessor build-form-api threads into
 * `meta` and register, so every consumer of a path shares one
 * computed). Dot descent terminates at schema leaves with a cached
 * field VIEW proxy; the call form resolves the same per-path view for
 * ANY schema-declared path (a container view carries the rollup), and
 * `undefined` for paths the schema doesn't have.
 */
export function buildFieldsSurface<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  getFieldStateAt: (path: Path) => ComputedRef<FieldState<unknown>>
): CallableSurface {
  const snapshotAt = (segments: readonly Segment[]): Record<string, unknown> => {
    const view = getFieldStateAt(segments as Path).value as unknown as Record<string, unknown>
    const snapshot: Record<string, unknown> = {}
    for (const k of FIELD_STATE_KEYS) snapshot[k] = view[k]
    return snapshot
  }

  // Per-path field-view cache: `form.fields.email` and
  // `form.fields('email')` resolve one identity-stable view per
  // canonical path.
  const viewCache = new Map<string, CallableSurface>()
  function viewAt(segments: readonly Segment[]): CallableSurface {
    const cacheKey = JSON.stringify(segments)
    const existing = viewCache.get(cacheKey)
    if (existing !== undefined) return existing
    const { toString, valueOf, toJSON, toPrimitive } = makeReadonlyCoercion(() =>
      snapshotAt(segments)
    )
    const target = {} as unknown as CallableSurface
    const proxy = new Proxy(target, {
      get(_, key: string | symbol): unknown {
        if (typeof key === 'symbol') {
          if (key === Symbol.toPrimitive) return toPrimitive
          return Reflect.get(target, key)
        }
        if (key === 'toJSON') return toJSON
        if (key === 'toString') return toString
        if (key === 'valueOf') return valueOf
        if (key === 'hasOwnProperty') return Object.prototype.hasOwnProperty
        if (FIELD_STATE_KEYS.has(key)) {
          const view = getFieldStateAt(segments as Path)
          return (view.value as unknown as Record<string, unknown>)[key]
        }
        return undefined
      },
      has(_, key: string | symbol): boolean {
        if (typeof key === 'symbol') return Reflect.has(target, key)
        return true
      },
      ownKeys: () => Array.from(FIELD_STATE_KEYS),
      getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
        if (typeof key !== 'string') return undefined
        if (!FIELD_STATE_KEYS.has(key)) return undefined
        const view = getFieldStateAt(segments as Path)
        return {
          configurable: true,
          enumerable: true,
          value: (view.value as unknown as Record<string, unknown>)[key],
          writable: false,
        }
      },
      set: (_, key) => {
        warnReadOnly('form.fields.<field>', 'write', key)
        return true
      },
      deleteProperty: (_, key) => {
        warnReadOnly('form.fields.<field>', 'delete', key)
        return true
      },
      defineProperty: (_, key) => {
        warnReadOnly('form.fields.<field>', 'define', key)
        return true
      },
    })
    viewCache.set(cacheKey, proxy)
    return proxy
  }

  return buildTree({
    schema: state.schema,
    leaf: (segs) => viewAt(segs),
    isTerminal: () => false,
    materialize: (segments) => materializeFields(state, segments, snapshotAt),
    ownKeys: (segments) => liveKeysAtPath(state, segments),
    hasOwn: (segments, key) => liveContainerHasKey(state, segments, key),
    isArrayAt: (segments) => isArrayPath(state, segments),
    // Any schema-declared path resolves a view (a leaf's own state, a
    // container's rollup); a path the schema doesn't have is a typo and
    // reads `undefined`. The root (`fields()`) is always declared.
    call: (path) =>
      state.schema.getSlimPrimitiveTypesAtPath(path).size > 0 ? viewAt(path) : undefined,
    surface: 'form.fields',
  })
}

/**
 * Dense `FieldState`-snapshot tree at `containerSegments` for
 * `JSON.stringify(form.fields.<container>)`: walks the live form value
 * and snapshots every schema-leaf descendant; containers recurse;
 * arrays produce arrays; a container with no live value surfaces that
 * value (`null` / `undefined`) so "never populated" stays
 * distinguishable from "empty". Schema-leaf wins over data shape.
 */
function materializeFields<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  containerSegments: readonly Segment[],
  snapshotAt: (segments: readonly Segment[]) => Record<string, unknown>
): unknown {
  const walk = (value: unknown, basePath: readonly Segment[]): unknown => {
    if (state.schema.isLeafAtPath(basePath as Path)) return snapshotAt(basePath)
    if (value === null || value === undefined) return value
    if (typeof value !== 'object') return value
    if (Array.isArray(value)) {
      return value.map((child, i) => walk(child, [...basePath, i]))
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = walk((value as Record<string, unknown>)[key], [...basePath, key])
    }
    return result
  }
  return walk(getAtPath(state.form.value, containerSegments), containerSegments)
}

// ---------------------------------------------------------------------------
// form.values
// ---------------------------------------------------------------------------

/**
 * Materialise the reactive form value into a plain (proxy-free) tree
 * for faithful serialisation: `safeOwnRead` recovers data fields whose
 * names Vue shims on reactive proxies (`hasOwnProperty`), and the
 * rebuild via `safeAssign` keeps a literal `__proto__` key an own data
 * property. Every descent reads THROUGH the reactive proxy, so the
 * serialising effect re-runs on writes. Non-plain objects (Date, File,
 * Map, class instances) unwrap via `toRaw` and serialise themselves.
 */
function materializeFormValue(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    const out: unknown[] = new Array(node.length)
    for (let i = 0; i < node.length; i++) out[i] = materializeFormValue(node[i])
    return out
  }
  if (!isPlainRecord(node)) return toRaw(node)
  const rec = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rec)) {
    safeAssign(out, key, materializeFormValue(safeOwnRead(rec, key)))
  }
  return out
}

/**
 * Build the `form.values` surface: a thin callable over Vue's native
 * `readonly` proxy. Dot reads delegate to the readonly proxy (per-key
 * dependency tracking lands in the consumer's effect); the call form
 * walks a path via `getAtPath`; coercion serialises through
 * `materializeFormValue`; enumeration reflects the readonly proxy;
 * writes are warn-and-noop. The wrapping computed re-mints the inner
 * readonly proxy on whole-form swaps while the callable stays
 * identity-stable.
 */
export function buildValuesSurface<F extends GenericForm>(form: Ref<F>): CallableSurface {
  const inner = computed(() => readonly(form.value))
  const { toString, valueOf, toJSON, toPrimitive } = makeReadonlyCoercion(() =>
    materializeFormValue(inner.value)
  )
  const target = (() => {}) as unknown as CallableSurface

  return new Proxy(target, {
    apply(_, __, args: unknown[]): unknown {
      const arg = args[0] as string | Path | undefined
      if (arg === undefined) return inner.value
      return getAtPath(inner.value, canonicalizePath(arg).segments)
    },
    get(_, key: string | symbol): unknown {
      if (typeof key === 'symbol') {
        if (key === Symbol.toPrimitive) return toPrimitive
        return Reflect.get(target, key)
      }
      if (key === 'toJSON') return toJSON
      if (key === 'toString') return toString
      if (key === 'valueOf') return valueOf
      // Prototype-shadowed names read off the RAW target so a data
      // field by that name returns its stored value while the real
      // inherited member resolves otherwise (dodges Vue's
      // `hasOwnProperty` shim). Ordinary keys read through the
      // readonly proxy for per-key tracking.
      return isShadowedKey(key)
        ? (toRaw(inner.value) as Record<string, unknown>)[key]
        : (inner.value as Record<string, unknown>)[key]
    },
    has(_, key: string | symbol): boolean {
      if (typeof key === 'symbol') return Reflect.has(target, key)
      return Reflect.has(inner.value as object, key)
    },
    ownKeys: () => Reflect.ownKeys(inner.value as object) as string[],
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (typeof key !== 'string') return undefined
      const desc = Reflect.getOwnPropertyDescriptor(inner.value as object, key)
      if (desc !== undefined) desc.configurable = true
      return desc
    },
    set: (_, key) => {
      warnReadOnly('form.values', 'write', key)
      return true
    },
    deleteProperty: (_, key) => {
      warnReadOnly('form.values', 'delete', key)
      return true
    },
    defineProperty: (_, key) => {
      warnReadOnly('form.values', 'define', key)
      return true
    },
  })
}
