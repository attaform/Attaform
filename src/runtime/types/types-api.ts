import type { ComputedRef, ObjectDirective, Ref } from 'vue'
import type { FieldMetaPayload, ResolvedFieldMeta } from '../core/field-meta'
import type { Path, PathKey } from '../core/paths'

export type { FieldMetaPayload, ResolvedFieldMeta }
import type {
  ArrayItem,
  ArrayPath,
  DeepPartial,
  DefaultValuesInput,
  DefaultValuesShape,
  FlatPath,
  FlatPathBuilder,
  GenericForm,
  IsUnion,
  JoinSegments,
  KeyofUnion,
  LiftedValueShape,
  NestedReadType,
  NestedType,
  PresentValueOfUnion,
  RecordPath,
  RecordValue,
  WriteShape,
} from './types-core'

/**
 * Identifier for a form. A `FormKey` is the string passed via
 * `useForm({ key })`, used to look up a form by name from a distant
 * component and to label errors and DevTools entries. Anonymous
 * `useForm` calls allocate one
 * automatically; you only need to pick one when the form needs
 * stable identity.
 */
export type FormKey = string

/**
 * Per-form options threaded from `useForm` into the adapter factory.
 * Today carries the resolved `maxRecursionDepth` so adapter walks can
 * cap their descent through recursive schemas; future per-form runtime
 * knobs land here too.
 */
export interface SchemaFactoryOptions {
  /** Resolved recursion ceiling (per-form > app-default > library default). */
  maxRecursionDepth: number
}

/**
 * One validation failure. `path` points at the offending field as a
 * structured array — `['user', 'address', 0, 'line1']` for a nested
 * field, `['']` (the empty-string path) for a form-level error
 * (root `.refine()` messages, `setFormErrors()` entries, server-
 * emitted form banners). `formKey` identifies which form produced
 * the error so a single error list can be routed to multiple forms.
 *
 * Returned by `validate()` / `validateAsync()` / `handleSubmit`'s
 * `onError` callback, and by `parseApiErrors` for server responses.
 */
export type ValidationError = {
  /** Human-readable message describing the failure. */
  message: string
  /**
   * Structured path of the offending field. The empty-string path
   * `['']` is the form-level bucket — the dedicated home for errors
   * that don't belong to any specific field, distinct from the
   * whole-form subtree address `[]`.
   */
  path: (string | number)[]
  /** Identifies which form produced this error. */
  formKey: FormKey
  /**
   * Stable machine identifier for the failure, scoped by prefix:
   *
   * - `atta:` — library-internal codes (see `AttaformErrorCode`).
   * - adapter prefix (e.g. `zod:`) — forwarded from the underlying
   *   schema library's own issue code, when one exists.
   * - consumer-defined — anything else (e.g. `api:duplicate-email`,
   *   `auth:expired-token`). Pick a prefix and stay consistent so
   *   error renderers and tests can branch on `code` instead of
   *   exact-message string matching.
   */
  code: string
}

/** Settled validation result when the form (or subtree) parsed successfully. */
export type ValidationResponseSuccess<TData> = {
  /** The parsed value at the validated subtree (whole form when `validate()` was called without a path). */
  data: TData
  errors: undefined
  success: true
  formKey: FormKey
}
/** Settled validation result when no data could be produced (e.g. a top-level type mismatch). */
export type ValidationResponseErrorWithoutData = {
  data: undefined
  /** Non-empty list of failures. */
  errors: ValidationError[]
  success: false
  formKey: FormKey
}
/** Settled validation result when the parser produced partial data alongside failures. */
export type ValidationResponseErrorWithData<TData> = {
  data: TData
  errors: ValidationError[]
  success: false
  formKey: FormKey
}

/**
 * Settled validation result. Discriminate on `success`:
 *
 * ```ts
 * if (result.success) {
 *   // result.data is the parsed value, errors is undefined
 * } else {
 *   // result.errors is non-empty, data may or may not be set
 * }
 * ```
 */
export type ValidationResponse<TData> =
  | ValidationResponseSuccess<TData>
  | ValidationResponseErrorWithData<TData>
  | ValidationResponseErrorWithoutData

/**
 * Result of resolving the form's default values. Always returns at
 * least the shape derived from the schema; `errors` carry any
 * failures from validating those defaults against the schema.
 */
export type DefaultValuesResponse<TData> =
  | ValidationResponseSuccess<TData>
  | ValidationResponseErrorWithData<TData>

/**
 * Trimmed `ValidationResponse` that omits the `data` payload. Used by
 * `validate()` / `validateAsync()` since consumers usually only need
 * the success flag and error list at those entry points.
 */
export type ValidationResponseWithoutValue<Form> = Omit<ValidationResponse<Form>, 'data'>

/**
 * Sync-or-async return shape for `AbstractSchema.validateAtPath`. The
 * adapter returns the response inline when the schema and the
 * caller's options permit synchronous validation; otherwise a
 * `Promise<T>`. Callers that don't care simply `await` (works for
 * both); callers that DO care (the reshape pre-pass — flicker
 * prevention) branch on `instanceof Promise`.
 */
export type MaybePromise<T> = T | Promise<T>

/**
 * Options accepted by `AbstractSchema.validateAtPath`. Currently a
 * single field; kept as an object for forward-compat with future
 * knobs (e.g. cancellation signals, abort tokens) without breaking
 * the call signature.
 *
 * - `sync`: when `true`, the adapter SHOULD return the response
 *   inline if the schema permits synchronous validation. When the
 *   schema is structurally async (any verdict that resolves only via
 *   a Promise — async refinements, async transforms / pipes — in
 *   whichever library the adapter wraps), the adapter falls back to
 *   a `Promise<T>` — the flag is a preference, not a guarantee.
 *
 *   When omitted or `false`, the adapter is free to use its async
 *   path (matches the historical Promise-returning contract; every
 *   non-reshape callsite uses this default).
 */
export type ValidateOptions = {
  sync?: boolean
}

/**
 * Configuration passed to `AbstractSchema.getDefaultValues`. Adapters
 * receive `useDefaultSchemaValues` (honor `.default(x)` wrappers vs.
 * empty/falsy fallbacks), an optional `strict` mode (refinement
 * preservation), and an optional `constraints` overlay merged into the
 * derived defaults so the runtime can stamp user-supplied defaults at
 * construction. Exported so adapter authors can co-implement the
 * service contract.
 */
export type GetDefaultValuesConfig<Form> = {
  useDefaultSchemaValues: boolean
  /**
   * Whether to keep schema refinements when deriving slim defaults.
   * `true` (default) — preserve refinements; `false` — strip them so
   * placeholder data lands without immediate construction-time
   * errors. Mirrors `useForm({ strict })`.
   */
  strict?: boolean
  constraints?: DeepPartial<WriteShape<Form>> | undefined
}

/**
 * The contract a schema adapter implements so the form runtime can
 * read defaults, validate, and walk paths against any underlying
 * schema library.
 *
 * Most consumers never touch this type directly — the typed entry
 * points (e.g. `attaform/zod`, `attaform/zod-v3`)
 * wire an adapter automatically. Implement this interface only when
 * adding support for a new schema library (Valibot, ArkType, custom).
 */
export type AbstractSchema<Form, GetValueFormType> = {
  /**
   * Structural fingerprint of the schema. Same shape → same string;
   * different shape → (best-effort) different string.
   *
   * Resolves a `Promise` so adapters can defer the structural walk (and
   * its `canonicalStringify` helper) onto a dynamic import. The framework
   * only ever needs the fingerprint for the dev-only shared-key schema
   * mismatch warning, so none of those bytes belong on the eager
   * `useForm` path.
   *
   * The library uses this to detect schema mismatches at a shared
   * form key: two `useForm({ key: 'x', schema })` calls are allowed
   * to land on the same `FormStore` (the "shared store" semantic),
   * but only when their schemas agree. If the second call's
   * fingerprint differs from the first's, the library emits a
   * dev-mode warning — the first call's schema stays canonical and
   * the second call's schema is silently ignored.
   *
   * Guarantees adapter authors should provide:
   * - **Determinism:** equal shapes at different memory addresses
   *   must produce the same fingerprint. Referential equality fails
   *   99% of the time across files, so reference-identity is not a
   *   substitute.
   * - **Key-order-insensitivity** for record-like shapes (object,
   *   struct) — two shapes with the same keys but different iteration
   *   order must match.
   * - **Order-insensitivity for unbounded unions** — `a | b` and
   *   `b | a` must match (the set of members is what matters, not
   *   their source order).
   *
   * Compromises adapter authors may accept:
   * - Function-valued metadata (refinements, transforms, lazy
   *   defaults) is not stably hashable. Represent it as an opaque
   *   sentinel; two schemas differing only in refinement logic will
   *   look identical. The warning is a footgun catcher, not a
   *   soundness guarantee.
   */
  fingerprint(): Promise<string>

  getDefaultValues(config: GetDefaultValuesConfig<Form>): DefaultValuesResponse<Form>
  /**
   * Return the schema-prescribed default value at the given path. The
   * runtime uses this to fill structural gaps so every `setValue` write
   * leaves the form satisfying the slim schema (objects/arrays/primitives
   * without refinement-level constraints).
   *
   * Semantics:
   * - **Object property path:** the property's schema default.
   * - **Array element path:** the element default (paths past the
   *   array's current length still resolve — every position resolves
   *   to the same element type).
   * - **Tuple position path:** the position-specific default. Out-of-
   *   range positions return `undefined`.
   * - **Optional/Default/Nullable/Readonly/Catch/Pipe wrappers:** the
   *   inner default.
   * - **Discriminated union:** the first variant's default (matches
   *   `validateAtPath`'s first-success semantic).
   * - **Leaf:** the primitive default (`''`, `0`, `false`, etc., or the
   *   wrapper's `.default(x)` value when present).
   * - **Path doesn't exist in schema:** `undefined`.
   *
   * Adapters may return `undefined` when the path can't be resolved;
   * callers treat that as "don't fill" and fall back to existing data.
   */
  getDefaultAtPath(path: Path): unknown
  /**
   * Return the schema's "appropriate nullish value" at the given path
   * — the underlying type's empty/falsy concrete, with `.default(x)`
   * wrappers explicitly NOT honoured. Powers `form.clear(path)`:
   * `clear` differs from `reset` precisely in that it ignores
   * declared defaults and produces `false` / `0` / `''` / `[]` / a
   * recursively-empty object instead.
   *
   * Semantics (mirrors `getDefaultAtPath`'s sub-path resolution,
   * differs at leaves):
   * - **Primitive leaf:** the primitive's falsy concrete
   *   (`''` / `0` / `false` / `0n` / `new Date(0)`, etc.).
   * - **Array / Set / Record:** empty.
   * - **Optional<T>:** `undefined` (the wrapper's "absent" marker).
   * - **Nullable<T>:** `null` (the wrapper's "explicit empty").
   * - **Default<T> / Prefault<T> / Catch<T>:** inner-schema empty
   *   — the declared default value is INTENTIONALLY skipped.
   * - **Readonly<T> / preprocess(fn, T):** inner-schema empty.
   * - **Object:** recursive — every property gets its own empty.
   * - **Discriminated union:** first variant's recursive empty
   *   (parallels `getDefaultAtPath`'s first-success precedent).
   * - **Path doesn't exist in schema:** `undefined`.
   *
   * Adapters may return `undefined` when the path can't be resolved;
   * callers treat that as "don't write" and leave existing storage
   * unchanged.
   */
  getEmptyValueAtPath(path: Path): unknown
  /**
   * Reports whether `path` resolves to (or descends through) a
   * schema-side normalizer that runs at parse, not at the write
   * boundary. In Zod v4 that's `z.preprocess(fn, inner)` and
   * `z.coerce.X()` (both desugar to `ZodPipe<ZodTransform, inner>`);
   * in Zod v3 it's `ZodEffects` with `_def.effect.type === 'preprocess'`.
   *
   * Consulted by the slim-primitive write gate. When true at a path,
   * the gate accepts the consumer's raw value verbatim and stops
   * walking children — storage holds the user's input, and the
   * normalizer fires during `safeParse` (handleSubmit / validate /
   * validateAsync), not at `setValue` time.
   *
   * Path-prefix semantic: returns true if ANY ancestor of `path`
   * resolves to such a wrapper, so descendants under a preprocess-
   * wrapped container also short-circuit the gate. Adapters cache
   * the result by canonicalized path key.
   */
  isPreprocessOrCoerceLeaf(path: Path): boolean
  /**
   * Distinguish a tuple (fixed-length, position-typed) from an
   * unbounded array at `path`. The runtime calls this on every
   * `mergeStructural` / `setAtPathWithSchemaFill` write that descends
   * into an array branch — caching the answer at the schema level
   * replaces the per-write 1M-index probe + sequential probe loop
   * (up to 1024 schema lookups) the runtime previously used.
   *
   * Return values:
   * - `number` → tuple of this structural length. The runtime pads
   *   the consumer to this length and recurses position-by-position.
   * - `null` → unbounded array. The runtime uses the consumer's
   *   length and reuses one element default for every position.
   * - `undefined` → the path doesn't resolve to an array OR the
   *   adapter can't determine the shape. The runtime falls back to
   *   a probe loop in this case (defensive — every built-in adapter
   *   returns `number` or `null`).
   *
   * Wrappers (optional / nullable / default / readonly / catch /
   * pipe / lazy) are peeled transparently before the type check, so
   * `optional(z.tuple([...]))` reports its tuple length.
   */
  arrayShapeAtPath(path: Path): number | null | undefined
  /**
   * Whether the schema at `path` is a FIXED object: a closed set of
   * declared keys (`z.object`), as opposed to an open or union container
   * (array / record / map / set / union / discriminated union) whose
   * element schema matches any segment.
   *
   * The surface proxies (`form.fields` / `form.errors`) use this to
   * resolve a collision: a fixed object's declared keys are known ahead
   * of any data, so a key the schema owns descends to a real terminal
   * even when the live value hasn't been populated yet (a declared-but-
   * absent `optional` field stays registrable). An open container can't
   * make that promise — its element schema accepts ANY segment, so the
   * proxy must fall back to the keys the data currently holds and read
   * a genuinely-absent key (out-of-bounds index, missing record key,
   * inactive variant key) as `undefined` rather than a phantom node.
   *
   * The empty path (the root form) is always a fixed object. Wrappers
   * (optional / nullable / default / readonly / catch / pipe / lazy)
   * are peeled before the kind check, so `z.object({...}).optional()`
   * still reports `true`. A path the schema doesn't declare reports
   * `false`.
   */
  isFixedObjectAtPath(path: Path): boolean
  /**
   * Return every sub-schema that could resolve at the given structured
   * path. Multiple results are only expected for discriminated / union
   * branches where the adapter can't decide a single winner until the
   * data lands. `path` is the canonical `Segment[]` — adapters walk it
   * segment-by-segment so literal-dot keys (`['user.name']`) don't
   * collide with the sibling-pair form (`['user', 'name']`).
   */
  getSchemasAtPath(path: Path): AbstractSchema<unknown, GetValueFormType>[]
  /**
   * Validate a subtree (when `path` is provided) or the whole form (when
   * `path` is `undefined`). `path` is the canonical `Segment[]`, not a
   * dotted string — two schemas with otherwise-colliding dotted forms
   * (`['user.name']` vs `['user', 'name']`) stay distinct at the
   * adapter boundary.
   *
   * Return type is `MaybePromise<ValidationResponse>`:
   * - With `options.sync === true` AND a sync-capable schema, the
   *   adapter SHOULD return the response inline (`T`). This lets the
   *   runtime batch error writes with a coincident form-value
   *   mutation in a single Vue reactive flush — preventing the `{}`
   *   flicker observable during DU variant reshape.
   * - With `options.sync === true` AND an async-only schema (any
   *   verdict that resolves only via a Promise), the adapter MUST
   *   fall back to `Promise<T>`. The flag is a preference, not a
   *   guarantee; sync isn't always achievable.
   * - With `options.sync` omitted or `false`, the adapter SHOULD
   *   return `Promise<T>` (matches the historical contract — every
   *   non-reshape callsite uses this default and immediately
   *   `await`s the result).
   *
   * Callers that don't care simply `await` (works for both arms);
   * callers that need to detect sync-vs-async branch on
   * `instanceof Promise`. Adapters MUST NOT throw — errors are
   * returned as a `success: false` response with a populated
   * `errors` array.
   */
  validateAtPath(
    data: unknown,
    path: Path | undefined,
    options?: ValidateOptions
  ): MaybePromise<ValidationResponse<GetValueFormType>>
  /**
   * Sync sister to `getSchemasAtPath` / `validateAtPath`. Returns the
   * set of primitive `typeof`-style kinds the path's leaf schema
   * accepts at write time. Wrappers (optional / nullable / default /
   * refinement / transform / pipe / readonly / catch / lazy) are
   * peeled; refinement-level constraints (format checks like email /
   * uuid, min/max length, enum membership, literal equality, regex)
   * are IGNORED — they're a validation-time concern.
   *
   * Used by `setValueAtPath` to gate writes synchronously without
   * round-tripping through async `validateAtPath`. The returned set
   * unions across union branches and intersects across intersection
   * sides.
   *
   * Conventions:
   * - Empty set → no kind admitted. The runtime gate rejects every
   *   write to the path. Surfaces for `never`-typed schemas AND for
   *   paths that don't resolve in the schema (typo / unknown leaf).
   * - Permissive set (every kind) → "unknown / unconstrained." The
   *   gate accepts any value. Surfaces for `any` / `unknown` / `void`
   *   and the lazy-peel-failure case where the adapter can't
   *   introspect the schema.
   * - For string-valued enums: returns `{'string'}`. For numeric
   *   enums: `{'number'}`.
   * - For literal types: returns `{primitiveKindOf(literalValue)}`.
   * - For object / array containers: `{'object'}` / `{'array'}`. The
   *   runtime walker recurses into entries / elements at write time.
   * - For nullable / optional wrappers: adds `'null'` / `'undefined'`
   *   to the inner's set.
   */
  getSlimPrimitiveTypesAtPath(path: Path): Set<SlimPrimitiveKind>
  /**
   * Return `true` iff `path` resolves to a **leaf** in the schema — a
   * path whose slim primitive set contains only primitive kinds (no
   * `object`, `array`, `map`, `set`). The runtime proxies (`form.values`,
   * `form.errors`, `form.fields`) query this at every step to decide
   * between **descend into a sub-proxy** (container) and **terminate
   * with a leaf value** (leaf).
   *
   * The leaf-aware branching is what kills the FIELD_STATE_KEYS
   * shadowing problem: reserved leaf-prop names (`dirty`, `errors`,
   * `valid`, …) inject only at the FieldState terminal, not at
   * every depth. A schema field literally named `dirty` at depth ≥ 2
   * stays reachable as a sub-proxy or leaf in its own right.
   *
   * Semantics:
   * - **Object / Array / Map / Set** at any wrapper layer → `false`
   *   (container; descend further).
   * - **Primitive** (string/number/boolean/bigint/symbol/null/undefined/
   *   date/function) → `true`. `'date'` counts as a leaf (don't drill
   *   into `Date`). `'function'` is a leaf for the same reason — opaque
   *   value.
   * - **Optional / Nullable / Default / Catch** wrappers transparent —
   *   adds `'null'` / `'undefined'` to the inner kind set without
   *   changing the leaf classification.
   * - **Discriminated union root** → `false` (variants are objects;
   *   the kind set contains `'object'`).
   * - **DU discriminator key** → `true` (the literal type resolves to
   *   `{'string'}` / `{'number'}`).
   * - **DU variant-only key** → `true` if it resolves to a primitive
   *   in any variant; schema-static (does NOT query live storage to
   *   decide which variant is active).
   * - **Empty path (root)** → `false` (root is the form-as-object).
   * - **Path doesn't exist in schema** → `false`. The proxy descends
   *   permissively; reads of leaf props at the unknown path return
   *   `undefined` from the underlying store. Treating unknown paths
   *   as containers preserves the schema's authority and avoids
   *   re-introducing shadowing on typos.
   *
   * Adapters MAY cache results per-path — `isLeafAtPath` will be
   * called on every proxy `get` trap hit. The reference implementation
   * memoises a `Map<PathKey, boolean>` keyed by `canonicalizePath(path).key`,
   * lifetime tied to the adapter (one per `useForm()` call).
   */
  isLeafAtPath(path: Path): boolean
  /**
   * Return `true` if the leaf at `path` is required — i.e. the schema
   * does NOT admit "empty" via `.optional()`, `.nullable()`,
   * `.default(N)`, or `.catch(N)` at the leaf or any wrapper.
   *
   * Used by the submit / validate path to surface a "No value supplied" error
   * when a field is in the form's `blankPaths` set (the user
   * cleared it or never answered) AND the schema treats the field as
   * required. Without this, a strict numeric leaf would silently
   * accept the slim default (`0`) for an unanswered field — the
   * "public-housing" footgun where `$0 income` passes validation.
   *
   * Semantics:
   * - **Optional / Nullable / Default / Catch** at any wrapper layer
   *   (root or nested) → `false`. The schema author opted into
   *   accepting empty.
   * - **Readonly / Pipe / Lazy** wrappers are transparent — peel and
   *   re-check the inner schema.
   * - **Union / Discriminated union** → `false` if ANY branch admits
   *   empty (the union accepts what the most permissive branch
   *   accepts). This matches the parse-time "first success wins"
   *   semantic of `validateAtPath`.
   * - **Intersection** → `true` if EITHER side requires the path
   *   (intersection requires both sides to accept; if one rejects
   *   empty, the intersection rejects empty).
   * - **Path doesn't exist in schema** → `false` (can't enforce
   *   what we don't know about).
   * - **Empty path (root)** → `true` (the root form is always
   *   required as an object).
   *
   * Refinement-level constraints (length / format / custom predicates)
   * are NOT consulted here — those run at parse time inside
   * `validateAtPath` and surface as schema errors regardless.
   * `isRequiredAtPath` only answers the "is this leaf at all
   * required?" question; the refinements layer on top.
   */
  isRequiredAtPath(path: Path): boolean
  /**
   * If the schema at `path` is (or wraps) a discriminated union,
   * return its discriminator key plus a `getVariantDefault(value)`
   * lookup — otherwise `undefined`. Wrappers (optional, default,
   * nullable, readonly, pipe, lazy, catch) are peeled transparently.
   *
   * The runtime uses this for two related reshapes that share the
   * same lookup:
   *
   *   1. **Discriminator-key write** — the runtime calls this with
   *      the parent path. If the returned `discriminatorKey` matches
   *      the path's last segment, the write changes which variant is
   *      active; the parent storage is replaced with the matching
   *      variant's slim default so the OLD variant's keys (e.g.
   *      `address` after switching to `sms`) don't leak.
   *
   *   2. **Whole-union write** — the runtime calls this with the
   *      path itself. If the returned info exists and the consumer's
   *      value carries the discriminator key, the merge uses the
   *      matching variant's default instead of the first-variant
   *      fallback that `getDefaultAtPath` returns for unions.
   *
   * Adapters that don't model discriminated unions can return
   * `undefined` unconditionally; the runtime reshape is a no-op
   * without this hook.
   */
  getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined

  /**
   * Return the resolved field metadata for the schema node at `path`
   * — label, description, placeholder, plus the full registered
   * payload as `meta` for consumer-augmented keys. Reads through the
   * shared cross-adapter field-meta store and applies these one-way
   * fallbacks:
   *
   *   - `label`:       registry payload → `humanize(lastSegment)`
   *   - `description`: registry payload → `schema.description`
   *                    (`.describe()` value) → `undefined`
   *   - `placeholder`: registry payload → `undefined`
   *   - `meta`:        registry payload (frozen) — empty object when
   *                    nothing was registered
   *
   * `path` is the canonical `Segment[]`. The empty path resolves to
   * the root schema's metadata. Multiple candidates (DU branches)
   * resolve against the first candidate to match the existing
   * first-success precedent in `getDefaultAtPath` /
   * `validateAtPath` — schema authors register on the union root
   * for shared metadata, on individual branches for variant-
   * specific metadata.
   *
   * Optional. The runtime treats a missing implementation as a
   * stub that returns `EMPTY_RESOLVED_FIELD_META` — so adapters
   * that don't model field metadata yet can omit it; consumers
   * see humanized fallbacks for `label`, undefined elsewhere.
   */
  getFieldMetaAtPath?(path: Path): ResolvedFieldMeta

  /**
   * Return `true` if `validateAtPath` MAY have to run asynchronously
   * to surface every error this schema can produce. The runtime uses
   * this at construction to decide whether to schedule a one-shot
   * full-form async validation: when `false` (or omitted), the
   * construction-time sync seed is the authoritative result and no
   * extra microtask is spent; when `true`, an async pass is queued
   * so any async-only verdicts (refinements / transforms / pipes
   * that resolve only via a Promise) surface without waiting for a
   * user mutation.
   *
   * Optional. The runtime treats a missing implementation as
   * `() => false`, so adapters that don't model async work — or
   * don't yet support detection — can omit it; async-only errors
   * then fall back to firing on first user mutation, matching the
   * pre-detection behavior. Detection is best-effort.
   *
   * For per-path queries, compose with `getSchemasAtPath(path)`:
   * each candidate sub-schema exposes its own
   * `needsAsyncValidation`, so a caller asking "does the cargo
   * subtree contain async work?" can union the per-candidate
   * answers without a separate top-level overload.
   */
  needsAsyncValidation?(): boolean

  /**
   * Return `true` iff the schema carries a refine / check / transform
   * at any NON-LEAF position — a container node (object / array /
   * tuple / union / intersection / record / map / set) or the root
   * itself. False means every check this schema runs is leaf-local,
   * so a per-keystroke `validateAtPath(form, leafPath)` catches the
   * same verdicts as a whole-form pass — no ancestor refine reads
   * the form's wider state.
   *
   * The runtime uses this at the per-keystroke schedule to scope
   * field-level validation to the changed subtree when it can,
   * falling back to a whole-form pass when an ancestor refine
   * (cross-field equality, sum constraints, etc.) could be moved
   * by a leaf write. Optional. The runtime treats a missing
   * implementation as `() => true` — conservative whole-form,
   * preserving correctness for adapters that don't yet model
   * container-refine detection.
   *
   * Detection is best-effort: false negatives (returning `true`
   * when no container refine exists) only lose a perf win and
   * still validate correctly; false positives (returning `false`
   * when a container refine exists) would let an ancestor verdict
   * go stale and are the real risk — implementations should bias
   * toward returning `true` when in doubt.
   */
  hasContainerOrRootRefine?(): boolean
}

/**
 * Adapter-returned info for a discriminated union — its discriminator
 * key plus a function that maps a discriminator literal to the slim
 * default of the matching variant. Returned by
 * `AbstractSchema.getUnionDiscriminatorAtPath`.
 */
export type UnionDiscriminatorContext = {
  /**
   * The union's discriminator key — the property name whose literal
   * value selects the variant (e.g. `'channel'` for a union split on
   * `{ channel: 'sms' | 'email' }`).
   */
  readonly discriminatorKey: string
  /**
   * Slim default for the variant whose discriminator literal equals
   * `value`. Returns `undefined` if no variant matches — the runtime
   * skips the reshape and falls back to a plain write.
   */
  getVariantDefault(value: unknown): unknown
  /**
   * Returns `true` iff `value` is a literal recognised by one of the
   * discriminator's variants. Used by reshape to decide whether to
   * seek a variant default or emit a stub state. NOT used at the
   * runtime write gate — consumer-side value validity is a
   * validation-time concern.
   */
  isVariantSelected(value: unknown): boolean
}

/**
 * The set of primitive "kinds" the slim-primitive write contract
 * recognises. Drawn from `typeof` plus a few well-known reference
 * shapes (`Date`, `Array`, `Map`, `Set`, plain `object`, `null`).
 *
 * The runtime gate's `slimKindOf(value)` returns one of these for a
 * value; the adapter's `getSlimPrimitiveTypesAtPath(path)` returns
 * the set of kinds the path's leaf schema accepts. A write is gated
 * by `accepted.has(slimKindOf(value))`.
 */
export type SlimPrimitiveKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'date'
  | 'null'
  | 'undefined'
  | 'object'
  | 'array'
  | 'symbol'
  | 'function'
  | 'map'
  | 'set'
  | 'file'

/**
 * The "no result yet" status returned by the reactive `validate()` ref
 * while a validation run is in flight.
 *
 * Narrow against `pending` to access the settled fields:
 *
 * ```ts
 * const status = form.validate()
 * watchEffect(() => {
 *   if (status.value.pending) return
 *   // status.value.success / status.value.errors are now safe to read
 * })
 * ```
 */
export type PendingValidationStatus = {
  readonly pending: true
  readonly errors: undefined
  readonly success: false
  readonly formKey: FormKey
}

/** Settled status of a reactive `validate()` call. Mirrors the latest result. */
export type SettledValidationStatus<Form> = {
  readonly pending: false
} & ValidationResponseWithoutValue<Form>

/**
 * The value type of the ref returned by `validate()`. Discriminate on
 * `pending` to switch between in-flight and settled states.
 */
export type ReactiveValidationStatus<Form> = PendingValidationStatus | SettledValidationStatus<Form>

/**
 * What to do when a submit attempt fails validation. The library can
 * focus and/or scroll the first errored field into view without you
 * wiring an `onError` callback yourself. Defaults to
 * `'focus-first-error'` because moving keyboard / screen-reader focus
 * to the broken field on submit is an accessibility baseline; opt out
 * with `'none'` if you're managing focus elsewhere.
 *
 * - `'focus-first-error'` (default): focus the first errored field's
 *   first visible element. Modern browsers scroll the focused element
 *   into view by default; pair with `'both'` if you want an explicit
 *   scroll alongside.
 * - `'scroll-to-first-error'`: scroll that element into view without
 *   moving focus.
 * - `'both'`: scroll first, then focus (with `preventScroll: true` so
 *   the browser doesn't undo the explicit scroll).
 * - `'none'`: no automatic UI nudge; the dev handles focus / scroll
 *   manually via `form.focusFirstError()` or `form.scrollToFirstError()`
 *   from an `onError` callback.
 *
 * If no errored field has a currently mounted, visible element, the
 * policy silently no-ops.
 */
export type OnInvalidSubmitPolicy = 'none' | 'focus-first-error' | 'scroll-to-first-error' | 'both'

/**
 * When per-field VALIDATION runs. Only validation timing varies per
 * mode; storage commit timing is the directive's concern (the
 * default `<input v-register>` commits per keystroke; `.lazy` defers
 * to blur).
 *
 * - `'change'` (default): every committed write schedules a
 *   validation for the affected path. With `debounceMs: 0` (also the
 *   default) the run is synchronous in the write handler;
 *   positive `debounceMs` coalesces rapid bursts.
 * - `'blur'`: validate immediately when the user tabs away from a
 *   registered field. No debounce — `debounceMs` is rejected by the
 *   type.
 * - `'submit'`: no live validation. `handleSubmit` and explicit
 *   `validate()` / `validateAsync()` calls are the only validation
 *   surfaces. `debounceMs` is rejected by the type.
 */
export type ValidateOn = 'change' | 'blur' | 'submit'

/**
 * Validation timing config — `validateOn` is the trigger, `debounceMs`
 * the wait (after the last committed write) before the next
 * validation run fires. `debounceMs` ONLY governs validation;
 * `setValueWithInternalPath` commits to `form.values` immediately
 * regardless of debounce. (How OFTEN the directive forwards writes
 * to storage is the directive's concern — default `<input
 * v-register>` commits per keystroke; `<input v-register.lazy>`
 * defers to the blur `change` event.)
 *
 * `debounceMs` is only meaningful with `validateOn: 'change'` (the
 * default); `'blur'` and `'submit'` ignore the wait entirely (blur
 * fires validation immediately on focus-out; submit is its own
 * trigger). The discriminated union below makes pairing `debounceMs`
 * with `'blur'` / `'submit'` a TS error instead of a silent runtime
 * drop.
 *
 * Pass `debounceMs: 0` (the default) to disable validation
 * debouncing — every committed write triggers a validation pass with
 * no `setTimeout` indirection. Schema work itself still rides
 * `Promise.resolve().then(validateAtPath)` — async but microtask, so
 * errors land on the next tick. Set `debounceMs` to a positive
 * number to coalesce rapid bursts (useful for slow async adapters or
 * for smoothing inline feedback under heavy typing).
 */
export type ValidateOnConfig =
  | {
      /** Validation trigger. Default `'change'`. */
      validateOn?: 'change'
      /**
       * Milliseconds to wait after the last committed write before
       * running validation. Default `0` (validation runs synchronously
       * after the write; no `setTimeout`). Set to a positive number
       * to coalesce rapid bursts into a single validation pass.
       *
       * Note: this is purely the validation debounce. Storage commits
       * happen at the directive's listener (per-keystroke for
       * `<input v-register>`, per-blur for `<input v-register.lazy>`)
       * — `debounceMs` doesn't change either.
       */
      debounceMs?: number
    }
  | {
      /** Validation trigger. */
      validateOn: 'blur' | 'submit'
      /** `debounceMs` is not allowed with `'blur'` or `'submit'`. */
      debounceMs?: never
    }

/**
 * Per-write metadata. Used internally to tag writes so listeners and
 * the write funnel can treat a write specially (a blank mark, an array
 * structural op, a hydration replay, a per-instance config override).
 */
export type WriteMeta = {
  /**
   * When `true`, the path being written is added to the FormStore's
   * `blankPaths` set — meaning storage holds a real, schema-
   * conformant value (the slim default) but the UI should display the
   * field as empty. The next write to that path WITHOUT this flag
   * implicitly removes the path from the set (the user typed something
   * real). Internal — set by `markBlank()` on the register
   * binding and by the `unset` translation in `setValue` / `reset` /
   * `useAbstractForm` construction. Don't set from consumer code.
   */
  readonly blank?: boolean
  /**
   * When `true`, the discriminator-aware variant reshape inside
   * `setValueAtPath` is skipped for this write. Internal — set by
   * the reshape itself when re-entering with the new variant default
   * so the literal discriminator inside the default doesn't trigger
   * an infinite loop. Don't set from consumer code.
   */
  readonly skipDiscriminatorReshape?: boolean
  /**
   * Records an array structural mutation precisely enough to replay the
   * exact index permutation it produced, set by `field-arrays.ts`
   * helpers. `setValueAtPath` uses it to surgically clear variant memory
   * for the indices the operation invalidated. Without this hint, a raw
   * whole-array `setValue(arrayPath, [...])` clears all memory under the
   * array (the runtime can't tell which indices stayed put). Internal —
   * don't set from consumer code.
   */
  readonly arrayOp?:
    | { readonly kind: 'insert'; readonly index: number }
    | { readonly kind: 'remove'; readonly index: number }
    | { readonly kind: 'move'; readonly from: number; readonly to: number }
    | { readonly kind: 'swap'; readonly a: number; readonly b: number }
    | { readonly kind: 'replace-at'; readonly index: number }
  /**
   * Per-instance config overrides threaded through writes so each
   * `useForm({ key })` callsite honors its own `validateOn` /
   * `debounceMs` / `rememberVariants` even when sharing a FormStore
   * with sibling calls (e.g., a modal and main form rendering the
   * same logical form). Internal — set by `buildFormApi` from
   * the per-instance options bag; the store reads each field with
   * fallback to its construction-time defaults.
   */
  readonly instance?: {
    readonly validateOn?: ValidateOn
    readonly debounceMs?: number
    readonly rememberVariants?: boolean
  }
  /**
   * When `true`, marks this `applyFormReplacement` call as a hydration
   * step (the async-`defaultValues` / `activate()` / `rehydrate()`
   * path). Modules that snapshot the form state (notably the history
   * module) treat hydration as the baseline: stacks reset to a single
   * seed of the post-hydration value, so a subsequent `undo()` can't
   * recover the transient pre-hydration default. Internal — set by the
   * activate path in `create-form-store.ts`. Don't set from consumer
   * code.
   */
  readonly hydration?: boolean
}

/**
 * Undo/redo configuration passed via `useForm({ history })`.
 *
 * - `true` — enable with the default position cap (`max: 128`).
 * - `{ max }` — enable and tune the bounded history size.
 *
 * When enabled, every mutation records a forward delta; `form.history.undo()`
 * / `form.history.redo()` walk the chain. `reset()` is itself a mutation —
 * the pre-reset state stays one undo away. Persistence hydration is the
 * floor: after hydrate applies, the chain reseeds with the hydrated value
 * and `undo()` cannot reach the transient pre-hydration default.
 */
export type HistoryConfig = true | { max?: number }

/**
 * Consolidated undo/redo namespace at `form.history`. All history-related
 * surface lives here — methods and reactive flags both — so consumers
 * have one canonical address to read from.
 *
 * Always present on `useForm()` return whether or not `history` was
 * configured. When history isn't enabled, methods are no-ops returning
 * `false` (or `void`), `canUndo` / `canRedo` read `false`, and `size`
 * reads `0`. Consumer templates don't need conditional logic.
 *
 * Reactivity: built as `readonly(reactive({...}))`, so `canUndo` / `canRedo`
 * / `size` auto-unwrap on access (plain `boolean` / `number`, not refs).
 * Method fields (`undo`, `redo`, `clear`) pass through as plain functions.
 */
export type FormHistoryNamespace = {
  /**
   * Step back one position in the history chain. Returns `true` when a
   * step was taken, `false` when already at the oldest reachable
   * position (or when history isn't configured).
   */
  readonly undo: () => boolean
  /**
   * Replay the next step forward in the chain. Returns `true` on
   * success, `false` when there's nothing queued (or history isn't
   * configured). The forward branch is dropped as soon as a new
   * mutation lands.
   */
  readonly redo: () => boolean
  /**
   * Wipe the undo and redo branches; reseed the chain with the current
   * form state as the new baseline. The form value, errors, and
   * blankPaths all stay where they are — only the past/future history
   * resets. After `clear()`: `canUndo === false`, `canRedo === false`,
   * `size === 1`. No-op when history isn't configured.
   */
  readonly clear: () => void
  /** `true` when there is at least one undo step available. */
  readonly canUndo: boolean
  /** `true` when `undo()` has been called and a `redo()` would replay. */
  readonly canRedo: boolean
  /**
   * Total reachable positions in the history chain (the current
   * position plus everything reachable via `undo()` / `redo()`).
   * Useful for debug overlays; UI driving undo/redo buttons should
   * gate on `canUndo` / `canRedo` instead. Reads `0` when history
   * isn't configured.
   */
  readonly size: number
}

/**
 * Configuration object passed to `useForm`. All fields except `schema`
 * are optional.
 *
 * ```ts
 * const form = useForm({
 *   schema: signupSchema,
 *   defaultValues: { email: '' },
 *   validateOn: 'change',
 *   debounceMs: 200,
 * })
 * ```
 */
export type UseFormConfiguration<
  Form extends GenericForm,
  GetValueFormType,
  Schema extends AbstractSchema<Form, GetValueFormType>,
  DefaultValues extends DefaultValuesInput<Form>,
  K extends FormKey = FormKey,
> = {
  /**
   * The schema describing the form's shape and validation rules.
   * Typed entry points like `attaform/zod` accept the
   * underlying library's schema directly and wrap an adapter; the
   * abstract entry point accepts any object implementing
   * `AbstractSchema`.
   *
   * For schemas that depend on the form's identity or per-form
   * options, pass a factory `(key, options) => schema` instead — the
   * library calls it once per form, after `mergeWithDefaults` has
   * resolved the options bag (`maxRecursionDepth`, etc.). Most
   * adapters ignore the options argument; the typed Zod entry points
   * use it to thread the resolved recursion cap into the adapter
   * closure.
   */
  schema: Schema | ((key: FormKey, options: SchemaFactoryOptions) => Schema)
  /**
   * Optional identifier for this form. Omit for one-off forms; the
   * library allocates a unique key automatically (SSR-safe, stable
   * across server→client hydration).
   *
   * Pass a string key when the form needs identity:
   * - to look it up from a distant component via `injectForm(key)`;
   * - to share state across components (multiple `useForm({ key })`
   *   calls with the same key resolve to the same form);
   * - to give DevTools and validation errors a recognisable label.
   *
   * Keys starting with `__atta:` are reserved for internal use and
   * throw `ReservedFormKeyError` if passed.
   *
   * When passed as a string literal, the literal is preserved on
   * `form.key` so `useWizard` and other consumers can discriminate
   * against the union of known keys at compile time.
   */
  key?: K
  /**
   * Initial values applied over the schema's defaults. Each field
   * falls back to the schema default (or the primitive default for
   * the slot's type) when not provided here.
   *
   * Values must satisfy the slim primitive type at each path
   * (string / number / boolean / Date / etc.) but do NOT have to
   * satisfy refinement-level constraints (format checks, enum
   * membership, length / range bounds). Refinement-invalid defaults
   * pass through and surface as field errors — this lets you
   * rehydrate stale saved data without losing the user's input.
   *
   * Accepts a plain value, a sync function, or an async function:
   *
   * ```ts
   * // Plain value — applies at construction.
   * defaultValues: { email: '' }
   *
   * // Sync function — invoked on a microtask after construction.
   * defaultValues: () => buildDraft()
   *
   * // Async function — form starts with the schema's slim defaults
   * // and `form.hydrating` flips true while the promise is
   * // in flight; on resolve the values apply and `hydrating` flips
   * // false. Under SSR the factory fires via `onServerPrefetch` so
   * // the resolved payload bakes into hydration transfer state and
   * // the client never re-fetches.
   * defaultValues: async () => api.fetchDraft(userId)
   * ```
   *
   * Errors thrown by a function-form factory surface on
   * `form.hydrateError`; the form stays usable with slim defaults.
   * Call `form.rehydrate()` to re-fire the factory.
   */
  defaultValues?: DefaultValues | (() => DefaultValues) | (() => Promise<DefaultValues>)
  /**
   * Whether to validate default values at construction. Default
   * `true`.
   *
   * - `true` (default): the schema is run against the derived
   *   defaults immediately; any failures populate `form.errors` from
   *   the first frame. The UI decides when to *show* errors — gate
   *   on `form.fields.<path>.touched`, `form.meta.submissionAttempts`, etc.
   * - `false`: refinements are stripped during defaults derivation
   *   and construction-time validation is skipped. Useful for
   *   multi-step wizards, field arrays seeded with placeholder
   *   rows, or any form intentionally mounting with incomplete data.
   *
   * Runtime validation (per-field on edit, full-form on submit) is
   * identical regardless of this flag.
   */
  strict?: boolean
  /**
   * Automatic UI nudge on submit-validation failure. Fires after
   * errors are populated and before your `onError` callback runs.
   * Default `'focus-first-error'`, which moves keyboard / screen-reader
   * focus to the broken field as an accessibility baseline.
   *
   * - `'focus-first-error'` (default): focus the first errored field's
   *   first visible element.
   * - `'scroll-to-first-error'`: scroll it into view without focusing.
   * - `'both'`: scroll, then focus.
   * - `'none'`: opt out entirely; handle focus / scroll yourself in an
   *   `onError` callback via `form.focusFirstError()` or
   *   `form.scrollToFirstError()`.
   *
   * If no errored field has a currently-mounted, visible element,
   * the policy silently no-ops.
   */
  onInvalidSubmit?: OnInvalidSubmitPolicy

  /**
   * When per-field VALIDATION runs (the directive's listener controls
   * how often storage commits — per keystroke by default, per blur
   * with `.lazy`). Default `'change'`. See `ValidateOn` for mode
   * semantics.
   *
   * The strict public `useForm` signature wraps this type in an
   * intersection with `ValidateOnConfig`, which enforces that
   * `debounceMs` is only allowed under `'change'`. Internal callers
   * (adapters, hydration paths) work with the loose form below.
   */
  validateOn?: ValidateOn
  /**
   * Milliseconds to wait after the last committed write before
   * running validation. Default `0` (validation fires synchronously
   * after the write; no `setTimeout`). Set to a positive number to
   * coalesce rapid bursts. Ignored under `validateOn: 'blur'` and
   * `'submit'`.
   *
   * This is purely a VALIDATION debounce — storage commits are the
   * directive's concern (per keystroke for `<input v-register>`,
   * per blur for `<input v-register.lazy>`).
   */
  debounceMs?: number

  /**
   * Opt-in undo/redo. Off by default. `true` enables with a 128-position
   * cap; `{ max: N }` tunes the cap.
   *
   * Every mutation records a forward delta. `form.history.undo()` walks
   * one step back; `form.history.redo()` walks one step forward.
   * `reset()` is itself a mutation, so the pre-reset state stays one
   * undo away. The consolidated `form.history` namespace also exposes
   * `clear()`, `canUndo`, `canRedo`, and `size`.
   */
  history?: HistoryConfig

  /**
   * Whether to remember the typed state of each discriminated-union
   * variant across switches. Default `true`.
   *
   * When `true`, switching `notify.channel` from `email` (with
   * `address: 'foo@bar.com'`) to `sms` and back lands on
   * `address: 'foo@bar.com'` again — the runtime snapshots the
   * outgoing variant's subtree on switch-out and restores the
   * incoming variant's prior subtree on switch-in. Each
   * discriminated union at every nesting depth is independently
   * memorized.
   *
   * Set to `false` to drop the outgoing variant's typed state on
   * every switch (the data is gone). The new variant initializes
   * from its slim default.
   *
   * Memory is in-memory only and does not survive a fresh mount: a
   * page reload starts every discriminator's variant memory empty.
   *
   * `reset()` clears variant memory. `resetField(path)` clears any
   * memory entry whose union path equals or sits under `path`.
   */
  rememberVariants?: boolean
  /**
   * Schema-driven coercion of user-typed DOM values at the v-register
   * directive layer. Per-form override of the plugin-level
   * `AttaformDefaults.coerce`.
   *
   * - `true` / `undefined` — runs the built-in `defaultCoercionRules`.
   * - `false` — disables coercion; the slim gate rejects mismatches.
   * - `CoercionRegistry` — a custom array of entries (REPLACES, not
   *   merges, the plugin defaults). Spread `defaultCoercionRules` to
   *   extend.
   *
   * Coercion applies ONLY to user-typed DOM values. Programmatic
   * writes (`form.setValue`, `setValueWithInternalPath`) are NEVER
   * coerced.
   */
  coerce?: boolean | CoercionRegistry
  /**
   * Per-form override of the `getDisplayState` heuristic that drives
   * `field.displayState` and the `show*` booleans (and their `form.meta`
   * rollups). Falls back to `AttaformDefaults.getDisplayState`, then to
   * the library default (`defaultDisplayState`). See
   * `AttaformDefaults.getDisplayState` for the resolution rules and
   * predicate signature.
   */
  getDisplayState?: GetDisplayState
  /**
   * Recursion ceiling for schema walks that descend through recursive
   * schemas (Zod's `z.lazy(...)` today). Default `64`. Per-form value
   * overrides `AttaformDefaults.maxRecursionDepth`, which overrides
   * the library default.
   *
   * Schemas that don't include a recursive boundary ignore this knob
   * entirely — it's read only at the descent step through a recursive
   * wrapper. Set it on the specific form whose schema is recursive
   * (a comment tree, a category tree, a nested-rule editor):
   *
   * ```ts
   * useForm({ schema: commentTreeSchema, maxRecursionDepth: 128 })
   * ```
   *
   * Past the cap, the slim-primitive type gate falls back to permissive
   * (write-time type checks skip; full schema validation still runs).
   * Storage and reads work at any depth; only the per-write type gate
   * stops short of the cap. Raise the cap if you regularly edit nodes
   * beyond the default depth.
   *
   * See `AttaformDefaults.maxRecursionDepth` for the resolution rules
   * and the broader description of where the cap is read.
   */
  maxRecursionDepth?: number
  /**
   * Whether `v-register` automatically manages aria attributes
   * (`aria-invalid`, `aria-busy`, `aria-required`, `aria-describedby`)
   * from the field's display state. **Defaults to `true`.**
   *
   * **Resolution order (per-register override > per-form > global > library):**
   *
   *   register(path, { autoAria })  >  useForm({ autoAria })  >  AttaformDefaults.autoAria  >  library default (`true`)
   *
   * Set `false` to leave all aria wiring to your own markup form-wide.
   * Any aria attribute you author yourself is always left untouched,
   * independent of this flag.
   */
  autoAria?: boolean
  /**
   * @internal
   * SSR prefetch mark — set by the `attaform/vite` compile-time
   * transform on `useForm` calls whose surrounding SFC template (or a
   * computed feeding it) reads the form's reactive state. The flag
   * enqueues the form on the registry's SSR prefetch queue so an
   * async `defaultValues` factory runs inside `onServerPrefetch` and
   * the resolved payload bakes into the hydration transfer state.
   *
   * Consumers do not write this directly — `form.activate()` is the
   * documented escape hatch when the transform's static analysis
   * can't see a reference (cross-module sharing, dynamic property
   * access, headless contexts).
   */
  __ssrAccessed?: boolean
}

/**
 * App-level defaults applied to every `useForm` call. Set these once
 * per app via `createAttaform({ defaults })` (bare Vue) or
 * `attaform.defaults` (Nuxt module).
 *
 * Resolution order (per-form wins):
 *
 *   useForm({ ... })  >  createAttaform({ defaults })  >  library default
 *
 * `validateOn` and `debounceMs` resolve per-field — set the debounce
 * globally while still overriding the trigger per form:
 *
 * ```ts
 * createAttaform({
 *   defaults: { debounceMs: 100 },
 * })
 * // later
 * useForm({ schema, validateOn: 'blur' })
 * // → { validateOn: 'blur', debounceMs: <ignored under blur> }
 * ```
 *
 * Note: per the discriminated union, `debounceMs` only takes effect
 * when `validateOn` is `'change'` (or omitted). Setting it as an
 * app-level default is fine — forms that switch to `'blur'` /
 * `'submit'` simply ignore the inherited `debounceMs`.
 *
 * `schema`, `key`, and `defaultValues` are not configurable here —
 * they belong on the per-form call.
 */
export type AttaformDefaults = {
  /** Default for `useForm({ strict })`. Default `true`. */
  strict?: boolean
  /** Default for `useForm({ onInvalidSubmit })`. */
  onInvalidSubmit?: OnInvalidSubmitPolicy
  /** Default for `useForm({ validateOn })` — when validation runs. */
  validateOn?: ValidateOn
  /**
   * Default for `useForm({ debounceMs })` — ms to wait after the last
   * input event before re-running validation. Only meaningful when
   * `validateOn` resolves to `'change'`. Default `0` (synchronous).
   */
  debounceMs?: number
  /** Default for `useForm({ history })`. */
  history?: HistoryConfig
  /** Default for `useForm({ rememberVariants })`. */
  rememberVariants?: boolean
  /**
   * Default for `useForm({ coerce })`. Schema-driven coercion of
   * user-typed DOM values at the v-register directive layer.
   *
   * - `true` (default) — runs the built-in `defaultCoercionRules`
   *   (`string→number`, `string→boolean`).
   * - `false` — disables coercion globally; the slim-primitive gate
   *   rejects type mismatches with its existing dev-warn instead.
   * - `CoercionRegistry` — a custom array of `CoercionEntry` records.
   *   Spread `defaultCoercionRules` to extend rather than replace:
   *   `[...defaultCoercionRules, defineCoercion({ ... })]`.
   *
   * Coercion applies ONLY to user-typed DOM values flowing through
   * the directive's assigner. Programmatic writes (`form.setValue`,
   * `setValueWithInternalPath`) are NEVER coerced — they're
   * authoritative writes whose strict typing is on the caller.
   */
  coerce?: boolean | CoercionRegistry
  /**
   * Default for `useForm({ getDisplayState })`. The centralised
   * heuristic that resolves every path's `field.displayState` — and thus
   * the `show*` booleans and their `form.meta` rollups — to one of
   * `'idle' | 'pending' | 'error' | 'success'`.
   *
   * Resolution order (per-form wins):
   *
   *   useForm({ getDisplayState })  >  AttaformDefaults  >  library default
   *
   * The library default opens one timing gate, then resolves by
   * precedence: gate closed → `'idle'`; a run in flight → a delayed
   * `'pending'` (held briefly to smooth fast validations, then held a
   * minimum so it never flashes); an own-path error → `'error'`;
   * otherwise earned `valid` → `'success'`, else `'idle'`. The gate opens
   * after the first submit attempt OR once the field is edited and left:
   *
   * ```ts
   * (prev, ctx) => {
   *   const gateOpen =
   *     ctx.formMeta.submissionAttempts > 0 ||
   *     ctx.field.blurredAfterInteraction === true
   *   if (!gateOpen) return { display: 'idle' }
   *   // ...timed 'pending' while validating; own-path error → 'error';
   *   //    earned valid → 'success'; else 'idle'
   * }
   * ```
   *
   * Compose with the library default via the public `defaultDisplayState`
   * export, or retune its timing via `makeDefaultDisplayState`. The
   * reducer runs on every field-state read, so it owns the
   * idle / pending / error / success decision outright.
   *
   * The reducer's `ctx.field` / `ctx.formMeta` are `Omit`'d of the
   * derived `displayState` / `show*` / `firstError` keys (see
   * `FieldStateDerivedKey`) to prevent a self-referential reducer.
   */
  getDisplayState?: GetDisplayState
  /**
   * Default for `useForm({ maxRecursionDepth })`. Recursion ceiling
   * for schema walks that descend through recursive schemas (Zod's
   * `z.lazy(...)` today, equivalent constructs in any future adapter).
   * Library default: `64`.
   *
   * Resolution order (per-form wins):
   *
   *   useForm({ maxRecursionDepth })  >  AttaformDefaults  >  library default (64)
   *
   * Read at every step of a schema walk that crosses a recursive
   * boundary — default-value derivation at construction, slim-primitive
   * type gates on each write, path-by-path schema resolution. Walks
   * track their descent depth and switch to a permissive fallback once
   * `depth > maxRecursionDepth`.
   *
   * "Permissive fallback" means storage and reads keep working at any
   * depth; only the per-write type gate stops checking past the cap.
   * Full schema validation (`validateAsync`, `handleSubmit`) still runs
   * against the real schema, so refinement errors at any depth still
   * surface — the cap only affects the *write-time gate*.
   *
   * Forms with no recursive schemas ignore this entirely — the cap is
   * read only at the descent step through a recursive wrapper. Setting
   * it app-wide is the right move when you have multiple recursive
   * forms that should share one ceiling:
   *
   * ```ts
   * createAttaform({
   *   defaults: { maxRecursionDepth: 128 },
   * })
   * ```
   *
   * Per-form override stays available for the one tree-shaped form
   * whose depth is unusual:
   *
   * ```ts
   * useForm({ schema: deepCategoryTreeSchema, maxRecursionDepth: 256 })
   * ```
   *
   * Setting this app-wide costs nothing for non-recursive forms — the
   * walks that read the cap never run for them.
   *
   * Pass `Infinity` to disable the cap entirely. Walks will then
   * descend through recursive boundaries until they terminate
   * structurally; a schema with no structural terminator will exhaust
   * the JS call stack. Reserve for schemas whose authors are
   * confident the recursion is bounded by the actual data shape.
   */
  maxRecursionDepth?: number
  /**
   * App-wide default for `useForm({ autoAria })`. Library default is
   * `true`: `v-register` keeps `aria-invalid` / `aria-busy` /
   * `aria-required` / `aria-describedby` in sync with each field's
   * display state out of the box.
   *
   * **Resolution order (per-form wins):**
   *
   *   useForm({ autoAria })  >  AttaformDefaults.autoAria  >  library default (`true`)
   *
   * Set `false` once at the plugin level to make every form manage its
   * own aria markup. Authored aria attributes are always preserved
   * regardless of this setting.
   */
  autoAria?: boolean
}

export type FormStore<TData extends GenericForm> = Map<FormKey, TData>

/**
 * Callback invoked by `handleSubmit` after the form parses successfully.
 * Receives the strictly-typed parsed value — refinements have run, so
 * enum / literal / format constraints are honoured.
 */
export type OnSubmit<Form extends GenericForm> = (form: Form) => void | Promise<void>

/**
 * Callback invoked by `handleSubmit` when validation fails. Receives
 * the full list of errors. Bind this when you want to react to
 * submit failures explicitly (alongside or instead of the
 * automatic `onInvalidSubmit` UI nudge).
 */
export type OnError = (error: ValidationError[]) => void | Promise<void>

/**
 * The display-state verdict at a path: the single signal a UI needs to
 * decide what (if anything) to surface about validation right now.
 * Rolled up at containers and at the form root (`form.meta.displayState`).
 *
 * - `'idle'` — nothing to surface. Either pre-interaction (the timing
 *   gate hasn't opened) or gate-open with no verdict worth showing.
 * - `'pending'` — a validation run is in flight at this path; the prior
 *   verdict is stale. Drive a spinner / "Checking…" affordance.
 * - `'error'` — a blocking error the timing gate has cleared for display.
 * - `'success'` — validation passed and the gate has cleared a positive
 *   confirmation (the green-check pattern).
 *
 * The four `show*` booleans on `FieldState` are sugar over this enum
 * (`showErrors === (displayState === 'error')`, and so on), so they can
 * never contradict it.
 */
export type DisplayState = 'idle' | 'pending' | 'error' | 'success'

/**
 * Keys on `FieldState` layered on FROM the display-state predicate
 * (plus `firstError`, computed alongside them). `Omit`'d from the
 * predicate's arguments so a predicate cannot read its own output and
 * form a cycle — enforced at the type level AND at runtime: the base
 * objects passed in literally lack these keys, so an `as` cast in TS
 * or a vanilla-JS caller still can't reach them. `FieldStateBase` /
 * `FormMetaBase` (field-state-api.ts) omit the same set in lockstep.
 */
export type FieldStateDerivedKey =
  | 'displayState'
  | 'showErrors'
  | 'showPending'
  | 'showSuccess'
  | 'showIdle'
  | 'firstError'

/**
 * One step of the display state machine: the verdict the field should
 * render right now (`display`, projected to `displayState` and the
 * `show*` booleans) plus two optional timing cells the engine reads.
 *
 * - `reviewAt` — an absolute `Date.now()` millisecond stamp telling the
 *   engine "re-evaluate this field no later than here." The engine keeps
 *   a single timer per form aimed at the nearest `reviewAt` across all
 *   active fields; when it fires, the dependent field computeds re-run
 *   and call the reducer again. A machine with no `reviewAt` and a
 *   non-pending `display` is terminal — the engine evicts it.
 * - `pendingShownAt` — the stamp at which `'pending'` was first shown,
 *   the memory the min-visible hold needs so a spinner that just appeared
 *   is not yanked away the instant validation resolves. Opaque to the
 *   engine; a custom reducer may carry its own extra memory fields too.
 */
export type DisplayMachine = {
  readonly display: DisplayState
  readonly reviewAt?: number
  readonly pendingShownAt?: number
}

/**
 * Inputs to a `getDisplayState` reducer. `field` and `formMeta` are the
 * same reactive snapshots a predicate has always received (still minus
 * the derived `displayState` / `show*` / `firstError` keys — see
 * `FieldStateDerivedKey` — so a reducer can never read its own output and
 * form a cycle), now joined by:
 *
 * - `validatingSince` — `Date.now()` at which the field's current
 *   validation streak opened, or `null` when nothing is in flight. This,
 *   not `field.validating`, is the timing anchor: the elapsed wait is
 *   `now - validatingSince`. Pinned to the start of the streak, so
 *   overlapping sub-runs do not reset it.
 * - `transformingSince` — the same anchor for an in-flight async
 *   `register` transform, or `null` when none is running. Folds into the
 *   one in-flight clock the reducer already runs for validation, so a
 *   deferred transform rides the anti-flash spinner timing identically.
 *   `null` for a sync-only chain, which never defers.
 * - `now` — the engine's clock, injected so the reducer stays pure and
 *   deterministic (and frozen to `0` under SSR, where there is no clock).
 */
export type DisplayCtx = {
  readonly field: Omit<FieldState, FieldStateDerivedKey>
  readonly formMeta: Omit<FormMeta, FieldStateDerivedKey>
  readonly validatingSince: number | null
  readonly transformingSince: number | null
  readonly now: number
}

/**
 * Pure transition reducer that resolves a path's `displayState`. Given
 * the field's previous `DisplayMachine` and the current `DisplayCtx`, it
 * returns the next machine; the engine owns the clock and the timers, the
 * reducer owns the timing policy. Runs on every field-state read (and
 * again whenever a `reviewAt` deadline fires), so the whole app's
 * validation-display behavior flows from this one function.
 *
 * The library default — `defaultDisplayState` — is publicly exported so a
 * layered reducer can compose with it, and `makeDefaultDisplayState`
 * builds a default with custom anti-flash timings:
 *
 * ```ts
 * import { defaultDisplayState } from 'attaform'
 *
 * useForm({
 *   schema,
 *   // Defer to the default everywhere, but never show a success check on `username`.
 *   getDisplayState: (prev, ctx) => {
 *     const next = defaultDisplayState(prev, ctx)
 *     return next.display === 'success' && ctx.field.path[0] === 'username'
 *       ? { display: 'idle' }
 *       : next
 *   },
 * })
 * ```
 */
export type GetDisplayState = (prev: DisplayMachine, ctx: DisplayCtx) => DisplayMachine

/**
 * Submit handler returned by `handleSubmit(onSubmit, onError)`. Bind
 * it to a `<form>`:
 *
 * ```vue
 * <form @submit.prevent="onSubmit">…</form>
 * ```
 *
 * It optionally accepts the originating `Event` so it can sit on
 * `@submit` directly (without `.prevent` if you want to call
 * `event.preventDefault()` yourself).
 */
export type SubmitHandler = (event?: Event) => Promise<void>

/**
 * Type of `form.handleSubmit`. Pass an `onSubmit` callback for the
 * happy path and (optionally) an `onError` callback that receives
 * the validation errors when parsing fails.
 *
 * ```ts
 * const onSubmit = form.handleSubmit(
 *   (data) => api.signup(data),
 *   (errors) => console.log(errors),
 * )
 * ```
 */
export type HandleSubmit<Form extends GenericForm> = (
  onSubmit: OnSubmit<Form>,
  onError?: OnError
) => SubmitHandler

/**
 * Per-leaf internal tracker record. Distinct from `FieldState.meta`
 * (which surfaces as `Readonly<FieldMetaPayload>` — the registry-
 * attached label / description / placeholder payload). Surfaced for
 * custom-adapter authors threading metadata through their own
 * pipelines; most consumers don't reach for it directly — the
 * matching fields appear with friendlier shape on `FieldState`.
 *
 * - `updatedAt` — ISO timestamp of the most recent write at this path,
 *   or `null` if the field has never been written.
 * - `rawValue` — the value as it arrived (before any transform);
 *   useful for distinguishing parse-coerced reads from raw user input.
 * - `connected` — whether at least one DOM element bound to this
 *   path is currently mounted. Flips to `false` when every binding
 *   unmounts.
 * - `formKey` — identifier of the form this metadata belongs to.
 * - `path` — dotted-string path to this leaf, or `null` when not applicable.
 */
export type MetaTrackerValue = {
  /** ISO timestamp of the most recent write at this path. `null` if never written. */
  updatedAt: string | null
  /** Value as it arrived, before any transforms. */
  rawValue: unknown
  /** `true` while at least one binding to this path is currently mounted. */
  connected: boolean
  /** Form this metadata belongs to. */
  formKey: FormKey
  /** Dotted-string path to this leaf. */
  path: string | null
  /**
   * `true` when this field is **blank** — the runtime has recorded
   * that storage and the visible display diverge here. Reserved for
   * the case the schema can't see on its own: storage forces a
   * value (e.g. `0` for a numeric leaf, `0n` for a bigint leaf)
   * while the DOM input shows `''`, and the runtime needs a side-
   * channel to tell "user typed 0" from "user supplied nothing."
   *
   * Set automatically for numeric leaves (the directive's input
   * listener on clear; the construction-time pass when the consumer
   * didn't supply a value). Set explicitly for any primitive leaf
   * via `setValue(path, unset)` / `defaultValues: { x: unset }` /
   * `reset({ x: unset })` — that's the documented opt-in signal for
   * strings, booleans, and other types that don't otherwise diverge.
   * Cleared on the first non-`unset` write.
   *
   * `errors = f(schema, state)` is reactive end-to-end: any required
   * path with `blank: true` produces a "No value supplied" entry in
   * `form.errors` immediately, no `validate()` / `handleSubmit` call
   * required. Most consumers don't need this flag directly — gate UI
   * on `errors[path]` and `touched`. Read `blank` itself when you
   * want pre-error introspection ("the user hasn't decided yet"
   * indicator, "review unanswered fields" hint).
   *
   * See `docs/validation/blank.md` for the full conceptual model.
   */
  blank: boolean
}

// Generates every registrable path inside `Form`. Arrays of primitive
// items (string / number / boolean / bigint) expose BOTH the array root
// AND `${Key}.${number}` so multi-select and multi-checkbox bindings
// can register at the array root; arrays of objects expose only the
// indexed-and-deeper paths. Sourced from the shared `FlatPathBuilder`
// recursion in `types-core.ts`; the `'register'` mode skips container
// paths because `v-register` only binds onto leaf-backing native
// elements (`<input>` / `<select>` / `<textarea>`).
export type RegisterFlatPath<Form, Key extends keyof Form = keyof Form> = FlatPathBuilder<
  Form,
  'register',
  Key
>

/**
 * A transformation applied to a field's value as user input flows
 * from DOM through the directive's assigner. Composes left-to-right
 * via the `transforms: [...]` array on `register()`.
 *
 * The shape is intentionally generic-erased (`(unknown) => unknown`)
 * rather than per-path-typed: a personal library of transforms
 * (`trim`, `lowercase`, `slugify`, `clamp`, …) should plug into any
 * `register()` slot regardless of the path's value type. Library
 * authors write defensive bodies that no-op on type mismatch:
 *
 * ```ts
 * export const trim: RegisterTransform = (v) =>
 *   typeof v === 'string' ? v.trim() : v
 * ```
 *
 * Type-safety at the call site is delegated to attaform's slim-primitive
 * gate — a transform that produces a value the path's storage
 * doesn't accept gets rejected at write time with a standard
 * diagnostic.
 *
 * Transforms may be sync or async. The chain stays fully synchronous —
 * the value reaches form state in the same tick — until a transform
 * returns a thenable; from there the write defers, the field reads
 * `busy` / `transforming` while the chain settles, and the resolved
 * value commits to canonical state once it lands. Rapid edits discard
 * all but the latest (latest-request-wins), and a rejection surfaces on
 * `field.transformError` rather than throwing or logging:
 *
 * ```ts
 * export const normalize: RegisterTransform = async (v, ctx) => {
 *   const res = await fetch(`/normalize?q=${v}`, { signal: ctx?.signal })
 *   return res.text()
 * }
 * ```
 *
 * `ctx.signal` is an `AbortSignal` aborted when the run is superseded by
 * a newer edit, or torn down by `reset()` / unmount — thread it into
 * cancellable I/O so a stale request is dropped. A sync chain never
 * touches it and allocates no controller.
 *
 * A synchronous throw is caught and aborts the pipeline: subsequent
 * transforms don't run, nothing is written to form state, and the
 * assigner returns `false` — so a buggy or defensive-throw transform
 * never crashes the host app. (An async rejection is the
 * `transformError` channel above, not a throw into the host app.)
 */
export type RegisterTransform = (value: unknown, ctx?: TransformContext) => unknown

/**
 * Runtime type for a slim primitive kind. Used to narrow the
 * `transform` parameter and return value on a `CoercionEntry` so
 * authors writing rules don't have to cast `unknown`.
 *
 * Exhaustive over `SlimPrimitiveKind` — adding a new kind to that
 * union must add a corresponding branch here.
 */
export type SlimRuntimeOf<K extends SlimPrimitiveKind> = K extends 'string'
  ? string
  : K extends 'number'
    ? number
    : K extends 'boolean'
      ? boolean
      : K extends 'bigint'
        ? bigint
        : K extends 'date'
          ? Date
          : K extends 'null'
            ? null
            : K extends 'undefined'
              ? undefined
              : K extends 'array'
                ? readonly unknown[]
                : K extends 'set'
                  ? ReadonlySet<unknown>
                  : K extends 'map'
                    ? ReadonlyMap<unknown, unknown>
                    : K extends 'object'
                      ? Record<string, unknown>
                      : K extends 'symbol'
                        ? symbol
                        : K extends 'function'
                          ? (...args: never[]) => unknown
                          : never

/**
 * Outcome of a coercion attempt.
 *
 * - `coerced: true` — the rule produced `value`, which the directive
 *   forwards to the slim gate (the gate may still reject if the
 *   value doesn't satisfy the path's accept set).
 * - `coerced: false` — the rule decided it can't coerce this input.
 *   The directive passes the original value through; the slim gate
 *   decides downstream.
 *
 * Discriminated rather than `O | undefined` so rules with
 * `output: 'undefined'` or `output: 'null'` don't conflict with the
 * "skip" signal.
 */
export type CoercionResult<O> = { coerced: true; value: O } | { coerced: false }

/**
 * A single coercion rule. `input` and `output` are
 * `SlimPrimitiveKind` literals; `transform` receives a value already
 * narrowed to `SlimRuntimeOf<input>` and returns
 * `CoercionResult<SlimRuntimeOf<output>>`.
 *
 * Rules MUST be sync. They SHOULD NOT throw — wrap internal
 * try/catch when the conversion can fail (e.g. `BigInt(s)` throws
 * for non-numeric strings). The library wraps each invocation in
 * try/catch as defense in depth; throws are caught, logged once per
 * `(input, output)`, and the original value passes through.
 */
export type CoercionEntry<
  I extends SlimPrimitiveKind = SlimPrimitiveKind,
  O extends SlimPrimitiveKind = SlimPrimitiveKind,
> = {
  readonly input: I
  readonly output: O
  readonly transform: (value: SlimRuntimeOf<I>) => CoercionResult<SlimRuntimeOf<O>>
}

/**
 * A registry is an ordered array of `CoercionEntry` records.
 * Consumers compose by spreading `defaultCoercionRules` and
 * appending their own entries. Order is observable only when two
 * entries share the same `(input, output)` pair — the library emits
 * a one-shot dev-warn and the LATER entry wins.
 */
export type CoercionRegistry = readonly CoercionEntry[]

/**
 * Options for `register(path, options)`. Per-field configuration
 * applied at the binding's own call site.
 */
export type RegisterOptions = {
  /**
   * Sync transformation pipeline applied to user-typed values before
   * they reach form state. Composes left-to-right: each transform
   * receives the previous transform's output (or the directive-
   * extracted DOM value for the first transform).
   *
   * Pipeline order:
   * `DOM event → modifier cast (.lazy/.trim/.number) → transforms[0] → … → transforms[n] → assigner`
   *
   * Applies to user input only. Programmatic writes
   * (`form.setValue(...)`, `rv.setValueWithInternalPath(...)`),
   * `form.reset()`, hydration, SSR replay, and `markBlank()` all
   * bypass transforms — those write canonical state, not normalized
   * user input. If you want the same normalization on a programmatic
   * write, compose the transforms yourself at the call site:
   *
   * ```ts
   * form.setValue('email', slugify(lowercase(rawValue)))
   * ```
   *
   * Transforms may be sync or async: the chain stays synchronous until
   * one returns a thenable, then the write defers and commits the
   * resolved value (the field reads `busy` meanwhile). A sync throw
   * aborts the write; an async rejection lands on `field.transformError`
   * (see `RegisterTransform` for the full contract).
   *
   * For patterns that need to inspect the `RegisterValue` itself
   * (rejection-with-side-effect, redirection to other fields, custom
   * DOM mutation), use `@update:registerValue` on the bound element
   * instead — see the "Custom assigners" section in the API docs.
   */
  transforms?: ReadonlyArray<RegisterTransform>
  /**
   * Per-binding override for automatic aria management, the narrowest
   * tier of the `autoAria` cascade. By default the directive keeps
   * `aria-invalid` / `aria-busy` / `aria-required` / `aria-describedby`
   * in sync with the field's display state. Pass `autoAria: false` to
   * leave every aria attribute on this element to you (the directive
   * still manages value binding and registration), or `autoAria: true`
   * to re-enable management on one binding even when the form set
   * `useForm({ autoAria: false })`.
   *
   * Overrides `useForm({ autoAria })` and
   * `createAttaform({ defaults: { autoAria } })`. Writing an aria
   * attribute yourself also locks the directive out of that one
   * attribute, regardless of this flag.
   */
  autoAria?: boolean
}

/**
 * The object returned by `form.register(path)`. Pass it to a native
 * input via `v-register`:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * ```
 *
 * Or read `innerRef` directly when integrating with custom components.
 *
 * The returned value is a `shallowReadonly` reactive proxy: top-level
 * reads (`rv.path`, `rv.formKey`, `rv.segments`, …) track in reactive
 * scopes, mutations are blocked, and inner refs (`innerRef`,
 * `displayValue`) keep their `Ref` shape.
 *
 * `path`, `formKey`, and `formInstanceId` are the wrapper-component
 * primitives — a generic component using `useRegister()` can derive
 * field state and form identity from them without re-threading props
 * from the parent.
 */
export type RegisterValue<Value = unknown> = Readonly<{
  /**
   * Live, read-only reactive value at this path. Watch it to drive
   * UI that depends on the field's current value.
   */
  innerRef: Readonly<Ref<Value>>
  /**
   * Attach an HTML element to this binding. Called by `v-register`
   * automatically; expose it to custom integrations that need to
   * register an element manually.
   *
   * Recording the element drives the form's element map (used for
   * `field.meta.connected`, `focusFirstError`, and `scrollToFirstError`).
   */
  registerElement: (el: HTMLElement) => void
  /**
   * Detach an HTML element from this binding. Pair with
   * `registerElement` for custom integrations. Drops the element from
   * the form's element map.
   */
  deregisterElement: (el: HTMLElement) => void
  /**
   * Write the field's value programmatically. Returns `true` when the
   * write was accepted, `false` when it was rejected (e.g. wrong
   * primitive type for the path).
   *
   * The write path for custom directives and consumer assigners: it
   * routes through the same funnel (and per-instance meta) as the
   * directive's default assigner. Caller-supplied `meta` passes through
   * unchanged.
   */
  setValueWithInternalPath: (value: unknown, meta?: WriteMeta) => boolean
  /**
   * Mark this field as DOM-connected during SSR so a server-rendered
   * template that reads `form.fields.<path>.connected` doesn't
   * flicker on hydration. The `v-register` directive calls this for
   * you; no-op on the client.
   * @internal
   */
  markConnectedOptimistically: () => void
  /**
   * Canonical, JSON-encoded path key for this binding (e.g.
   * `'["items",0,"name"]'`). Useful for stable Map / Set keys, log
   * messages, and equality checks against another `RegisterValue`'s
   * path. Treat as opaque — for `form.fields(...)` / `form.values(...)`
   * lookups inside wrapper components, use `segments` instead.
   */
  path: PathKey
  /**
   * Structured path segments for this binding (e.g.
   * `['items', 0, 'name']`). The consumer-friendly form for
   * `form.fields(...)` / `form.values(...)` lookups in generic
   * wrapper components:
   *
   * ```ts
   * const rv = useRegister()
   * const form = injectForm()
   * const field = computed(() => form.fields(rv.value?.segments ?? []))
   * ```
   *
   * Frozen at runtime so wrapper components can read it without
   * defensive copying.
   */
  segments: Path
  /**
   * The form's user-supplied (or auto-allocated) `key`, mirroring
   * `form.key` on the public form API. Useful in wrapper components
   * that target a specific form by key without prop-drilling.
   */
  formKey: string
  /**
   * Per-mount runtime identifier for the form instance. Stable across
   * the form's lifetime. Used by the directive to scope element
   * registrations to a single mount and exposed here for wrapper
   * components that need to disambiguate sibling forms with the same
   * `key`.
   */
  formInstanceId: string
  /**
   * Sync transform pipeline applied by the directive's assigner to
   * user-typed values before they reach form state. See
   * `RegisterOptions.transforms` for the public contract; this is
   * the readonly internal handle the directive iterates. Optional
   * so hand-rolled `RegisterValue` mocks (test fixtures, custom
   * integrations) don't have to declare an empty array — the
   * directive falls back to a no-op pipeline.
   * @internal
   */
  transforms?: ReadonlyArray<RegisterTransform>
  /**
   * Schema-driven coercion closure baked at register-time. Captures
   * the path's slim accept set and the resolved coercion index so
   * the per-event hot path is a single function call. Identity
   * function when coercion is disabled or the path admits no
   * coercion target. Optional so hand-rolled `RegisterValue` mocks
   * (test fixtures, custom integrations) don't have to declare it —
   * the directive falls back to identity.
   * @internal
   */
  coerce?: (value: unknown) => unknown
  /**
   * Element-level coercion closure for container paths
   * (`z.array(...)` / `z.set(...)`). Coerces a scalar DOM-side
   * value (an option's `value` attribute, a checkbox's value)
   * against the container's element type. `undefined` when the
   * path isn't a container — scalar paths use `coerce` exclusively.
   *
   * Used by the directive's read-side comparisons in setChecked
   * (array/Set branches) and setSelected (multi-select) to keep
   * parity with the change handler's WRITE-side path-level coerce.
   * @internal
   */
  coerceElement?: (value: unknown) => unknown
  /**
   * Read-only, string-form view of the field's current value — what
   * the compile-time `:value` injection reads on every input /
   * textarea / select bound by `v-register`.
   *
   * Returns `''` when the path is in the form's `blankPaths`
   * set OR storage is `null` / `undefined`; otherwise stringifies
   * the storage value via `String(...)`. The blank branch
   * lets the user clear a numeric field without the next Vue render
   * patching `el.value` back to `'0'` (the slim default).
   */
  displayValue: Readonly<Ref<string>>
  /**
   * Add this field's path to the form's `blankPaths` set,
   * writing the slim default to storage. Returns the `setValueAtPath`
   * boolean (`true` accepted, `false` rejected by the slim-primitive
   * gate).
   *
   * Called by the directive's input listener on numeric clear (commit
   * 5) and by the imperative `setValue(path, unset)` translation
   * (commit 7). Don't call from consumer code.
   * @internal
   */
  markBlank: () => boolean
  /**
   * Flip this field's sticky `interacted` flag — the signal that the
   * user has issued at least one value edit here (an insert or a
   * delete). Called by the directive's input / change listeners on
   * every genuine user input; never by hydration or programmatic
   * writes. Idempotent (the store skips the write once set). Don't
   * call from consumer code.
   * @internal
   */
  markInteracted: () => void
  /**
   * `true` when the schema's slim primitive set at this path includes
   * `'undefined'` — i.e. the leaf was declared `.optional()` (or as
   * part of a union admitting `undefined`). Cached at register-time.
   *
   * Read by the directive's text-input listener to map a DOM clear
   * (`el.value === ''`) onto `undefined` storage instead of `''`, so
   * the `.optional()` "absent" semantic survives user interactions.
   * Without this, a user who typed an invalid value into an optional
   * field and then cleared it would be stuck with a permanent
   * validation error (storage holds `''`, which is neither
   * `undefined` nor a valid inner value).
   * @internal
   */
  acceptsUndefined: boolean
  /**
   * `true` when the schema's slim primitive set at this path includes
   * `'string'`. Cached at register-time alongside
   * [[acceptsUndefined]].
   *
   * Read by the directive's text-input listener so a DOM clear on a
   * numeric-only (or boolean-only, bigint-only) leaf takes the
   * `markBlank` path instead of writing `''` through the assigner:
   * the slim-primitive gate would reject the empty string anyway,
   * and the directive's post-write force-sync would then snap the
   * DOM back to the last accepted value, making the final character
   * undeletable. With `markBlank`, storage holds the slim default
   * with the blank meta and the DOM stays empty.
   * @internal
   */
  acceptsString: boolean
  /**
   * The field's aria satellite ids, mirroring `FieldState.aria`. The
   * directive points `aria-describedby` at `errorId` while the field
   * is in its error state. Optional so hand-rolled `RegisterValue`
   * mocks don't have to declare it; the directive skips aria wiring
   * when absent.
   * @internal
   */
  aria?: {
    readonly errorId: string
    readonly descriptionId: string
  }
  /**
   * Whether the schema marks this path required, from
   * `schema.isRequiredAtPath(segments)`. Drives `aria-required`.
   * Optional for the same mock-tolerance reason as `aria`.
   * @internal
   */
  isRequired?: boolean
  /**
   * Whether the directive should auto-manage aria attributes for this
   * binding. Resolves the per-register `autoAria` override against the
   * form-level value: `options.autoAria ?? formAutoAria`. The directive
   * treats an absent value as off.
   * @internal
   */
  ariaEnabled?: boolean
  /**
   * The gated display-state verdict for this path, reusing the same
   * field-state identity as `form.fields`. The directive watches it to
   * keep `aria-invalid` / `aria-busy` / `aria-describedby` in lockstep
   * with the visible error state, even on async ticks with no parent
   * re-render. Optional; the directive skips aria wiring when absent.
   * @internal
   */
  ariaDisplayState?: Readonly<Ref<DisplayState>>
}>

/**
 * Internal extension of `RegisterValue` that includes directive-private
 * coordination state. Imported by the directive runtime; not part of
 * the public surface.
 *
 * `lastTypedForm` is the user's most recently typed string form for a
 * numeric field while mid-typing, or `null` once the field has been
 * blurred / cleared. The directive populates it on every committable
 * input event and clears it on the change (blur) event so:
 *
 *   - Mid-typing: `displayValue` returns the typed form (e.g.
 *     `'1e2'`) when it parses back to current storage. Vue's
 *     `:value` patch then targets the typed form, which already
 *     equals the DOM — idempotent, no cursor reset.
 *   - On blur: `displayValue` falls back to `String(storage)`
 *     (`'100'`), Vue patches the DOM to match. The user sees
 *     exactly what's stored.
 *
 * Why a separate field: JavaScript's Number carries no representation
 * info — `1e2 === 100`, so `String(parseFloat('1e2'))` yields `'100'`.
 * Tracking the typed form lets us avoid Vue's mid-typing DOM yank
 * without lying about storage. Only meaningful for `.number` text
 * inputs and `<input type="number">`; other bindings ignore it.
 *
 * @internal
 */
/**
 * Mutable holder for an async-transform run's `AbortController`, shared
 * between the directive — which lazily creates the controller the first
 * time a transform reaches for `ctx.signal` — and the store, which
 * aborts it when the run is superseded, cancelled, or reset.
 * `controller` stays `null` until `ctx.signal` is actually touched, so a
 * purely-sync chain never allocates one. `aborted` latches `true` the
 * moment the store tears the run down, so a signal accessed AFTER
 * teardown still resolves to an already-aborted signal rather than a
 * live one.
 */
export type TransformAbortHolder = { controller: AbortController | null; aborted: boolean }

/**
 * The second argument handed to every transform in a `transforms: [...]`
 * chain. `signal` is an `AbortSignal` that aborts when the run is
 * superseded by a newer input, or torn down by a reset / cancel — so a
 * transform doing cancellable I/O (a `fetch`, a worker round-trip) can
 * pass `ctx.signal` through and bail the moment its result is no longer
 * wanted.
 *
 * The signal is lazy: the backing `AbortController` is allocated only on
 * first access, so a purely-synchronous chain that never reaches for
 * `ctx.signal` allocates nothing. It is meaningful for async transforms;
 * a sync chain has no in-flight I/O to cancel, so its `signal` simply
 * never aborts.
 */
export type TransformContext = { readonly signal: AbortSignal }

export type InternalRegisterValue<Value = unknown> = RegisterValue<Value> & {
  lastTypedForm: Ref<string | null>
  /**
   * Open an async-transform run at this path: bump the path's run
   * token, increment the in-flight counters (so `field.transforming` /
   * `field.busy` light up), stamp `transformingSince`, clear any prior
   * `transformError`, and register `holder` so a later supersede /
   * cancel / reset can abort the run's signal. Returns the run token —
   * pass it back to `isCurrentTransform` / `endTransform`. Store-backed;
   * the directive owns the orchestration (see `directive.ts`).
   */
  beginTransform: (holder: TransformAbortHolder) => number
  /**
   * `true` while `token` is still the live run at this path — `false`
   * once a newer input superseded it or a reset / cancel tore it down.
   * The deferred orchestrator checks this after `await` to decide
   * commit-vs-discard (latest-request-wins).
   */
  isCurrentTransform: (token: number) => boolean
  /**
   * Close the run identified by `token`: release the in-flight counters
   * and flush any `settleTransforms` waiters that just went idle.
   * Idempotent on the counters when the run was already released by a
   * supersede / cancel, so the orchestrator can call it unconditionally
   * in both the resolve and reject paths.
   */
  endTransform: (token: number) => void
  /**
   * Record a per-field normalization failure (a rejected async
   * transform, or a resolved value the slim-primitive gate refused).
   * Surfaces as `field.transformError`; a channel separate from
   * validation `errors`.
   */
  setTransformError: (err: Error) => void
  /**
   * `true` while an async transform run is in flight at this path. Set
   * synchronously by `beginTransform` (the deferred orchestrator opens
   * the run before the listener's post-write force-sync block runs), so
   * the directive's force-sync blocks read it to skip snapping the DOM
   * back to stale storage while a deferred commit is pending — the
   * resolved value is painted in once the run lands instead.
   */
  readonly transforming: boolean
}

/**
 * Custom assigner installed on an element via the directive's
 * `[assignKey]` slot OR an `@update:registerValue` listener. Called
 * by the directive when a DOM event (input / change / etc.) fires
 * on the bound element.
 *
 * The directive passes the extracted value plus the `RegisterValue`
 * the directive is currently bound to, regardless of install path.
 * The second arg lets a top-level handler write back to form state
 * without having to capture the RV via closure:
 *
 * ```ts
 * function upperCaseAssigner(value: unknown, rv: RegisterValue): void {
 *   rv.setValueWithInternalPath(String(value ?? '').toUpperCase())
 * }
 * ```
 *
 * The `registerValue` parameter is typed optional only to keep
 * standalone invocations from outside the directive (rare; manual
 * dispatch in tests, for example) type-checkable; the directive
 * itself always supplies it at fire time.
 *
 * Return `true` when the write was accepted, `false` when it was
 * rejected (e.g. the value didn't match the path's expected type).
 * `undefined` is treated as "succeeded" so simple assigners can
 * just return `void`.
 */
export type CustomDirectiveRegisterAssignerFn = (
  value: unknown,
  registerValue?: RegisterValue
) => boolean | undefined
/**
 * Generic shape of a v-register directive variant. Used by the
 * library's text / checkbox / radio / select directive types and
 * available for custom integrations that need to drop in their own
 * variant.
 *
 * The value generic admits `undefined` because `useRegister()` may
 * return `undefined` (a wrapper component rendered without a parent
 * `registerValue`); binding that value to `v-register` is supported
 * and installs a no-op assigner at runtime.
 */
export type CustomRegisterDirective<T, Modifiers extends string = string> = ObjectDirective<
  T & {
    _assigning?: boolean
    /**
     * Snapshot of the last `value.innerRef.value` reference the
     * directive's DOM-sync (setSelected / setChecked / radio
     * `el.checked = …`) was applied for. Used by every input
     * directive's `updated` / `beforeUpdate` to skip the per-render
     * DOM sync when the model is identity-unchanged — preventing
     * parent re-renders (a typed character in a sibling, an async-
     * validation tick, any reactive read) from clobbering an in-
     * progress user interaction. Identity comparison is sound:
     * every form write produces a fresh value at the path (scalars
     * are new primitives; arrays/Sets get fresh references along the
     * spine via diff-apply), so reference equality on
     * `innerRef.value` tracks "did the model move" exactly. The
     * `_assigning` gate stays alongside — it short-circuits the
     * immediate post-write render where the DOM is already in sync
     * from the user's input.
     */
    _lastAppliedModel?: unknown
    /**
     * Variant-specific "repaint the DOM from current storage" closure,
     * stashed by each input directive's `created` hook (it mirrors that
     * variant's post-write force-sync block). The deferred async-transform
     * orchestrator calls it once the resolved value has committed, so a
     * bare `<input v-register>` with no other reactive reader still paints
     * the normalized result without depending on a parent re-render.
     */
    _syncFromStorage?: () => void
    [S: symbol]: CustomDirectiveRegisterAssignerFn
  },
  RegisterValue | undefined,
  Modifiers,
  string
>

/**
 * Modifier names supported by `v-register` on `<input type="text">`,
 * `<input type="number">`, and `<textarea>`. Mirrors Vue's
 * `v-model` modifier semantics on the same elements; combine freely
 * (`<input v-register.lazy.trim.number="..." />`).
 */
export type RegisterTextModifier =
  /**
   * Write on `change` (blur) instead of `input`. The reactive
   * model only updates after the user tabs/clicks out of the
   * field. IME composition handlers are skipped under `.lazy` —
   * composition events do not gate writes.
   */
  | 'lazy'
  /**
   * Strip leading and trailing whitespace on blur. The form holds
   * the user's raw input (whitespace included) while they're
   * typing; on `change` (blur / commit) the value is trimmed
   * once and written back to both the model and the visible DOM.
   * Combine with `.lazy` to skip the mid-typing writes entirely.
   */
  | 'trim'
  /**
   * Cast the value via `parseFloat` before writing. Values that
   * can't be parsed as a number (e.g. `'abc'`) pass through
   * unchanged — the slim-primitive gate then sees a string
   * heading to a numeric slot and rejects the write. Auto-applied
   * for `<input type="number">`; explicit `.number` is redundant
   * there.
   */
  | 'number'

/**
 * v-register directive variant for `<input type="text">`,
 * `<input type="number">`, and `<textarea>`. Supports the
 * `.lazy`, `.trim`, and `.number` modifiers — see
 * `RegisterTextModifier` for per-modifier semantics.
 */
export type RegisterTextCustomDirective = CustomRegisterDirective<
  HTMLInputElement | HTMLTextAreaElement,
  RegisterTextModifier
>

/** v-register directive variant for checkboxes. No modifiers. */
export type RegisterCheckboxCustomDirective = CustomRegisterDirective<HTMLInputElement>
/** v-register directive variant for radio inputs. No modifiers. */
export type RegisterRadioCustomDirective = CustomRegisterDirective<HTMLInputElement>

/**
 * Modifier name supported by `v-register` on `<select>`. Mirrors
 * Vue's `v-model` `.number` on the same element.
 */
export type RegisterSelectModifier =
  /**
   * Cast each selected option's `value` via `parseFloat` before
   * writing. The form state holds numbers, not numeric strings —
   * useful when option values are written as strings in the
   * markup but the schema expects numbers.
   */
  'number'

/**
 * v-register directive variant for `<select>`. Supports `.number`
 * — see `RegisterSelectModifier` for semantics.
 */
export type RegisterSelectCustomDirective = CustomRegisterDirective<
  HTMLSelectElement,
  RegisterSelectModifier
>

/** v-register directive variant for the dynamic input/select/textarea bridge. */
export type RegisterModelDynamicCustomDirective = ObjectDirective<
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  RegisterValue | undefined,
  string
>
/**
 * The `v-register` directive. Binds a form field to a native
 * input, select, textarea, checkbox, or radio:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * <select v-register="form.register('country')">
 *   <option value="us">US</option>
 *   <option value="uk">UK</option>
 * </select>
 * ```
 *
 * Also works on custom components whose root is NOT a native
 * input — call `useRegister()` in the child's setup to read the
 * parent's binding, then re-bind `v-register` onto an inner native
 * element. (When the wrapper's root IS the input itself, attribute
 * fallthrough handles it; `useRegister` is unnecessary.)
 *
 * ```vue
 * <!-- Parent -->
 * <MyField label="Email" v-register="form.register('email')" />
 *
 * <!-- MyField.vue (root is <label>, not <input>) -->
 * <script setup>
 * import { useRegister } from 'attaform'
 * defineProps<{ label: string }>()
 * const register = useRegister()
 * </script>
 * <template>
 *   <label>
 *     <span>{{ label }}</span>
 *     <input v-register="register" />
 *   </label>
 * </template>
 * ```
 *
 * Modifier support varies by element:
 *   - text / number / textarea: `.lazy`, `.trim`, `.number`
 *   - select: `.number`
 *   - checkbox / radio: none
 *
 * See `RegisterTextModifier` / `RegisterSelectModifier` for
 * per-modifier semantics.
 *
 * Registered globally by `createAttaform()` (and by the
 * `attaform/nuxt` module). Most consumers don't import the
 * directive itself — it's exposed for integrations that install
 * directives manually.
 */
export type RegisterDirective =
  | RegisterTextCustomDirective
  | RegisterCheckboxCustomDirective
  | RegisterSelectCustomDirective
  | RegisterRadioCustomDirective
  | RegisterModelDynamicCustomDirective

/**
 * Module augmentation: register `v-register` with Vue's template
 * type system. Lives in `types-api` because every public entry
 * (`attaform`, `attaform/zod`, `attaform/zod-v3`, `attaform/zod-v4`)
 * transitively reaches this file via the `useForm` return type, so
 * the augmentation propagates to consumer SFCs regardless of which
 * entry they import from — and regardless of whether they install
 * `attaform/nuxt` or the Vite plugin.
 *
 * Augmentation targets `vue` rather than `@vue/runtime-core`:
 * `GlobalDirectives` is originally declared in `@vue/runtime-core`,
 * but consumers and Volar's strict-template codegen both resolve
 * the interface through `vue`'s `export * from '@vue/runtime-dom'`
 * → `export * from '@vue/runtime-core'` chain. TypeScript merges
 * interfaces across re-exports, so augmenting `'vue'` reaches Volar
 * without needing `@vue/runtime-core` to be hoisted into the
 * library's own `node_modules` for its own typecheck.
 */
declare module 'vue' {
  interface GlobalDirectives {
    /**
     * The `v-register` directive. Binds a form field to a native
     * input, select, textarea, checkbox, or radio:
     *
     * ```vue
     * <input v-register="form.register('email')" />
     * ```
     *
     * Also works on custom components whose root is NOT a native
     * input — call `useRegister()` in the child's setup to read the
     * parent's binding, then re-bind `v-register` onto an inner
     * native element. (When the wrapper's root IS the input itself,
     * attribute fallthrough handles it; `useRegister` is unnecessary.)
     *
     * Modifier support varies by element:
     *   - text / number / textarea: `.lazy`, `.trim`, `.number`
     *   - select: `.number`
     *   - checkbox / radio: none
     */
    vRegister: RegisterDirective
  }
}

/**
 * Callback form of `setValue`'s value argument. Receives the previous
 * value at the path and returns the next value:
 *
 * ```ts
 * form.setValue('count', (prev) => prev + 1)
 * form.setValue((prev) => ({ ...prev, name: 'Ada' }))
 * ```
 *
 * The library fills any missing structural slots (e.g. nested
 * objects) against the schema's defaults after the callback returns,
 * so partial returns are safe.
 */
export type SetValueCallback<Read, Write = Read> = (prev: Read) => Read | Write

/**
 * The value argument of `form.setValue`. Either the next value
 * directly, or a callback that derives it from the previous value.
 *
 * Type parameters:
 * - `Write` — what the direct value form accepts (the storable shape
 *   at the path).
 * - `Read` — what the callback's `prev` argument exposes (defaults
 *   to `Write`). For whole-form callbacks the read shape tags
 *   array elements as possibly-undefined to reflect runtime reality.
 */
export type SetValuePayload<Write, Read = Write> = Write | SetValueCallback<Read, Write>

/**
 * Detect `any` distinctly from `unknown`. The trick: `1 & any` is `any`
 * and `0 extends any` is `true`; `1 & unknown` is `1` and `0 extends 1`
 * is `false`. Used to fork `PathSetValuePayload` so `z.any()` paths
 * resolve to `any` (matching the read-side surface) and `z.unknown()` /
 * preprocess paths resolve to `unknown` (matching Zod's input typing).
 */
type IsAny<T> = 0 extends 1 & T ? true : false

/**
 * Resolves `setValue`'s `value` argument type at a single `Path` leaf.
 *
 * Three branches, one per Zod input-typing case:
 *
 *   1. **`any` leaf (`z.any()`)** — schema input type is `any`; the
 *      whole form API surface (read, register, fields) is `any` at
 *      this path. This branch returns raw `any` so `setValue` stays
 *      consistent with the rest. Callsites that pass an unannotated
 *      `(prev) => ...` may surface `noImplicitAny` under the
 *      consumer's tsconfig — annotate `(prev: any) => ...` to opt
 *      into the looser shape explicitly.
 *
 *   2. **`unknown` leaf (`z.unknown()`, `z.preprocess()` input)** —
 *      schema input is unconstrained; consumers narrow before use.
 *      The branch returns `({} | null | undefined) | ((prev: unknown)
 *      => unknown)` instead of a `SetValuePayload<unknown, ...>`-style
 *      union for three reasons:
 *
 *      a. **Union absorption** — `unknown | X` collapses to `unknown`,
 *         erasing the callback union member. With the callback shape
 *         gone, TS has no contextual type for `prev` and decays it to
 *         implicit `any` under `noImplicitAny`. The triple
 *         `{} | null | undefined` is structurally equivalent to
 *         `unknown` (covers the same value space) but is NOT subject
 *         to absorption — the callback branch survives the union and
 *         `prev` infers cleanly to `unknown`.
 *
 *      b. **`NonNullable<unknown> = {}`** — applying `NonNullable` to
 *         the read slot for an unknown leaf narrows `prev` to `{}`,
 *         which is looser than `unknown` (allows ad-hoc property
 *         access). This branch keeps the read slot as `unknown`
 *         directly so the consumer is forced to narrow.
 *
 *      c. **`Unset`-widening doesn't apply** — `DefaultValuesShape`
 *         widens primitive leaves to admit `unset`; for an unknown
 *         leaf there's no primitive to widen. The open-form triple
 *         covers the same value space the runtime accepts (any
 *         value, including `unset` — symbols are `{}`).
 *
 *   3. **All other leaves** — flow through unchanged via
 *      `SetValuePayload<DefaultValuesShape<Leaf>, NonNullable<WriteShape<Leaf>>>`.
 */
export type PathSetValuePayload<Leaf> =
  IsAny<Leaf> extends true
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    : unknown extends Leaf
      ? // eslint-disable-next-line @typescript-eslint/no-empty-object-type
          ({} | null | undefined) | ((prev: unknown) => unknown)
      : SetValuePayload<DefaultValuesShape<Leaf>, NonNullable<WriteShape<Leaf>>>

/**
 * Per-field reactive shape returned by `form.fields.<leaf-path>` and
 * `form.fields(path)`. Slim, readonly across the board. The unified
 * shape replaces the older split between `FieldState` /
 * `FieldStateBranch`: one type lives at every path, with aggregations
 * rolled up at containers.
 *
 * Leaf-aware: this shape only injects these keys at LEAF paths via
 * dot-access. At container paths the proxy descends without
 * injecting, so a schema field literally named `dirty` at depth 2+
 * stays reachable as a descent target — no shadowing. Container
 * call-form (`form.fields('address')`) returns a `FieldState`
 * surface where the keys are aggregations of the descendant leaves.
 */
export type FieldState<Value = unknown> = {
  readonly value: Value
  readonly original: Value
  readonly pristine: boolean
  readonly dirty: boolean
  readonly focused: boolean | null
  readonly blurred: boolean | null
  readonly touched: boolean
  /**
   * `true` once the user has issued at least one value edit on this
   * field through `v-register` (an insert or a delete), sticky
   * thereafter and preserved across disconnects. Distinct from
   * `dirty`: typing `"a"` then deleting it back to empty leaves the
   * field net-unchanged (`dirty: false`) yet `interacted: true`.
   * Distinct from `touched`: tabbing through a field without editing
   * flips `touched` but never `interacted`. Set only by user input,
   * never by hydration or programmatic `setValue`; cleared by
   * `form.reset()` / `form.resetField(path)`. Containers roll it up as
   * a disjunction (any descendant interacted).
   */
  readonly interacted: boolean
  /**
   * `true` once the user has blurred this field after editing it: the
   * first time they edit a value and then leave. Sticky thereafter and
   * preserved across disconnects; a tab-through with no edit never sets
   * it (`interacted` is still false at that blur). It composes
   * `interacted` with the departure and drives the default display gate,
   * so errors reveal once the user finishes a pass and leaves, then stay
   * visible through a re-focus to be fixed live. Set only by user
   * input/blur, never by hydration or programmatic writes; cleared by
   * `form.reset()` / `form.resetField(path)`. Containers roll it up as a
   * disjunction.
   */
  readonly blurredAfterInteraction: boolean
  readonly connected: boolean
  /**
   * The first DOM element bound to this path via `v-register`, or
   * `null` when none is registered (initial mount, post-unmount,
   * SSR). "First" means first by registration order. Reach for it
   * when you need to call a native DOM method on a field's input —
   * `focus()`, `scrollIntoView()`, `select()`, `setSelectionRange()`,
   * etc. — without the library having to verb every imperative:
   *
   * ```ts
   * form.fields.email.element?.focus()
   * form.fields.email.element?.scrollIntoView({ block: 'center' })
   * ```
   *
   * For paths with multiple bindings (input syncing, mirrored
   * shadow inputs), prefer `elements` and pick the right target
   * yourself. Reactive: register / deregister triggers
   * re-evaluation.
   */
  readonly element: HTMLElement | null
  /**
   * Every DOM element currently bound to this path via `v-register`,
   * in registration order. Empty array when none is registered.
   * Two bindings to the same path are intentional — input syncing,
   * mirrored shadow inputs:
   *
   * ```ts
   * for (const el of form.fields.email.elements) el.blur()
   * ```
   *
   * For the common single-binding case, reach for `element` — sugar
   * over `elements[0] ?? null`.
   */
  readonly elements: readonly HTMLElement[]
  readonly updatedAt: string | null
  readonly errors: readonly ValidationError[]
  /**
   * `true` while a per-field validation run is in flight at this path.
   * Reflects field-level debounced runs (`validate-on-change`) and
   * cross-field re-validations targeting this path. Whole-form
   * `validate()` / `validateAsync()` calls drive `form.meta.validating`
   * only — they don't flip per-field flags.
   *
   * Per-field analogue of `form.meta.validating`. Use for a tight
   * "Checking…" indicator next to a single async-validated input
   * without commandeering the whole-form spinner.
   */
  readonly validating: boolean
  /**
   * `true` when this field has no errors AND no per-field validation
   * is in flight (`errors.length === 0 && !validating`). Confidence
   * that "we've checked, and we have no problems right now." Use for
   * green-checkmark / `aria-invalid` UX.
   *
   * Validation-only: an in-flight async transform does NOT clamp
   * `valid` to `false`. `valid` is the verdict on the last committed
   * value; `busy` is the union "work in flight" signal.
   */
  readonly valid: boolean
  /**
   * `true` while an async `register` transform is in flight at this
   * path: a transform returned a thenable and the resolved value has
   * not yet committed to form state. Always `false` for a sync-only
   * chain, which reaches form state in the same tick with no deferral.
   * Containers roll it up as a disjunction (any descendant transforming).
   */
  readonly transforming: boolean
  /**
   * `transforming || validating` — the union "work is in flight at this
   * path" signal. Drives `aria-busy` through `displayState` on a
   * revealed field, and is the surface to bind for a busy indicator on a
   * field not yet revealed (where `displayState` stays idle by the
   * reveal gate). Containers roll it up as a disjunction.
   */
  readonly busy: boolean
  /**
   * The `Error` from the most recent async transform that rejected at
   * this path, else `null`. A per-field normalization-failure channel
   * separate from validation `errors`: a transform that rejects (a
   * failed fetch, a parse error) surfaces here instead of crashing the
   * host app or logging. Cleared when a fresh transform starts or a
   * write supersedes it. Leaf-only — containers do not roll it up (it is
   * always `null` at a container path).
   */
  readonly transformError: Error | null
  /**
   * The single display-state verdict at this path: `'idle'`,
   * `'pending'`, `'error'`, or `'success'`. The source of truth the
   * four `show*` booleans below derive from. Bind it directly when one
   * branch over the set reads cleaner than four flags:
   *
   * ```vue
   * <FieldStatusIcon :state="form.fields.email.displayState" />
   * ```
   *
   * Resolved by the `getDisplayState` heuristic:
   * `useForm({ getDisplayState })` →
   * `createAttaform({ defaults: { getDisplayState } })` → library
   * default (`defaultDisplayState`). Override per form, app-wide, or
   * compose with `defaultDisplayState` for a layered predicate.
   *
   * Available on container paths too: `form.fields.users[0].displayState`
   * rolls up over the row's descendants.
   */
  readonly displayState: DisplayState
  /**
   * `displayState === 'error'`. The centralised "render this field's
   * errors right now?" gate, so templates avoid re-spelling the
   * heuristic at every error site:
   *
   * ```vue
   * <span v-if="form.fields.email.showErrors">
   *   {{ form.fields.email.firstError?.message }}
   * </span>
   * ```
   *
   * Kept plural to match `errors` / `firstError`. On container paths it
   * rolls up over descendants (any descendant resolving to `'error'`
   * flips the container on).
   */
  readonly showErrors: boolean
  /**
   * `displayState === 'pending'`. A per-field validation run is in
   * flight at this path and the prior verdict is stale; drive a spinner
   * or a "Checking…" affordance.
   */
  readonly showPending: boolean
  /**
   * `displayState === 'success'`. Validation has passed and the timing
   * gate has cleared a positive confirmation; drive the green-check
   * pattern.
   */
  readonly showSuccess: boolean
  /**
   * `displayState === 'idle'`. Nothing to surface yet — pre-interaction,
   * or gate-open with no verdict worth showing. Read it to suppress
   * helper text the moment any other signal takes over.
   */
  readonly showIdle: boolean
  /**
   * The first `ValidationError` at this path in the deterministic
   * schema-declaration order — equivalent to `errors[0]`, exposed as
   * a sugar accessor for the common case of "show the highest-priority
   * error message and ignore the rest":
   *
   * ```vue
   * <span v-if="form.fields.email.showErrors">
   *   {{ form.fields.email.firstError?.message }}
   * </span>
   * ```
   *
   * `undefined` when no errors exist. Independent of `showErrors` —
   * the data primitive is always available; the heuristic only
   * decides when to render it.
   *
   * On container paths, the first error in the aggregated subtree
   * (descendants sorted by `pathOrdinal`).
   */
  readonly firstError: ValidationError | undefined
  readonly path: ReadonlyArray<string | number>
  /**
   * Stable, SSR-safe DOM id for this field, unique across every mount
   * on the page. Derived from the form's key and this path, folded with
   * the form's per-mount `instanceId` so two simultaneous mounts of the
   * same keyed form never collide. Bind it to wire a label and its
   * input without inventing your own id:
   *
   * ```vue
   * <label :for="form.fields.email.id">Email</label>
   * <input :id="form.fields.email.id" v-register="form.register('email')" />
   * ```
   *
   * Treat as identity, not state: stable for the path across the form's
   * lifetime, opaque, not meant to be parsed.
   */
  readonly id: string
  /**
   * Satellite ids derived from {@link id} for the elements that
   * describe this field. Wire them to an error node and a description
   * node so assistive tech announces them with the input. The
   * `v-register` directive points `aria-describedby` at `errorId`
   * automatically while the field is in its error state; you render the
   * matching element and id it:
   *
   * ```vue
   * <input v-register="form.register('email')" />
   * <span :id="form.fields.email.aria.errorId" v-if="form.fields.email.showErrors">
   *   {{ form.fields.email.firstError?.message }}
   * </span>
   * ```
   *
   * `descriptionId` is for opt-in help text; chain it into your own
   * `aria-describedby` when you render a persistent description element.
   */
  readonly aria: {
    readonly errorId: string
    readonly descriptionId: string
  }
  /**
   * Stable identity for this field as an element of its parent array,
   * suitable as a Vue `:key` when iterating array elements. An allocated
   * token (not derived from the element's value) that follows the
   * element across inserts, removals, moves, and swaps, so a row keeps
   * its component instance across a reorder. Empty for fields that are
   * not array elements. Treat as opaque identity, not state.
   */
  readonly key: string
  readonly blank: boolean
  /**
   * Presentational label for this field. Resolves through the
   * shared cross-adapter field-meta store — written via
   * `schema.register(fieldMeta, {...})` (Zod 4 native chain) or the
   * `withMeta()` helper (works on both majors) — and falls back to
   * a humanized form of the path's last segment when nothing has
   * been registered. Always a string.
   *
   * ```ts
   * z.string().register(fieldMeta, { label: 'Reference' })
   * // template: <label>{{ form.fields.reference.label }}</label>
   * ```
   *
   * Numeric segments (array indices) collapse to the empty string;
   * consumers wanting "Item 3" substitute their own format.
   */
  readonly label: string
  /**
   * Helper-text description for this field. Reads from the
   * registered `description` first; falls back to the schema's own
   * `.describe('...')` value (both Zod 3 and Zod 4 expose that as
   * `schema.description`); `undefined` when neither is set.
   *
   * Useful for `aria-describedby`-linked help text. Distinct from
   * `label` — descriptions are longer prose, labels are short
   * presentational nouns.
   */
  readonly description: string | undefined
  /**
   * Placeholder hint for input affordance. Reads from the
   * registered `placeholder`; `undefined` otherwise.
   */
  readonly placeholder: string | undefined
  /**
   * Full registered metadata payload, frozen — empty object when
   * nothing has been registered. Use as an escape hatch for
   * consumer-augmented keys (declared via TypeScript module
   * augmentation on `FieldMetaPayload`):
   *
   * ```ts
   * declare module 'attaform/zod' {
   *   interface FieldMetaPayload { tooltip?: string }
   * }
   * // template: {{ form.fields.email.meta.tooltip }}
   * ```
   */
  readonly meta: Readonly<FieldMetaPayload>
}

/**
 * Recursive type behind `form.fields`. Leaf-aware branching: at
 * primitive paths (string, number, boolean, bigint, Date, …) the
 * proxy returns a `FieldState`; at container paths (object,
 * array, …) the proxy descends without injecting leaf-keys.
 *
 * Field-name collisions at depth 2+ resolve unambiguously: a schema
 * field literally named `dirty` at depth 2 is reachable as a
 * descent target (`form.fields.address.dirty` returns the
 * FieldState for `address.dirty`). Reading `dirty` AT the
 * leaf-view (`form.fields.address.dirty.dirty`) reads the leaf's
 * own dirty boolean — path-segment and leaf-prop occupy different
 * proxy depths.
 *
 * The runtime implementation queries `schema.isLeafAtPath(segments)`
 * at every step; this type approximates that decision using
 * "T extends primitive". The two stay in sync for typical schemas;
 * exotic adapter-defined leaf kinds (custom `Date`-like) may need
 * a runtime check (the runtime is authoritative).
 *
 * The mapped type strips optional flags (`-?:`) because the field-
 * state surface always exposes a record per known leaf, regardless
 * of whether the schema field is declared `.optional()`. Optional
 * schemas mean the VALUE can be undefined — `FieldState<string |
 * undefined>` carries that — but the FieldState wrapper itself
 * always exists. Without the strip, `form.fields.notes` (where
 * `notes?: string`) would type as `FieldState<...> | undefined`,
 * forcing consumers to optional-chain through every reactive read.
 *
 * For discriminated-union containers the object branch uses
 * `[T] extends [object]` (non-distributive) plus
 * `KeyofUnion`/`ValueOfUnion` to merge variant key sets — so
 * `form.fields.cargo.tempMinC` (refrigerated-only) is reachable
 * regardless of the active variant, with the leaf typed as
 * `FieldState<number | undefined>`. Matches the runtime's stub
 * `FieldState` for inactive-variant paths.
 */
/**
 * Leaf-shape dispatch table for `LeafWalker`. Each entry maps a walker
 * kind to the leaf type that walker produces at primitive / Date /
 * non-recursable positions. The lookup `LeafSchemeFor<T>[Kind]`
 * threads `T` through the leaf type when the kind needs it
 * (`field` carries `FieldState<T>`); kinds that don't depend on
 * `T` simply ignore it (`errors` always produces
 * `readonly ValidationError[] | undefined`).
 *
 * Adding a new walker is one entry here plus a one-line wrapper
 * alias (`type FooShape<T> = LeafWalker<T, 'foo'>`). The walker
 * topology is shared; only the leaf changes.
 *
 * The `errors` entry threads `T` to preserve `| undefined` when the
 * value type itself includes undefined (DU variant-only fields whose
 * lifted shape resolves to `X | undefined`). Statically-known leaves
 * collapse to `readonly ValidationError[]` (no undefined); dynamic-key
 * boundaries (array indices, record keys) re-introduce `| undefined`
 * via the structural index-signature channels.
 *
 * Preprocess / coerce leaves (StorageShape = `unknown`) are
 * statically known too — the IsUnknown filter keeps them on the
 * non-optional branch instead of being swept into the dynamic
 * `| undefined` arm by `undefined extends unknown`.
 *
 * Implementation-detail surface — consumers reach for `FieldStateMap`
 * or `FormErrorsSurface` instead.
 */
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false

export interface LeafSchemeFor<T> {
  field: FieldState<T>
  errors: IsUnknown<T> extends true
    ? readonly ValidationError[]
    : undefined extends T
      ? readonly ValidationError[] | undefined
      : readonly ValidationError[]
}

/**
 * Generic walk that produces a proxy shape over `T` with leaves
 * dispatched via `LeafSchemeFor<T>[Kind]`. The walk topology
 * (object → mapped homomorphic, object-union → KeyofUnion merge,
 * array → indexed, primitive / Date → terminal) is identical
 * across walker kinds; only the leaf type differs.
 *
 * Replaces the duplicated bodies of `FieldStateMapEntry` and
 * `ErrorsProxyShape`. The prior duplication walked the same shape
 * twice per useForm return type — once for the fields proxy, once
 * for the errors proxy. Factoring lets the bundled `.d.ts` carry one
 * shared walker body plus per-kind one-line wrappers, halving the
 * recursive depth contribution from these two proxies on consumer
 * call sites.
 *
 * `StripOptional` controls whether optional modifiers on input
 * properties are stripped at every recursion level. `true` (default)
 * matches the fields proxy semantics — every known leaf carries a
 * `FieldState` wrapper regardless of source `?`. `false` matches the
 * errors proxy semantics — the proxy shape stays structurally
 * identical to the input form, optional keys included.
 *
 * Implementation-detail surface — consumers reach for `FieldStateMap`
 * or `FormErrorsSurface` instead.
 */
export type LeafWalker<
  T,
  Kind extends keyof LeafSchemeFor<unknown>,
  StripOptional extends boolean = true,
> = [T] extends [string | number | boolean | bigint | symbol | null | undefined | Date | File]
  ? LeafSchemeFor<T>[Kind]
  : [T] extends [ReadonlyArray<infer U>]
    ? {
        // Array element: an index signature, so `noUncheckedIndexedAccess`
        // adds the `| undefined` on a direct index read (`form.fields
        // .tags[99]`, matching the runtime's truthful gate at an
        // out-of-bounds index) while `v-for` iteration over present
        // elements stays guard-free.
        readonly [K: number]: LeafWalker<U, Kind, StripOptional>
      } & ContainerSelfErrorsSlot<T, Kind>
    : [T] extends [object]
      ? string extends keyof T
        ? {
            // Record value: the homomorphic map (`[K in keyof T]`) keeps a
            // type that merely INTERSECTS a record (`{ a: X } & Record<
            // string, Y>`, e.g. a `.passthrough()` object or a widened
            // test form) addressable by its declared keys rather than
            // collapsing to a bare index signature. A pure record reduces
            // to a string index signature, so `noUncheckedIndexedAccess`
            // adds the `| undefined` on a missing-key read (matching the
            // runtime's truthful gate) while `v-for` stays guard-free.
            readonly [K in keyof T]: LeafWalker<T[K], Kind, StripOptional>
          } & ContainerSelfErrorsSlot<T, Kind>
        : [IsUnion<T>] extends [true]
          ? StripOptional extends true
            ? {
                readonly [K in KeyofUnion<T>]-?: DiscriminatedLeaf<T, K, Kind, StripOptional>
              } & ContainerSelfErrorsSlot<T, Kind>
            : {
                readonly [K in KeyofUnion<T>]: DiscriminatedLeaf<T, K, Kind, StripOptional>
              } & ContainerSelfErrorsSlot<T, Kind>
          : StripOptional extends true
            ? {
                readonly [K in keyof T]-?: LeafWalker<T[K], Kind, StripOptional>
              } & ContainerSelfErrorsSlot<T, Kind>
            : {
                readonly [K in keyof T]: LeafWalker<T[K], Kind, StripOptional>
              } & ContainerSelfErrorsSlot<T, Kind>
      : LeafSchemeFor<T>[Kind]

/**
 * One key of a discriminated-union container in `LeafWalker`. A key
 * present (and required) in EVERY variant is universal — its node is
 * always reachable. A variant-only or optional-in-some key is a dynamic
 * hop: its node is `undefined` when its variant isn't active, so it
 * carries node-optionality (`LeafWalker<…> | undefined`), NOT value-
 * optionality (`LeafWalker<… | undefined>`). `PresentValueOfUnion`
 * strips the synthetic absent-variant `undefined` so the present node
 * resolves to the precise value type; a genuine `undefined` from an
 * `optional` declaration survives.
 *
 * Universality is `[T] extends [Record<K, unknown>]` — true iff `T`
 * (the whole union) satisfies "has K, required", which holds only when
 * every variant declares K as a required property.
 */
type DiscriminatedLeaf<
  T,
  K extends PropertyKey,
  Kind extends keyof LeafSchemeFor<unknown>,
  StripOptional extends boolean,
> = [T] extends [Record<K, unknown>]
  ? LeafWalker<PresentValueOfUnion<T, K>, Kind, StripOptional>
  : LeafWalker<PresentValueOfUnion<T, K>, Kind, StripOptional> | undefined

/**
 * Intersection augmenting every container in the `form.errors` walker
 * with a `''` sentinel slot — the per-container home for cross-field
 * refine errors, server-side container marks, and (at root) form-level
 * errors. Gated on `Kind extends 'errors'` so `form.values` and
 * `form.fields` surfaces stay untouched. Carve-out for schemas that
 * legitimately declare a `''` field: the declared field type wins; at
 * runtime the two collide harmlessly (errors at the literal leaf and
 * any container-self errors share the slot via array concat).
 */
type ContainerSelfErrorsSlot<T, Kind> = Kind extends 'errors'
  ? '' extends keyof T
    ? unknown
    : { readonly ['']: readonly ValidationError[] }
  : unknown

export type FieldStateMapEntry<T> = LeafWalker<T, 'field'>

/**
 * Result of the `form.fields(path)` string call-form. A path the schema
 * declares resolves to its `FieldState` — a leaf's value type, or a
 * container's rolled-up aggregate (every FieldState property exists
 * regardless of the value type). A path the schema lacks resolves to
 * `undefined`, because a typo is not a field and the runtime hands back
 * `undefined` rather than a phantom stub. A non-literal `string` could
 * be either, so it widens to `FieldState<unknown> | undefined`.
 *
 * Named (rather than inlined into the `FieldStateMap` call signature) so
 * the conditional is one cached type — keeps two structurally-identical
 * `FieldStateMap` instantiations (e.g. the unified `attaform/zod` return
 * and `UseFormReturnV4`) relatable instead of collapsing to a nominal
 * "two different types with this name" mismatch.
 */
export type FieldCallResult<Form, P extends string> = [P] extends [FlatPath<Form>]
  ? FieldState<NestedType<Form, P>>
  : string extends P
    ? FieldState<unknown> | undefined
    : undefined

/**
 * Type of `form.fields` — leaf-aware drillable callable Proxy. At
 * a leaf path the proxy resolves to a `FieldState<Value>`; at
 * a container path it returns a sub-proxy you can keep drilling.
 *
 * Augmented with the callable signatures so dot-access and function-
 * call coexist on the same identifier:
 *
 * ```ts
 * form.fields.email.value           // string (leaf-prop on FieldState)
 * form.fields('email').value        // function-call (dynamic / programmatic)
 * form.fields(['users', 0, 'name']) // path-array form
 * form.fields()                     // root proxy
 * ```
 *
 * Single-bracket dotted access (`form.fields['address.city']`) is
 * intentionally NOT supported — JS object semantics treat the dotted
 * string as a single key. Use chained dot/bracket or the callable
 * form.
 */
export type FieldStateMap<Form extends GenericForm> = LeafWalker<Form, 'field'> & {
  /**
   * String-path form (dynamic / programmatic). See {@link FieldCallResult}:
   * a path the schema declares resolves to its precise `FieldState`, a
   * path it lacks to `undefined`, and a non-literal `string` to
   * `FieldState<unknown> | undefined`.
   */
  <P extends string>(path: P): FieldCallResult<Form, P>
  /**
   * Tuple-segment form. Returns the typed `FieldStateMapEntry` for
   * the resolved path when the tuple resolves to a known path.
   * Equivalent to `form.fields[a][b][...]` but useful when the path
   * is built from variables.
   */
  <const S extends ReadonlyArray<string | number>>(
    segments: S & ([JoinSegments<S>] extends [FlatPath<Form>] ? unknown : never)
  ): FieldStateMapEntry<NestedType<Form, JoinSegments<S>>>
  /**
   * Dynamic-array fallback for callers passing `Path`-typed (runtime)
   * segment arrays — e.g. forwarding `RegisterValue.segments` to
   * resolve a field view. The path may not resolve, so the result
   * widens with `| undefined`; cast when the value type is known.
   */
  (segments: ReadonlyArray<string | number>): FieldState<unknown> | undefined
  /**
   * No-arg call returns the root FieldState — same as
   * `form.fields([])`. Aggregates over the whole form (one
   * conjunction over every active-variant leaf).
   */
  (): FieldState<Form>
}

/**
 * Untyped error map keyed by dotted-string path. The same data
 * exposed by `form.errors`, but as a plain record — useful when
 * routing API errors that may land on paths the form's TypeScript
 * type doesn't know about.
 */
export type FormErrorRecord = Record<string, ValidationError[]>

/**
 * Type of `form.errors`. Leaf-aware drillable callable Proxy. At a
 * statically-known leaf the proxy resolves to `readonly ValidationError[]`
 * (empty array when no errors land); at dynamic boundaries (array
 * indices, record keys, DU variant-only fields) it resolves to
 * `readonly ValidationError[] | undefined`. At a container path it
 * returns a sub-proxy you can keep drilling.
 *
 * Dot/bracket access mirrors the schema shape:
 *
 * ```ts
 * form.errors.email                  // readonly ValidationError[] (static leaf)
 * form.errors.user.profile.email     // readonly ValidationError[] (chained static leaves)
 * form.errors.posts[3]?.title        // readonly ValidationError[] | undefined (past array boundary)
 * form.errors.address                // sub-proxy (container — descend further)
 * ```
 *
 * Callable form for dynamic / programmatic paths:
 *
 * ```ts
 * form.errors('user.profile.email')              // dotted-string
 * form.errors(['user', 'profile', 'email'])      // path-array
 * form.errors()                                  // root proxy
 * ```
 *
 * Single-bracket dotted access (`form.errors['user.profile.email']`)
 * is intentionally NOT supported — JS object semantics treat the
 * dotted string as a single key, which would land on a non-existent
 * path. Use chained dot/bracket access or the callable form.
 */

/**
 * Recursive shape of the `form.errors` proxy. Mirrors the schema:
 * statically-known primitive leaves expose `readonly ValidationError[]`
 * (always an array; empty when no errors); leaves whose value type
 * itself includes `undefined` (DU variant-only fields) keep the
 * `| undefined` branch. Containers expose a sub-shape you can keep
 * drilling. Arrays expose numeric-indexed sub-shapes; reading a
 * numeric index introduces `| undefined` via noUncheckedIndexedAccess.
 *
 * Augmented with the callable signatures so dot-access and function-
 * call coexist on the same identifier.
 */
export type FormErrorsSurface<Form> = ErrorsProxyShape<Form> & {
  (path: string): readonly ValidationError[]
  /**
   * Tuple-segment form. Validated against `FlatPath<Form>` so literal
   * tuples that don't resolve to a known path fail at the call site.
   * Dynamic `Path`-typed inputs hit the untyped fallback overload below.
   */
  <const S extends ReadonlyArray<string | number>>(
    segments: S & ([JoinSegments<S>] extends [FlatPath<Form>] ? unknown : never)
  ): readonly ValidationError[]
  (segments: ReadonlyArray<string | number>): readonly ValidationError[]
  /**
   * No-arg call returns the form-level error aggregate — same as
   * `form.errors([])` and `form.meta.errors`. Always a readonly array;
   * empty when the form has no errors.
   */
  (): readonly ValidationError[]
}

/**
 * Implementation-detail walker backing `form.errors` typed proxy.
 * Thin alias over `LeafWalker<T, 'errors', false>` — the shared walker
 * topology is defined once at `LeafWalker` and parameterized via
 * `LeafSchemeFor`. `false` preserves optional-key modifiers (errors
 * proxy mirrors the input shape including `?`); contrast with the
 * fields proxy alias which strips them via the default `true`.
 *
 * Exported so the bundled `.d.ts` references a single alias body
 * rather than re-emitting the full union-aware recursion at every
 * consumer call site that types `form.errors`. Multiple useForm
 * instances in one scope otherwise compound this into TS2589
 * territory. Consumers should reach for `FormErrorsSurface` instead.
 */
export type ErrorsProxyShape<T> = LeafWalker<T, 'errors', false>

/**
 * Type of `form.values`. Drillable readonly callable proxy. Unlike
 * `form.errors` and `form.fields`, containers are USEFUL terminals:
 * `form.values.address` returns the actual `{ city, … }` subtree
 * (and keeps drilling). Asymmetry justified by density — every
 * container in `values` carries meaningful data; in errors / fields
 * containers are derivations.
 *
 * ```ts
 * form.values.email                  // string (the value)
 * form.values.address                // { city, … } — object (drillable)
 * form.values.address.city           // string (chained descent)
 * form.values('address.city')        // function-call (dynamic / programmatic)
 * form.values(['address', 'city'])   // path-array form
 * form.values()                      // the whole form value (root)
 * ```
 *
 * Single-bracket dotted access (`form.values['address.city']`) is
 * intentionally NOT supported — JS object semantics treat the dotted
 * string as a single key. Use chained dot/bracket or the callable
 * form.
 *
 * The chained shape applies the discriminated-union lift via
 * `LiftedValueShape<F>` so per-variant keys are reachable without
 * narrowing first (e.g. `form.values.cargo.permitNumber` types as
 * `string | undefined` regardless of which cargo variant is active —
 * matching the runtime, where plain JS object access on a missing
 * variant key returns `undefined`). The strict-variant shape is
 * still required at the WRITE side: `setValue` and `defaultValues`
 * use the un-lifted `WriteShape` so consumers can't accidentally
 * hand the form a partial / cross-variant object.
 */
export type ValuesSurface<F> = Readonly<LiftedValueShape<F>> & {
  (path: string): unknown
  (path: ReadonlyArray<string | number>): unknown
  (): Readonly<F>
}

/**
 * A single server-side error entry. Carries both the human-readable
 * `message` and a stable `code` identifier — both fields are required.
 * The `code` is stamped verbatim onto the produced `ValidationError`,
 * so consumers can branch on it without string-matching on `message`.
 *
 * Pick a prefix for your codes (`api:`, `auth:`, etc.) and stay
 * consistent so error-rendering UIs can switch on the code.
 */
export type ApiErrorEntry = {
  /** Human-readable failure description. */
  message: string
  /**
   * Stable machine identifier for the failure (e.g. `'api:duplicate-email'`).
   * Forwarded verbatim onto the produced `ValidationError`.
   */
  code: string
}

/**
 * Shape of a server-side error details record. Keys are dotted field
 * paths; values are either a single entry, an array of entries, or a
 * mix of structured and bare-string entries. Each entry is one of:
 *
 * - **Structured** — `{ message: string, code: string }`. The `code`
 *   forwards verbatim onto the produced `ValidationError`.
 * - **Bare string** — a plain string. The Rails / Django REST
 *   Framework / Laravel default JSON shape (`{ field: ["msg"] }`).
 *   Synthesized into `{ message: <string>, code: <defaultCode> }` at
 *   parse time, where `defaultCode` defaults to `'api:unknown'` and
 *   is configurable via `parseApiErrors`'s options bag.
 *
 * Multiple entries at the same path produce multiple
 * `ValidationError`s — useful for a single field that fails multiple
 * checks (e.g. `password` is too short *and* missing a digit).
 */
export type ApiErrorDetails = Record<string, ApiErrorValue>

/**
 * One entry inside an {@link ApiErrorDetails} value — either the
 * strict `{ message, code }` object, or a bare string (synthesised
 * with the parser's `defaultCode`).
 */
export type ApiErrorValue = string | ApiErrorEntry | ReadonlyArray<string | ApiErrorEntry>

/**
 * Outer envelope `parseApiErrors` accepts. Both the wrapped form
 * (`{ error: { details } }`) and the unwrapped form (`{ details }`)
 * are recognised; raw detail records (`{ email: { message, code } }`)
 * are also accepted directly.
 */
export type ApiErrorEnvelope = {
  /** Wrapped error envelope — `parseApiErrors` reads `details` from inside. */
  error?: {
    details?: ApiErrorDetails
    [k: string]: unknown
  }
  /** Unwrapped error envelope. */
  details?: ApiErrorDetails
}

/**
 * Reactive form-level flags, counters, and aggregates returned as
 * `form.meta`. "Meta" because every other surface (`form.values`,
 * `form.errors`, `form.fields`) is data-shaped — `form.meta` holds
 * facts derived ABOUT the form.
 *
 * Read fields directly with no `.value` — they auto-unwrap inside
 * the reactive object:
 *
 * ```vue
 * <button :disabled="form.meta.submitting">Save</button>
 * ```
 *
 * Watch a single field via the getter form:
 *
 * ```ts
 * watch(() => form.meta.submitting, (value) => …)
 * ```
 *
 * Per-field state (touched, dirty, errors) lives behind
 * `form.fields.<path>`; this is the aggregate view across the
 * whole form.
 *
 * Read-only at runtime — assignments throw. Destructuring snapshots
 * the current values; use `toRefs()` if you need reactive handles
 * to individual fields.
 */
export type FormMeta<F = unknown> = FieldState<F> & {
  /**
   * `true` while a `handleSubmit`-produced submit handler is running.
   * Covers both the validation phase and your async submit callback.
   * Useful for disabling the submit button.
   */
  readonly submitting: boolean

  /**
   * How many times the submit handler has been invoked, regardless of
   * outcome (validation failure, callback success, callback throw).
   * Useful for "show errors after first submit attempt" UX.
   */
  readonly submissionAttempts: number

  /**
   * How many times wizard navigation (`wizard.next`, `wizard.back`,
   * `wizard.goTo`) has actually departed this form. Bumped on real
   * departures only: no-ops like `back()` from the first step, a
   * same-key `goTo`, or a `next()` blocked by failed activation leave
   * the counter at its prior value.
   *
   * Pure introspection counter — useful for "this form has been
   * visited and left" UX (analytics, prior-step badges, layered
   * `getDisplayState` predicates) but does NOT drive the library's
   * default `getDisplayState` heuristic. The reveal-on-submit story
   * runs entirely through `submissionAttempts`, which
   * `wizard.handleSubmit` bumps on the active form at intermediate
   * steps and on every form at the final step.
   *
   * Distinct from `submissionAttempts`, which counts `handleSubmit`
   * passes only — wizard departures and form submissions are tracked
   * separately so consumers can introspect each cleanly. Distinct
   * from `form.validate()`, which is a read-only inspection primitive
   * that never bumps any counter.
   *
   * Cleared by `form.reset()`.
   */
  readonly departAttempts: number

  /**
   * The error thrown or rejected by the most recent submit callback (or
   * its `onError` handler), coerced to a real `Error` (a non-`Error`
   * throw keeps its origin on `.cause`). Cleared to `null` at the start
   * of each new submission attempt; stays `null` on success.
   *
   * The submit handler does NOT re-throw — its returned promise always
   * resolves, so binding it to `@submit.prevent` never manufactures a
   * `window` unhandledrejection. This is the single channel for "the
   * submit failed", read the same way in templates and after an
   * imperative `await submit()`. Like `hydrateError`, it stays distinct
   * from the curated user-error store: render it where you choose:
   *
   * ```vue
   * <p v-if="form.meta.submitError">{{ form.meta.submitError.message }}</p>
   * ```
   */
  readonly submitError: Error | null

  /**
   * Scalar mirror of `meta.errors.length`. Read it from templates and
   * `watch()` without indexing the underlying array.
   *
   * Always tracks `errors.length` exactly — reactivity is wired through
   * the same computed graph, so a `watch(form.meta.errorCount, ...)`
   * fires when (and only when) the aggregate error count changes.
   */
  readonly errorCount: number

  /**
   * `true` once a `handleSubmit` callback has resolved without
   * throwing. Independent of `submissionAttempts` — a failed submit
   * (validation failure or callback rejection) increments attempts but
   * leaves `submitted` at `false`. Templates read it as "the form has
   * been submitted successfully at least once."
   *
   * Cleared by `form.reset()` alongside `submissionAttempts` and
   * `submitError`. For "the user has attempted a submit," read
   * `submissionAttempts > 0` directly.
   */
  readonly submitted: boolean

  /**
   * Per-`useForm()`-call identity. Stable for the lifetime of one
   * `useForm()` call; new on every fresh mount. Orthogonal to
   * `form.key`: the key identifies a SHARED FormStore (so two
   * `useForm({ key: 'signup' })` calls return the same store and the
   * same key), while `instanceId` identifies THIS specific callsite —
   * useful when two forms share a key (sidebar + main rendering the
   * same form) and you need to disambiguate which caller is which.
   *
   * Format is opaque (Vue 3.5+ `useId()`-derived). Treat as identity,
   * not state — don't parse, don't compare ordinally, don't persist.
   *
   * Common patterns:
   *
   * - **Devtools panels** disambiguating shared-key form mounts.
   * - **Telemetry / logging hooks** tagging events with which mount
   *   triggered them.
   * - **E2E test selectors** stamping `data-form-id={form.meta.instanceId}`
   *   onto a wrapper to assert which form was focused.
   * - **Vue `:key`** for keyed lists of dynamically-rendered forms
   *   (drag-reorder, etc.) — stable identity per useForm() call.
   */
  readonly instanceId: string
}

/**
 * The object returned by `useForm`. Holds every reactive ref, write
 * helper, and lifecycle method bound to one form.
 *
 * ```ts
 * const form = useForm({ schema })
 * form.register('email')        // bind to <input v-register>
 * form.values.email             // current value (proxy, no .value)
 * form.fields.email.dirty   // per-field flags
 * form.errors.email             // readonly ValidationError[]
 * form.setValue('email', 'a@b.c')
 * form.handleSubmit(onSubmit)   // returns a submit handler
 * form.meta.submitting        // form-level reactive flag
 * ```
 *
 * Three generic slots split the write view, parse view, and read view:
 *
 * - `Form` — the **input / write shape** (`z.input<Schema>`). Used
 *   by `setValue`, `defaultValues`, and `register`'s write side.
 *   Loose: preprocess paths accept `unknown` at the write boundary,
 *   defaulted fields accept their inner type optionally.
 *
 * - `GetValueFormType` — the **output / parsed shape**
 *   (`z.output<Schema>`). Used by `handleSubmit`'s `onSubmit`
 *   callback and by `form.parse()`'s success payload. This is the
 *   shape after refinements have fired and transforms have run.
 *
 * - `ReadForm` — the **read / storage shape**. Used by `values`,
 *   `fields`, `register`'s read side, `toRef`. Per-key precise: at
 *   the write-boundary wrappers (`default` / `prefault` / `catch` /
 *   `readonly` / `preprocess`) the value is `z.output<Inner>`
 *   (default has fired, preprocess has normalized); at transforms /
 *   pipes the value stays `z.input<Inner>` (transforms are deferred
 *   until parse). For schema-agnostic call sites defaults to `Form`.
 *
 * For schemas without write-boundary wrappers or transforms the three
 * shapes coincide.
 */

/**
 * Read-only view returned by `form.blankPaths.value`. Exposes lookup
 * (`.has`), aggregate (`.size`), and iteration over the form's
 * blank-marked paths.
 *
 * `.has(input)` and the iterator yield consistent results across both
 * input conventions the library accepts everywhere a path is named:
 *
 *  - **Dotted string**: `'user.email'`, matching what `register('user.email')`
 *    or `setValue('items.0.sku', …)` accept. Convenient when no segment
 *    contains a literal dot.
 *  - **Array form**: `['user', 'email']`, mirroring `register(['user', 'email'])`.
 *    Required when a single segment contains literal dots (e.g.
 *    `['address.primary']` for a top-level key named `address.primary` —
 *    the dotted form `'address.primary'` would be parsed as two
 *    segments).
 *
 * Iteration yields `Path` arrays so the structure is unambiguous —
 * consumers building debug UI or persisting the set never have to guess
 * whether a dot in a segment is a separator or part of the name.
 *
 * Mutating the view does nothing — writes still go through
 * `setValue(path, unset)`, `markBlank()` on a register binding, or the
 * directive's input listener on numeric clear.
 */
export interface BlankPathsView {
  /** Number of blank-marked paths. */
  readonly size: number
  /**
   * `true` when the path is in the blank set. Accepts dotted-string
   * form (parsed by [[parseDottedPath]]) or the array form.
   */
  has(input: string | Path): boolean
  /** Snapshot of all blank-marked paths as segment arrays. */
  values(): readonly Path[]
  /** Iterates the blank-marked paths as segment arrays. */
  [Symbol.iterator](): IterableIterator<Path>
}

export type UseFormReturnType<
  Form extends GenericForm,
  GetValueFormType extends GenericForm = Form,
  ReadForm extends GenericForm = Form,
  K extends FormKey = FormKey,
> = {
  /**
   * Wraps your submit logic with validation and error routing.
   *
   * ```ts
   * <form @submit.prevent="form.handleSubmit(
   *   (data) => api.signup(data),
   *   (errors) => console.log(errors),
   * )">
   * ```
   *
   * `data` is the strictly-typed parsed value — refinements have
   * fired and `.transform()`s have run, so the payload matches
   * `z.output<Schema>` (the post-parse output shape). For schemas
   * where the input type differs from the output type (e.g.
   * `z.string().transform(v => v.length > 10)`), `data` is the
   * output shape while `form.values` stays the input shape.
   */
  handleSubmit: HandleSubmit<GetValueFormType>

  /**
   * Reactive readonly proxy over the form's storage value. Read
   * identically in script and template — no `.value`, no auto-unwrap
   * rules. Pinia setup-store pattern.
   *
   * ```vue
   * <script setup>
   *   const form = useForm({ schema, key: 'login' })
   * </script>
   *
   * <template>
   *   <p>{{ form.values.email }}</p>
   *   <p>{{ form.values.address.city }}</p>
   * </template>
   * ```
   *
   * Writes are blocked at the proxy boundary — go through `setValue`,
   * the directive, or one of the field-array helpers. The
   * slim-primitive write gate stays the only path into storage.
   *
   * Reads reflect what's storable: enum-typed slots widen to their
   * primitive supertype (`string`), so refinement-invalid but
   * structurally-valid values are visible. Storage holds the
   * `z.input<Schema>` shape — `.transform()`s have NOT run, so for
   * a schema like `z.string().transform(v => v.length > 10)` the
   * value reads as `string`, not `boolean`. Use `handleSubmit` or
   * `form.parse()` when you need the post-transform output shape.
   */
  values: ValuesSurface<WriteShape<ReadForm>>

  /**
   * Reactive per-field state proxy. Pinia-style nested object — read
   * leaf properties (`value`, `dirty`, `touched`, `errors`, `blurred`,
   * `focused`, `blank`, …) directly off the field's path:
   *
   * ```vue
   * <p v-if="form.fields.email.touched && form.fields.email.errors.length">
   *   {{ form.fields.email.errors[0].message }}
   * </p>
   * <p>City dirty? {{ form.fields.address.city.dirty }}</p>
   * ```
   *
   * The same proxy supports descent at every level — `address` reads
   * the FieldState for the address object, and `address.city`
   * descends into the nested leaf.
   *
   * Leaf values follow the slim WriteShape contract: enum-typed leaves
   * widen to their primitive supertype, and the leaf value reflects
   * the `z.input<Schema>` shape (transforms deferred until parse).
   * The errors array, dirty flag, focus state, etc. are unaffected.
   *
   * Shadowing: at depth 2+, FieldState keys (`dirty`, `touched`,
   * `errors`, `blank`, `focused`, `blurred`, `value`,
   * `original`, `pristine`, `connected`, `updatedAt`, `path`) win
   * over schema field names. Top-level fields are NOT shadowed.
   * Document edge case; rename the offending schema field if the
   * collision matters.
   */
  fields: FieldStateMap<WriteShape<ReadForm>>

  /**
   * Write to the form programmatically. Two forms:
   *
   * - `setValue(value)` — replace the whole form.
   * - `setValue(path, value)` — write at a specific path.
   *
   * Either takes a callback in place of `value` to derive the next
   * value from the previous one:
   *
   * ```ts
   * form.setValue('count', (prev) => prev + 1)
   * form.setValue((prev) => ({ ...prev, name: 'Ada' }))
   * ```
   *
   * Returns `true` when the write is accepted. A `false` return
   * means the value didn't match the slot's expected type
   * (e.g. writing a number to a string field) — the form state
   * stays unchanged. Refinement-level mismatches (out-of-enum
   * values, failing format checks, etc.) DO succeed and surface as
   * field errors instead.
   */
  setValue: {
    /**
     * Replace the whole form. Pass a value or a callback receiving
     * the previous form.
     *
     * ```ts
     * form.setValue({ name: 'Ada', email: 'a@b.c' })
     * form.setValue((prev) => ({ ...prev, name: 'Ada' }))
     * ```
     *
     * Returns `true` when the write was accepted, `false` when the
     * value didn't match the expected shape (e.g. wrong primitive
     * type at a leaf). Refinement-level mismatches (out-of-enum
     * values, failing format checks, etc.) succeed and surface as
     * field errors instead.
     */
    <Value extends SetValuePayload<DefaultValuesShape<Form>, WriteShape<Form>>>(
      value: Value
    ): boolean
    /**
     * Write at a specific path. Pass a value or a callback receiving
     * the previous value at that path.
     *
     * ```ts
     * form.setValue('email', 'a@b.c')
     * form.setValue('count', (prev) => prev + 1)
     * form.setValue('income', unset) // numeric leaf marked displayed-empty
     * ```
     *
     * Returns `true` when the write was accepted, `false` when the
     * value didn't match the slot's expected primitive type.
     * Refinement-level mismatches succeed and surface as field
     * errors. Pass the `unset` symbol at any primitive leaf to mark
     * it blank (storage holds the slim default; UI displays
     * empty; submit raises "No value supplied" for required schemas).
     */
    <Path extends FlatPath<Form>, Value extends PathSetValuePayload<NestedType<Form, Path>>>(
      path: Path,
      value: Value
    ): boolean
    /**
     * Tuple-segment form. Equivalent to the dotted-string overload —
     * useful when paths are built from variables or arrays:
     * `form.setValue([prefix, 'line1'], 'value')`. The resolved leaf
     * type is exact, matching the dotted-string form.
     */
    <
      const S extends ReadonlyArray<string | number>,
      Value extends PathSetValuePayload<NestedType<Form, JoinSegments<S>>>,
    >(
      segments: S & ([JoinSegments<S>] extends [FlatPath<Form>] ? unknown : never),
      value: Value
    ): boolean
  }

  /**
   * Reactive validation status. Re-runs whenever the form (or the
   * subtree at `path`) mutates. The returned ref carries a `pending`
   * flag — gate on `!status.value.pending` before reading
   * `success` / `errors`.
   *
   * ```ts
   * const status = form.validate()
   * watchEffect(() => {
   *   if (status.value.pending) return
   *   if (!status.value.success) console.log(status.value.errors)
   * })
   * ```
   *
   * Stale in-flight runs are dropped automatically — the ref only
   * settles to results from the most recent call.
   */
  validate: (path?: FlatPath<Form>) => Readonly<Ref<ReactiveValidationStatus<Form>>>

  /**
   * Run validation once and return the result. Unlike `validate()`,
   * this does not subscribe to form reactivity.
   *
   * ```ts
   * const result = await form.validateAsync()
   * if (!result.success) showErrors(result.errors)
   * ```
   *
   * Pass a path to validate a subtree. `state.validating` flips
   * `true` while the promise is in flight.
   */
  validateAsync: (path?: FlatPath<Form>) => Promise<ValidationResponseWithoutValue<Form>>
  /**
   * Resolve once every in-flight async `register({ transforms })` run
   * has settled — globally, or (with `path`) only at-or-under that path.
   * Resolve-never-reject: a transform that throws still settles the
   * field (its failure lands on `field.transformError`), so the returned
   * promise always resolves.
   *
   * `handleSubmit` awaits this internally before parsing, so a submit
   * fired the instant after an async transform still validates the
   * resolved value. Reach for it directly when you need the same
   * guarantee outside submit — e.g. before reading `form.values` in an
   * imperative flow or a test:
   *
   * ```ts
   * input.value = '  a@b.com '
   * await form.settleTransforms('email')
   * // form.values.email is now the normalized value
   * ```
   */
  settleTransforms: (path?: FlatPath<Form>) => Promise<void>
  /**
   * Imperative one-shot parse. Same pipeline as `validateAsync` —
   * runs refinements, applies `.transform()`s, composes blank-required
   * errors — but RETAINS the parsed data instead of stripping it.
   *
   * Storage holds the "honest input view" — values you wrote, with
   * preprocess normalization applied but `.transform()` deferred. For
   * schemas where the input type differs from the output type (e.g.,
   * `z.string().transform(v => v.length > 10)`), `form.values.X` is
   * the input shape and `(await form.parse()).data?.X` is the
   * output shape.
   *
   * ```ts
   * const result = await form.parse()
   * if (result.success) {
   *   // result.data matches z.output<typeof schema>
   * } else {
   *   // result.errors is the validation failure list
   * }
   * ```
   *
   * Always async, and there is no synchronous variant by design: a
   * schema can carry async refinements or transforms, so a sync parse
   * would silently miss them the moment one is added. One always-
   * awaited `parse` closes that category of bug entirely. The returned
   * promise never rejects (a thrown adapter lands as a `success: false`
   * response). Pass a path to parse a subtree only. `meta.validating`
   * flips `true` while the promise is in flight (shared with
   * validateAsync).
   */
  parse: (path?: FlatPath<Form>) => Promise<ValidationResponse<GetValueFormType>>
  /**
   * Bind a path to a native input via `v-register`. Returns a
   * `RegisterValue` carrying the live ref and event handlers the
   * directive needs.
   *
   * ```vue
   * <input v-register="form.register('email')" />
   * <input v-register="form.register('username', { transforms: [trim] })" />
   * ```
   *
   * Also accepts a segment-array form for callers building paths
   * dynamically — particularly inside a `v-for` over a prefix variable
   * where dotted-string concatenation widens the prefix's literal
   * union to plain `string`:
   *
   * ```vue
   * <fieldset v-for="block in [{ prefix: 'pickup' }, { prefix: 'delivery' }] as const">
   *   <input v-register="form.register([block.prefix, 'line1'])" />
   * </fieldset>
   * ```
   *
   * Pass `options.transforms` to run a sync normalisation pipeline over
   * user-typed values before they reach form state.
   */
  register: {
    <Path extends RegisterFlatPath<Form, keyof Form>>(
      path: Path,
      options?: RegisterOptions
    ): RegisterValue<NestedReadType<WriteShape<ReadForm>, Path>>
    <const S extends ReadonlyArray<string | number>>(
      segments: S &
        ([JoinSegments<S>] extends [RegisterFlatPath<Form, keyof Form>] ? unknown : never),
      options?: RegisterOptions
    ): RegisterValue<NestedReadType<WriteShape<ReadForm>, JoinSegments<S>>>
  }
  /**
   * The form's identifier — either the explicit `key` passed to
   * `useForm` or an auto-generated unique id when `key` was omitted.
   * Use it when feeding API errors through `parseApiErrors`:
   *
   * ```ts
   * const result = parseApiErrors(serverPayload, { formKey: form.key })
   * if (result.ok) form.setFieldErrors(result.errors)
   * ```
   *
   * Typed as the literal `K` when an explicit `key` was passed; falls
   * back to `FormKey` when omitted (auto-generated id).
   */
  key: K

  // --- Async-defaults lifecycle ---

  /**
   * `true` while a function-form `defaultValues` factory is in flight
   * — between `useForm` construction and the moment the factory
   * resolves (sync function on the next microtask; async function when
   * its promise settles). `false` otherwise, including when
   * `defaultValues` is a plain value.
   *
   * The form is fully usable while `hydrating` is `true` — it holds
   * the schema's slim defaults. The flag exists so templates can show
   * a spinner / dim the form while real data loads:
   *
   * ```vue
   * <div :aria-busy="form.hydrating">…</div>
   * ```
   *
   * Exposed as an auto-unwrapping `boolean` (no `.value`); reactivity
   * is preserved via a getter that tracks the underlying ref at the
   * access site, so `watch(() => form.hydrating, …)` and template
   * reads both fire on change. Reading this property activates the
   * form's factory under the lazy-by-default rule.
   */
  readonly hydrating: boolean

  /**
   * The error from the most recent function-form `defaultValues` factory,
   * normalized to a `ValidationError` (code `atta:hydration-failed`) so the
   * shape matches every other surface in `form.errors` / `form.meta.errors`.
   * `null` on construction, on successful resolution, and whenever no
   * factory has fired. Updates with each `form.rehydrate()` call.
   *
   * Distinct from `meta.submitError` so retry buttons and recovery UX can
   * stay focused on the load-time failure without entangling the submit
   * pipeline. Read directly in templates and script (no `.value`);
   * reactivity is preserved via a getter:
   *
   * ```vue
   * <p v-if="form.hydrateError">{{ form.hydrateError.message }}</p>
   * ```
   */
  readonly hydrateError: ValidationError | null

  /**
   * `true` once the form's defaults have been applied — either a plain
   * `defaultValues` value at construction or an async factory whose
   * settle completed successfully. Stays `false` for dormant lazy
   * forms (factory not yet activated) and for failed activations
   * (`hydrateError` set). Once `true`, stays `true` through refetches
   * so stale-while-revalidate UIs can keep rendering the prior values
   * while a `rehydrate()` is in flight.
   *
   * Composes with `hydrating` and `hydrateError`:
   *
   * ```vue
   * <Spinner v-if="!form.ready && form.hydrating" />
   * <ErrorBanner v-if="!form.ready && form.hydrateError" :error="form.hydrateError" />
   * <form v-if="form.ready">…</form>
   * ```
   *
   * Exposed as a reactive `boolean` (no `.value`). Reading it activates
   * the factory under the lazy-by-default rule — observing readiness
   * implies use.
   */
  readonly ready: boolean

  /**
   * Re-fire the captured `defaultValues` factory and re-apply its
   * payload over the current form values. Useful when the upstream
   * source changes (the user picks a different draft, a background
   * sync indicates fresh server data, etc.).
   *
   * Resolves after `hydrating` flips back to `false`. Throws
   * synchronously when the form was constructed with a plain-value
   * `defaultValues` (nothing to re-fire). Does NOT clear dirty /
   * touched / submit state — chain `form.reset()` for that.
   */
  rehydrate(): Promise<void>

  /**
   * Idempotent activation. Forms are lazy-by-default: a function-form
   * `defaultValues` factory fires on the first reactive interaction
   * (reading `form.values`, calling `form.setValue`, etc.). Call
   * `form.activate()` to kick the factory explicitly — typically from
   * `setup` so SSR's `onServerPrefetch` hook awaits the resolution
   * before the page renders. Subsequent calls return the in-flight
   * promise until the factory settles, after which they resolve
   * immediately. Plain-value forms (no factory captured) always
   * return a resolved promise.
   */
  activate(): Promise<void>

  // --- Reactive field-error API ---

  /**
   * Reactive map of field errors, keyed by dotted path. Populated
   * automatically by `handleSubmit` and per-field validation; cleared
   * on validation success.
   *
   * Read in templates with no `.value`:
   *
   * ```vue
   * <p v-if="form.errors.email">{{ form.errors.email[0].message }}</p>
   * ```
   *
   * Watch from script via the getter form:
   *
   * ```ts
   * watch(() => form.errors.email, (errors) => …)
   * ```
   *
   * Use bracket access for nested dotted keys
   * (`form.errors['user.profile.email']`) — JS dot notation splits
   * on literal dots.
   *
   * Read-only — populate via `setFieldErrors`, `addFieldErrors`, and
   * `clearFieldErrors`. Server-side errors flow through
   * `parseApiErrors` first.
   */
  errors: FormErrorsSurface<Form>

  /**
   * Escape hatch for the rare case a consumer needs a `Ref<T>` —
   * e.g. handing the value to an external composable that expects a
   * Vue ref, or watching a single path with `watch(formRef, ...)`.
   *
   * ```ts
   * const emailRef = form.toRef('email')         // Readonly<Ref<string>>
   * watch(emailRef, (next) => console.log(next))
   * ```
   *
   * Returns `Readonly<Ref<...>>` — writes go through `setValue`,
   * `register()`, or the field-array helpers, never via the ref.
   * Prefer `form.values.email` for direct reads in templates +
   * scripts; `toRef` is for ref-shaped interop only.
   */
  toRef: {
    <Path extends FlatPath<Form>>(
      path: Path
    ): Readonly<Ref<NestedReadType<WriteShape<ReadForm>, Path>>>
    <const S extends ReadonlyArray<string | number>>(
      segments: S & ([JoinSegments<S>] extends [FlatPath<Form>] ? unknown : never)
    ): Readonly<Ref<NestedReadType<WriteShape<ReadForm>, JoinSegments<S>>>>
  }

  /**
   * Replace every field error for this form with the provided list.
   * Useful after `parseApiErrors` produces a fresh batch from a
   * server response.
   *
   * ```ts
   * const result = parseApiErrors(payload, { formKey: form.key })
   * if (result.ok) form.setFieldErrors(result.errors)
   * ```
   */
  setFieldErrors: (errors: ValidationError[]) => void

  /**
   * Append errors to the existing set without clearing prior entries.
   * Use when reporting an additional issue alongside existing errors
   * (e.g. a partial server response).
   */
  addFieldErrors: (errors: ValidationError[]) => void

  /**
   * Clear errors. Pass a path to clear errors for a single field;
   * call with no arguments to clear every error on the form.
   *
   * ```ts
   * form.clearFieldErrors('email')   // clear one field
   * form.clearFieldErrors()          // clear all
   * ```
   */
  clearFieldErrors: (path?: string | (string | number)[]) => void

  /**
   * Replace the form-level errors — the entries at the empty path
   * (`path: []`) — without disturbing any field-level errors. Pass an
   * empty array to clear them all.
   *
   * ```ts
   * form.setFormErrors([{ message: 'Capacity exceeded' }])
   * form.setFormErrors([
   *   { message: 'Capacity exceeded', code: 'capacity:exceeded' },
   *   { message: 'Pickup window full' },
   * ])
   * form.setFormErrors([])  // clear
   * ```
   *
   * Only `message` is required. `code` defaults to `'atta:form-error'`.
   * Any caller-provided `path` or `formKey` is ignored — `path` is
   * always forced to `[]` (this API is form-level-only by definition)
   * and `formKey` is filled in from the form instance. The lenient
   * input shape lets you pipe `parseApiErrors` output (or any
   * `ValidationError[]`) straight in:
   *
   * ```ts
   * const result = parseApiErrors(payload, { formKey: form.key })
   * if (result.ok) form.setFormErrors(result.errors)
   * ```
   *
   * Form-level errors land at the empty-string path bucket
   * (`path: ['']`). They surface in `form.meta.errors` (alongside
   * field errors), in `form.errors()` / `form.errors([])` (whole-form
   * subtree aggregates), and — uniquely — in `form.errors('')`,
   * which returns ONLY the form-level bucket. They're excluded from
   * the path-keyed `form.errors` drill proxy because no nested-object
   * key represents the empty-string path. Read them via
   * `meta.errors.filter(e => e.path.length === 1 && e.path[0] === '')`
   * if you need a programmatic split.
   */
  setFormErrors: (errors: ReadonlyArray<Partial<ValidationError> & { message: string }>) => void

  /**
   * Clear every form-level error. Equivalent to `setFormErrors([])`;
   * field errors are untouched.
   */
  clearFormErrors: () => void

  // --- Form-level meta ---

  /**
   * Form-level reactive flags, counters, and aggregates (`dirty`,
   * `valid`, `submitting`, `submissionAttempts`, and the flat `errors`
   * array). See `FormMeta` for the full shape. Read leaves directly
   * with no `.value`.
   *
   * For per-field state (touched, focused, blurred, errors at one
   * path), use `form.fields.<path>` instead. Undo/redo state lives at
   * `form.history` (see `FormHistoryNamespace`).
   */
  meta: FormMeta<Form>

  // --- Reset ---

  /**
   * Restore the form to its initial state. Without arguments,
   * re-applies the schema defaults (and any `defaultValues` passed
   * to `useForm`). Pass `nextDefaultValues` to seed the reset with
   * a fresh set of overrides.
   *
   * Resets:
   *   - the form value back to defaults;
   *   - the dirty baseline (so the next edit flips `dirty` correctly);
   *   - field errors;
   *   - touched / focused / blurred per-field flags;
   *   - submission state (`submitting` / `submissionAttempts` /
   *     `submitted` / `submitError`).
   */
  reset: (nextDefaultValues?: DefaultValuesInput<Form>) => void

  /**
   * Restore a single field (or a sub-tree like `'user'`) to its
   * initial value. Clears errors and touched flags for the field
   * and its descendants; leaves siblings and submission state alone.
   *
   * No-op when the path doesn't exist on the form (e.g. a typo'd
   * dynamic key).
   */
  resetField: (path: FlatPath<Form>) => void

  /**
   * Wipe a field (or the whole form) to the "appropriate nullish
   * value" for its declared type — the underlying type's empty/falsy
   * concrete, with any `.default(x)` wrapper INTENTIONALLY skipped.
   * Orthogonal to `reset` / `resetField` by design.
   *
   * ```ts
   * const schema = z.object({
   *   notify: z.boolean().default(true),
   *   count: z.number().default(5),
   * })
   * const form = useForm({ schema })
   *
   * form.reset()         // notify → true,  count → 5  (defaults)
   * form.clear()         // notify → false, count → 0  (falsy-for-type)
   * form.clear('notify') // → false (NOT the declared default true)
   * ```
   *
   * Per-wrapper semantics:
   *
   * - `.default(x)` / `.prefault(x)` / `.catch(x)` → inner-schema
   *   empty (default is INTENTIONALLY skipped).
   * - `.optional()` → `undefined` (the wrapper's "absent" marker).
   * - `.nullable()` → `null` (the wrapper's "explicit empty").
   * - Object → recursive (every property gets its own empty).
   * - Array / Set / Record → empty.
   *
   * Returns `true` when the write was accepted, `false` when the
   * adapter couldn't resolve an empty value at the path (e.g. the
   * path doesn't exist in the schema). The form state is unchanged
   * on a `false` return.
   *
   * Sugar over `setValue(path, schema.getEmptyValueAtPath(path))` —
   * no separate bookkeeping. Variant memory, history, and listeners
   * all see this as a regular write at the path.
   *
   * `clear()` (no arg) targets the whole form. `clear('')` targets
   * the empty-string path slot SPECIFICALLY — the two are NOT
   * interchangeable, matching `touch()` / `touch('')` from #184.
   */
  clear: {
    (): boolean
    <Path extends FlatPath<Form> | ''>(path: Path): boolean
    <const S extends ReadonlyArray<string | number>>(
      segments: S & ([JoinSegments<S>] extends [FlatPath<Form> | ''] ? unknown : never)
    ): boolean
  }

  // --- Undo / redo ---

  /**
   * Consolidated undo/redo namespace — `form.history.{undo, redo,
   * clear, canUndo, canRedo, size}`. Always present; inert when
   * `useForm({ history })` wasn't configured. See `FormHistoryNamespace`
   * for field-by-field semantics.
   */
  history: FormHistoryNamespace

  // --- Focus / scroll to first error ---

  /**
   * Focus the first errored field's first visible element. Returns
   * `true` when an element was focused, `false` when no candidate
   * element exists (no errors, or every errored field is unmounted
   * or hidden).
   *
   * Pass `{ preventScroll: true }` if you're scrolling separately
   * (e.g. via `scrollToFirstError`) and don't want the browser to
   * fight the explicit scroll.
   */
  focusFirstError: (options?: { preventScroll?: boolean }) => boolean

  /**
   * Scroll the first errored field's first visible element into
   * view. Returns `true` when the call ran, `false` when no
   * candidate element exists.
   *
   * `options` is forwarded to `Element.scrollIntoView` unchanged.
   */
  scrollToFirstError: (options?: ScrollIntoViewOptions) => boolean

  /**
   * Drive the form's `onInvalidSubmit` policy imperatively. The same
   * focus/scroll behavior `handleSubmit` runs after a failed submit,
   * but available standalone. Defaults to the policy configured via
   * `useForm({ onInvalidSubmit })` (or `'focus-first-error'` when
   * omitted). Pass an explicit policy to override for one call.
   *
   * Used by `useWizard` after navigating to the first failing form
   * during `wizard.handleSubmit`, so the failing form's own configured
   * policy fires once its DOM is in view.
   *
   * No-op when no errored field is currently registered or when the
   * resolved policy is `'none'`.
   */
  applyInvalidSubmitPolicy: (policy?: OnInvalidSubmitPolicy) => void

  /**
   * Programmatically mark fields as touched — the sticky flag the
   * standard "show errors after interaction" pattern reads. Closes
   * the gap when fields are populated without a DOM gesture (post-
   * import, paste, autofill, server-seeded values you want to
   * validate immediately).
   *
   * ```ts
   * form.touch('email')                 // one leaf
   * form.touch('profile')               // every leaf under profile
   * form.touch(['profile', 'name'])     // segment-array form
   * form.touch()                        // every leaf in the form
   * ```
   *
   * Pure flag write — does not mutate value, focused, blurred, or
   * trigger validation. Idempotent: re-calling on an already-touched
   * field is a no-op. Touched is sticky-true; pair with
   * `form.reset()` / `form.resetField()` to clear.
   */
  touch: (path?: FlatPath<Form> | (string | number)[]) => void

  // --- Field arrays ---

  /**
   * Append `value` to the array at `path`.
   *
   * ```ts
   * form.append('items', { name: 'New' })
   * ```
   */
  append: <Path extends ArrayPath<Form>>(path: Path, value: ArrayItem<Form, Path>) => void
  /** Prepend `value` to the array at `path`. */
  prepend: <Path extends ArrayPath<Form>>(path: Path, value: ArrayItem<Form, Path>) => void
  /**
   * Insert `value` into the array at `path` at the given `index`.
   * Behaves like `Array.prototype.splice`: `index` is clamped into
   * `[0, length]`, and negative indices count from the end.
   */
  insert: <Path extends ArrayPath<Form>>(
    path: Path,
    index: number,
    value: ArrayItem<Form, Path>
  ) => void
  /** Remove the element at `index` from the array at `path`. No-op when out of range. */
  remove: <Path extends ArrayPath<Form>>(path: Path, index: number) => void
  /** Swap the elements at indices `a` and `b`. No-op when either is out of range. */
  swap: <Path extends ArrayPath<Form>>(path: Path, a: number, b: number) => void
  /**
   * Move the element at `from` to `to`. Useful for drag-and-drop
   * reordering. No-op when either index is out of range.
   */
  move: <Path extends ArrayPath<Form>>(path: Path, from: number, to: number) => void
  /** Replace the element at `index` with `value`. No-op when out of range. */
  replace: <Path extends ArrayPath<Form>>(
    path: Path,
    index: number,
    value: ArrayItem<Form, Path>
  ) => void
  /**
   * Read-only, reactive view of the array at `path` as one `FieldState`
   * per element, in index order. Each entry carries its element `key`,
   * an allocated identity token, so a `v-for` keyed by it keeps a row's
   * component instance across an insert, removal, move, or swap:
   *
   * ```vue
   * <div v-for="(row, i) in form.list('contacts')" :key="row.key">
   *   <input v-register="form.register(`contacts.${i}.name`)" />
   *   <p v-if="row.showErrors">{{ row.firstError?.message }}</p>
   * </div>
   * ```
   *
   * Entries are the same field states `form.fields` exposes, so reads
   * stay live. `form.fields(path)` remains the single aggregated
   * container for the whole array; `list` is the per-element view.
   * For a record, reach for `record`, which keys each entry by its own
   * key.
   */
  list: <Path extends ArrayPath<Form>>(path: Path) => readonly FieldState<ArrayItem<Form, Path>>[]
  /**
   * Read-only, reactive view of the record at `path` as one `FieldState`
   * per entry, keyed by the entry's own key. Where `list` hands back an
   * ordered array for an array path, `record` hands back a keyed object
   * for a record path, so you iterate it by key:
   *
   * ```vue
   * <div v-for="(field, key) in form.record('scoresByTeam')" :key="key">
   *   <label>{{ key }}</label>
   *   <input v-register="form.register(`scoresByTeam.${key}`)" />
   *   <p v-if="field.showErrors">{{ field.firstError?.message }}</p>
   * </div>
   * ```
   *
   * Entries are the same field states `form.fields` exposes, so reads
   * stay live, and the keyed shape mirrors the record's own keys: an
   * entry appears once you write its key (`form.setValue`) and drops
   * when the key leaves. `form.fields(path)` remains the single
   * aggregated container for the whole record; `record` is the
   * per-entry view.
   */
  record: <Path extends RecordPath<Form>>(
    path: Path
  ) => Readonly<Record<string, FieldState<RecordValue<Form, Path>>>>
  /**
   * Read-only view of the form's blank path set. Reactive — Vue 3.5
   * tracks `.has()` / `for..of` / size accesses, so consumers can drive
   * conditional UI off it directly:
   *
   * ```ts
   * watchEffect(() => {
   *   if (form.blankPaths.value.size > 0) {
   *     const paths = [...form.blankPaths.value]   // Path[][] — array of segments per entry
   *     console.warn('unanswered fields:', paths.map((p) => p.join('.')))
   *   }
   * })
   * ```
   *
   * `.has(input)` accepts the dotted-string form (`'user.email'`) or
   * the array form (`['user', 'email']`). The array form disambiguates
   * keys with literal dots (e.g. `['address.primary']`). See
   * [[BlankPathsView]] for the full surface.
   *
   * For per-path access, use `form.fields.<path>.blank`.
   * Writes happen through `setValue(path, unset)`,
   * `markBlank()` on a register binding, and the directive's
   * input listener on numeric clear.
   */
  blankPaths: ComputedRef<BlankPathsView>
}
