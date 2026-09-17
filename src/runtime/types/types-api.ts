import type { ComputedRef, MaybeRefOrGetter, ObjectDirective, Ref } from 'vue'
import type { FieldMetaPayload, ResolvedFieldMeta } from '../core/field-meta'
import type { Path, PathKey } from '../core/paths'
import type { ElementRecord, FieldRecord } from '../core/store-records'

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
  SegmentPathRejection,
  SegmentRegisterRejection,
  WriteShape,
} from './types-core'

/**
 * Identifier for a form: the string passed to `useForm({ key })`, used
 * to look a form up by name from a distant component and to label
 * errors and DevTools entries. An anonymous `useForm` allocates one
 * automatically, so pick one only when the form needs stable identity.
 */
export type FormKey = string

/** Per-form options threaded from `useForm` into the adapter factory. */
export interface SchemaFactoryOptions {
  /** Recursion ceiling for walks through recursive schemas. */
  maxRecursionDepth: number
}

/**
 * A JSON-serialisable value: the recursive shape of anything that
 * survives a `JSON.stringify` / `JSON.parse` round-trip unchanged. The
 * type of `ValidationError.data`.
 *
 * The object arm is a named interface rather than an inline index
 * signature because TypeScript expands an anonymous recursive alias
 * eagerly and hits TS2589 once `Json` is checked inside a large
 * structural type such as the form store. A named reference defers
 * that expansion.
 */
export type Json = string | number | boolean | null | JsonArray | JsonObject
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a named array arm (not inline `Json[]`) is what defers the recursion and avoids TS2589
interface JsonArray extends Array<Json> {}
interface JsonObject {
  [key: string]: Json
}

/**
 * One validation failure, as returned by `validate()`, `parse()` and
 * `handleSubmit`'s `onError`, and accepted leniently as `ErrorInput` by
 * `form.setErrors`.
 *
 * Which form produced an error is envelope-level identity: the
 * `ValidationResponse` or submit result carrying the list stamps
 * `formKey` once, and an aggregator merging lists across forms (the
 * wizard) stamps its own envelope.
 */
export type ValidationError = {
  /** Human-readable message describing the failure. */
  message: string
  /**
   * Structured path of the offending field, such as
   * `['user', 'address', 0, 'line1']`.
   *
   * The root path `[]` is the form-level bucket, the home for errors
   * belonging to no specific field: root `.refine()` messages,
   * `setErrors` entries with no path, hydration failures,
   * server-emitted banners. The empty-STRING path `['']` is unrelated
   * and means an ordinary field whose key is the empty string.
   */
  path: (string | number)[]
  /**
   * Stable machine identifier for the failure, scoped by prefix:
   *
   * - `atta:` for Attaform's own codes, see `AttaformErrorCode`.
   * - an adapter prefix such as `zod:`, forwarded from the underlying
   *   schema library's issue code where it has one.
   * - anything else for consumer-defined codes (`api:duplicate-email`,
   *   `auth:expired-token`). Pick a prefix and stay consistent, so
   *   error renderers and tests branch on `code` rather than matching
   *   exact message strings.
   */
  code: string
  /**
   * Optional structured payload. Attaform never sets or reads this; it
   * is a passthrough for whatever a server sends alongside the message
   * (a captcha challenge, a lockout `unlocks_at`, an MFA step-up
   * descriptor) so the UI can act on it. Survives serialise, hydrate,
   * undo and redo unchanged.
   */
  data?: Json | null
}

/**
 * One path's slot in the form's tagged error store. The two sources
 * that can put an error at a path stay segregated: `schema` holds the
 * validation pipeline's verdicts, `user` holds `setErrors` entries and
 * their history and SSR replays. Reads merge schema, then derived
 * blank, then user, and each writer replaces exactly its own side.
 *
 * Cells are immutable. Every write replaces the whole cell, or deletes
 * the key when both sides are empty, so Vue's per-key Map tracking
 * fires for a change on either side. An empty side is the shared frozen
 * `NO_ERRORS` array, never a fresh allocation.
 *
 * @internal
 */
export type ErrorCell = {
  readonly schema: readonly ValidationError[]
  readonly user: readonly ValidationError[]
}

/**
 * The lenient input `form.setErrors` accepts: a real `Error`, or a
 * partial `ValidationError` where every field is optional.
 *
 * - `message`: omitted or empty coerces to `"Unknown error"`.
 * - `path`: defaults to `[]`, a form-level error. Ignored by the
 *   path-scoped `setErrors(path, ...)` form, which stamps its own.
 * - `code`: defaults to `atta:user-error`.
 * - `data`: forwarded verbatim onto the produced `ValidationError`.
 *
 * Because every field is optional, `ValidationError` is a subtype of
 * `ErrorInput`: a `ValidationError[]` read back out, or a server
 * response already emitting the shape, pipes straight into
 * `form.setErrors` with no adapter.
 */
export type ErrorInput =
  | Error
  | {
      message?: string
      path?: (string | number)[]
      code?: string
      data?: Json | null
    }

/**
 * A parse verdict as an `AbstractSchema` produces it. Adapter authors
 * implement THESE.
 *
 * A schema knows nothing about which form asked, being a pure function
 * of the schema it wraps, which is what lets one `AbstractSchema` serve
 * every form built on the same schema. The owning store stamps its own
 * `formKey` on the way out, producing the `ValidationResponse` arms
 * below.
 */
export type SchemaParseSuccess<TData> = {
  /** The parsed value at the validated subtree, or the whole form when `validate()` took no path. */
  data: TData
  errors: undefined
  success: true
}
/** Schema-level verdict when no data could be produced, such as a top-level type mismatch. */
export type SchemaParseErrorWithoutData = {
  data: undefined
  /** Non-empty list of failures. */
  errors: ValidationError[]
  success: false
}
/** Schema-level verdict when the parser produced partial data alongside failures. */
export type SchemaParseErrorWithData<TData> = {
  data: TData
  errors: ValidationError[]
  success: false
}
/** Settled schema-level verdict. Discriminate on `success`. */
export type SchemaParseResult<TData> =
  SchemaParseSuccess<TData> | SchemaParseErrorWithData<TData> | SchemaParseErrorWithoutData
/** Schema-level `getDefaultValues` verdict: defaults always come back. */
export type SchemaDefaultsResult<TData> =
  SchemaParseSuccess<TData> | SchemaParseErrorWithData<TData>

/** Settled validation result when the form or subtree parsed successfully. */
export type ValidationResponseSuccess<TData> = SchemaParseSuccess<TData> & {
  /** The form this verdict belongs to. Stamped by the store, not the schema. */
  formKey: FormKey
}
/** Settled validation result when no data could be produced. */
export type ValidationResponseErrorWithoutData = SchemaParseErrorWithoutData & {
  formKey: FormKey
}
/** Settled validation result when the parser produced partial data alongside failures. */
export type ValidationResponseErrorWithData<TData> = SchemaParseErrorWithData<TData> & {
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
 * `ValidationResponse` without the `data` payload, for the reactive
 * `validate()` status, whose consumers need only the success flag and
 * the error list.
 */
export type ValidationResponseWithoutValue<Form> = Omit<ValidationResponse<Form>, 'data'>

/** Options bag for `form.parse`. */
export type ParseOptions = {
  /**
   * Turn the pure read into an authoritative run: the verdict is
   * committed to the error store at the parsed scope, and in-flight
   * per-field validation is cancelled first. Default `false`.
   */
  readonly commit?: boolean
}

/**
 * Sync-or-async return shape for `AbstractSchema.validateAtPath`. The
 * adapter returns the response inline when the schema and the caller's
 * options permit synchronous validation, and a `Promise<T>` otherwise.
 * Callers that do not care simply `await`, which works for both; the
 * reshape pre-pass, which prevents flicker, branches on
 * `instanceof Promise`.
 */
export type MaybePromise<T> = T | Promise<T>

/** Options accepted by `AbstractSchema.validateAtPath`. */
export type ValidateOptions = {
  /**
   * Ask the adapter to return the response inline where the schema
   * permits synchronous validation. A preference, not a guarantee: a
   * structurally async schema, meaning any verdict that resolves only
   * through a Promise (async refinements, async transforms or pipes)
   * in whichever library the adapter wraps, still falls back to a
   * `Promise<T>`.
   *
   * Omitted or `false`, the adapter is free to use its async path.
   * Every call site outside the reshape pre-pass leaves it so.
   */
  sync?: boolean
}

/**
 * Configuration passed to `AbstractSchema.getDefaultValues`. Adapters
 * receive `useDefaultSchemaValues`, which chooses between honoring
 * `.default(x)` wrappers and using empty or falsy fallbacks, plus an
 * optional `constraints` overlay merged into the derived defaults so
 * the runtime can stamp user-supplied defaults at construction.
 * Exported so adapter authors can co-implement the service contract.
 */
export type GetDefaultValuesConfig<Form> = {
  useDefaultSchemaValues: boolean
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
  getDefaultValues(config: GetDefaultValuesConfig<Form>): SchemaDefaultsResult<Form>
  /**
   * The schema-prescribed default at `path`. The runtime uses it to
   * fill structural gaps, so every `setValue` write leaves the form
   * satisfying the slim schema, meaning objects, arrays and primitives
   * without refinement-level constraints.
   *
   * - Object property: the property's schema default.
   * - Array element: the element default. Positions past the array's
   *   current length still resolve, since every position has the same
   *   element type.
   * - Tuple position: the position's default, and `undefined` out of
   *   range.
   * - Optional / Default / Nullable / Readonly / Catch / Pipe: the
   *   inner default.
   * - Discriminated union: the first variant's default, matching
   *   `validateAtPath`'s first-success rule.
   * - Leaf: the primitive default (`''`, `0`, `false`), or the
   *   wrapper's `.default(x)` value when present.
   * - A path the schema does not declare: `undefined`.
   *
   * An adapter may return `undefined` for any path it cannot resolve;
   * callers read that as "do not fill" and keep the existing data.
   */
  getDefaultAtPath(path: Path): unknown
  /**
   * The schema's appropriate nullish value at `path`: the underlying
   * type's empty concrete, with `.default(x)` wrappers explicitly NOT
   * honoured. This is what makes `form.clear(path)` differ from
   * `reset`: it ignores declared defaults and produces `false`, `0`,
   * `''`, `[]` or a recursively empty object instead.
   *
   * Sub-path resolution mirrors `getDefaultAtPath`; only leaves differ.
   *
   * - Primitive leaf: the falsy concrete (`''`, `0`, `false`, `0n`,
   *   `new Date(0)`).
   * - Array / Set / Record: empty.
   * - `Optional<T>`: `undefined`, the wrapper's absent marker.
   * - `Nullable<T>`: `null`, the wrapper's explicit empty.
   * - `Default<T>` / `Prefault<T>` / `Catch<T>`: the inner schema's
   *   empty. The declared default is INTENTIONALLY skipped.
   * - `Readonly<T>` / `preprocess(fn, T)`: the inner schema's empty.
   * - Object: recursive, every property gets its own empty.
   * - Discriminated union: the first variant's recursive empty.
   * - A path the schema does not declare: `undefined`.
   *
   * An adapter may return `undefined` for any path it cannot resolve;
   * callers read that as "do not write" and leave storage unchanged.
   */
  getEmptyValueAtPath(path: Path): unknown
  /**
   * Whether `path` resolves to, or descends through, a schema-side
   * normalizer that runs at parse rather than at the write boundary.
   * In Zod v4 that is `z.preprocess(fn, inner)` and `z.coerce.X()`,
   * which both desugar to `ZodPipe<ZodTransform, inner>`; in Zod v3 it
   * is `ZodEffects` with `_def.effect.type === 'preprocess'`.
   *
   * The slim-primitive write gate consults it. True at a path means the
   * gate takes the consumer's raw value verbatim and stops walking
   * children: storage holds the user's input, and the normalizer fires
   * during `safeParse`, not at `setValue` time.
   *
   * Prefix semantic: true if ANY ancestor of `path` resolves to such a
   * wrapper, so descendants of a preprocess-wrapped container
   * short-circuit the gate too. Adapters cache by canonical path key.
   */
  isPreprocessOrCoerceLeaf(path: Path): boolean
  /**
   * Whether `path` resolves to an opaque leaf: a schema that declares a
   * value without describing its shape. In Zod v4 that is `z.any()`,
   * `z.unknown()` and `z.custom(...)`, which is what both
   * `z.instanceof(X)` and `z.custom<T>()` compile to; in Zod v3 it is
   * `z.any()` and `z.unknown()`, with `z.instanceof(X)` peeling through
   * `ZodEffects` to `ZodAny`.
   *
   * The slim-primitive write gate consults it. An opaque leaf admits
   * every kind, containers included, and declares no sub-paths. Without
   * this the gate accepts an array at the leaf and then walks into it,
   * checking `files.0` against a schema that never declared that path;
   * the empty accept set there reads as "not in your schema" and no-ops
   * the whole write (#542).
   *
   * Exact-path semantic, unlike `isPreprocessOrCoerceLeaf`: it answers
   * for the node at `path` only. Descendants stay unwritable on their
   * own, because the schema genuinely does not declare them and
   * fabricating them would put phantom nodes on `form.fields`. Writing
   * the whole value at the opaque leaf is the supported move.
   */
  isOpaqueLeafAtPath(path: Path): boolean
  /**
   * Distinguish a tuple, fixed-length and position-typed, from an
   * unbounded array at `path`. The runtime calls this on every write
   * that descends into an array branch and treats the answer as
   * definitive.
   *
   * - `number`: a tuple of this structural length. The runtime pads the
   *   consumer's value to that length and recurses position by
   *   position.
   * - `null`: not a tuple. Covers the unbounded array, where the
   *   runtime uses the consumer's length and reuses one element default
   *   for every position, and also every path that does not resolve to
   *   an array at all, where `getDefaultAtPath` yields no element
   *   default either and the consumer's array passes through unchanged.
   *
   * Wrappers (optional, nullable, default, readonly, catch, pipe, lazy)
   * are peeled before the type check, so `optional(z.tuple([...]))`
   * reports its tuple length.
   */
  arrayShapeAtPath(path: Path): number | null
  /**
   * Whether the schema at `path` is a FIXED object, meaning a closed
   * set of declared keys (`z.object`), as opposed to an open or union
   * container (array, record, map, set, union, discriminated union)
   * whose element schema matches any segment.
   *
   * `form.fields` and `form.errors` use this to resolve a collision. A
   * fixed object's declared keys are known ahead of any data, so a key
   * the schema owns descends to a real terminal even before the live
   * value is populated, which keeps a declared-but-absent `optional`
   * field registrable. An open container cannot promise that: its
   * element schema accepts ANY segment, so the proxy falls back to the
   * keys the data currently holds and reads a genuinely absent key (an
   * out-of-bounds index, a missing record key, an inactive variant key)
   * as `undefined` rather than a phantom node.
   *
   * The empty path, the root form, is always a fixed object. Wrappers
   * are peeled before the kind check, so `z.object({...}).optional()`
   * still reports `true`. An undeclared path reports `false`.
   */
  isFixedObjectAtPath(path: Path): boolean

  /**
   * How the container at `path` spells the keys of its own entries:
   * `'number'` for an array or tuple, `'string'` for an object or
   * record, and for a `z.map` the kind its declared key type accepts.
   * `undefined` for anything else, a leaf and an undeclared path
   * included.
   *
   * The write walkers consult it at a `Map`, where a new entry must be
   * filed under a key of the declared type and the path segment alone
   * cannot say which: an integer-looking segment canonicalises to a
   * number, so `scores.42` against a `z.map(z.string(), V)` would
   * otherwise take the number `42` as its key and fail the map's own
   * parse. An entry the map already holds needs no ruling, since its
   * existing key wins.
   *
   * A map whose key type is neither string-ish nor number-ish, or which
   * admits both, reports `undefined`: no segment can spell such a key,
   * so the map stays a whole value with no addressable entries.
   *
   * Adapters MAY cache per path; the runtime calls this on the write
   * path.
   */
  entryKeyKindAtPath(path: Path): 'string' | 'number' | undefined
  /**
   * Every sub-schema that could resolve at `path`. Multiple results are
   * expected only for union branches, where the adapter cannot pick a
   * single winner until the data lands.
   *
   * `path` is the canonical `Segment[]`, walked segment by segment, so
   * a literal-dot key (`['user.name']`) never collides with the
   * sibling-pair form (`['user', 'name']`).
   */
  getSchemasAtPath(path: Path): AbstractSchema<unknown, GetValueFormType>[]
  /**
   * Validate the subtree at `path`, or the whole form when `path` is
   * `undefined`. As with `getSchemasAtPath`, `path` is the canonical
   * `Segment[]` rather than a dotted string, so two schemas with
   * colliding dotted forms stay distinct at the adapter boundary.
   *
   * Adapters MUST NOT throw: an error comes back as a `success: false`
   * response with a populated `errors` array.
   *
   * The `MaybePromise` return has three cases:
   * - `options.sync === true` and a sync-capable schema: the adapter
   *   SHOULD return the response inline. That lets the runtime batch
   *   error writes with a coincident value mutation into one Vue
   *   reactive flush, which is what prevents the `{}` flicker
   *   observable during a discriminated-union variant reshape.
   * - `options.sync === true` and an async-only schema, meaning any
   *   verdict that resolves only through a Promise: the adapter MUST
   *   fall back to `Promise<T>`. The flag is a preference; sync is not
   *   always achievable.
   * - `options.sync` omitted or `false`: the adapter SHOULD return
   *   `Promise<T>`.
   *
   * Callers that do not care simply `await`, which works for both arms.
   * A caller that must tell them apart branches on `instanceof Promise`.
   */
  validateAtPath(
    data: unknown,
    path: Path | undefined,
    options?: ValidateOptions
  ): MaybePromise<SchemaParseResult<GetValueFormType>>
  /**
   * The set of primitive `typeof`-style kinds the leaf schema at `path`
   * accepts at write time. The sync sister to `getSchemasAtPath` and
   * `validateAtPath`, used by `setValueAtPath` to gate writes without
   * round-tripping through async validation.
   *
   * Wrappers (optional, nullable, default, refinement, transform, pipe,
   * readonly, catch, lazy) are peeled. Refinement-level constraints,
   * meaning format checks such as email or uuid, min and max length,
   * enum membership, literal equality and regex, are IGNORED here:
   * those are a validation-time concern.
   *
   * The returned set unions across union branches and intersects across
   * intersection sides. Conventions:
   *
   * - Empty set: no kind admitted, so the gate rejects every write to
   *   the path. Surfaces for `never`-typed schemas and for paths that
   *   do not resolve in the schema at all, such as a typo.
   * - Permissive set, every kind: unknown or unconstrained, so the gate
   *   accepts any value. Surfaces for `any`, `unknown` and `void`, and
   *   where a lazy peel failed and the adapter cannot introspect.
   * - String-valued enums return `{'string'}`; numeric enums
   *   `{'number'}`; literal types `{primitiveKindOf(literalValue)}`.
   * - Object and array containers return `{'object'}` / `{'array'}`;
   *   the runtime walker recurses into entries at write time.
   * - Nullable and optional wrappers add `'null'` / `'undefined'` to
   *   the inner set.
   */
  getSlimPrimitiveTypesAtPath(path: Path): ReadonlySet<SlimPrimitiveKind>
  /**
   * Whether `path` resolves to a LEAF, meaning a path the schema
   * declares no sub-paths under. `form.values`, `form.errors` and
   * `form.fields` query this at every step to choose between
   * descending into a sub-proxy and terminating with a leaf value.
   *
   * That branching is what keeps reserved leaf-prop names (`dirty`,
   * `errors`, `valid`) from shadowing schema keys: they inject only at
   * the FieldState terminal, not at every depth, so a schema field
   * literally named `dirty` at depth 2 or deeper stays reachable in its
   * own right.
   *
   * - Object / Array / Map / Set, under any wrapper: `false`, a
   *   container, so descend further.
   * - Primitive (string, number, boolean, bigint, symbol, null,
   *   undefined, date, function): `true`. `date` and `function` are
   *   leaves because their values are opaque; do not drill into them.
   * - Opaque leaf (`z.any()`, `z.unknown()`, `z.custom()`, and the
   *   `z.instanceof(X)` that compiles to it): `true`, and this answers
   *   AHEAD of the kind test. An opaque leaf admits every kind
   *   including the container ones, so classifying it off the slim
   *   primitive set alone would call it a container and hang phantom
   *   nodes under it on `form.fields`. See `isOpaqueLeafAtPath`.
   *   Leafness asks whether the schema declares sub-paths here, and an
   *   opaque leaf declares none.
   * - Optional / Nullable / Default / Catch: transparent. They add
   *   `'null'` / `'undefined'` to the inner kind set without changing
   *   the classification.
   * - Discriminated union root: `false`, since the variants are
   *   objects and the kind set holds `'object'`.
   * - A union's discriminator key: `true`, since the literal type
   *   resolves to `{'string'}` or `{'number'}`.
   * - A variant-only key: `true` if it resolves to a primitive in any
   *   variant. Schema-static, so it does NOT read live storage to
   *   decide which variant is active.
   * - Empty path, the root: `false`, the form-as-object.
   * - A path the schema does not declare: `false`. The proxy descends
   *   permissively and leaf-prop reads at the unknown path return
   *   `undefined` from the store. Treating unknown paths as containers
   *   preserves the schema's authority and keeps a typo from
   *   re-introducing shadowing.
   *
   * Adapters MAY cache per path: this is called on every proxy `get`
   * trap hit. The reference implementation memoises a
   * `Map<PathKey, boolean>` keyed by `canonicalizePath(path).key`, with
   * a lifetime tied to the adapter, one per `useForm()` call.
   */
  isLeafAtPath(path: Path): boolean
  /**
   * Whether the leaf at `path` is required, meaning the schema does NOT
   * admit empty through `.optional()`, `.nullable()`, `.default(N)` or
   * `.catch(N)` at the leaf or any wrapper.
   *
   * The submit and validate path uses it to raise "No value supplied"
   * when a field is in the form's `blankPaths` set, because the user
   * cleared it or never answered, AND the schema treats it as required.
   * Without it a strict numeric leaf silently accepts its slim default
   * of `0` for an unanswered field, so an unanswered income reads as
   * zero and passes validation.
   *
   * - Optional / Nullable / Default / Catch at any wrapper layer, root
   *   or nested: `false`. The schema author opted into accepting empty.
   * - Readonly / Pipe / Lazy: transparent, peel and re-check the inner
   *   schema.
   * - Union or discriminated union: `false` if ANY branch admits empty,
   *   since a union accepts what its most permissive branch accepts.
   *   This matches `validateAtPath`'s first-success rule.
   * - Intersection: `true` if EITHER side requires the path, since an
   *   intersection needs both sides to accept, so one side rejecting
   *   empty makes the whole rejection.
   * - A path the schema does not declare: `false`.
   * - Empty path, the root: `true`, always required as an object.
   *
   * Refinement-level constraints (length, format, custom predicates)
   * are not consulted. Those run at parse time inside `validateAtPath`
   * and surface as schema errors regardless. This answers only whether
   * the leaf is required at all; refinements layer on top.
   */
  isRequiredAtPath(path: Path): boolean
  /**
   * If the schema at `path` is, or wraps, a discriminated union, its
   * discriminator key plus a `getVariantDefault(value)` lookup;
   * otherwise `undefined`. Wrappers are peeled transparently.
   *
   * Two reshapes share this lookup:
   *
   *   1. Discriminator-key write. The runtime calls it with the PARENT
   *      path. If `discriminatorKey` matches the path's last segment,
   *      the write changes which variant is active, so parent storage
   *      is replaced with the matching variant's slim default and the
   *      old variant's keys (an `address` left over after switching to
   *      `sms`) cannot leak.
   *   2. Whole-union write. The runtime calls it with the path itself.
   *      If the info exists and the consumer's value carries the
   *      discriminator key, the merge uses that variant's default
   *      instead of the first-variant fallback `getDefaultAtPath`
   *      returns for a union.
   *
   * An adapter that does not model discriminated unions can return
   * `undefined` unconditionally; the reshape is then a no-op.
   */
  getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined

  /**
   * Resolved field metadata for the schema node at `path`: label,
   * description and placeholder, plus the full registered payload as
   * `meta` for consumer-augmented keys. Reads through the shared
   * cross-adapter field-meta store, with one-way fallbacks:
   *
   *   - `label`:       registry payload, else `humanize(lastSegment)`
   *   - `description`: registry payload, else `schema.description`
   *                    (the `.describe()` value), else `undefined`
   *   - `placeholder`: registry payload, else `undefined`
   *   - `meta`:        registry payload, frozen; an empty object when
   *                    nothing was registered
   *
   * `path` is the canonical `Segment[]`, and the empty path resolves to
   * the root schema's metadata. Multiple candidates from union branches
   * resolve against the first match, following the same first-success
   * precedent as `getDefaultAtPath` and `validateAtPath`: register on
   * the union root for shared metadata, on individual branches for
   * variant-specific metadata.
   *
   * Optional. A missing implementation is treated as a stub returning
   * `EMPTY_RESOLVED_FIELD_META`, so consumers see the humanized `label`
   * fallback and `undefined` elsewhere.
   */
  getFieldMetaAtPath?(path: Path): ResolvedFieldMeta

  /**
   * Whether `validateAtPath` MAY have to run asynchronously to surface
   * every error this schema can produce. The runtime asks at
   * construction: `false` means the construction-time sync seed is
   * authoritative and no extra microtask is spent, `true` queues a
   * one-shot full-form async pass so async-only verdicts (refinements,
   * transforms or pipes that resolve only through a Promise) surface
   * without waiting for a user mutation.
   *
   * Optional and best-effort. A missing implementation is treated as
   * `() => false`, and async-only errors then fire on first user
   * mutation instead.
   *
   * For a per-path query, compose with `getSchemasAtPath(path)`: each
   * candidate sub-schema exposes its own `needsAsyncValidation`, so
   * "does the cargo subtree contain async work?" is the union of the
   * per-candidate answers, with no separate top-level overload.
   */
  needsAsyncValidation?(): boolean

  /**
   * Whether the schema carries a refine, check or transform at any
   * NON-LEAF position: a container node (object, array, tuple, union,
   * intersection, record, map, set) or the root itself. `false` means
   * every check is leaf-local, so a per-keystroke
   * `validateAtPath(form, leafPath)` catches the same verdicts as a
   * whole-form pass, because no ancestor refine reads the form's wider
   * state.
   *
   * The runtime uses it at the per-keystroke schedule to scope
   * field-level validation to the changed subtree where it can, and
   * falls back to a whole-form pass when an ancestor refine, such as a
   * cross-field equality or a sum constraint, could be moved by a leaf
   * write.
   *
   * Optional, and a missing implementation is treated as `() => true`,
   * the conservative whole-form answer. Detection is best-effort and
   * the two error directions are not symmetric: returning `true` where
   * no container refine exists only loses a perf win, while returning
   * `false` where one exists lets an ancestor verdict go stale. Bias
   * toward `true` when in doubt.
   */
  hasContainerOrRootRefine?(): boolean
  /**
   * Whether the schema tree holds at least one discriminated union at
   * any depth, inside arrays, tuples, records and lazy schemas
   * included. The store computes its per-form union capability flag
   * from this once at construction: `false` lets every write skip the
   * cross-variant ancestor guard and the variant-reshape dispatch, and
   * stops stub correction from running at all.
   *
   * Optional, and an adapter that omits it is treated as containing
   * unions, which keeps the conservative per-write probes on. Never
   * return `false` for a schema that DOES hold a discriminated union:
   * that disables variant reshape and stub correction for the form.
   */
  hasDiscriminatedUnions?(): boolean
}
/**
 * A discriminated union as the adapter reports it: the discriminator
 * key plus a lookup from a discriminator literal to the matching
 * variant's slim default. Returned by
 * `AbstractSchema.getUnionDiscriminatorAtPath`.
 */
export type UnionDiscriminatorContext = {
  /**
   * The property name whose literal value selects the variant, such as
   * `'channel'` for a union split on `{ channel: 'sms' | 'email' }`.
   */
  readonly discriminatorKey: string
  /**
   * Slim default for the variant whose discriminator literal equals
   * `value`, or `undefined` when no variant matches, in which case the
   * runtime skips the reshape and falls back to a plain write.
   */
  getVariantDefault(value: unknown): unknown
  /**
   * Whether `value` is a literal one of the discriminator's variants
   * recognises. Reshape uses it to choose between seeking a variant
   * default and emitting a stub state. NOT used at the write gate,
   * where consumer-side value validity is a validation-time concern.
   */
  isVariantSelected(value: unknown): boolean
}

/**
 * The primitive kinds the slim-primitive write contract recognises:
 * `typeof` plus a few well-known reference shapes (`Date`, `Array`,
 * `Map`, `Set`, plain `object`, `null`).
 *
 * The runtime gate's `slimKindOf(value)` returns one of these for a
 * value, and the adapter's `getSlimPrimitiveTypesAtPath(path)` returns
 * the set a leaf accepts. A write is gated by
 * `accepted.has(slimKindOf(value))`.
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
 * The "no result yet" status the reactive `validate()` ref holds while
 * a run is in flight. Narrow against `pending` to reach the settled
 * fields:
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
 * The value type of the ref `validate()` returns. Discriminate on
 * `pending` to switch between the in-flight and settled states.
 */
export type ReactiveValidationStatus<Form> = PendingValidationStatus | SettledValidationStatus<Form>

/**
 * When per-field validation runs.
 *
 * - `'change'` (default): every committed write schedules a validation
 *   for the affected path. At `debounceMs: 0`, also the default, the
 *   run is synchronous in the write handler; a positive `debounceMs`
 *   coalesces rapid bursts.
 * - `'blur'`: validate when the user tabs away from a registered
 *   field. No debounce; `debounceMs` is a type error.
 * - `'submit'`: no live validation. `handleSubmit` and explicit
 *   `validate()` / `parse()` calls are the only validation surfaces.
 *   `debounceMs` is a type error.
 *
 * Only validation timing varies by mode. How often a value commits to
 * storage is the directive's concern: `<input v-register>` commits per
 * keystroke, `<input v-register.lazy>` defers to blur.
 */
export type ValidateOn = 'change' | 'blur' | 'submit'

/**
 * Validation timing: `validateOn` is the trigger and `debounceMs` the
 * wait after the last committed write. The union is what makes pairing
 * `debounceMs` with `'blur'` or `'submit'` a type error rather than a
 * silent runtime drop.
 */
export type ValidateOnConfig =
  | {
      /** Validation trigger. Default `'change'`. */
      validateOn?: 'change'
      /**
       * Milliseconds to wait after the last committed write before
       * running validation, to coalesce rapid bursts into one pass.
       * Useful for slow async adapters, or to smooth inline feedback
       * under heavy typing.
       *
       * Default `0`: validation runs synchronously after the write,
       * with no `setTimeout`. Schema work still rides
       * `Promise.resolve().then(validateAtPath)`, so even at `0` errors
       * land a microtask later rather than in the same statement.
       *
       * This debounces validation only. A value commits to
       * `form.values` immediately either way.
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
 * Per-write metadata, tagging a write so listeners and the write funnel
 * can treat it specially. Every field is internal; do not set any of
 * them from consumer code.
 */
export type WriteMeta = {
  /**
   * Add the written path to the store's `blankPaths` set: storage holds
   * a real, schema-conformant value, the slim default, but the UI shows
   * the field as empty. The next write to that path WITHOUT this flag
   * removes it from the set, the user having typed something real.
   *
   * Set by `markBlank()` on the register binding, and by the `unset`
   * translation in `setValue`, `reset` and `useAbstractForm`
   * construction.
   */
  readonly blank?: boolean
  /**
   * Skip the discriminator-aware variant reshape inside
   * `setValueAtPath` for this write. Set by the reshape itself when it
   * re-enters with the new variant default, so the literal
   * discriminator inside that default cannot loop forever.
   */
  readonly skipDiscriminatorReshape?: boolean
  /**
   * Record an array structural mutation precisely enough to replay the
   * index permutation it produced. Set by the typed array helpers in
   * `array-engine.ts`, and used by `setValueAtPath` to surgically clear
   * variant memory for just the indices the operation invalidated.
   *
   * Without the hint, a raw whole-array `setValue(arrayPath, [...])`
   * clears all memory under the array, because the runtime cannot tell
   * which indices stayed put.
   */
  readonly arrayOp?:
    | { readonly kind: 'insert'; readonly index: number }
    | { readonly kind: 'remove'; readonly index: number }
    | { readonly kind: 'move'; readonly from: number; readonly to: number }
    | { readonly kind: 'swap'; readonly a: number; readonly b: number }
    | { readonly kind: 'replace-at'; readonly index: number }
  /**
   * Per-instance config threaded through writes so each
   * `useForm({ key })` call site honors its own `validateOn`,
   * `debounceMs` and `rememberVariants` even while sharing a store with
   * sibling calls, as a modal and a main form rendering the same
   * logical form do.
   *
   * Set by `buildFormApi` from the per-instance options bag; the store
   * reads each field with a fallback to its construction-time defaults.
   */
  readonly instance?: {
    readonly validateOn?: ValidateOn
    readonly debounceMs?: number
    readonly rememberVariants?: boolean
  }
  /**
   * Mark this `applyFormReplacement` call as a hydration step, meaning
   * the async-`defaultValues`, `activate()` or `rehydrate()` path.
   * Modules that snapshot form state, the history module in particular,
   * treat hydration as the baseline: stacks reset to a single seed of
   * the post-hydration value, so a later `undo()` cannot recover the
   * transient pre-hydration default.
   *
   * Set by the activate path in `create-form-store.ts`.
   */
  readonly hydration?: boolean
}

/**
 * The store slice the history runtime binds to. Structural on purpose:
 * `historyPlugin()` ships from the separate `attaform/history` entry,
 * so the runtime receives the store through this seam instead of
 * importing the store module, which would pull history internals onto
 * every form's eager path. A FormStore satisfies it as-is.
 *
 * @internal
 */
export type HistoryKernel = {
  readonly form: Ref<unknown>
  readonly blankPaths: Set<PathKey>
  readonly errorCells: Map<PathKey, ErrorCell>
  onFormChange(listener: (next: unknown, meta?: WriteMeta) => void): () => void
  applyFormReplacement(next: unknown): void
  restoreErrorCells(entries: ReadonlyArray<readonly [PathKey, ErrorCell]>): void
}

/**
 * The live undo/redo runtime a {@link HistoryPlugin} attaches to one
 * form. Cached on the store so every `useForm` and `injectForm`
 * consumer of the same key shares one chain; `buildFormApi` adapts it
 * into the public `form.history` namespace.
 *
 * @internal
 */
export type HistoryModule = {
  undo(): boolean
  redo(): boolean
  clear(): void
  canUndo: Readonly<ComputedRef<boolean>>
  canRedo: Readonly<ComputedRef<boolean>>
  historySize: Readonly<ComputedRef<number>>
  dispose(): void
}

/**
 * Opt-in undo/redo, created by `historyPlugin()` from
 * `attaform/history` and passed to `useForm({ history })`:
 *
 * ```ts
 * import { historyPlugin } from 'attaform/history'
 *
 * const form = useForm({ schema, history: historyPlugin({ max: 200 }) })
 * ```
 *
 * Every mutation records a position, and `form.history.undo()` /
 * `form.history.redo()` walk the chain. `reset()` is itself a mutation,
 * so the pre-reset state stays one undo away. Hydration is the floor:
 * once it applies, the chain reseeds with the hydrated value and
 * `undo()` cannot reach the transient pre-hydration default.
 *
 * A plugin instance is a reusable configuration, not per-form state, so
 * passing one instance to several forms gives each its own independent
 * chain.
 */
export type HistoryPlugin = {
  /**
   * Bind a fresh history runtime to one form's store. Called by
   * `useForm` when the store is first created.
   *
   * @internal
   */
  readonly attach: (kernel: HistoryKernel) => HistoryModule
}

/**
 * The undo/redo namespace at `form.history`, holding every
 * history-related method and reactive flag, so there is one address to
 * read from.
 *
 * Always present on a `useForm()` return whether or not `history` was
 * configured. Unconfigured, the methods are no-ops returning `false` or
 * `void`, `canUndo` and `canRedo` read `false`, and `size` reads `0`,
 * so a template needs no conditional.
 *
 * `canUndo`, `canRedo` and `size` read as plain values rather than
 * refs; no `.value`.
 */
export type FormHistoryNamespace = {
  /**
   * Step back one position. `true` when a step was taken, `false` at
   * the oldest reachable position or when history is not configured.
   */
  readonly undo: () => boolean
  /**
   * Replay the next step forward. `true` on success, `false` when
   * nothing is queued or history is not configured. The forward branch
   * is dropped as soon as a new mutation lands.
   */
  readonly redo: () => boolean
  /**
   * Wipe the undo and redo branches and reseed the chain with the
   * current form state as the new baseline. Values, errors and
   * blankPaths all stay put; only past and future reset. Afterwards
   * `canUndo` and `canRedo` are `false` and `size` is `1`. A no-op when
   * history is not configured.
   */
  readonly clear: () => void
  /** `true` when at least one undo step is available. */
  readonly canUndo: boolean
  /** `true` when `undo()` has been called and a `redo()` would replay. */
  readonly canRedo: boolean
  /**
   * Total reachable positions: the current one plus everything
   * reachable by `undo()` and `redo()`. Useful for a debug overlay; UI
   * driving undo and redo buttons should gate on `canUndo` and
   * `canRedo`. Reads `0` when history is not configured.
   */
  readonly size: number
}

/**
 * Configuration passed to `useForm`. Only `schema` is required.
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
   * The schema describing the form's shape and validation rules. A
   * typed entry point such as `attaform/zod` takes the underlying
   * library's schema directly and wraps an adapter; the abstract entry
   * point takes any object implementing `AbstractSchema`.
   *
   * For a schema that depends on the form's identity or per-form
   * options, pass a factory `(key, options) => schema` instead, called
   * once per form. Most adapters ignore the options argument; the typed
   * Zod entry points use it to thread the recursion cap into the
   * adapter closure.
   */
  schema: Schema | ((key: FormKey, options: SchemaFactoryOptions) => Schema)
  /**
   * Optional identifier for this form. Omit it for a one-off form and
   * Attaform allocates a unique key automatically, SSR-safe and stable
   * across hydration.
   *
   * Pass a string when the form needs identity:
   * - to look it up from a distant component via `injectForm(key)`;
   * - to share state across components, since several `useForm({ key })`
   *   calls with the same key resolve to the same form;
   * - to give DevTools and validation errors a recognisable label.
   *
   * Keys starting with `__atta:` are reserved and throw
   * `ReservedFormKeyError`.
   *
   * A string literal is preserved on `form.key`, so `useWizard` and
   * other consumers can discriminate against the union of known keys at
   * compile time.
   */
  key?: K
  /**
   * Initial values applied over the schema's defaults. A field not
   * named here falls back to the schema default, or to the primitive
   * default for the slot's type.
   *
   * Values must satisfy the slim primitive type at each path (string,
   * number, boolean, Date) but do NOT have to satisfy refinement-level
   * constraints such as format checks, enum membership or length and
   * range bounds. A refinement-invalid default passes through and
   * surfaces as a field error, which is what lets you rehydrate stale
   * saved data without discarding the user's input.
   *
   * Accepts a plain value, a sync function, or an async function:
   *
   * ```ts
   * // Plain value: applies at construction.
   * defaultValues: { email: '' }
   *
   * // Sync function: invoked on a microtask after construction.
   * defaultValues: () => buildDraft()
   *
   * // Async function: the form starts with the schema's slim defaults
   * // and `form.hydrating` is true while the promise is in flight; on
   * // resolve the values apply and `hydrating` flips false. Under SSR
   * // the factory fires via `onServerPrefetch`, so the resolved payload
   * // bakes into hydration transfer state and the client never
   * // re-fetches.
   * defaultValues: async () => api.fetchDraft(userId)
   * ```
   *
   * An error thrown by a function-form factory surfaces on
   * `form.hydrateError` and leaves the form usable with slim defaults.
   * Call `form.rehydrate()` to re-fire the factory.
   */
  defaultValues?: DefaultValues | (() => DefaultValues) | (() => Promise<DefaultValues>)
  /**
   * Move keyboard and screen-reader focus to the first errored field
   * when a submit attempt fails validation, after errors are populated
   * and before your `onError` callback runs. Default `true`: focusing
   * the broken field is an accessibility baseline, and browsers scroll
   * the focused element into view as part of the move.
   *
   * Pass `false` to drive the nudge yourself from `onError` with
   * `form.focusFirstError()` or `form.scrollToFirstError()`, both of
   * which stay available either way.
   *
   * The focus requests `focusVisible: true` so the browser paints a
   * focus ring despite the move being programmatic. On a UA that does
   * not support that hint, a non-text control (radio, checkbox, custom
   * widget) can end up focused with no visible ring after a
   * pointer-driven submit; pair this with your own indicator, such as a
   * `:focus-within` ring on the option wrapper, if you target those
   * browsers.
   *
   * If no errored field has a mounted, visible element, the focus
   * silently no-ops.
   */
  focusOnInvalidSubmit?: boolean
  /**
   * Freeze the form's data. While this resolves truthy every value
   * write no-ops at the store's write chokepoint, programmatic
   * `setValue`, the `v-register` directive and host-model events alike;
   * native registered inputs render the HTML `disabled` attribute;
   * component hosts receive a `disabled` flag on their register value;
   * and every field's `displayState` drops to `'idle'`, so error,
   * pending and success signals stand down. The first blocked write
   * logs a one-time dev warning. Writes never throw.
   *
   * `reset()` and `defaultValues` hydration still apply while frozen,
   * so a disabled form can be populated or cleared programmatically.
   * This is a data freeze only: the form stays navigable, which is what
   * a read-only review page wants.
   *
   * Accepts a boolean, ref, computed or getter, read live so the freeze
   * tracks a reactive source. `undefined` resolves to `false`.
   *
   * A shared store resolves `disabled` from its first
   * `useForm({ key })` call; a later caller passing a different value
   * is ignored.
   */
  disabled?: MaybeRefOrGetter<boolean | undefined>

  /**
   * When per-field validation runs. Default `'change'`. See
   * `ValidateOn` for mode semantics.
   *
   * This sets validation timing only. How often a value commits to
   * storage is the directive's concern: per keystroke for
   * `<input v-register>`, per blur for `<input v-register.lazy>`.
   */
  validateOn?: ValidateOn
  /**
   * Milliseconds to wait after the last committed write before running
   * validation, to coalesce rapid bursts. Default `0`: validation runs
   * synchronously after the write, with no `setTimeout`.
   *
   * Only accepted under `validateOn: 'change'`. Passing it with
   * `'blur'` or `'submit'` is a type error.
   */
  debounceMs?: number

  /**
   * Opt-in undo/redo, off by default. Pass `historyPlugin()` from
   * `attaform/history`, which caps at 128 positions, or
   * `historyPlugin({ max: N })` to tune it. See {@link HistoryPlugin}
   * for how the chain behaves, and `form.history` for the surface it
   * adds.
   */
  history?: HistoryPlugin

  /**
   * Whether to remember each discriminated-union variant's typed state
   * across switches. Default `true`.
   *
   * At `true`, switching `notify.channel` from `email`, holding
   * `address: 'foo@bar.com'`, to `sms` and back lands on
   * `address: 'foo@bar.com'` again: the runtime snapshots the outgoing
   * variant's subtree on switch-out and restores the incoming variant's
   * prior subtree on switch-in. Every union at every nesting depth is
   * memorized independently.
   *
   * At `false`, the outgoing variant's typed state is dropped on every
   * switch and the incoming variant initializes from its slim default.
   *
   * Memory is in-memory only and does not survive a fresh mount, so a
   * page reload starts every discriminator empty. `reset()` clears it;
   * `resetField(path)` clears any entry whose union path equals or sits
   * under `path`.
   */
  rememberVariants?: boolean
  /**
   * Schema-driven coercion of user-typed DOM values at the v-register
   * layer. Two rules ship, string to number and string to boolean, each
   * firing only where the schema declares that single type at the path.
   * Defaults to on; `false` disables coercion form-wide and the slim
   * gate rejects mismatches instead.
   *
   * Coercion applies ONLY to user-typed DOM values. A programmatic
   * write is never coerced.
   */
  coerce?: boolean
  /**
   * @internal
   * SSR prefetch mark, set by the `attaform/vite` compile-time
   * transform on a `useForm` call whose surrounding SFC template, or a
   * computed feeding it, reads the form's reactive state. The flag
   * enqueues the form on the registry's SSR prefetch queue, so an async
   * `defaultValues` factory runs inside `onServerPrefetch` and the
   * resolved payload bakes into the hydration transfer state.
   *
   * Consumers do not write this; `form.activate()` is the documented
   * escape hatch for where the transform's static analysis cannot see a
   * reference, such as cross-module sharing, dynamic property access or
   * a headless context.
   */
  __ssrAccessed?: boolean
}

export type FormStore<TData extends GenericForm> = Map<FormKey, TData>

/**
 * Callback invoked by `handleSubmit` after the form parses successfully.
 * Receives the strictly-typed parsed value — refinements have run, so
 * enum / literal / format constraints are honoured.
 */
export type OnSubmit<Form extends GenericForm> = (form: Form) => void | Promise<void>

/**
 * Callback invoked by `handleSubmit` on a failed submit. Fires when
 * client validation fails AND when the submit callback leaves errors in
 * the user-error layer (the `setErrors(...); return` server-rejection
 * pattern). Receives the full list of errors. Bind this when you want to
 * react to submit failures explicitly (alongside or instead of the
 * automatic `focusOnInvalidSubmit` nudge).
 */
export type OnError = (error: ValidationError[]) => void | Promise<void>

/**
 * The display-state verdict at a path: the one signal a UI needs to
 * decide what, if anything, to surface about validation right now.
 * Rolled up at containers and at the form root
 * (`form.meta.displayState`).
 *
 * - `'idle'`: nothing to surface, either because the timing gate has
 *   not opened yet or because it has and no verdict is worth showing.
 * - `'pending'`: a run is in flight at this path and the prior verdict
 *   is stale. Drive a spinner or a "Checking..." affordance.
 * - `'error'`: a blocking error the timing gate has cleared for
 *   display.
 * - `'success'`: validation passed and the gate has cleared a positive
 *   confirmation, the green-check pattern.
 *
 * The four `show*` booleans on `FieldState` are sugar over this enum
 * (`showErrors === (displayState === 'error')`, and so on), so they can
 * never contradict it.
 */
export type DisplayState = 'idle' | 'pending' | 'error' | 'success'

/**
 * The `FieldState` keys layered on FROM the display-state predicate,
 * plus `firstError` and `firstOwnError`, computed alongside them.
 *
 * They are `Omit`'d from the predicate's own arguments so it cannot
 * read its own output and form a cycle. Enforced at the type level and
 * at runtime both: the base objects passed in literally lack these
 * keys, so neither an `as` cast nor a vanilla-JS caller can reach them.
 * `FieldStateBase` and `FormMetaBase` in `field-state-api.ts` omit the
 * same set in lockstep.
 */
export type FieldStateDerivedKey =
  | 'displayState'
  | 'showErrors'
  | 'showPending'
  | 'showSuccess'
  | 'showIdle'
  | 'firstError'
  | 'firstOwnError'

/**
 * One step of the display state machine: the verdict the field should
 * render now, as `display`, projected to `displayState` and the `show*`
 * booleans, plus two optional timing cells the engine reads.
 */
export type DisplayMachine = {
  readonly display: DisplayState
  /**
   * An absolute `Date.now()` stamp meaning "re-evaluate this field no
   * later than here". The engine keeps one timer per form aimed at the
   * nearest `reviewAt` across all active fields; when it fires, the
   * dependent field computeds re-run and call the reducer again.
   *
   * A machine with no `reviewAt` and a non-pending `display` is
   * terminal, and the engine evicts it.
   */
  readonly reviewAt?: number
  /**
   * The stamp at which `'pending'` was first shown: the memory the
   * min-visible hold needs, so a spinner that has only just appeared is
   * not yanked away the instant validation resolves. Opaque to the
   * engine, and a custom reducer may carry extra memory fields of its
   * own alongside it.
   */
  readonly pendingShownAt?: number
}

/**
 * Inputs to the display reducer. `field` and `formMeta` are the
 * reactive snapshots it resolves against, minus the derived
 * `displayState`, `show*` and `firstError` keys, so the reducer can
 * never read its own output and form a cycle. See
 * `FieldStateDerivedKey`.
 */
export type DisplayCtx = {
  readonly field: Omit<FieldState, FieldStateDerivedKey>
  readonly formMeta: Omit<FormMeta, FieldStateDerivedKey>
  /**
   * `Date.now()` at which the field's current validation streak opened,
   * or `null` when nothing is in flight. This, not `field.validating`,
   * is the timing anchor: the elapsed wait is `now - validatingSince`.
   * Pinned to the start of the streak, so overlapping sub-runs do not
   * reset it.
   */
  readonly validatingSince: number | null
  /**
   * The same anchor for an in-flight async `register` transform, or
   * `null` when none is running, including for a sync-only chain, which
   * never defers. It folds into the one in-flight clock the reducer
   * already runs for validation, so a deferred transform rides the
   * anti-flash spinner timing identically.
   */
  readonly transformingSince: number | null
  /**
   * The engine's clock, injected so the reducer stays pure and
   * deterministic. Frozen to `0` under SSR, where there is no clock.
   */
  readonly now: number
}

/**
 * Pure transition reducer resolving a path's `displayState`. Given the
 * field's previous `DisplayMachine` and the current `DisplayCtx` it
 * returns the next machine: the engine owns the clock and the timers,
 * the reducer owns the timing policy.
 *
 * It runs on every field-state read, and again whenever a `reviewAt`
 * deadline fires, so the whole app's validation-display behavior flows
 * from this one function in `core/display-state.ts`.
 *
 * @internal
 */
export type GetDisplayState = (prev: DisplayMachine, ctx: DisplayCtx) => DisplayMachine

/**
 * The submit handler `handleSubmit(onSubmit, onError)` returns. Bind it
 * to a `<form>`:
 *
 * ```vue
 * <form @submit="onSubmit">...</form>
 * ```
 *
 * It takes the originating `Event` and calls `event.preventDefault()`
 * itself, so bind with `@submit`, not `@submit.prevent`, which would
 * only prevent the default a second time. Called imperatively with no
 * event, the `preventDefault` step is skipped.
 */
export type SubmitHandler = (event?: Event) => Promise<void>

/**
 * The type of `form.handleSubmit`. Pass an `onSubmit` for the happy
 * path, and optionally an `onError` that receives the validation errors
 * when parsing fails.
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
 * Per-leaf internal tracker record, distinct from `FieldState.meta`,
 * which surfaces the registry-attached label, description and
 * placeholder payload as `Readonly<FieldMetaPayload>`.
 *
 * Surfaced for custom-adapter authors threading metadata through their
 * own pipelines. Most consumers do not reach for it, since the matching
 * fields appear in friendlier shape on `FieldState`.
 */
export type MetaTrackerValue = {
  /** ISO timestamp of the most recent write at this path. `null` if never written. */
  updatedAt: string | null
  /** Value as it arrived, before any transforms. Distinguishes a parse-coerced read from raw user input. */
  rawValue: unknown
  /** `true` while at least one binding to this path is currently mounted. */
  connected: boolean
  /** Form this metadata belongs to. */
  formKey: FormKey
  /** Dotted-string path to this leaf, or `null` when not applicable. */
  path: string | null
  /**
   * `true` when storage and the visible display diverge at this path.
   * Reserved for the case the schema cannot see on its own: storage
   * forces a value, `0` for a numeric leaf or `0n` for a bigint leaf,
   * while the DOM input shows `''`, so the runtime needs a side channel
   * to tell "user typed 0" from "user supplied nothing".
   *
   * Set automatically for numeric leaves, by the directive's input
   * listener on clear and by the construction-time pass when the
   * consumer supplied no value. Set explicitly for any primitive leaf
   * through `setValue(path, unset)`, `defaultValues: { x: unset }` or
   * `reset({ x: unset })`, which is the documented opt-in for strings,
   * booleans and other types that do not otherwise diverge. Cleared on
   * the first non-`unset` write.
   *
   * Errors are reactive end to end, so any required path with
   * `blank: true` puts a "No value supplied" entry in `form.errors`
   * immediately, with no `validate()` or `handleSubmit` call. Most
   * consumers gate UI on `errors[path]` and `touched` instead; read
   * `blank` when you want pre-error introspection, such as a "the user
   * has not decided yet" indicator or a "review unanswered fields"
   * hint.
   *
   * See `docs/validation/blank.md` for the full conceptual model.
   */
  blank: boolean
}

// Every registrable path inside `Form`. An array of primitive items
// exposes BOTH the array root AND `${Key}.${number}`, so multi-select
// and multi-checkbox bindings can register at the root; an array of
// objects exposes only the indexed-and-deeper paths. The `'register'`
// mode of the shared `FlatPathBuilder` recursion is what skips
// container paths, since `v-register` binds onto leaf-backing native
// elements only. The `Form extends unknown` wrapper distributes over a
// union root exactly as `PartialFlatPath` does.
export type RegisterFlatPath<Form> = Form extends unknown
  ? FlatPathBuilder<Form, 'register'>
  : never

/**
 * A transformation applied to a field's value as user input flows from
 * the DOM through the directive's assigner. Composes left to right via
 * the `transforms: [...]` array on `register()`.
 *
 * The shape is deliberately generic-erased rather than per-path-typed,
 * so a personal library of transforms (`trim`, `lowercase`, `slugify`,
 * `clamp`) plugs into any `register()` slot whatever the path's value
 * type. Write defensive bodies that no-op on a type mismatch:
 *
 * ```ts
 * export const trim: RegisterTransform = (v) =>
 *   typeof v === 'string' ? v.trim() : v
 * ```
 *
 * Call-site type safety is delegated to the slim-primitive gate: a
 * transform producing a value the path's storage does not accept is
 * rejected at write time with a standard diagnostic.
 *
 * Transforms may be sync or async. The chain stays fully synchronous,
 * with the value reaching form state in the same tick, until a
 * transform returns a thenable; from there the write defers, the field
 * reads `busy` and `transforming` while the chain settles, and the
 * resolved value commits once it lands. Rapid edits discard all but the
 * latest, and a rejection surfaces on `field.transformError` rather
 * than throwing or logging:
 *
 * ```ts
 * export const normalize: RegisterTransform = async (v, ctx) => {
 *   const res = await fetch(`/normalize?q=${v}`, { signal: ctx?.signal })
 *   return res.text()
 * }
 * ```
 *
 * `ctx.signal` aborts when the run is superseded by a newer edit, or is
 * torn down by `reset()` or unmount. Thread it into cancellable I/O so
 * a stale request is dropped. A sync chain never touches it and
 * allocates no controller.
 *
 * A synchronous throw is caught and aborts the pipeline: later
 * transforms do not run, nothing is written, and the assigner returns
 * `false`, so a buggy or defensively-throwing transform never crashes
 * the host app. An async rejection is the `transformError` channel
 * above, not a throw into the host app.
 */
export type RegisterTransform = (value: unknown, ctx?: TransformContext) => unknown

/** Options for `register(path, options)`, applied at the binding's own call site. */
export type RegisterOptions = {
  /**
   * Transformation pipeline applied to user-typed values before they
   * reach form state, composing left to right: each transform receives
   * the previous one's output, and the first receives the
   * directive-extracted DOM value.
   *
   * The full order is
   * `DOM event -> modifier cast (.lazy/.trim/.number) -> transforms[0] -> ... -> assigner`.
   *
   * User input only. `form.setValue(...)`,
   * `rv.setValueWithInternalPath(...)`, `form.reset()`, hydration, SSR
   * replay and `markBlank()` all bypass transforms, because they write
   * canonical state rather than normalized user input. To apply the
   * same normalization to a programmatic write, compose it yourself:
   *
   * ```ts
   * form.setValue('email', slugify(lowercase(rawValue)))
   * ```
   *
   * See `RegisterTransform` for the sync and async contract. For a
   * pattern that needs to inspect the `RegisterValue` itself, such as
   * rejection with a side effect, redirection to other fields or custom
   * DOM mutation, use `@update:registerValue` on the bound element
   * instead; see "Custom assigners" in the API docs.
   */
  transforms?: ReadonlyArray<RegisterTransform>
}

/**
 * The narrow kernel surface the DOM binding drives, structurally a
 * subset of the form store: the field-record connect and disconnect
 * transitions, focus marking, which owns blur-validation, the record
 * and merged-error reads the focus walk needs, and the async-transform
 * abort for a fully detached path.
 *
 * @internal
 */
export type DomBindingKernel = {
  readonly noteDomConnected: (path: Path) => void
  readonly noteDomDisconnected: (path: Path) => void
  readonly markFocused: (
    path: Path,
    focused: boolean,
    meta?: { readonly instance?: WriteMeta['instance'] }
  ) => void
  readonly getFieldRecord: (path: Path) => FieldRecord | undefined
  readonly getErrorsForPath: (path: Path) => ValidationError[]
  readonly cancelTransformsUnder: (prefix: Path) => void
}

/**
 * The form store's DOM slice: the element registry behind
 * `field.element` and `field.elements`, no-latch host focus anchors,
 * and first-error focus resolution. Implemented in the directive
 * cluster's lazy graph and armed into the store's `domBinding` slot on
 * first use, see `RegisterValue.ensureDomBinding`. A `null` slot means
 * nothing in the app ever registered an element.
 *
 * @internal
 */
export type AttaformDomBinding = {
  readonly elements: Map<PathKey, ElementRecord>
  readonly attach: (
    segments: Path,
    element: HTMLElement,
    formInstanceId: string,
    instanceMeta: WriteMeta['instance'] | undefined
  ) => void
  readonly detach: (segments: Path, element: HTMLElement) => void
  readonly markHostConnected: (
    segments: Path,
    connected: boolean,
    hostEl: HTMLElement,
    formInstanceId: string
  ) => void
  readonly getFirstErrorElement: (
    formInstanceId: string
  ) => { path: Path; element: HTMLElement } | null
}

/**
 * Factory the directive and `useRegister` inject through
 * `RegisterValue.ensureDomBinding` to arm a store's `domBinding` slot.
 *
 * @internal
 */
export type DomBindingFactory = (kernel: DomBindingKernel) => AttaformDomBinding

/**
 * What `form.register(path)` returns. Pass it to a native input via
 * `v-register`:
 *
 * ```vue
 * <input v-register="form.register('email')" />
 * ```
 *
 * Or read `innerRef` directly when integrating a custom component.
 *
 * It is a `shallowReadonly` reactive proxy: top-level reads track in
 * reactive scopes, mutations are blocked, and inner refs (`innerRef`,
 * `displayValue`) keep their `Ref` shape.
 *
 * `path`, `formKey` and `formInstanceId` are the wrapper-component
 * primitives: a generic component using `useRegister()` derives field
 * state and form identity from them without re-threading props from
 * its parent.
 */
export type RegisterValue<Value = unknown> = Readonly<{
  /**
   * Live, read-only value at this path. Watch it to drive UI that
   * depends on the field's current value.
   */
  innerRef: Readonly<Ref<Value>>
  /**
   * Attach an HTML element to this binding. `v-register` calls it
   * automatically; expose it to a custom integration that registers an
   * element by hand.
   *
   * Recording the element drives the form's element map, behind
   * `field.meta.connected`, `focusFirstError` and `scrollToFirstError`.
   */
  registerElement: (el: HTMLElement) => void
  /**
   * Detach an HTML element, dropping it from the form's element map.
   * Pair with `registerElement` for custom integrations.
   */
  deregisterElement: (el: HTMLElement) => void
  /**
   * Write the field's value programmatically, returning `true` when
   * accepted and `false` when rejected, as for a wrong primitive type
   * at the path.
   *
   * This is the write path for custom directives and consumer
   * assigners: it routes through the same funnel, and the same
   * per-instance meta, as the directive's default assigner.
   * Caller-supplied `meta` passes through unchanged.
   */
  setValueWithInternalPath: (value: unknown, meta?: WriteMeta) => boolean
  /**
   * Commit a value emitted by a third-party component bound through
   * `v-register`'s compile-time v-model desugar. Writes the component's
   * typed model output as authoritative, with no coercion, AND marks
   * the field interacted, since a v-model host has no DOM input
   * listener to flip the sticky `interacted` bit. The injected
   * `onUpdate:modelValue` handler is the only caller. `true` when the
   * write was accepted.
   *
   * @internal
   */
  setValueFromHost: (value: unknown) => boolean
  /**
   * Mark this field DOM-connected during SSR, so a server-rendered
   * template reading `form.fields.<path>.connected` does not flicker on
   * hydration. `v-register` calls it for you; a no-op on the client.
   *
   * @internal
   */
  markConnectedOptimistically: () => void
  /**
   * Mark this field DOM-connected or disconnected for a `v-register`
   * component host that binds value through the v-model desugar but
   * exposes no single inner control to register: a composite widget, or
   * one where none was found. The directive calls it on mount and
   * unmount. Distinct from the SSR-only
   * `markConnectedOptimistically`.
   *
   * `hostEl` is the host root, recorded on connect as the field's
   * focus-first-error anchor. A no-latch host registers no control, so
   * it would otherwise be invisible to `focusFirstError` and
   * `scrollToFirstError`, which walk the registered-element set. On an
   * invalid submit the error walk resolves the host root to its first
   * focusable descendant. The directive passes the same element on both
   * edges.
   *
   * @internal
   */
  markHostConnected: (connected: boolean, hostEl: HTMLElement) => void
  /**
   * Mark this field focused or blurred for a `v-register` component
   * host with no single latched control: a composite widget whose focus
   * moves between inner segments, or a control-less one. The directive
   * tracks focusin and focusout on the widget root and forwards here,
   * so focus state and blur-validation still arm without an
   * element-level focus listener. Carries this binding's instance meta,
   * including its `validateOn`.
   *
   * @internal
   */
  markFocused: (focused: boolean) => void
  /**
   * `true` when an element already registered for this binding's path
   * is inside, or is, `hostElement`. The directive's component-host
   * branch reads it to tell a `useRegister` wrapper, whose inner
   * control self-registered, from a third-party component, which
   * registered nothing, so the latch runs only for the latter.
   *
   * @internal
   */
  hasRegisteredDescendant: (hostElement: HTMLElement) => boolean
  /**
   * Arm this binding's form store with the DOM-binding implementation:
   * element registry, focus listeners, first-error focus resolution.
   * That implementation lives in the directive cluster's lazy graph, so
   * the directive and `useRegister` inject its factory here before any
   * element call, and once armed the store's `domBinding` slot serves
   * every later registration.
   *
   * Optional, so a hand-rolled RegisterValue owning its own element
   * handling need not declare it.
   *
   * @internal
   */
  ensureDomBinding?: (factory: DomBindingFactory) => void
  /**
   * Canonical JSON-encoded path key for this binding, such as
   * `'["items",0,"name"]'`. Useful for stable Map and Set keys, log
   * messages, and equality against another `RegisterValue`'s path.
   * Treat it as opaque: for `form.fields(...)` and `form.values(...)`
   * lookups inside a wrapper component, use `segments`.
   */
  path: PathKey
  /**
   * Structured path segments for this binding, such as
   * `['items', 0, 'name']`. The consumer-friendly form for
   * `form.fields(...)` and `form.values(...)` lookups in a generic
   * wrapper:
   *
   * ```ts
   * const rv = useRegister()
   * const form = injectForm()
   * const field = computed(() => form.fields(rv.value?.segments ?? []))
   * ```
   *
   * Frozen at runtime, so a wrapper can read it without defensive
   * copying.
   */
  segments: Path
  /**
   * The form's `key`, supplied or auto-allocated, mirroring `form.key`.
   * Useful in a wrapper that targets a specific form by key without
   * prop-drilling.
   */
  formKey: string
  /**
   * Per-mount identifier for the form instance, stable across the
   * form's lifetime. The directive uses it to scope element
   * registrations to a single mount; it is exposed here for wrappers
   * that must disambiguate sibling forms sharing a `key`.
   */
  formInstanceId: string
  /**
   * The readonly handle the directive iterates for this binding's
   * transform pipeline. See `RegisterOptions.transforms` for the public
   * contract. Optional, so a hand-rolled mock need not declare an empty
   * array; the directive falls back to a no-op pipeline.
   *
   * @internal
   */
  transforms?: ReadonlyArray<RegisterTransform>
  /**
   * Schema-driven coercion closure baked at register time, capturing
   * the path's slim accept set and the resolved coercion index so the
   * per-event hot path is one function call. The identity function when
   * coercion is disabled or the path admits no coercion target.
   * Optional, so a hand-rolled mock need not declare it; the directive
   * falls back to identity.
   *
   * @internal
   */
  coerce?: (value: unknown) => unknown
  /**
   * Element-level coercion closure for container paths (`z.array(...)`,
   * `z.set(...)`), coercing a scalar DOM-side value such as an option's
   * `value` attribute or a checkbox's value against the container's
   * element type. `undefined` when the path is not a container, where
   * `coerce` is used exclusively.
   *
   * The directive's read-side comparisons in `setChecked` and
   * `setSelected` use it to keep parity with the change handler's
   * write-side path-level coerce.
   *
   * @internal
   */
  coerceElement?: (value: unknown) => unknown
  /**
   * Read-only string view of the field's current value: what the
   * compile-time `:value` injection reads on every input, textarea and
   * select bound by `v-register`.
   *
   * `''` when the path is in the form's `blankPaths` set, or storage is
   * `null` or `undefined`; otherwise `String(storage)`. The blank branch
   * is what lets a user clear a numeric field without the next render
   * patching `el.value` back to the slim default `'0'`.
   */
  displayValue: Readonly<Ref<string>>
  /**
   * Blank-aware presentation for a component host's `:modelValue`, the
   * typed-model analog of `displayValue`'s `''`: `undefined` when the
   * path is in `blankPaths`, otherwise the raw typed storage. Lets a
   * cleared numeric field read empty in a v-model-bound component as it
   * does in a native input. Read only by the compile-time
   * component-bridge transform.
   *
   * @internal
   */
  hostModelValue: Readonly<Ref<Value | undefined>>
  /**
   * Live `true` when this binding's form is frozen via
   * `useForm({ disabled })`. The compile-time transforms bind it to the
   * host's `:disabled`, so a native `<input v-register>` renders the
   * HTML `disabled` attribute on both server and client, and a
   * component host receives a `disabled` prop. Read it from a custom
   * `useRegister` integration to drive your own disabled affordance.
   */
  disabled: Readonly<Ref<boolean>>
  /**
   * Add this field's path to the form's `blankPaths` set, writing the
   * slim default to storage. Returns the `setValueAtPath` verdict:
   * `true` accepted, `false` rejected by the slim-primitive gate.
   *
   * Called by the directive's input listener on a numeric clear, and by
   * the `setValue(path, unset)` translation.
   *
   * @internal
   */
  markBlank: () => boolean
  /**
   * Flip this field's sticky `interacted` flag, the signal that the
   * user has made at least one value edit here, an insert or a delete.
   * Called by the directive's input and change listeners on genuine
   * user input, never by hydration or a programmatic write. Idempotent,
   * since the store skips the write once set.
   *
   * @internal
   */
  markInteracted: () => void
  /**
   * `true` when the schema's slim primitive set at this path includes
   * `'undefined'`, meaning the leaf was declared `.optional()`, or sits
   * in a union admitting `undefined`. Cached at register time.
   *
   * The directive's text-input listener reads it to map a DOM clear
   * onto `undefined` storage rather than `''`, so the `.optional()`
   * absent semantic survives user interaction. Without it, a user who
   * typed an invalid value into an optional field and then cleared it
   * would be stuck with a permanent validation error, storage holding
   * `''`, which is neither `undefined` nor a valid inner value.
   *
   * @internal
   */
  acceptsUndefined: boolean
  /**
   * `true` when the schema's slim primitive set at this path includes
   * `'string'`. Cached at register time alongside `acceptsUndefined`.
   *
   * The directive's text-input listener reads it so a DOM clear on a
   * numeric-only, boolean-only or bigint-only leaf takes the
   * `markBlank` path instead of writing `''` through the assigner. The
   * slim gate would reject the empty string anyway, and the directive's
   * post-write force-sync would then snap the DOM back to the last
   * accepted value, making the final character undeletable. Through
   * `markBlank`, storage holds the slim default with the blank meta and
   * the DOM stays empty.
   *
   * @internal
   */
  acceptsString: boolean
  /**
   * The field's aria satellite ids, mirroring `FieldState.aria`. The
   * directive points `aria-describedby` at `errorId` while the field is
   * in its error state. Optional for mock tolerance; the directive
   * skips aria wiring when absent.
   *
   * @internal
   */
  aria?: {
    readonly errorId: string
    readonly descriptionId: string
  }
  /**
   * Whether the schema marks this path required, from
   * `schema.isRequiredAtPath(segments)`. Drives `aria-required`.
   * Optional for the same mock tolerance as `aria`.
   *
   * @internal
   */
  isRequired?: boolean
  /**
   * The gated display-state verdict for this path, reusing the same
   * field-state identity as `form.fields`. The directive watches it to
   * keep `aria-invalid`, `aria-busy` and `aria-describedby` in lockstep
   * with the visible error state, even on an async tick with no parent
   * re-render. Optional; the directive skips aria wiring when absent.
   *
   * @internal
   */
  ariaDisplayState?: Readonly<Ref<DisplayState>>
}>

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
 * Delivered by the Vite / Nuxt plugin's compile-time binding, or by
 * `installVRegister(app)` from `attaform/directive` everywhere else.
 * Most consumers don't import the directive itself — it's exposed for
 * integrations that install directives manually.
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
 * A whole-form callback replaces the whole form. Any key the return
 * omits is refilled from the SCHEMA's declared defaults (the slim
 * value where none is declared), so an omitted key is not carried
 * over from the previous value or from `defaultValues` — spread
 * `prev` to keep the rest of the form.
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
  /**
   * Every `ValidationError` in this path's SUBTREE: the node's own
   * bucket plus every descendant's, sorted by schema-declaration order.
   * On a leaf (no descendants) this equals `ownErrors`. On a container
   * it rolls up the whole fieldset, so a parent's `errors` is non-empty
   * whenever any child is invalid.
   *
   * For the errors pinned at THIS path alone (a container's own
   * cross-field `.refine()`, or `setErrors` at this path), read
   * `ownErrors`.
   */
  readonly errors: readonly ValidationError[]
  /**
   * Every `ValidationError` at THIS exact path's own bucket, excluding
   * descendants: schema errors, blank-required errors, and `setErrors`
   * pinned here, in `schema`, `blank`, `user` order. The exact-path
   * counterpart to the subtree-scoped `errors`.
   *
   * On a leaf this is the same array as `errors` (a leaf has no
   * descendants). On a container it holds only the container's OWN
   * errors, a cross-field `.refine()` on the fieldset or a path-less
   * `setErrors` at this node, without dragging in any child error:
   *
   * ```vue
   * <p v-if="form.fields.address.firstOwnError">
   *   {{ form.fields.address.firstOwnError.message }}
   * </p>
   * ```
   *
   * On `form.meta` this is the root `[]` bucket: form-level errors from
   * a root `.refine()` or a path-less `setErrors`. `form.meta.ownErrors`
   * (with `firstOwnError`) is the banner accessor for those.
   */
  readonly ownErrors: readonly ValidationError[]
  /**
   * `true` while a per-field validation run is in flight at this path.
   * Reflects field-level debounced runs (`validate-on-change`) and
   * cross-field re-validations targeting this path. Whole-form
   * `validate()` / `parse()` calls drive `form.meta.validating`
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
   * Resolved by the display heuristic: gate closed → `'idle'`; a run
   * in flight → a delayed `'pending'`; an own-path error → `'error'`;
   * otherwise earned `valid` → `'success'`, else `'idle'`. The gate
   * opens after the first submit attempt OR once the field is edited
   * and left.
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
   * (descendants sorted by `pathOrdinal`). For the container's OWN
   * first error only, read `firstOwnError`.
   */
  readonly firstError: ValidationError | undefined
  /**
   * The first `ValidationError` in `ownErrors` (this exact path's own
   * bucket), or `undefined` when that bucket is empty. Equivalent to
   * `ownErrors[0]`, the exact-path counterpart to `firstError`.
   *
   * On a leaf this equals `firstError`. On a container it is the
   * container's own cross-field error (a fieldset `.refine()`), never a
   * child's. `form.meta.firstOwnError` is the form-level banner: the
   * first root `[]` error from a root `.refine()` or a path-less
   * `setErrors`:
   *
   * ```vue
   * <p v-if="form.meta.firstOwnError" role="alert">
   *   {{ form.meta.firstOwnError.message }}
   * </p>
   * ```
   */
  readonly firstOwnError: ValidationError | undefined
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
   * `true` when this field's form is frozen via `useForm({ disabled })`.
   * While disabled, value writes no-op and this field's `displayState`
   * is forced to `'idle'` so error, pending, and success signals stand
   * down. A form-level flag: every field of a disabled form reads
   * `true`, and the form root exposes it as `form.meta.disabled`. Bind
   * read-only or styling affordances off this.
   */
  readonly disabled: boolean
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

/** `true` only for bare `unknown`, the storage shape of a preprocess or
 *  coerce leaf. `any` is excluded, since it absorbs every test. */
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false

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
 * with a `''` slot. At a depth >= 1 container it's the container-self
 * sentinel — the home for cross-field refine errors and server-side
 * container marks; at root the `''` property addresses the literal
 * empty-key field. Gated on `Kind extends 'errors'` so `form.values`
 * and `form.fields` surfaces stay untouched. Carve-out for schemas that
 * legitimately declare a `''` field: the declared field type wins; at
 * runtime the two collide harmlessly (errors at the literal leaf and
 * any container-self errors share the slot via array concat).
 *
 * Global (root) errors are NOT this slot: they live at the root `[]`
 * and are read via the `errors([])` call-form, never `errors['']`.
 */
type ContainerSelfErrorsSlot<T, Kind> = Kind extends 'errors'
  ? '' extends keyof T
    ? unknown
    : { readonly ['']: readonly ValidationError[] }
  : unknown

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
   * Tuple-segment form. The segment-array spelling of the string
   * call-form above, for a path built from variables — the two resolve
   * to the same proxy, so `form.fields(['users', i, 'email'])` and
   * `form.fields(\`users.${i}.email\`)` are interchangeable.
   *
   * Resolves to that path's `FieldState`, which at a container is its
   * rolled-up aggregate (`displayState`, `valid`, `dirty`, ... all
   * exist regardless of the value type), exactly as the string form
   * does. Note this is the CALL form: it hands back the path's state,
   * not a drillable sub-proxy. To walk into a container's children use
   * dot/bracket access (`form.fields.users[i].email`), which is what
   * descends.
   */
  <const S extends ReadonlyArray<string | number>>(
    segments: S &
      ([JoinSegments<S>] extends [FlatPath<Form>] ? unknown : SegmentPathRejection<JoinSegments<S>>)
  ): FieldState<NestedType<Form, JoinSegments<S>>>
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
 * Single-bracket dotted access (`form.errors['user.profile.email']`) is
 * intentionally NOT supported: JS object semantics read the dotted string
 * as one key, which lands on a path that does not exist. Use chained
 * dot/bracket access, or the callable form.
 *
 * The underlying shape mirrors the schema. A statically-known primitive
 * leaf exposes `readonly ValidationError[]`, always an array and empty
 * when no errors land; a leaf whose value type itself includes `undefined`
 * (a DU variant-only field) keeps the `| undefined` branch. A container
 * exposes a sub-shape to keep drilling, and an array exposes
 * numeric-indexed sub-shapes where reading an index introduces
 * `| undefined` through noUncheckedIndexedAccess. The callable signatures
 * are intersected in, so dot access and a function call coexist on one
 * identifier.
 */
export type FormErrorsSurface<Form> = ErrorsProxyShape<Form> & {
  (path: string): readonly ValidationError[]
  /**
   * Tuple-segment form. Validated against `FlatPath<Form>` so literal
   * tuples that don't resolve to a known path fail at the call site.
   * Dynamic `Path`-typed inputs hit the untyped fallback overload below.
   */
  <const S extends ReadonlyArray<string | number>>(
    segments: S &
      ([JoinSegments<S>] extends [FlatPath<Form>] ? unknown : SegmentPathRejection<JoinSegments<S>>)
  ): readonly ValidationError[]
  (segments: ReadonlyArray<string | number>): readonly ValidationError[]
  /**
   * No-arg call returns the whole-form error aggregate, the same as
   * `form.meta.errors` and `form.errors([])`: every field error plus
   * the root bucket. `form.errors(path)` is uniform at every depth,
   * including `[]`, so the root is no exception. For the root bucket
   * alone (a root `.refine()`, a path-less `setErrors`), read
   * `form.meta.ownErrors`. Always a readonly array; empty when the form
   * has no errors.
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
 * Type of `form.values`: a drillable readonly callable proxy. Unlike
 * `form.errors` and `form.fields`, containers here are USEFUL
 * terminals, because every container in `values` carries real data
 * where in errors and fields it carries a derivation:
 * `form.values.address` returns the actual `{ city, ... }` subtree and
 * keeps drilling.
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
 * The two shapes answer different questions. Dot access is the
 * REACTIVE view: per-key tracking, no copying, always the live value.
 * The call form returns a SNAPSHOT: a detached plain object that keeps
 * what it held at capture time, so it is the shape to hand an async
 * call, a serialiser, or a diff.
 *
 * ```ts
 * const before = form.values()   // detached; survives later writes
 * await api.save(before)         // cannot mutate underneath the call
 * form.values.email              // reactive read; use this in computed
 * ```
 *
 * Prefer dot access inside a `computed`, `watchEffect`, or template:
 * it tracks the one key you read, where the call form depends on the
 * whole form and re-runs the consumer on any change.
 *
 * The copy is deep across plain objects and arrays. Non-plain
 * instances (Map, Set, File, Date) are shared by reference, matching
 * `JSON.stringify` behaviour; `structuredClone(form.values())` gives a
 * fully detached copy when one is needed.
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
 * Read-only at runtime — an assignment is refused with a dev-console
 * warning and never lands (Attaform does not throw from a read
 * surface). Destructuring snapshots
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
   * visited and left" UX (analytics, prior-step badges) but does NOT
   * drive the display heuristic. The reveal-on-submit story
   * runs entirely through `submissionAttempts`, which
   * `wizard.handleSubmit` bumps on every form (it always validates the
   * whole step list).
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
   * resolves, so binding it to `@submit` never manufactures a
   * `window` unhandledrejection. This is the channel for an UNEXPECTED
   * submit failure (a thrown exception or rejected promise), read the
   * same way in templates and after an imperative `await submit()`. An
   * EXPECTED rejection handled the documented way (`setErrors(...)` then
   * `return`, no throw) surfaces through the error store and `onError`
   * instead, leaving `submitError` `null`. Like `hydrateError`, it stays
   * distinct from the curated user-error store: render it where you
   * choose:
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
   * `true` once a `handleSubmit` callback has resolved without throwing
   * AND left no errors behind. Independent of `submissionAttempts` — a
   * failed submit (validation failure, callback rejection, or a callback
   * that calls `setErrors` and returns) increments attempts but leaves
   * `submitted` at `false`. Templates read it as "the form has been
   * submitted successfully at least once."
   *
   * The error check is scoped to the user-error layer (`setErrors` /
   * `clearErrors`): the documented server-rejection pattern
   * (`setErrors(response.errors); return`) is a failed submit, so it does
   * not flip `submitted`. A background async refinement that writes a
   * schema error mid-submit does not retroactively fail it.
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

/**
 * The no-arg `form.record()` call form, present only when the form root
 * is itself an open record (`z.record(K, V)`). `string extends keyof
 * Form` is the open-keyset probe: true for `Record<string, V>`, false
 * for a fixed `z.object` shape. On a fixed object this resolves to
 * `unknown`, which contributes nothing to the intersection in `record`
 * below, so the no-arg call form simply does not exist there (and
 * `form.record()` stays a compile error, as it should when the root has
 * a closed key set). On a record root it mirrors the path-addressed
 * `record(path)` overload: one `FieldState` per entry, keyed by the
 * record's own runtime keys.
 */
export type RootRecordView<Form> = string extends keyof Form
  ? Form extends Record<string, infer RootValue>
    ? () => Readonly<Record<string, FieldState<RootValue>>>
    : unknown
  : unknown

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
   * const onSubmit = form.handleSubmit(
   *   (data) => api.signup(data),
   *   (errors) => console.log(errors),
   * )
   * // Bind the returned handler: <form @submit="onSubmit">
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
      segments: S &
        ([JoinSegments<S>] extends [FlatPath<Form>]
          ? unknown
          : SegmentPathRejection<JoinSegments<S>>),
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
   * Imperative one-shot parse. Runs the full pipeline — refinements,
   * `.transform()`s, blank-required composition — against the current
   * form snapshot and RETAINS the parsed data.
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
   * By default the call is a PURE read: nothing is written to
   * `form.errors`, and in-flight per-field validation runs are left
   * alone. Pass `{ commit: true }` to make the run authoritative —
   * the verdict is committed to the error store at the parsed scope
   * and any in-flight per-field runs are cancelled first (mirroring
   * `handleSubmit`), so `await form.parse('email', { commit: true })`
   * lands a deterministic view of `form.errors.email`:
   *
   * ```ts
   * const result = await form.parse({ commit: true })
   * if (!result.success) showErrors(result.errors)
   * ```
   *
   * Always async, and there is no synchronous variant by design: a
   * schema can carry async refinements or transforms, so a sync parse
   * would silently miss them the moment one is added. One always-
   * awaited `parse` closes that category of bug entirely. The returned
   * promise never rejects (a thrown adapter lands as a `success: false`
   * response). Pass a path to parse a subtree only. `meta.validating`
   * flips `true` while the promise is in flight.
   */
  parse: {
    (path?: FlatPath<Form>, options?: ParseOptions): Promise<ValidationResponse<GetValueFormType>>
    (options: ParseOptions): Promise<ValidationResponse<GetValueFormType>>
  }
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
    <Path extends RegisterFlatPath<Form>>(
      path: Path,
      options?: RegisterOptions
    ): RegisterValue<NestedReadType<WriteShape<ReadForm>, Path>>
    <const S extends ReadonlyArray<string | number>>(
      segments: S &
        ([JoinSegments<S>] extends [RegisterFlatPath<Form>]
          ? unknown
          : SegmentRegisterRejection<JoinSegments<S>>),
      options?: RegisterOptions
    ): RegisterValue<NestedReadType<WriteShape<ReadForm>, JoinSegments<S>>>
  }
  /**
   * The form's identifier — either the explicit `key` passed to
   * `useForm` or an auto-generated unique id when `key` was omitted.
   * Every `ValidationError` this form produces carries it as `formKey`,
   * so a shared error list can be routed back to the right form.
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
   * `defaultValues` (nothing to re-fire).
   *
   * The payload becomes the form's defaults, the same way a
   * `reset(next)` argument does, so `form.reset()` afterwards lands on
   * the values just fetched. Does NOT clear touched / submit state;
   * chain `form.reset()` for that.
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
   * Read-only — populate via `setErrors` / `clearErrors`. A server
   * response that already emits `ValidationError[]` pipes straight into
   * `setErrors` with no adapter.
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
      segments: S &
        ([JoinSegments<S>] extends [FlatPath<Form>]
          ? unknown
          : SegmentPathRejection<JoinSegments<S>>)
    ): Readonly<Ref<NestedReadType<WriteShape<ReadForm>, JoinSegments<S>>>>
  }

  /**
   * Set the form's manual error layer. One surface for server-side
   * errors, optimistic-UI errors, and form-level banners: a field error
   * and a global (form-level) error are the same thing at different
   * paths, so there is no separate field/form split.
   *
   * Input is lenient ({@link ErrorInput}): a real `Error`, a partial
   * `{ message?, path?, code?, data? }`, or an array of either. The form
   * stamps its own `formKey`, defaults a missing `code` to
   * `atta:user-error`, and coerces a missing or empty `message` to
   * `"Unknown error"` instead of throwing. A server that already emits
   * `ValidationError[]` satisfies the input shape directly, so
   * `form.setErrors(response.errors)` needs no adapter.
   *
   * Three call forms, mirroring `setValue`:
   *
   * ```ts
   * // Whole-layer replace. An entry with no `path` is a global,
   * // form-level error (path `[]`); add a `path` to target a field.
   * form.setErrors([{ path: ['email'], message: 'Already taken' }])
   * form.setErrors({ message: 'Capacity exceeded' })   // global banner
   * form.setErrors(new Error('Network unreachable'))   // message coerced
   *
   * // Functional update. `prev` is the current manual layer, flat.
   * form.setErrors((prev) => [...prev, { message: 'And one more' }])
   *
   * // Path-scoped. The path is stamped onto every entry, and only that
   * // path's bucket is replaced. `prev` is that path's manual errors.
   * form.setErrors('email', [{ message: 'Already taken' }])
   * form.setErrors(['profile', 'handle'], { message: 'Reserved' })
   * form.setErrors('email', (prev) => prev.slice(0, 1))
   * ```
   *
   * Replaces only the manual layer; schema/validation errors live in a
   * separate store and merge on read. Pass `[]` to clear the manual
   * layer (or use `clearErrors`, which also clears the schema layer).
   */
  setErrors: {
    (update: (prev: ValidationError[]) => ErrorInput | ErrorInput[]): void
    (errors: ErrorInput | ErrorInput[]): void
    (
      path: string | (string | number)[],
      errors: ErrorInput | ErrorInput[] | ((prev: ValidationError[]) => ErrorInput | ErrorInput[])
    ): void
  }

  /**
   * Clear errors at one path, or everywhere. Clears BOTH the manual
   * layer (set through `setErrors`) and the schema/validation layer at
   * the target. With always-on validation the schema half re-populates
   * on the next mutation if the value is still invalid, so the cleared
   * state is short-lived for a field that is still wrong.
   *
   * ```ts
   * form.clearErrors('email')   // one field
   * form.clearErrors([])        // the global, form-level bucket
   * form.clearErrors()          // every error on the form
   * ```
   */
  clearErrors: (path?: string | (string | number)[]) => void

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
   * Restore the form to its defaults. Without arguments, re-applies
   * whatever the defaults currently are: `useForm({ defaultValues })`
   * on a fresh form, or the last values a `reset(next)` or an async
   * `defaultValues` factory settled on.
   *
   * Resets:
   *   - the form value back to defaults;
   *   - the dirty baseline (so the next edit flips `dirty` correctly);
   *   - field errors;
   *   - touched / focused / blurred per-field flags;
   *   - submission state (`submitting` / `submissionAttempts` /
   *     `submitted` / `submitError`).
   *
   * `nextDefaultValues` RE-SEATS the defaults rather than applying for
   * one call, so the form has a single set of defaults that `reset()`,
   * `resetField(path)`, and `dirty` all read. That is what makes the
   * save-then-discard shape work: reset from the resource the server
   * returned, and a later Discard returns to the save instead of
   * rolling back across it.
   *
   * ```ts
   * const saved = await api.save(form.values())
   * form.reset(toValues(saved))   // the saved resource is now the baseline
   * // …later…
   * form.reset()                  // back to the saved resource
   * ```
   *
   * The argument is sparse: it folds over the defaults already in
   * force, so paths it does not name keep the value they had, and
   * `reset({})` changes nothing. Arrays are replaced wholesale rather
   * than merged element-wise. Pass `unset` at a path to withdraw its
   * value and mark it blank.
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
      segments: S &
        ([JoinSegments<S>] extends [FlatPath<Form> | '']
          ? unknown
          : SegmentPathRejection<JoinSegments<S>>)
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
   *
   * Requests `focusVisible: true` so the UA paints a focus ring even
   * though the move is programmatic. Honored where supported; on
   * browsers without it, non-text controls focused after a pointer
   * submit may show no ring, so you may still want an app-side
   * indicator.
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
   * Run the form's own invalid-submit nudge imperatively: exactly what
   * `handleSubmit` does after a failed submit, but available standalone
   * and honoring this form's `useForm({ focusOnInvalidSubmit })` choice.
   *
   * Used by `useWizard` after navigating to the first failing form
   * during `wizard.handleSubmit`, so the failing form's own configured
   * behavior fires once its DOM is in view.
   *
   * No-op when this form opted out, or when no errored field is
   * currently registered. Use `focusFirstError()` to focus regardless
   * of the configured choice.
   */
  applyInvalidSubmitPolicy: () => void

  /**
   * Programmatically mark fields as `touched` — the descriptive
   * "this field was visited" flag.
   *
   * ```ts
   * form.touch('email')                 // one leaf
   * form.touch('profile')               // every leaf under profile
   * form.touch(['profile', 'name'])     // segment-array form
   * form.touch()                        // every leaf in the form
   * ```
   *
   * **This does not reveal errors under the default display
   * heuristic.** `touched` also flips on a bare focus → blur with no
   * edit, so the library-default gate deliberately ignores it and
   * reads `blurredAfterInteraction` instead — the stricter bit that
   * only a blur *following* an edit sets. Reach for `touch()` when
   * your own analytics reads `touched`; reach for
   * {@link UseFormReturnType.interact} to make
   * seeded or imported values surface their errors.
   *
   * Pure flag write — does not mutate value, focused, blurred, or
   * trigger validation. Idempotent: re-calling on an already-touched
   * field is a no-op. Touched is sticky-true; pair with
   * `form.reset()` / `form.resetField()` to clear.
   */
  touch: (path?: FlatPath<Form> | (string | number)[]) => void

  /**
   * Simulate a complete focus → edit → blur over every leaf under
   * `path` (the whole form when omitted), so values that arrived
   * without a DOM gesture reveal their errors under the default
   * display heuristic.
   *
   * ```ts
   * form.interact('profile')            // arm one subtree
   * await form.interact(['members', 2]) // errors committed on resolve
   * form.interact()                     // every leaf in the form
   * ```
   *
   * Flips the full interaction ladder (`touched`, `interacted`, and
   * `blurredAfterInteraction`) and runs the subtree's validation, so
   * the default gate — `submissionAttempts > 0 ||
   * blurredAfterInteraction` — opens through its front door. Use it
   * to arm one region's errors without a form-wide submit, which
   * would light up every other field on the page: a field-array row
   * edited in a modal, a server-seeded section, a pasted import.
   *
   * Walks schema leaves, so it reaches fields that are currently
   * `v-if`'d away or were never mounted; the flags are sticky, so
   * such a subtree stays revealed when it remounts.
   *
   * Flags land synchronously — the returned promise resolves once the
   * subtree's validation has committed, so an awaiting caller can read
   * `showErrors` / `errors` immediately after. It never rejects, and
   * ignoring it is fine.
   *
   * No-op on a disabled form, matching every other interaction-
   * lifecycle write. Does not mutate value, `focused`, or `blurred`:
   * those are DOM-owned, and the display gate reads none of them.
   * Sticky like `touched`; pair with `form.reset()` /
   * `form.resetField()` to clear.
   */
  interact: (path?: FlatPath<Form> | (string | number)[]) => Promise<void>

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
   *
   * When the form root is itself a record (`useForm({ schema:
   * z.record(K, V) })` — a dictionary form), call `form.record()` with
   * no argument for the root entry view:
   *
   * ```vue
   * <div v-for="(member, id) in form.record()" :key="id">
   *   <input v-register="form.register(id)" />
   *   <p v-if="member.showErrors">{{ member.firstError?.message }}</p>
   * </div>
   * ```
   */
  record: RootRecordView<Form> &
    (<Path extends RecordPath<Form>>(
      path: Path
    ) => Readonly<Record<string, FieldState<RecordValue<Form, Path>>>>)
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
