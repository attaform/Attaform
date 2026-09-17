import { computed, readonly, toRaw, type ComputedRef, type Ref } from 'vue'
import type { ValidationError } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import type { DynamicPathSweep } from './dynamic-path-sweep'
import { makeBlankRequiredError } from './error-codes'
import { aggregateErrorsAt, type FieldState } from './field-state-api'
import { getAtPath, hasAtPath, isPlainRecord } from './path-walker'
import {
  type Path,
  type PathKey,
  ROOT_PATH_KEY,
  type Segment,
  canonicalizePath,
  isPathPrefix,
  keyForSegments,
} from './paths'
import { isArrayPath, liveContainerHasKey, liveKeysAtPath } from './proxy-live-keys'
import { makeReadonlyCoercion, warnReadOnly } from './proxy-readonly-helpers'
import { isShadowedKey, safeAssign, safeOwnRead } from './safe-assign'

/**
 * The callable-tree layer, building the three read surfaces (`form.values`,
 * `form.errors`, `form.fields`) as callable readonly Proxies. The two
 * schema-aware surfaces, errors and fields, share the node machinery; values is
 * a thin callable over Vue's native `readonly`.
 *
 * The surface contract, pinned in `surface-contract-pins.test.ts`:
 *
 * - Only the ROOT is callable, a function target with an `apply` trap. Every
 *   non-root container is a plain object or Array target, so calling a node
 *   throws like any non-function and `Array.isArray` holds on an array-shaped
 *   path, which is what puts Vue's `renderList` on its indexed branch.
 * - Truthful descend gate. A key that is neither a surface-declared terminal,
 *   nor a declared field of a FIXED object, nor a key the container currently
 *   holds reads `undefined`: no phantom nodes. Fixed-object gating matters
 *   because an open container's element schema matches ANY segment, so schema
 *   presence cannot arbitrate there and open containers rely on live keys.
 * - Live enumeration. `Object.keys`, spread and `v-for` reflect the live form
 *   data, and the errors surface unions in error-store keys so a server error
 *   at an unknown key stays enumerable.
 * - Coercion. `toJSON`, `toString`, `valueOf` and `Symbol.toPrimitive` resolve
 *   to the surface's materialiser at every node, so `JSON.stringify` and
 *   template interpolation never see a proxy.
 * - `form.values()` returns a detached snapshot rather than the live proxy,
 *   while dot access stays the reactive view. See `buildValuesSurface`.
 * - Writes warn and no-op at every node: a strict-mode caller must not throw,
 *   and the readonly contract is the absence of mutation.
 * - Per-path node memoisation keyed by canonical path AND live shape, so
 *   repeated reads return the same Proxy and a variant flip that swaps the
 *   shape at a path mints a freshly-targeted node.
 *
 * A schema field literally named after a built-in (`toString`, `valueOf`,
 * `hasOwnProperty`) is not reachable through dot access on these surfaces; the
 * call form addresses any path regardless of name. `call`, `apply` and `bind`
 * on the ROOT resolve invoke shims, because a transpiler that downlevels
 * optional chaining compiles the documented `surface(path)?.x` idiom into a
 * helper that reads `.call` off the surface and invokes it. Without the shim
 * that documented pattern throws under sucrase, the docs playground's
 * in-browser compiler, and under any sub-ES2020 build target. Below the root
 * the three names are ordinary keys through the truthful gate.
 */

/**
 * Tests an integer-like string without leading zeros; mirrors
 * `INTEGER_SEGMENT` in paths.ts so proxy descent produces the same
 * canonical segments as a dotted-string call.
 */
const INTEGER_SEGMENT = /^(?:0|[1-9]\d*)$/

/**
 * Marks a snapshot box whose payload a write has dropped. Distinct from
 * `undefined`, which is a legitimate materialised value for a form
 * whose root is absent.
 */
const RELEASED: unique symbol = Symbol()

/** Inert descent target for an invoke shim over a non-existent field. */
const EMPTY_DESCENT: Readonly<Record<string, never>> = Object.freeze({})

function keyToSegment(key: string): Segment {
  return INTEGER_SEGMENT.test(key) ? Number(key) : key
}

/**
 * Vue probes these reactivity sigils as string keys on any object it meets
 * inside an effect. `__v_skip` opts the proxy out of reactive wrapping, the
 * reads inside the traps doing the tracking; the rest must read `undefined`
 * rather than descending into phantom child nodes.
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
 * Callable shim returned for `call`, `apply` or `bind` read off a callable ROOT
 * surface. A transpiler that downlevels optional chaining, sucrase or any
 * bundler targeting below ES2020, compiles `surface(path)?.x` into a helper
 * that READS `.call` off the surface and invokes the result to call it. The
 * shim is invokable as the matching `Function.prototype` method against the
 * surface, so the downleveled call lands in the surface's `apply` trap, and it
 * forwards every other proxy operation to the descent value so a schema field
 * literally named `call` stays reachable through it. The descent resolves
 * lazily, so the common invoke-only path touches no child node.
 */
function callableInvokeShim(
  method: 'call' | 'apply' | 'bind',
  surface: CallableSurface,
  getDescent: () => unknown
): CallableSurface {
  const fnMethod = Reflect.get(Function.prototype, method) as (
    this: unknown,
    ...args: unknown[]
  ) => unknown
  return new Proxy((() => {}) as unknown as CallableSurface, {
    apply: (_target, _thisArg, args) => Reflect.apply(fnMethod, surface, args),
    get: (_target, key) => Reflect.get(getDescent() as object, key),
    has: (_target, key) => Reflect.has(getDescent() as object, key),
    ownKeys: () => Reflect.ownKeys(getDescent() as object),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(getDescent() as object, key)
      // The fresh arrow-function target owns no matching property, so a
      // descriptor forwarded from the descent must be reported
      // configurable to satisfy the Proxy own-property invariant.
      if (descriptor !== undefined) descriptor.configurable = true
      return descriptor
    },
  })
}

/**
 * Per-surface configuration for the shared schema-aware node builder. Every
 * hook is required: both surfaces supply all of them, so the trap layer carries
 * no fallback branches.
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
  /** Shared liveness sweep; this tree registers its caches into it. */
  readonly sweep: DynamicPathSweep
}

function buildTree(spec: TreeSpec): CallableSurface {
  const containerCache = new Map<string, CallableSurface>()
  // Per-path "schema has a field here" memo for the fixed-object gate.
  const existsCache = new Map<PathKey, boolean>()

  // Both grow one entry per path the surface has ever resolved, so both
  // are swept for paths the form no longer has (#617). The container
  // cache keys by path AND live shape, so an eviction drops both
  // variants; a key it never held is a no-op delete.
  spec.sweep.onEvict((key) => {
    containerCache.delete(`${key}+A`)
    containerCache.delete(`${key}+O`)
    existsCache.delete(key)
  })

  function schemaHasPath(segs: readonly Segment[]): boolean {
    // `keyToSegment` normalises an integer-looking key to a number exactly as
    // `normalizeSegment` does, so these segments are already canonical and the
    // bare stringify IS the `PathKey` the sweep evicts by. Spelling it that way
    // rather than routing through `canonicalizePath` keeps the descend gate,
    // which runs on every dot access, off a re-normalise it cannot need.
    const cacheKey = keyForSegments(segs).key
    const cached = existsCache.get(cacheKey)
    if (cached !== undefined) return cached
    const result = spec.schema.getSlimPrimitiveTypesAtPath(segs).size > 0
    existsCache.set(cacheKey, result)
    spec.sweep.track(segs as Path, cacheKey)
    return result
  }

  function descend(segs: readonly Segment[]): unknown {
    if (spec.schema.isLeafAtPath(segs)) return spec.leaf(segs)
    if (spec.isTerminal(segs)) return spec.leaf(segs)
    return containerAt(segs)
  }

  function containerAt(segments: readonly Segment[]): CallableSurface {
    // Shape participates in the cache key, so a variant switch that swaps the
    // live shape at this path mints a freshly-targeted proxy on the next read
    // while a flip and back returns the original. A held reference keeps its
    // minted target, proxy targets being immutable, but every trap re-evaluates
    // live state per call, so `held.length`, `Object.keys(held)` and descent
    // all track reality; only host-level checks stay pinned.
    const isArrayLike = spec.isArrayAt(segments)
    const pathKey = keyForSegments(segments).key
    const cacheKey = `${pathKey}+${isArrayLike ? 'A' : 'O'}`
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
        // `Array.prototype` pass-through for a non-integer key on an
        // array-shaped path (`.map`, `.forEach`, `.slice`). Those methods read
        // `this[i]` and `this.length` back through this trap, and a mutator is
        // reachable but the write traps no-op it.
        if (arrayNow && typeof keyToSegment(key) === 'string' && key in Array.prototype) {
          return Reflect.get(Array.prototype, key)
        }
        // Direct method-call coercion. A schema field with one of these names
        // is not dot-reachable; address it through the call form.
        if (key === 'toString') return containerToString
        if (key === 'valueOf') return containerValueOf
        // The real method, routed through this proxy's descriptor trap,
        // so `surface.hasOwnProperty(k)` agrees with `Object.keys`.
        if (key === 'hasOwnProperty') return Object.prototype.hasOwnProperty
        const childSegs = [...segments, keyToSegment(key)]
        // Root-only invoke shims: a downleveled `surface(path)?.x` reads
        // `.call` off the surface to invoke it. See `callableInvokeShim`. A
        // non-root node is not callable, so a nested `call` field keeps plain
        // gated descent.
        if (isRoot && (key === 'call' || key === 'apply' || key === 'bind')) {
          return callableInvokeShim(key, proxy, () => {
            if (
              spec.isTerminal(childSegs) ||
              (isFixedObject && schemaHasPath(childSegs)) ||
              spec.hasOwn(segments, key)
            ) {
              return descend(childSegs)
            }
            // No such field: the shim stays invokable and its field
            // reads resolve against an empty descent (never a throw).
            return EMPTY_DESCENT
          })
        }
        // Truthful descend gate; see the module docblock.
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
        // Conservatively true: whether a path resolves is the read's answer,
        // and it returns `undefined` past the gate.
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
    spec.sweep.track(segments as Path, pathKey)
    return proxy
  }

  return containerAt([])
}

// ---------------------------------------------------------------------------
// form.errors
// ---------------------------------------------------------------------------

/**
 * Build the `form.errors` surface. A leaf read merges the path's schema,
 * derived-blank and user buckets, applying the active-path filter to the
 * library-produced classes only. A trailing `''` is the container-self
 * sentinel, the call form aggregates a subtree, enumeration unions live form
 * keys with error-store keys, and `toJSON` materialises the sparse error tree
 * through a per-container memoised computed.
 */
export function buildErrorsSurface<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  sweep: DynamicPathSweep
): CallableSurface {
  // One lazily-allocated computed per materialised container path, so the
  // sparse tree rebuilds when a store or the form value changes rather than on
  // every stringify. Its deps are read inside the computed, so tracking is
  // unchanged.
  const treeCache = new Map<PathKey, ComputedRef<unknown>>()
  // Keyed per container path, so it is bounded by container count for a
  // fixed schema but not for a record of objects, where every entry is
  // its own container (#617).
  sweep.onEvict((key) => treeCache.delete(key))
  const materialize = (segments: readonly Segment[]): unknown => {
    const cacheKey = keyForSegments(segments).key
    let tree = treeCache.get(cacheKey)
    if (tree === undefined) {
      const frozen = [...segments]
      tree = computed(() => materializeErrors(state, frozen))
      treeCache.set(cacheKey, tree)
      sweep.track(segments as Path, cacheKey)
    }
    return tree.value
  }

  const resolveLeaf = (path: readonly Segment[]): ValidationError[] => {
    // A path of two segments or more ending in `''` is the container-self
    // sentinel: it surfaces errors stored at the parent container path, from a
    // cross-field refine or a server-side container mark, plus any literal-`''`
    // leaf errors. A bare `['']` is the literal root `''` field, read from its
    // own bucket. Global errors live at the root and come through
    // `meta.ownErrors`.
    const isContainerSelfAccess = path.length > 1 && path[path.length - 1] === ''

    const merged: ValidationError[] = []
    if (isContainerSelfAccess) {
      const containerPath = path.slice(0, -1)
      const container = canonicalizePath(containerPath)
      const literal = canonicalizePath(path)
      const active = hasAtPath(state.form.value, containerPath)
      collectErrorsAt(state, container.key, container.segments, active, merged)
      // Skip the literal lookup when canonical keys collide: the root
      // path resolves both to the same bucket and we'd double-count.
      if (literal.key !== container.key) {
        collectErrorsAt(state, literal.key, literal.segments, active, merged)
      }
      return merged
    }

    const { key, segments } = canonicalizePath(path)
    const active = hasAtPath(state.form.value, path)
    collectErrorsAt(state, key, segments, active, merged)
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
    // `errors()`, `errors([])` and `errors(path)` are all the subtree
    // aggregate, through the helper `meta.errors` reads, so they cannot
    // drift.
    call: (path) => aggregateErrorsAt(state, path, keyForSegments(path).key),
    surface: 'form.errors',
    sweep,
  })
}

/**
 * Append the three error lists at one path, in store order, applying the
 * active-path filter per class: a library verdict, schema or blank, stays
 * hidden at an unreachable path, while a consumer-supplied user entry surfaces
 * unconditionally.
 *
 * Blank is synthesized from this path's OWN membership rather than read out of
 * the whole-form `derivedBlankErrors` map, for the reason `aggregateErrorsAt`
 * gives: that map takes a fresh identity on ANY blank transition in the form,
 * so reading it here would give every materialised tree node a dependency on
 * every other path's blanks. Same builder and same gate, so the entry is
 * identical.
 *
 * One helper for all three `form.errors` readers, leaf resolution, container
 * key enumeration and tree materialisation, so the per-class filter cannot
 * drift between them.
 */
function collectErrorsAt<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  key: PathKey,
  segments: Path,
  active: boolean,
  into: ValidationError[]
): void {
  const cell = state.errorCells.get(key)
  if (active) {
    if (cell !== undefined) into.push(...cell.schema)
    if (state.blankPaths.has(key) && state.schema.isRequiredAtPath(segments)) {
      into.push(makeBlankRequiredError(segments))
    }
  }
  // User errors are consumer data (server replies, manual marks), never
  // silently dropped, even at unreachable paths.
  if (cell !== undefined) into.push(...cell.user)
}

/**
 * Container enumeration for `form.errors`: the union of the live form-data keys
 * at the path and the first-child segments of every error-store entry beneath
 * it. The active-path filter mirrors a leaf read, so a library-produced verdict
 * at an unreachable path stays hidden while a user-supplied entry surfaces. An
 * equal-length entry, the container's own bucket, contributes no child key, and
 * the two-class iteration preserves schema, blank, then user order.
 */
function errorAwareContainerKeys<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  segments: readonly Segment[]
): readonly string[] {
  const keys = new Set<string>(liveKeysAtPath(state, segments))
  const formValue = state.form.value
  // One scratch list reused across candidates: this only asks whether a
  // path contributes anything, never what.
  const errors: ValidationError[] = []
  const found: { readonly childKey: string; readonly ordinal: number }[] = []
  for (const { key, segments: decoded } of state.errorWindowAt(
    segments,
    keyForSegments(segments).key
  )) {
    // The window is a key-range superset, so membership is still decided
    // here. An equal-length entry is the container's own bucket (root
    // `[]` included) and contributes no child key.
    if (decoded.length <= segments.length) continue
    if (!isPathPrefix(segments, decoded)) continue
    errors.length = 0
    collectErrorsAt(state, key, decoded, hasAtPath(formValue, decoded), errors)
    if (errors.length === 0) continue
    const nextSeg = decoded[segments.length] as Segment
    found.push({
      childKey: typeof nextSeg === 'number' ? String(nextSeg) : nextSeg,
      ordinal: state.ensurePathOrdinal(key),
    })
  }
  // Error-only keys join in schema-declaration order, behind the live
  // data keys. The window is sorted by PATH, which is a different order,
  // so emitting straight from it would re-sort the enumeration.
  found.sort((a, b) => a.ordinal - b.ordinal)
  for (const { childKey } of found) keys.add(childKey)
  return [...keys]
}

/**
 * Build the sparse nested error tree under `containerSegments` for
 * `JSON.stringify(form.errors.<container>)`. Each entry at `fullPath` is
 * placed:
 *
 * - The root bucket, at the root materialisation, under the root-path key,
 *   never the `''` slot: `''` is a plain field key and conflating the two is a
 *   hard boundary. At a sub-container materialisation it is out of scope.
 * - The container-self bucket at the materialisation root, at `tree['']`.
 * - A schema-leaf descendant, at its relative path.
 * - A schema-container descendant, from a cross-field refine there, at
 *   `[...relativePath, '']`, so its self errors keep their own slot.
 * - An unknown path, a user error at a key the schema does not know, at its
 *   relative path as a leaf.
 *
 * Sparse: a container with neither self nor descendant errors does not appear.
 * The active-path filter matches a leaf read. The tree mirrors the live shape
 * at the root, an array container giving an array root, so shape parity with
 * `form.values` holds.
 */
function materializeErrors<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  containerSegments: readonly Segment[]
): Record<string, unknown> | unknown[] {
  const formValue = state.form.value
  const liveContainer = getAtPath(formValue, containerSegments)
  const tree: Record<string, unknown> | unknown[] = Array.isArray(liveContainer) ? [] : {}

  const placements: {
    readonly placePath: readonly Segment[]
    readonly errors: ValidationError[]
    readonly ordinal: number
  }[] = []

  for (const { key, segments: fullPath } of state.errorWindowAt(
    containerSegments,
    keyForSegments(containerSegments).key
  )) {
    // The root bucket, holding global and root-refine errors and `setErrors`
    // entries, is never variant-bound, so it is collected unfiltered and only
    // at the root materialisation. For everything else the window is a
    // key-range superset, so membership is decided here.
    const isRoot = fullPath.length === 0
    if (isRoot) {
      if (containerSegments.length !== 0) continue
    } else if (!isPathPrefix(containerSegments, fullPath)) {
      continue
    }

    const errors: ValidationError[] = []
    collectErrorsAt(state, key, fullPath, isRoot || hasAtPath(formValue, fullPath), errors)
    if (errors.length === 0) continue

    const relativePath = fullPath.slice(containerSegments.length)
    let placePath: readonly Segment[]
    if (isRoot) {
      placePath = [ROOT_PATH_KEY]
    } else if (relativePath.length === 0) {
      placePath = ['']
    } else if (state.schema.isLeafAtPath(fullPath)) {
      placePath = relativePath
    } else if (state.schema.getSlimPrimitiveTypesAtPath(fullPath).size > 0) {
      placePath = [...relativePath, '']
    } else {
      placePath = relativePath
    }

    placements.push({ placePath, errors, ordinal: state.ensurePathOrdinal(key) })
  }

  // Placed in schema-declaration ordinal order, which `meta.errors` and
  // `aggregateErrorsAt` already use, so every error surface agrees on key
  // order. The window is sorted by PATH, a different order, so placing straight
  // from it would re-sort the tree. Ordinals are also stable across an error
  // clearing and coming back, where the store's own insertion order is not.
  placements.sort((a, b) => a.ordinal - b.ordinal)
  for (const { placePath, errors } of placements) placeAt(tree, placePath, errors)
  return tree
}

/**
 * Place `errors` at the relative `path` inside `tree`, allocating intermediate
 * containers, where a numeric segment produces an array, and concatenating when
 * several stores land at one path. `safeOwnRead` and `safeAssign` keep a
 * literal `__proto__` segment an own data property with no route to
 * `Object.prototype`.
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
 * The FieldState key set exposed at a field view. At a leaf path a read of one
 * terminates against the per-path computed's reactive prop; a container path
 * does NOT inject them through dot access, its rolled-up state being the call
 * form. Shared with `build-form-api`'s meta surfaces.
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
 * Build the `form.fields` surface over an existing field-state accessor, the
 * same memoised one `build-form-api` threads into `meta` and register, so every
 * consumer of a path shares one computed. Dot descent terminates at a schema
 * leaf with a cached field VIEW proxy; the call form resolves that same
 * per-path view for ANY schema-declared path, a container view carrying the
 * rollup, and `undefined` for a path the schema does not have.
 */
export function buildFieldsSurface<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  getFieldStateAt: (path: Path) => ComputedRef<FieldState<unknown>>,
  sweep: DynamicPathSweep
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
  const viewCache = new Map<PathKey, CallableSurface>()
  // Identity stability is the contract, which is why only a path the form no
  // longer HAS may be dropped (#617). A dead path's view is unreachable through
  // this surface, and a consumer still holding one keeps reading correctly:
  // every trap re-resolves live state per hit rather than capturing anything.
  sweep.onEvict((key) => viewCache.delete(key))
  function viewAt(segments: readonly Segment[]): CallableSurface {
    const cacheKey = keyForSegments(segments).key
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
    sweep.track(segments as Path, cacheKey)
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
    sweep,
  })
}

/**
 * Dense `FieldState`-snapshot tree at `containerSegments` for
 * `JSON.stringify(form.fields.<container>)`. It walks the live form value and
 * snapshots every schema-leaf descendant, recursing through containers and
 * producing arrays for arrays. A container with no live value surfaces that
 * value, so "never populated" stays distinguishable from "empty", and a schema
 * leaf wins over the data shape.
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
 * Materialise the reactive form value into a plain, proxy-free tree for
 * faithful serialisation. `safeOwnRead` recovers a data field whose name Vue
 * shims on a reactive proxy, and the rebuild through `safeAssign` keeps a
 * literal `__proto__` key an own data property. Every descent reads THROUGH the
 * reactive proxy, so the serialising effect re-runs on writes. A non-plain
 * object (Date, File, Map, a class instance) unwraps through `toRaw` and
 * serialises itself.
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
 * Build the `form.values` surface: a thin callable over Vue's native `readonly`
 * proxy. Dot reads delegate to that proxy, so per-key dependency tracking lands
 * in the consumer's effect; enumeration reflects it; writes warn and no-op. The
 * wrapping computed re-mints the inner readonly proxy on a whole-form swap
 * while the callable stays identity-stable.
 *
 * The two read shapes answer different questions, and the split is the
 * documented contract:
 *
 * - `form.values.email` is the REACTIVE view: per-key tracking, no copying,
 *   always the live value.
 * - `form.values()` is a SNAPSHOT: a detached plain object, so a captured
 *   result keeps what it held at capture time as the form moves on.
 *
 * Returning the live readonly proxy from the call form instead makes every
 * documented use of it silently wrong: `api.save(form.values())` hands an async
 * call an object that keeps mutating underneath it,
 * `structuredClone(form.values())` throws on the proxy, and
 * `watch(() => form.values(), cb)` never fires, the identity never changing
 * (#567).
 *
 * Memoised through a computed rather than materialised per call. A deep walk of
 * the form is some 1400x the cost of handing back the proxy, a real regression
 * when the call sits in a render; behind a computed it is paid once per write
 * rather than once per call, and not at all until someone reads. Repeated calls
 * between writes measure at parity with returning the proxy.
 *
 * The copy is deep across the plain-data spine. A non-plain instance (Map, Set,
 * File, Date) passes through `toRaw` by reference, matching what `toJSON` does:
 * cloning a File would be expensive and wrong, identity being what an upload
 * needs. A caller wanting a fully detached copy can `structuredClone` the
 * result, which the live proxy never allowed.
 */
export function buildValuesSurface<F extends GenericForm>(
  form: Ref<F>,
  onFormChange: (listener: () => void) => () => void
): CallableSurface {
  const inner = computed(() => readonly(form.value))

  // The materialised copy lives in a box the computed hands back, so a write
  // can drop the payload while the computed still holds the box. Vue keeps a
  // computed's last value until something reads it again, which would leave the
  // previous snapshot pinning whatever the form used to hold. That is invisible
  // for the plain-data spine, which is a copy and is replaced, but not for the
  // instances materialise shares by reference: a cleared 50 MB File stays
  // reachable through the stale copy until the next read or teardown.
  let held: { value: unknown } | null = null
  const snapshot = computed(() => {
    const box = { value: materializeFormValue(inner.value) as unknown }
    held = box
    return box
  })
  onFormChange(() => {
    if (held === null) return
    held.value = RELEASED
    held = null
  })

  // Every write that releases also invalidates the computed, so a released box
  // is not reachable through this read. The branch guards that invariant rather
  // than being an expected path: degrade to a fresh materialisation, never
  // serve an emptied box.
  const readSnapshot = (): unknown => {
    const box = snapshot.value
    return box.value === RELEASED ? materializeFormValue(inner.value) : box.value
  }

  const { toString, valueOf, toJSON, toPrimitive } = makeReadonlyCoercion(() => readSnapshot())
  const target = (() => {}) as unknown as CallableSurface

  return new Proxy(target, {
    apply(_, __, args: unknown[]): unknown {
      const arg = args[0] as string | Path | undefined
      if (arg === undefined) return readSnapshot()
      const segments = canonicalizePath(arg).segments
      // A leaf needs no copy, so it walks the live tree and never builds the
      // root snapshot. A container resolves out of the memoised snapshot rather
      // than materialising per call: copying a subtree on every call measures
      // some 250x returning the proxy on a 27-row form, and hands back a fresh
      // object each time, so unchanged state compares unequal to itself.
      const node = getAtPath(inner.value, segments)
      if (node === null || typeof node !== 'object') return node
      return getAtPath(readSnapshot(), segments)
    },
    get(_, key: string | symbol): unknown {
      if (typeof key === 'symbol') {
        if (key === Symbol.toPrimitive) return toPrimitive
        return Reflect.get(target, key)
      }
      if (key === 'toJSON') return toJSON
      if (key === 'toString') return toString
      if (key === 'valueOf') return valueOf
      // A prototype-shadowed name reads off the RAW target, so a data field by
      // that name returns its stored value while the real inherited member
      // resolves otherwise, dodging Vue's `hasOwnProperty` shim. An ordinary
      // key reads through the readonly proxy for per-key tracking.
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
