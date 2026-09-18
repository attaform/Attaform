/**
 * Path primitives for advanced integrations. Attaform accepts a
 * dotted-string path (`'user.email'`) at every public API; these
 * primitives are exposed for an adapter author who needs to canonicalise
 * a user-provided one.
 */
import { __DEV__ } from './dev'
import { InvalidPathError } from './errors'

declare const pathKeyBrand: unique symbol

/**
 * Branded string identifier for a canonicalised path, and a useful `Map`
 * key: two paths resolving to the same canonical form produce the same
 * `PathKey`. Treat it as opaque and do not parse it.
 */
export type PathKey = string & { readonly [pathKeyBrand]: 'PathKey' }

/** A single path segment: a property name, or an array index. */
export type Segment = string | number
/** A structured path as a read-only sequence of segments. */
export type Path = readonly Segment[]

/** Tests an integer-like string without leading zeros. `'0'` | `'1'` | `'42'` pass; `'01'`, `'-1'`, `'1.5'` do not. */
const INTEGER_SEGMENT = /^(?:0|[1-9]\d*)$/

/**
 * The synthetic segment that asks a `z.set` what its members look
 * like.
 *
 * A set's members are not addressable, a member being its own key, so no
 * address survives a write to one. The coercion layer still has to know a
 * member's type before it can coerce one, and it asks by resolving this
 * segment under the set's path.
 *
 * The segment MUST stay inside the reserved `__atta:` namespace (see
 * `RESERVED_KEY_PREFIX`) so no consumer path can spell it. A plain index
 * in this role makes `tags.0` resolve in the schema, appear on
 * `form.fields` as a dead node, and clear the write gate, where the
 * numeric rebuild turns a `Set` of three into an `Array` of one (#614).
 */
export const SET_MEMBER_SEGMENT = '__atta:member'

/**
 * A map's keys as path segments, or `null` when any of them is a key
 * no segment can spell (an object, a symbol).
 *
 * `null` means the map has NO addressable entries, not that one of
 * them is missing: half-addressing a map would let `form.fields`
 * enumerate the spellable entries while the diff, which cannot file a
 * patch for the rest, treats the whole map as one value. The two
 * answers have to agree, so an unspellable key makes the map whole.
 * `entryKeyKindAtPath` reports `undefined` for the same map.
 */
export function mapSegmentKeys(value: ReadonlyMap<unknown, unknown>): Segment[] | null {
  const keys: Segment[] = []
  for (const key of value.keys()) {
    if (typeof key === 'string') keys.push(key)
    else if (typeof key === 'number' && Number.isInteger(key) && key >= 0) keys.push(key)
    else return null
  }
  return keys
}

function normalizeSegment(raw: Segment): Segment {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new InvalidPathError(
        __DEV__
          ? `Path segments must be non-negative integers when numeric; got ${String(raw)}`
          : `[attaform] AF08 attaform.dev/e/af08 ${String(raw)}`
      )
    }
    return raw
  }
  // Integer-looking strings normalise to numbers, so dotted-form
  // `'items.0.name'` and array-form `['items', 0, 'name']` yield one
  // canonical path and one PathKey.
  if (INTEGER_SEGMENT.test(raw)) return Number(raw)
  return raw
}

/**
 * Parse a dotted-string path into structured segments.
 *
 * ```ts
 * parseDottedPath('user.address.line1')   // ['user', 'address', 'line1']
 * parseDottedPath('items.0.name')         // ['items', 0, 'name']
 * parseDottedPath('')                     // ['']  (the empty-string key)
 * ```
 *
 * The empty-string input `''` is the **literal empty-key path** `['']`,
 * an ordinary (if rare) field address, not the root. Use the array
 * form `[]` for the root. Form-level errors (root `.refine()`,
 * `setErrors` with no path) live at the root path `[]` and are read via
 * `errors([])`, never `errors('')`.
 *
 * Throws `InvalidPathError` for paths with empty INTERNAL segments
 * (`'a..b'`, leading or trailing dots). For keys containing literal
 * dots, pass an array form (`['user.name']`) instead.
 */
export function parseDottedPath(path: string): Segment[] {
  if (path.length === 0) return ['']
  const rawSegments = path.split('.')
  const segments: Segment[] = []
  for (const raw of rawSegments) {
    if (raw.length === 0) {
      throw new InvalidPathError(
        __DEV__
          ? `Path '${path}' has an empty segment; use the array form for empty keys.`
          : `[attaform] AF09 attaform.dev/e/af09 '${path}'`
      )
    }
    segments.push(normalizeSegment(raw))
  }
  return segments
}

/**
 * Bounded FIFO cache for `canonicalizePath` on dotted-string inputs. A
 * real form re-canonicalises a small working set thousands of times a
 * session (every keystroke on a registered field, every validate, every
 * getValue), so a small cache amortises the parse and stringify across
 * repeats without pinning memory as an app accumulates fields.
 *
 * Eviction is FIFO, oldest insertion first, not LRU. 128 entries is
 * generous against a typical working set (the playground holds ~15 paths,
 * the whole test suite 45 unique register patterns), so overflow does not
 * fire in practice, and when it does the re-canonicalisation is still
 * O(segments) and lands back in the cache. Bumping recency per hit
 * (`delete` + `set`) would cost two Map operations in the hottest
 * read-side loop in Attaform for no observable benefit at this cap.
 *
 * Array inputs are not cached. The runtime's callers (unset-walker's
 * recursive `[...segments, i]`, the devtools inspector's
 * `payload.path.slice(...)`) pass a freshly allocated array per call, so a
 * WeakMap-keyed cache would miss every time and still pay lookup-then-set.
 */
const CANONICAL_STRING_CACHE_MAX = 128
const canonicalStringCache = new Map<string, { segments: readonly Segment[]; key: PathKey }>()

/**
 * Inverse cache: PathKey → segments. Populated by `canonicalizePath`
 * (string and array branches) so any consumer holding a PathKey
 * produced through the canonical pipeline can recover its structured
 * segments without `JSON.parse`. Callers reach this through
 * `segmentsForPathKey` below.
 *
 * Every store-side structure keyed by PathKey (the form-store error maps,
 * the blank-paths set, the variant-memory map) sources its keys from
 * `canonicalizePath`, so reads are dominantly cache hits. A cold key, one
 * round-tripped through an SSR payload, pays a single `JSON.parse` on
 * first lookup and then warms the cache.
 *
 * Bounded FIFO at 4096 entries: generous against a typical working set of
 * tens to hundreds of paths per form, small enough that a long-running
 * multi-form app accumulates no unbounded references. Eviction fires only
 * on a net-new entry, an idempotent overwrite (same key, same segments)
 * counting toward nothing.
 */
const PATHKEY_TO_SEGMENTS_MAX = 4096
const pathKeyToSegments = new Map<PathKey, readonly Segment[]>()

function rememberSegmentsForPathKey(key: PathKey, segments: readonly Segment[]): void {
  if (!pathKeyToSegments.has(key) && pathKeyToSegments.size >= PATHKEY_TO_SEGMENTS_MAX) {
    const oldest = pathKeyToSegments.keys().next().value
    if (oldest !== undefined) pathKeyToSegments.delete(oldest)
  }
  pathKeyToSegments.set(key, segments)
}

/**
 * Recover the structured `Segment[]` for a `PathKey` that
 * `canonicalizePath` produced. O(1) on a cache hit; a cold key falls back
 * to `JSON.parse(key)` plus segment normalization and then warms the
 * cache.
 *
 * Returns `null` for a malformed PathKey: non-JSON, non-array, or holding
 * something other than strings and numbers. A key from `canonicalizePath`
 * never trips it, so the realistic sources are a corrupt SSR payload and
 * a test fixture crafting raw strings.
 */
export function segmentsForPathKey(key: PathKey): readonly Segment[] | null {
  const cached = pathKeyToSegments.get(key)
  if (cached !== undefined) return cached
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const segments: Segment[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null
    segments.push(normalizeSegment(raw))
  }
  rememberSegmentsForPathKey(key, segments)
  return segments
}

/**
 * Canonicalise a path into structured segments plus a stable string
 * key. Accepts either dotted-string or array form; integer-looking
 * segments normalise to numbers.
 *
 * ```ts
 * canonicalizePath('items.0.name')
 * // { segments: ['items', 0, 'name'], key: '["items",0,"name"]' as PathKey }
 *
 * canonicalizePath(['items', 0, 'name'])
 * // → same result
 * ```
 *
 * The returned `key` works as a `Map` or `Set` key: equal paths produce
 * equal keys whichever input form they arrived in.
 */
export function canonicalizePath(input: string | Path): {
  segments: readonly Segment[]
  key: PathKey
} {
  if (typeof input === 'string') {
    const cached = canonicalStringCache.get(input)
    if (cached !== undefined) return cached
    // `parseDottedPath` normalises each segment already, so no second
    // `.map(normalizeSegment)` pass is needed.
    const segments: readonly Segment[] = parseDottedPath(input)
    const key = JSON.stringify(segments) as PathKey
    const entry = { segments, key }
    if (canonicalStringCache.size >= CANONICAL_STRING_CACHE_MAX) {
      const oldest = canonicalStringCache.keys().next().value
      if (oldest !== undefined) canonicalStringCache.delete(oldest)
    }
    canonicalStringCache.set(input, entry)
    rememberSegmentsForPathKey(key, segments)
    return entry
  }
  return keyForSegments(input)
}

/**
 * Canonical `{ segments, key }` for an already-array path: normalise each
 * segment (integer-looking → number) and mint the stable `JSON.stringify`
 * key, which is exactly what [[canonicalizePath]]'s array branch does, by
 * delegating here. It is separate so a hot caller already holding a
 * segment array, the container field-state leaf walk, can mint a `PathKey`
 * matching the one `originals` was seeded with WITHOUT routing through
 * `canonicalizePath`, whose per-read call count a meta-budget test gate
 * watches.
 */
export function keyForSegments(input: Path): {
  segments: readonly Segment[]
  key: PathKey
} {
  const segments = Array.from(input).map(normalizeSegment)
  const key = JSON.stringify(segments) as PathKey
  rememberSegmentsForPathKey(key, segments)
  return { segments, key }
}

/**
 * Render a segment array as a dotted path string in Attaform's public path
 * notation (`'user.email'`, `'items.0.name'`). The inverse of
 * [[parseDottedPath]] for the common case: a segment carrying a literal
 * dot, a leading zero or an array-index bracket round-trips ambiguously
 * and should not reach this helper.
 *
 * Used where internal `PathKey` storage surfaces to consumers, on the
 * `form.blankPaths` view and in the SSR snapshot.
 */
function segmentsToDotted(segments: Path): string {
  return segments.join('.')
}

/**
 * Resolve a `PathKey` back to its dotted public form, `null` for a
 * malformed key as [[segmentsForPathKey]] does. The common path is a cache
 * hit on `pathKeyToSegments` plus one `join('.')`.
 */
export function pathKeyToDotted(key: PathKey): string | null {
  const segments = segmentsForPathKey(key)
  if (segments === null) return null
  return segmentsToDotted(segments)
}

/**
 * The root path, an empty segment tuple. Pass it to any API taking a
 * `Path` to address the form value whole. It is also where form-level
 * errors live: a root `.refine()` message, a hydration failure, and a
 * `setErrors` entry with no path all land at `[]`. The aggregate reads
 * (`errors()`, `errors([])`, `meta.errors`) surface them alongside field
 * errors, and `meta.ownErrors` returns the root bucket alone.
 *
 * The empty SEGMENT tuple `[]` is structurally unconstructible as a field
 * path, so it can never collide with a schema key. The empty STRING key
 * `''` (path `['']`, key `'[""]'`) is an ordinary field address.
 */
export const ROOT_PATH: Path = Object.freeze([])
/** Stable string key for the root path. */
export const ROOT_PATH_KEY = '[]' as PathKey

/**
 * `true` when `path` starts with every segment of `prefix`, in order. The
 * empty `prefix` matches every path, the ROOT prefix being universal.
 *
 * Walks segments rather than `PathKey` strings because the data it
 * operates on (`meta.errors[].path`, for one) carries segment arrays
 * directly.
 *
 * ```ts
 * isPathPrefix(['cargo'], ['cargo', 'items', 0, 'sku'])  // true
 * isPathPrefix(['cargo', 'items'], ['cargo'])             // false (path shorter)
 * isPathPrefix([], ['anything'])                          // true (root prefix)
 * ```
 */
export function isPathPrefix(prefix: readonly Segment[], path: readonly Segment[]): boolean {
  if (path.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false
  }
  return true
}

/**
 * `true` when two paths are structurally equal: same length, identical
 * segments in order. Numeric and string segments compare with `!==`, so
 * `0` and `'0'` are NOT equal. Pass canonicalised paths, with
 * integer-looking segments normalised to numbers, as [[canonicalizePath]]
 * and the diff walker both do.
 *
 * ```ts
 * pathsEqual(['rows', 0], ['rows', 0])   // true
 * pathsEqual(['rows'], ['rows', 0])      // false (different length)
 * pathsEqual(['rows', 0], ['rows', '0']) // false (segment types differ)
 * ```
 */
export function pathsEqual(a: readonly Segment[], b: readonly Segment[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
