import type { AbstractSchema } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import { canonicalizePath, type Path, type PathKey, type Segment } from './paths'
import { safeAssign } from './safe-assign'
import { isUnset } from './unset'

/**
 * Walk a defaults / setValue / reset payload depth-first and produce
 * the cleaned-up storage tree plus the set of paths to mark as blank.
 * Used at three boundaries:
 *
 *   - `useAbstractForm` construction (defaultValues pre-pass)
 *   - `setValue(path, unset)` translation
 *   - `reset(nextDefaultValues)` translation
 *
 * `blank` is the runtime's bookkeeping for **storage / display
 * divergence** — see `docs/validation/blank.md` for the concept. Two sources of
 * marks, gated by that purpose:
 *
 *   1. **Explicit `unset` (any position)** — the consumer wrote
 *      `unset` at a primitive leaf OR a container
 *      (`defaultValues: { count: unset }` /
 *      `defaultValues: { profile: unset }` / `setValue('cargo', unset)`).
 *      At a primitive leaf, the sentinel is replaced with the schema's
 *      slim default and the leaf path is marked. At a container, the
 *      walker recurses through the schema's slim subtree and marks
 *      every primitive descendant — `expandUnsetAt` handles the
 *      recursion, re-checking `getUnionDiscriminatorAtPath` at every
 *      level so nested discriminated unions stub out as
 *      `{ <discKey>: <kind-blank> }` rather than over-marking the
 *      first variant's body.
 *
 *   2. **Unspecified numeric leaf (auto-mark)** — the consumer's
 *      payload is partial (or omitted entirely) and the schema has a
 *      `number` / `bigint` leaf the consumer did not cover. The slim
 *      default (`0` / `0n`) lands in storage and the path is
 *      auto-marked. Rationale: numeric storage forces a value (`0`,
 *      `0n`) that the DOM input represents as `''` — the runtime
 *      can't tell "user typed 0" from "user supplied nothing" without
 *      this side-channel. Strings and booleans are NOT auto-marked:
 *      their slim defaults (`''` / `false`) match what the DOM shows
 *      natively, so there's no divergence to record. Adding an
 *      auto-mark for those types would be the library second-
 *      guessing the schema's accepted-empty verdict, which is the
 *      schema author's call to express via `.min(1)` /
 *      `z.literal(true)` / refinements.
 *
 * Recurses into plain objects, arrays, and tuples; non-recursable
 * containers (`Date`, `RegExp`, `Map`, `Set`, functions) pass through
 * unchanged. Arrays / tuples / records under explicit `unset` write
 * the falsy concrete (`[]` / slim tuple / `{}`) with no per-element
 * marks — per-element opt-in via the existing `[unset, unset]`
 * syntax still works.
 */
export function walkUnsetSentinels<T>(
  values: T,
  schema: AbstractSchema<GenericForm, GenericForm>
): { cleanedValues: T; paths: PathKey[] } {
  const paths: PathKey[] = []
  // No defaults supplied — auto-mark every primitive leaf reachable
  // from the schema's slim root default. cleanedValues stays `undefined`
  // to preserve createFormStore's existing "no user defaults" code path.
  if (values === undefined) {
    const rootSlim = schema.getDefaultAtPath([])
    walkUnspecified(rootSlim, [], paths)
    return { cleanedValues: undefined as unknown as T, paths }
  }
  const cleaned = walkCore(values as unknown, [], schema, paths, true)
  return { cleanedValues: cleaned as T, paths }
}

/**
 * `true` for the non-recursable container kinds (`Date`, `RegExp`,
 * `Map`, `Set`, functions) the walkers treat as opaque leaf values:
 * passed through unchanged rather than descended into.
 */
function isOpaqueLeaf(value: unknown): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    typeof value === 'function'
  )
}

/**
 * Shared depth-first walker behind both unset-walker entry points.
 * `synthesizeSchemaKeys` selects the boundary:
 *
 *   - `true` (construction-time `walkUnsetSentinels`): an unspecified key
 *     falls through to `walkUnspecified` on the schema's slim default so
 *     numeric leaves auto-mark, and object paths also synthesize
 *     schema-only keys so a partially-supplied object still marks the
 *     leaves it omitted. An explicit consumer `undefined` at a key is
 *     preserved rather than filled.
 *   - `false` (setValue-time `substituteUnsetSentinels`): the caller's
 *     shape is authoritative — no auto-marking, no schema-only key
 *     synthesis. `undefined` / `null` pass through untouched.
 *
 * Reference-stable in both modes: a subtree with no substitution /
 * synthesis returns its original `input` reference so deep watchers on
 * untouched peers stay quiet (a watcher that writes back to the form on
 * an identity-changed peer would otherwise loop forever).
 */
function walkCore(
  input: unknown,
  segments: Segment[],
  schema: AbstractSchema<GenericForm, GenericForm>,
  paths: PathKey[],
  synthesizeSchemaKeys: boolean
): unknown {
  if (isUnset(input)) {
    return expandUnsetAt(segments, schema, paths)
  }
  // Unspecified key. In synthesize mode, fall through to walkUnspecified
  // on the schema's slim default so primitive leaves get marked;
  // otherwise the caller's `undefined` is authoritative and passes through.
  if (input === undefined) {
    if (synthesizeSchemaKeys) {
      const slim = schema.getDefaultAtPath(segments)
      return walkUnspecified(slim, segments, paths)
    }
    return input
  }
  // Explicit null is the user's choice, not absence — pass through.
  if (input === null) return null
  if (isOpaqueLeaf(input)) return input
  if (Array.isArray(input)) {
    const out = new Array(input.length)
    let mutated = false
    for (let i = 0; i < input.length; i++) {
      const walked = walkCore(input[i], [...segments, i], schema, paths, synthesizeSchemaKeys)
      out[i] = walked
      if (walked !== input[i]) mutated = true
    }
    return mutated ? out : input
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const inputKeys = Object.keys(obj)
    // setValue boundary: iterate only consumer-supplied keys.
    // Construction boundary: ALSO synthesize schema-only keys so
    // unspecified primitive leaves auto-mark even inside a
    // partially-supplied object (e.g. `{ user: { name: 'a' } }` against a
    // `user.{name, age}` schema marks `user.age`).
    let keys: Iterable<string> = inputKeys
    let mutated = false
    let inputKeysSet: Set<string> | null = null
    if (synthesizeSchemaKeys) {
      inputKeysSet = new Set(inputKeys)
      const allKeys = new Set<string>(inputKeys)
      const slim = schema.getDefaultAtPath(segments)
      if (
        slim !== null &&
        slim !== undefined &&
        typeof slim === 'object' &&
        !Array.isArray(slim) &&
        !isOpaqueLeaf(slim)
      ) {
        for (const k of Object.keys(slim as object)) allKeys.add(k)
      }
      keys = allKeys
      mutated = allKeys.size !== inputKeys.length
    }
    // Container carries `Object.prototype` and writes route through
    // `safeAssign` so a consumer schema using a literal `__proto__`
    // key (unusual but legal) lands as an own data property here too.
    // Output stays structurally identical to `setAtPath`'s so a value
    // flowing through both surfaces the same shape.
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const orig = obj[key]
      // Construction boundary only: an explicit consumer-supplied
      // `undefined` at a key means the consumer named the slot empty.
      // Preserve the signal in storage instead of filling from the
      // schema's slim default — distinct semantics with distinct
      // implications for the schema-error filter (the path lands in
      // `authoredPaths` and validation runs against undefined).
      if (synthesizeSchemaKeys && orig === undefined && inputKeysSet?.has(key) === true) {
        safeAssign(out, key, undefined)
        mutated = true
        continue
      }
      const walked = walkCore(orig, [...segments, key], schema, paths, synthesizeSchemaKeys)
      safeAssign(out, key, walked)
      if (walked !== orig) mutated = true
    }
    return mutated ? out : input
  }
  return input
}

/**
 * Recurse into a schema slim-default subtree, auto-marking every
 * **numeric** primitive leaf encountered. Called from `walkCore` (in
 * synthesize mode) whenever the user's payload is missing at a path, and
 * from the top-level walker entry point when no defaults are supplied at
 * all. Strings,
 * booleans, and other non-numeric leaves are left unmarked — the
 * library only auto-marks where storage and display diverge, which
 * for slim primitives is exclusively `number` and `bigint`. See the
 * docblock on `walkUnsetSentinels` for the full rationale.
 *
 * Exported so the discriminated-union variant-switch reshape in
 * `create-form-store.ts` can re-mark numeric leaves of the newly
 * activated variant after replacing the union's parent storage.
 */
export function walkUnspecified(slim: unknown, segments: Segment[], paths: PathKey[]): unknown {
  if (isPrimitiveOrEmpty(slim)) {
    if (isSlimNumericPrimitive(slim)) {
      paths.push(canonicalizePath(segments).key)
    }
    return slim
  }
  if (isOpaqueLeaf(slim)) {
    return slim
  }
  // Arrays: pass through without recursion. Elements are runtime-added;
  // tuple-shaped fixed arrays opt-in via explicit per-element `unset`.
  if (Array.isArray(slim)) return slim
  if (slim !== null && typeof slim === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(slim as object)) {
      safeAssign(
        out,
        key,
        walkUnspecified((slim as Record<string, unknown>)[key], [...segments, key], paths)
      )
    }
    return out
  }
  return slim
}

/**
 * Substitute every `unset` sentinel inside `value` with the schema's
 * slim default at its absolute path (rooted at `prefix`), returning
 * the cleaned value plus the absolute paths where substitutions
 * happened.
 *
 * Trust-the-caller cousin of `walkUnsetSentinels`. Differs in two
 * ways tuned for the `setValue(path, value)` runtime boundary:
 *
 *   1. No auto-marking of unspecified primitive leaves. The caller's
 *      shape is authoritative — we don't synthesize blanks for keys
 *      they didn't supply. (The discriminated-union variant reshape
 *      in `create-form-store.ts` handles numeric auto-marks for the
 *      activated variant separately.)
 *   2. No schema-only key synthesis at object paths. For Case B
 *      whole-union writes (`setValue('cargo', { type: 'oversized', … })`),
 *      `schema.getDefaultAtPath(['cargo'])` returns the FIRST union
 *      variant's default — synthesizing those keys would smuggle the
 *      FIRST variant's leaves into the activated variant. The variant
 *      reshape clears them via the matched `getVariantDefault`; we
 *      must not put them back.
 *
 * Reference-stable: subtrees with no substitutions return their
 * original input reference, so a watcher on `form.values.<peer>`
 * stays quiet when the consumer's write didn't touch that peer.
 */
export function substituteUnsetSentinels<T>(
  value: T,
  prefix: Path,
  schema: AbstractSchema<GenericForm, GenericForm>
): { cleanedValues: T; paths: PathKey[] } {
  const paths: PathKey[] = []
  const cleaned = walkCore(value as unknown, [...prefix], schema, paths, false)
  return { cleanedValues: cleaned as T, paths }
}

function isPrimitiveOrEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  const t = typeof value
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint'
}

/**
 * `true` when `value` is the slim numeric primitive (`0` or `0n`).
 * Auto-mark fires here and ONLY here: a `<input type="number">`
 * can't render `0` as anything other than `"0"`, so the runtime
 * records "storage holds the slim, display blank" to distinguish
 * "user supplied nothing" from "user typed 0." Other numeric values
 * (`10`, `42`, the schema's `.default(N)` for N ≠ 0) have no
 * divergence — the input renders them natively — so they MUST NOT
 * auto-mark; doing so would force the schema author's prefill to
 * silently disappear from the rendered field even though storage
 * holds the declared value. Strings (`''` storage = `''` display),
 * booleans (`false` storage = unchecked display), null, and
 * undefined never auto-mark for the same reason: no divergence to
 * record.
 */
function isSlimNumericPrimitive(value: unknown): boolean {
  return value === 0 || value === 0n
}

/**
 * Return the kind-appropriate blank primitive for a slim-default value
 * sampled from the schema. `''` for strings, `0` for numbers, `0n` for
 * bigints, `false` for booleans, `null` for nullable wrappers, and
 * `undefined` for everything else (the wrapper-absent / opaque case).
 *
 * Used by the DU container branch in `expandUnsetAt` to write the
 * stub discriminator value AND by `setValue('cargo.kind', unset)`
 * (the discriminator-leaf direct case in `build-form-api.ts`) so
 * both paths land the same blank shape.
 */
export function blankForKind(slimDefault: unknown): unknown {
  if (typeof slimDefault === 'string') return ''
  if (typeof slimDefault === 'number') return 0
  if (typeof slimDefault === 'bigint') return 0n
  if (typeof slimDefault === 'boolean') return false
  if (slimDefault === null) return null
  return undefined
}

/**
 * Recursive translation of an explicit `unset` at `segments` into the
 * cleaned storage value plus the list of paths to mark blank. Used at
 * two callsites: the shared `walkCore` recursor (reached from both
 * `walkUnsetSentinels` and `substituteUnsetSentinels`), and the
 * `setValue(path, unset)` direct case in `build-form-api.ts`.
 *
 * Detection order, applied at every recursion level:
 *
 *   1. **Discriminated union at this path** — write the stub
 *      `{ <discKey>: blankForKind(discSlim) }` and mark only the
 *      discriminator path. No variant body. Checking the DU at every
 *      level (not just the entry) keeps nested unions clean: a root
 *      `defaultValues: unset` against a schema with nested DUs stubs
 *      each DU it encounters rather than recursing into a first
 *      variant's body.
 *
 *   2. **Primitive leaf or wrapper-absent (`undefined` / `null`)** —
 *      write the slim and mark the path. `getEmptyValueAtPath` returns
 *      `undefined` / `null` for `.optional()` / `.nullable()` wrappers,
 *      so wrapper-absent values flow through this branch naturally.
 *
 *   3. **Opaque non-recursable leaf (`Date`, `RegExp`, `Map`, `Set`,
 *      function)** — write the falsy concrete from the schema and
 *      mark the path. No recursion.
 *
 *   4. **Array / tuple / record** — write the schema's slim concrete
 *      (`[]` / slim tuple / `{}`) with no per-element marks.
 *      Per-element opt-in still works via the existing `[unset, …]`
 *      syntax handled by the surrounding `walkCore` recursion on
 *      non-unset inputs.
 *
 *   5. **Bare object** — recurse into every key via `expandUnsetAt` so
 *      DU detection re-applies at each child level.
 */
export function expandUnsetAt(
  segments: readonly Segment[],
  schema: AbstractSchema<GenericForm, GenericForm>,
  paths: PathKey[]
): unknown {
  const du = schema.getUnionDiscriminatorAtPath(segments)
  if (du !== undefined) {
    const discPath = [...segments, du.discriminatorKey]
    const discSlim = schema.getEmptyValueAtPath(discPath)
    paths.push(canonicalizePath(discPath).key)
    return { [du.discriminatorKey]: blankForKind(discSlim) }
  }

  const slim = schema.getEmptyValueAtPath(segments)

  if (isPrimitiveOrEmpty(slim)) {
    paths.push(canonicalizePath(segments).key)
    return slim
  }

  if (isOpaqueLeaf(slim)) {
    paths.push(canonicalizePath(segments).key)
    return slim
  }

  if (Array.isArray(slim)) return slim

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(slim as object)) {
    result[key] = expandUnsetAt([...segments, key], schema, paths)
  }
  return result
}
