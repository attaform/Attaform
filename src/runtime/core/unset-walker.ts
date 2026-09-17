import type { AbstractSchema } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import { canonicalizePath, type Path, type PathKey, type Segment } from './paths'
import { consumerKeys, readConsumerIndex, readConsumerProp } from './consumer-code'
import { isPlainRecord } from './path-walker'
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
 * divergence**; `docs/validation/blank.md` carries the concept. Two
 * sources of marks, both gated by that purpose:
 *
 *   1. **Explicit `unset`, at any position.** The consumer wrote `unset`
 *      at a primitive leaf or at a container
 *      (`defaultValues: { count: unset }`,
 *      `defaultValues: { profile: unset }`, `setValue('cargo', unset)`).
 *      At a primitive leaf the sentinel becomes the schema's slim default
 *      and the leaf path is marked. At a container the walker recurses
 *      through the schema's slim subtree and marks every primitive
 *      descendant: `expandUnsetAt` owns that recursion and re-checks
 *      `getUnionDiscriminatorAtPath` at every level, so a nested
 *      discriminated union stubs out as `{ <discKey>: <kind-blank> }`
 *      rather than over-marking the first variant's body.
 *
 *   2. **Unspecified numeric leaf, auto-marked.** The consumer's payload
 *      is partial or absent and the schema has a `number` / `bigint` leaf
 *      it does not cover. The slim default (`0` / `0n`) lands in storage
 *      and the path is auto-marked, because numeric storage forces a value
 *      the DOM input represents as `''` and without the side-channel the
 *      runtime cannot tell "user typed 0" from "user supplied nothing".
 *      Strings and booleans are NOT auto-marked: their slim defaults
 *      (`''` / `false`) are what the DOM shows natively, so there is no
 *      divergence to record, and marking them would be Attaform
 *      second-guessing the schema's accepted-empty verdict. That verdict
 *      is the schema author's to express, through `.min(1)`,
 *      `z.literal(true)` or a refinement.
 *
 * Recurses into plain objects, arrays and tuples, and carries a
 * non-recursable container (`Date`, `RegExp`, `Map`, `Set`, a function)
 * through unchanged. An array, tuple or record under an explicit `unset`
 * gets the falsy concrete (`[]`, the slim tuple, `{}`) and no per-element
 * marks; per-element opt-in is still `[unset, unset]`.
 */
export function walkUnsetSentinels<T>(
  values: T,
  schema: AbstractSchema<GenericForm, GenericForm>
): { cleanedValues: T; paths: PathKey[] } {
  const paths: PathKey[] = []
  // No defaults supplied: auto-mark every primitive leaf reachable from
  // the schema's slim root default. `cleanedValues` stays `undefined` so
  // createFormStore keeps taking its "no user defaults" path.
  if (values === undefined) {
    const rootSlim = schema.getDefaultAtPath([])
    walkUnspecified(rootSlim, [], paths)
    return { cleanedValues: undefined as unknown as T, paths }
  }
  const cleaned = walkCore(values as unknown, [], schema, paths, true)
  return { cleanedValues: cleaned as T, paths }
}

/**
 * `true` for a value the walkers descend into: a plain record or an
 * array. Everything else is carried through unchanged.
 *
 * It must stay a structural test, never a list of built-ins to skip. A
 * list (`Date | RegExp | Map | Set | function`) flattens everything it was
 * not told about: a `File`, a `Blob`, a `URL` or any consumer class
 * instance arriving through `defaultValues` gets rebuilt key by key into a
 * plain object, losing its prototype and every property on it. A prototype
 * test is closed over the values that exist; a list is closed only over
 * the ones someone remembered (#605).
 */
function isRecursable(value: unknown): boolean {
  return Array.isArray(value) || isPlainRecord(value)
}

/**
 * Shared depth-first walker behind both unset-walker entry points.
 * `synthesizeSchemaKeys` selects the boundary:
 *
 *   - `true` (construction-time `walkUnsetSentinels`): an unspecified key
 *     falls through to `walkUnspecified` on the schema's slim default so
 *     numeric leaves auto-mark, and an object path also synthesizes
 *     schema-only keys so a partially-supplied object marks the leaves it
 *     omitted. An explicit consumer `undefined` at a key is preserved
 *     rather than filled.
 *   - `false` (setValue-time `substituteUnsetSentinels`): the caller's
 *     shape is authoritative, so no auto-marking and no schema-only key
 *     synthesis, and `undefined` / `null` pass through untouched.
 *
 * Reference-stable in both modes: a subtree with no substitution or
 * synthesis returns its original `input` reference, so a deep watcher on
 * an untouched peer stays quiet. One that wrote back to the form on an
 * identity-changed peer would otherwise loop forever.
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
  // Unspecified key. In synthesize mode fall through to walkUnspecified on
  // the schema's slim default so primitive leaves get marked; otherwise
  // the caller's `undefined` is authoritative and passes through.
  if (input === undefined) {
    if (synthesizeSchemaKeys) {
      const slim = schema.getDefaultAtPath(segments)
      return walkUnspecified(slim, segments, paths)
    }
    return input
  }
  // Explicit null is the user's choice, not absence. Pass it through.
  if (input === null) return null
  if (!isRecursable(input)) return input
  if (Array.isArray(input)) {
    const out = new Array(input.length)
    let mutated = false
    for (let i = 0; i < input.length; i++) {
      // Read once and compare against that read: an index can be an
      // accessor, and reading twice would invoke it twice.
      const original = readConsumerIndex(input, i)
      const walked = walkCore(original, [...segments, i], schema, paths, synthesizeSchemaKeys)
      out[i] = walked
      if (walked !== original) mutated = true
    }
    return mutated ? out : input
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const inputKeys = consumerKeys(obj)
    // setValue boundary: iterate only consumer-supplied keys. Construction
    // boundary: ALSO synthesize schema-only keys, so an unspecified
    // primitive leaf auto-marks even inside a partially-supplied object.
    // `{ user: { name: 'a' } }` against a `user.{name, age}` schema marks
    // `user.age`.
    let keys: Iterable<string> = inputKeys
    let mutated = false
    let inputKeysSet: Set<string> | null = null
    if (synthesizeSchemaKeys) {
      inputKeysSet = new Set(inputKeys)
      const allKeys = new Set<string>(inputKeys)
      const slim = schema.getDefaultAtPath(segments)
      if (isPlainRecord(slim)) {
        for (const k of Object.keys(slim)) allKeys.add(k)
      }
      keys = allKeys
      mutated = allKeys.size !== inputKeys.length
    }
    // The container carries `Object.prototype` and writes route through
    // `safeAssign`, so a consumer schema using a literal `__proto__` key
    // (unusual but legal) lands as an own data property here too. The
    // output stays structurally identical to `setAtPath`'s, so a value
    // flowing through both surfaces one shape.
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      // Guarded because `obj` came from the consumer and the key may be
      // an accessor: a getter on a literal built with
      // `Object.defineProperty`, or a `computed` reached through a Vue
      // reactive object, both of which read as plain records here. An
      // accessor that throws would otherwise escape `setValue` / `reset` /
      // `useForm` and take the host component down (#608). Reading as
      // `undefined` leaves the key looking absent, which every branch
      // below already handles.
      const orig = readConsumerProp(obj, key)
      // Construction boundary only: an explicit consumer-supplied
      // `undefined` at a key means the consumer named the slot empty.
      // Preserve that signal in storage rather than filling from the
      // schema's slim default. The semantics differ, and so does the
      // schema-error filter's reading: the path lands in `authoredPaths`
      // and validation runs against undefined.
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
 * **numeric** primitive leaf it meets. Called from `walkCore` in
 * synthesize mode whenever the user's payload is missing at a path, and
 * from the top-level entry point when no defaults are supplied at all.
 * Strings, booleans and other non-numeric leaves stay unmarked: the
 * auto-mark only fires where storage and display diverge, which among
 * slim primitives is `number` and `bigint` alone. `walkUnsetSentinels`
 * carries the full rationale.
 *
 * Exported so the discriminated-union variant-switch reshape in
 * `create-form-store.ts` can re-mark the numeric leaves of a newly
 * activated variant after replacing the union's parent storage.
 */
export function walkUnspecified(slim: unknown, segments: Segment[], paths: PathKey[]): unknown {
  if (isPrimitiveOrEmpty(slim)) {
    if (isSlimNumericPrimitive(slim)) {
      paths.push(canonicalizePath(segments).key)
    }
    return slim
  }
  // An array passes through without recursion, its elements being
  // runtime-added and a tuple-shaped fixed array opting in through an
  // explicit per-element `unset`. So does every other non-record value.
  if (!isPlainRecord(slim)) return slim
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(slim)) {
    safeAssign(out, key, walkUnspecified(slim[key], [...segments, key], paths))
  }
  return out
}

/**
 * Substitute every `unset` sentinel inside `value` with the schema's
 * slim default at its absolute path (rooted at `prefix`), returning
 * the cleaned value plus the absolute paths where substitutions
 * happened.
 *
 * The trust-the-caller cousin of `walkUnsetSentinels`, differing in two
 * ways tuned to the `setValue(path, value)` runtime boundary:
 *
 *   1. No auto-marking of unspecified primitive leaves. The caller's shape
 *      is authoritative, so no blanks are synthesized for a key they did
 *      not supply. The discriminated-union variant reshape in
 *      `create-form-store.ts` handles the activated variant's numeric
 *      auto-marks separately.
 *   2. No schema-only key synthesis at object paths. On a whole-union
 *      write (`setValue('cargo', { type: 'oversized', ... })`),
 *      `schema.getDefaultAtPath(['cargo'])` returns the FIRST variant's
 *      default, so synthesizing those keys would smuggle the first
 *      variant's leaves into the activated one. The variant reshape clears
 *      them through the matched `getVariantDefault`, and they must not
 *      come back here.
 *
 * Reference-stable: a subtree with no substitutions returns its original
 * input reference, so a watcher on `form.values.<peer>` stays quiet when
 * the consumer's write did not touch that peer.
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
 * `true` when `value` is the slim numeric primitive, `0` or `0n`. The
 * auto-mark fires here and ONLY here: an `<input type="number">` cannot
 * render `0` as anything but `"0"`, so the runtime records "storage holds
 * the slim, display is blank" to tell "user supplied nothing" from "user
 * typed 0".
 *
 * Any other numeric value (`10`, `42`, a schema `.default(N)` for N ≠ 0)
 * has no divergence, the input rendering it natively, and MUST NOT
 * auto-mark: that would make the schema author's prefill disappear from
 * the rendered field while storage holds the declared value. Strings
 * (`''` storage, `''` display), booleans (`false` storage, unchecked
 * display), null and undefined never auto-mark for the same reason.
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
 * Used by the DU container branch in `expandUnsetAt` to write the stub
 * discriminator value, and by `setValue('cargo.kind', unset)` (the
 * discriminator-leaf direct case in `build-form-api.ts`), so both paths
 * land the same blank shape.
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
 *   1. **Discriminated union at this path.** Write the stub
 *      `{ <discKey>: blankForKind(discSlim) }`, mark only the
 *      discriminator path, and write no variant body. Checking the DU at
 *      every level rather than at the entry alone is what keeps nested
 *      unions clean: a root `defaultValues: unset` against a schema with
 *      nested DUs stubs each DU it meets instead of recursing into a first
 *      variant's body.
 *
 *   2. **Primitive leaf, or wrapper-absent (`undefined` / `null`).** Write
 *      the slim and mark the path. `getEmptyValueAtPath` returns
 *      `undefined` / `null` for an `.optional()` / `.nullable()` wrapper,
 *      so a wrapper-absent value flows through this branch naturally.
 *
 *   3. **Opaque non-recursable leaf** (`Date`, `RegExp`, `Map`, `Set`, a
 *      function). Write the falsy concrete from the schema and mark the
 *      path. No recursion.
 *
 *   4. **Array, tuple or record.** Write the schema's slim concrete (`[]`,
 *      the slim tuple, `{}`) with no per-element marks. Per-element opt-in
 *      stays `[unset, ...]`, handled by the surrounding `walkCore`
 *      recursion on non-unset inputs.
 *
 *   5. **Bare object.** Recurse into every key through `expandUnsetAt`, so
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

  if (Array.isArray(slim)) return slim

  // Every non-record value is its own leaf: it marks its path and is
  // returned whole. `Date` and `Map` reach here, and so do `File`, `Blob`
  // and consumer class instances, which is why the test is structural
  // rather than an instanceof list (see `isRecursable`).
  if (!isPlainRecord(slim)) {
    paths.push(canonicalizePath(segments).key)
    return slim
  }

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(slim)) {
    result[key] = expandUnsetAt([...segments, key], schema, paths)
  }
  return result
}

/**
 * Walk the consumer's `defaultValues` argument and stamp every leaf path
 * as "consumer-authored." Even an explicit `undefined` at a leaf counts:
 * the consumer named the path, so any verdict against that undefined IS
 * one they had a chance to provoke and should see.
 *
 * Plain records and arrays descend; non-record leaves (primitives, Date,
 * Map, class instances) mark their own path and stop.
 */
export function walkAuthoredFromConstraints(value: unknown, prefix: Path, out: Set<PathKey>): void {
  if (prefix.length > 0) out.add(canonicalizePath(prefix).key)
  if (isPlainRecord(value)) {
    for (const k of consumerKeys(value)) {
      walkAuthoredFromConstraints(readConsumerProp(value, k), [...prefix, k], out)
    }
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkAuthoredFromConstraints(readConsumerIndex(value, i), [...prefix, i], out)
    }
  }
}
