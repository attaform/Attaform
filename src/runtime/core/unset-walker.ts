import type { AbstractSchema } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import { canonicalizePath, type Path, type PathKey, type Segment } from './paths'
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
 * divergence** — see `docs/recipes/blank-inputs.md` for the concept. Two sources of
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
  const cleaned = walk(values as unknown, [], schema, paths)
  return { cleanedValues: cleaned as T, paths }
}

function walk(
  input: unknown,
  segments: Segment[],
  schema: AbstractSchema<GenericForm, GenericForm>,
  paths: PathKey[]
): unknown {
  if (isUnset(input)) {
    return expandUnsetAt(segments, schema, paths)
  }
  // User omitted this key — fall through to walkUnspecified on the
  // schema's slim default at this path so primitive leaves get marked.
  if (input === undefined) {
    const slim = schema.getDefaultAtPath(segments)
    return walkUnspecified(slim, segments, paths)
  }
  // Explicit null is the user's choice, not absence — pass through.
  if (input === null) return null
  if (
    input instanceof Date ||
    input instanceof RegExp ||
    input instanceof Map ||
    input instanceof Set ||
    typeof input === 'function'
  ) {
    return input
  }
  // Reference stability: when an array's elements all walk to themselves
  // (no unset substitutions, no schema-only keys synthesized), return the
  // ORIGINAL `input` reference. Without this, a whole-form setValue with
  // a structurally-unchanged subtree (e.g., the `pickup` half of
  // `({ ...prev, delivery: prev.pickup })`) still produces a new clone of
  // pickup, which then re-fires any deep watch on `form.values.pickup` —
  // and a watcher that reacts by writing back to the form loops forever.
  // Returning the original reference for unchanged subtrees keeps Vue's
  // reactivity quiet on identity-equal slots.
  if (Array.isArray(input)) {
    const out = new Array(input.length)
    let mutated = false
    for (let i = 0; i < input.length; i++) {
      const walked = walk(input[i], [...segments, i], schema, paths)
      out[i] = walked
      if (walked !== input[i]) mutated = true
    }
    return mutated ? out : input
  }
  if (typeof input === 'object') {
    // Walk both user-supplied keys AND schema-only keys so unspecified
    // primitive leaves get auto-marked even inside a partially-supplied
    // object (e.g., `defaultValues: { user: { name: 'a' } }` against a
    // schema with `user.{name, age}` marks `user.age`).
    const slim = schema.getDefaultAtPath(segments)
    const inputKeys = Object.keys(input as object)
    const allKeys = new Set<string>(inputKeys)
    if (
      slim !== null &&
      slim !== undefined &&
      typeof slim === 'object' &&
      !Array.isArray(slim) &&
      !(slim instanceof Date) &&
      !(slim instanceof RegExp) &&
      !(slim instanceof Map) &&
      !(slim instanceof Set)
    ) {
      for (const k of Object.keys(slim as object)) allKeys.add(k)
    }
    const out: Record<string, unknown> = {}
    let mutated = allKeys.size !== inputKeys.length
    for (const key of allKeys) {
      const orig = (input as Record<string, unknown>)[key]
      const walked = walk(orig, [...segments, key], schema, paths)
      out[key] = walked
      if (walked !== orig) mutated = true
    }
    return mutated ? out : input
  }
  return input
}

/**
 * Recurse into a schema slim-default subtree, auto-marking every
 * **numeric** primitive leaf encountered. Called from `walk` whenever
 * the user's payload is missing at a path, and from the top-level
 * walker entry point when no defaults are supplied at all. Strings,
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
  if (
    slim instanceof Date ||
    slim instanceof RegExp ||
    slim instanceof Map ||
    slim instanceof Set ||
    typeof slim === 'function'
  ) {
    return slim
  }
  // Arrays: pass through without recursion. Elements are runtime-added;
  // tuple-shaped fixed arrays opt-in via explicit per-element `unset`.
  if (Array.isArray(slim)) return slim
  if (slim !== null && typeof slim === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(slim as object)) {
      out[key] = walkUnspecified((slim as Record<string, unknown>)[key], [...segments, key], paths)
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
  const cleaned = substitute(value as unknown, [...prefix], schema, paths)
  return { cleanedValues: cleaned as T, paths }
}

function substitute(
  input: unknown,
  segments: Segment[],
  schema: AbstractSchema<GenericForm, GenericForm>,
  paths: PathKey[]
): unknown {
  if (isUnset(input)) {
    return expandUnsetAt(segments, schema, paths)
  }
  if (input === undefined || input === null) return input
  if (
    input instanceof Date ||
    input instanceof RegExp ||
    input instanceof Map ||
    input instanceof Set ||
    typeof input === 'function'
  ) {
    return input
  }
  if (Array.isArray(input)) {
    let mutated = false
    const out = new Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const walked = substitute(input[i], [...segments, i], schema, paths)
      out[i] = walked
      if (walked !== input[i]) mutated = true
    }
    return mutated ? out : input
  }
  if (typeof input === 'object') {
    let mutated = false
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(input as object)) {
      const orig = (input as Record<string, unknown>)[key]
      const walked = substitute(orig, [...segments, key], schema, paths)
      out[key] = walked
      if (walked !== orig) mutated = true
    }
    return mutated ? out : input
  }
  return input
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
 * three callsites: the `walk()` recursor inside `walkUnsetSentinels`,
 * the `substitute()` recursor inside `substituteUnsetSentinels`, and
 * the `setValue(path, unset)` direct case in `build-form-api.ts`.
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
 *      syntax handled by the surrounding `walk`/`substitute` recursion
 *      on non-unset inputs.
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

  if (
    slim instanceof Date ||
    slim instanceof RegExp ||
    slim instanceof Map ||
    slim instanceof Set ||
    typeof slim === 'function'
  ) {
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
