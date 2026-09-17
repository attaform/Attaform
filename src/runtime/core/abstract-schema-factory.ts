/**
 * `createAbstractSchema`, the schema-agnostic factory hosting every
 * `AbstractSchema` method whose implementation is the same in the v3 and v4
 * adapters once the introspector is swapped.
 *
 * Each adapter wires through two contracts.
 *
 *   - `SchemaIntrospector<Schema>`: pure, side-effect-free accessors over
 *     schema shape. The factory branches on `kindOf`, walks
 *     discriminated-union literals through `getLiteralValues` and
 *     `getDiscriminatedOptions`, detects coerce and preprocess nodes, and
 *     consults the async and container-refine flags.
 *   - `AbstractSchemaServices<Schema, Form, GetValueFormType>`: the delegates
 *     for everything that genuinely diverges per Zod version, namely path
 *     walking, default-value derivation, the `getDefaultValues` flow, the
 *     wrapper peeling tied to each version's wrapper set, field-meta
 *     resolution and the `safeParse` boundary.
 *
 * The split is what keeps the introspector reusable by any other walker,
 * slim-primitives and default-values among them, without dragging the
 * side-effectful services along. Services consume the introspector as they
 * wish; the factory consumes both.
 *
 * Per-adapter caches live one per `useForm()` call, and `getSchemasAtPath`
 * hands sub-schema construction to the `makeSubSchema` service rather than
 * picking one strategy: v3 recurses through the full factory, v4 builds a
 * four-method stub.
 */
import type {
  AbstractSchema,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
  SlimPrimitiveKind,
  UnionDiscriminatorContext,
  ValidationError,
  ValidateOptions,
  SchemaDefaultsResult,
  SchemaParseResult,
  SchemaFactoryOptions,
} from '../types/types-api'
import { AttaformErrorCode } from './error-codes'
import { canonicalizePath, type Path, type PathKey } from './paths'

const PATH_SEPARATOR = '.'

/**
 * Stable shape-discriminant the factory branches on. Adapters return the union
 * of v3 and v4 kinds plus `'unknown'` for anything unrecognised. The factory
 * inspects only a small subset, `'tuple'` and `'array'` for
 * `arrayShapeAtPath` and `'literal'` for the discriminated-union walk, so an
 * adapter can return extra version-specific kinds (`'effects'`, `'pipeline'`,
 * `'branded'`, `'native-enum'` on v3) without confusing it.
 */
export type SharedZodKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'date'
  | 'null'
  | 'undefined'
  | 'literal'
  | 'enum'
  | 'native-enum'
  | 'object'
  | 'array'
  | 'tuple'
  | 'set'
  | 'record'
  | 'map'
  | 'union'
  | 'discriminated-union'
  | 'intersection'
  | 'optional'
  | 'nullable'
  | 'default'
  | 'catch'
  | 'readonly'
  | 'branded'
  | 'effects'
  | 'pipeline'
  | 'lazy'
  | 'pipe'
  | 'transform'
  | 'preprocess'
  | 'any'
  | 'unknown'
  | 'never'
  | 'nan'
  | 'void'
  | 'file'
  | 'function'
  | 'symbol'
  | 'promise'
  | 'custom'
  | 'template-literal'
  // v4-only. Both wrap an inner schema on `def.innerType`.
  | 'nonoptional'
  | 'success'

/**
 * A kind that declares a value without describing its shape.
 *
 * Nothing descends into an opaque leaf, and nothing can be inferred about what
 * a valid value looks like: the schema's own predicate is the only authority,
 * and it runs at parse time. `custom` is what `z.instanceof(X)` and
 * `z.custom<T>()` compile to on v4; on v3 those spellings peel through
 * `ZodEffects` to `any` (#542).
 *
 * Three comparisons rather than a module-level `Set`: the membership test is
 * the whole predicate, and the eager bundle is measured in bytes.
 */
function isOpaqueKind(kind: SharedZodKind | string): boolean {
  return kind === 'any' || kind === 'unknown' || kind === 'custom'
}

/**
 * Pure schema-shape accessors, consulted to branch on structural facts about a
 * node. Every member is side-effect-free and idempotent.
 *
 * `kindOf` returns the discriminant, and the structural accessors each read a
 * single field of the node's def shape. The boolean predicates summarise
 * tree-walking detections the adapters already expose and memoise at the
 * AbstractSchema level, so calling one per construction is cheap.
 */
export interface SchemaIntrospector<Schema> {
  /** Discriminant on schema shape. Adapters may return extra kinds. */
  kindOf(schema: Schema): SharedZodKind | string
  /**
   * Returns the property-to-sub-schema map of a `ZodObject`. Empty
   * record for non-objects.
   */
  getObjectShape(schema: Schema): Record<string, Schema>
  /** Returns the position-typed items of a `ZodTuple`. Empty for non-tuples. */
  getTupleItems(schema: Schema): readonly Schema[]
  /**
   * The option objects of a `ZodDiscriminatedUnion`. Each is a `ZodObject`
   * whose `getObjectShape` carries the discriminator key as a `ZodLiteral`.
   */
  getDiscriminatedOptions(schema: Schema): readonly Schema[]
  /** Returns the discriminator key of a `ZodDiscriminatedUnion`. */
  getDiscriminator(schema: Schema): string | undefined
  /**
   * The literal values a `ZodLiteral` admits: both for
   * `z.literal(['a', 'b'])`, the one for a single-value literal, and empty for
   * a non-literal.
   */
  getLiteralValues(schema: Schema): readonly unknown[]
  /**
   * True iff the node is a preprocess-style schema-side normalizer,
   * `z.preprocess(fn, inner)` in either version: v3's `ZodEffects` with
   * `effect.type === 'preprocess'` and v4's `ZodPipe<ZodTransform, inner>`
   * both collapse here. A coerce primitive goes through `isCoercePrimitive`
   * instead, being neither a pipe on v4 nor an effect on v3, though both
   * adapters detect it off the same flag.
   */
  isPreprocessNode(schema: Schema): boolean
  /**
   * True iff the schema is a `z.coerce.X()` primitive. Both adapter
   * versions store the coerce intent as a flag on the wrapped
   * primitive's def (not as a wrapper), so detection is uniform.
   */
  isCoercePrimitive(schema: Schema): boolean
  /**
   * True iff the schema tree contains a refine whose predicate can run
   * asynchronously. v3 is conservative and flags every `.refine`, its inner
   * sync wrapper hiding the user function; v4 is exact, inspecting
   * `def.checks[].def.fn.constructor.name`. Either way the runtime reads it to
   * decide whether a construction-time async pass is needed.
   */
  containsAsyncRefine(schema: Schema): boolean
  /**
   * True iff the schema tree contains a `.transform(asyncFn)` or
   * `z.preprocess(asyncFn, …)`, detectable statically in both adapters through
   * the user function's `constructor.name`. Disjoint from
   * `containsAsyncRefine`: refines and transforms live in different slots.
   */
  containsAsyncTransform(schema: Schema): boolean
  /**
   * True iff any refine fires at a container node (object, array, tuple, union,
   * discriminated union, intersection, record, set) or at the root. False means
   * every refine is leaf-local, so per-keystroke subtree validation catches the
   * same verdicts a whole-form pass would.
   */
  hasContainerOrRootRefine(schema: Schema): boolean
  /**
   * True iff the schema tree holds at least one discriminated union at
   * any depth. Drives the store's per-form DU capability flag; queried
   * once at construction.
   */
  containsDiscriminatedUnion(schema: Schema): boolean

  // --- Walker accessors ---
  // Consumed by the shared `core/walk-*` walkers, so the path-walking,
  // slim-primitive and default-derivation shapes do not fork per adapter. Both
  // adapters expose the full surface, and a member that does not apply to one
  // returns `undefined` rather than being absent, so the walkers never branch
  // on adapter identity.

  /** Element schema of a `z.array(...)`. Undefined for non-arrays / malformed defs. */
  getArrayElement(schema: Schema): Schema | undefined
  /** Element schema of a `z.set(...)`. Undefined for non-sets / malformed defs. */
  getSetValueType(schema: Schema): Schema | undefined
  /** Value schema of a `z.record(...)`. Undefined for non-records / malformed defs. */
  getRecordValueType(schema: Schema): Schema | undefined
  /**
   * Key schema of a `z.map(K, V)`, undefined for a non-map. The walker consults
   * it to decide whether a map's entries are addressable at all: a key no path
   * segment can spell, an object or a symbol, has no path, so the map stays a
   * whole value.
   */
  getMapKeyType(schema: Schema): Schema | undefined
  /** Value schema of a `z.map(...)`. Undefined for non-maps. */
  getMapValueType(schema: Schema): Schema | undefined
  /** Option array of a `z.union(...)`. Empty for non-unions. */
  getUnionOptions(schema: Schema): readonly Schema[]
  /** Left side of a `z.intersection(L, R)`. Undefined for non-intersections. */
  getIntersectionLeft(schema: Schema): Schema | undefined
  /** Right side of a `z.intersection(L, R)`. Undefined for non-intersections. */
  getIntersectionRight(schema: Schema): Schema | undefined
  /** Values of a `z.enum(...)`. Empty for non-enums. */
  getEnumValues(schema: Schema): readonly (string | number)[]
  /**
   * Raw reverse-mapped values object of a `z.nativeEnum(E)`. v3 returns the TS
   * enum object directly; v4 always returns `undefined`, folding nativeEnum
   * into the regular `enum` kind.
   */
  getNativeEnumValues(schema: Schema): Record<string, unknown> | undefined

  /**
   * Inner schema of any wrapper exposing `def.innerType`: Optional, Nullable,
   * Default, Readonly and Catch in both versions. Branded, v3-only, uses
   * `def.type` instead; see `unwrapBranded`. `undefined` when no inner is
   * available.
   */
  unwrapInner(schema: Schema): Schema | undefined
  /**
   * v3-only: `ZodBranded`'s inner schema (`_def.type`). Returns
   * `undefined` on v4 (no branded wrapper) and on non-branded schemas.
   */
  unwrapBranded(schema: Schema): Schema | undefined
  /**
   * v3-only: the structural source of a `ZodEffects` (refine, transform,
   * preprocess), `_def.schema`. `undefined` on v4, which has no ZodEffects
   * wrapper and keeps effects as pipe sides or leaf checks.
   */
  unwrapEffectsSource(schema: Schema): Schema | undefined
  /** Input side of v4's `z.pipe(IN, OUT)` (also v3's `z.pipeline(...)`). */
  unwrapPipeIn(schema: Schema): Schema | undefined
  /** Output side of a pipe; undefined on v3's `ZodEffects`. */
  unwrapPipeOut(schema: Schema): Schema | undefined
  /**
   * Inner schema of a `z.lazy(() => inner)`. Each call invokes the getter
   * fresh, and a getter that throws, a recursive cycle resolved before its
   * target is constructed, yields `undefined`.
   */
  unwrapLazy(schema: Schema): Schema | undefined

  /**
   * Resolve a `z.default(...)` wrapper to its declared default value. v3 stores
   * it as a thunk and v4 as a getter; both adapters return the resolved value.
   */
  getDefaultValue(schema: Schema): unknown
  /**
   * Resolve a `z.catch(inner, val)` wrapper to its fallback value. The catch
   * slot holds a `(ctx) => value`, which both adapters invoke with a
   * placeholder context, surfacing `undefined` when it throws.
   */
  getCatchDefault(schema: Schema): unknown
  /**
   * True iff the schema carries a callable `z.catch(...)` fallback, which
   * separates "no catch wrapper" from "catch wrapper resolving to `undefined`".
   */
  hasCatchValue(schema: Schema): boolean
}

/**
 * The delegates for operations that genuinely differ per Zod version: path
 * walking, default-value derivation, wrapper peeling, error normalization and
 * sub-schema construction. Each is a thin wrapper around per-adapter helpers,
 * and the factory composes them.
 *
 * `safeParseSync` / `safeParseAsync` abstract the per-version parse calls so
 * the factory stays version-agnostic. Both return a uniform
 * success-discriminant shape, and `safeParseSync` may throw on an async-only
 * schema, which the factory catches before falling back to the async path.
 *
 * `makeSubSchema` builds `getSchemasAtPath`'s sub-schemas. v3 recurses through
 * the full factory, so its sub-schemas expose the entire `AbstractSchema`
 * surface; v4 builds a four-method stub (`needsAsyncValidation`,
 * `getDefaultValues`, `getSchemasAtPath`, `validateAtPath`), which is all its
 * consumers reach for and keeps sub-walker allocation cheap.
 */
export interface AbstractSchemaServices<Schema, Form, GetValueFormType> {
  /**
   * Every sub-schema reachable at the given path. Several results mean a union
   * or discriminated-union split, and none means the path does not resolve.
   * Adapters cap descent through `z.lazy(...)` with `maxRecursionDepth`.
   */
  getNestedSchemasAtPath(schema: Schema, path: Path, maxRecursionDepth: number): Schema[]
  /**
   * The slim-mode path walk `getSlimPrimitiveTypesAtPath` and
   * `getSchemasAtPath` consume. v3 strips refinements, defaults, optional,
   * nullable and effects off the root before walking, so the candidates reflect
   * the slim shape the gate sees and consumers expect. v4 aliases this to
   * `getNestedSchemasAtPath`, its path walker already inlining the peeling.
   */
  getNestedSchemasInSlimMode(schema: Schema, path: Path, maxRecursionDepth: number): Schema[]
  /** Returns the slim-primitive accept-set of a single sub-schema. */
  slimPrimitivesOf(schema: Schema, maxRecursionDepth: number): Set<SlimPrimitiveKind>
  /**
   * The schema's prescribed default at the given root. `getDefaultAtPath` calls
   * it with `useDefault=true` to honour `.default(x)`, and
   * `getEmptyValueAtPath` with `false` to yield the inner schema's falsy
   * concrete. Each adapter implements its own walker.
   */
  deriveDefault(schema: Schema, useDefault: boolean, maxRecursionDepth: number): unknown
  /**
   * The construction-time default-values flow. v3 runs a validate-then-fix loop
   * against a slim schema and then parses the real one; v4 parses the real
   * schema against the derived data. Both honour `config.constraints`.
   */
  runGetDefaults(
    schema: Schema,
    config: GetDefaultValuesConfig<Form>,
    maxRecursionDepth: number
  ): SchemaDefaultsResult<Form>
  /**
   * Peels `.optional()` and `.nullable()` only when the inner is structurally
   * fillable: an object, array, tuple, record, union or intersection, or a
   * chain of peelable wrappers resolving to one. `getDefaultAtPath` uses it so
   * a partial write through an optional sub-schema fills from the inner
   * shape's defaults. `.default(x)` is preserved at every layer.
   */
  unwrapStructuralWrappers(schema: Schema): Schema
  /**
   * Peels every transparent wrapper (optional, nullable, default, readonly,
   * catch, pipe, lazy, branded, effects) and descends intersection sides
   * looking for a single discriminated union. Returns the match, or `undefined`
   * when none is found or two different DUs are both reachable.
   */
  unwrapToDiscriminatedUnion(schema: Schema): Schema | undefined
  /**
   * Peels every transparent wrapper off a schema. `arrayShapeAtPath` wants the
   * structural kind regardless of default-value semantics, so `.default(x)`
   * and `.catch(x)` are peeled here where `unwrapStructuralWrappers` keeps
   * them.
   */
  peelAllWrappers(schema: Schema): Schema
  /**
   * True iff the leaf schema is required in the union-aware sense
   * `AbstractSchema.isRequiredAtPath` documents: `.optional()`, `.nullable()`,
   * `.default()` or `.catch()` at any wrapper layer makes the leaf permissive,
   * a union requires every branch, and an intersection requires either side.
   */
  isLeafRequired(schema: Schema): boolean
  /** Returns the resolved field-meta payload for the schema at `path`. */
  resolveFieldMetaAtPath(schema: Schema, path: Path, maxRecursionDepth: number): ResolvedFieldMeta
  /**
   * Normalise schema-library issues into `ValidationError[]`. The `ZodIssue`
   * payload differs between versions, and each adapter maps its own.
   */
  issuesToValidationErrors(issues: readonly unknown[]): ValidationError[]
  /**
   * Run a sync `safeParse`, returning a tagged result the factory aggregates
   * into a `SchemaParseResult`. MAY throw on a schema holding async-only
   * refines or transforms, which the factory catches before falling back to
   * the async path.
   */
  safeParseSync(
    schema: Schema,
    data: unknown
  ): { success: true; data: unknown } | { success: false; issues: readonly unknown[] }
  /** Async sister of `safeParseSync`. MUST NOT throw (catch user-fn rejections). */
  safeParseAsync(
    schema: Schema,
    data: unknown
  ): Promise<{ success: true; data: unknown } | { success: false; issues: readonly unknown[] }>
  /**
   * Per-adapter sub-schema constructor for `getSchemasAtPath`. v3 recurses
   * through the full factory, so its sub-schemas carry the entire
   * `AbstractSchema` surface; v4 returns a four-method stub. Runtime consumers
   * only reach for `needsAsyncValidation()` on a sub-schema, so the two shapes
   * are observationally interchangeable.
   */
  makeSubSchema(
    schema: Schema,
    maxRecursionDepth: number
  ): AbstractSchema<unknown, GetValueFormType>
}

/**
 * Ceiling on any one per-path memo inside an `AbstractSchema`. It sits far
 * above a real form's working set, the widest bench form being 500 leaves, and
 * far below anything worth holding, so reaching it means a churn of invented
 * keys rather than a working set.
 */
export const MEMO_CAP = 4096

/** The root is always an object, and nothing else ever asks. */
const ROOT_KINDS: ReadonlySet<SlimPrimitiveKind> = new Set<SlimPrimitiveKind>(['object'])
/** A path the schema does not declare accepts nothing. */
const NO_KINDS: ReadonlySet<SlimPrimitiveKind> = new Set<SlimPrimitiveKind>()

/**
 * Record a memoised answer, dropping the whole memo once it outgrows the cap.
 *
 * Clearing rather than evicting one entry is deliberate: every value here is a
 * pure function of the schema and the path, so all are free to recompute, and
 * a size check plus an occasional clear is the cheapest bound available. An
 * LRU would cost a second structure per cache per schema to protect answers
 * that are not expensive.
 */
export function memoPut<V>(memo: Map<PathKey, V>, key: PathKey, value: V): V {
  if (memo.size >= MEMO_CAP) memo.clear()
  memo.set(key, value)
  return value
}

/**
 * Per-adapter store of shared `AbstractSchema` instances.
 *
 * An `AbstractSchema` is a pure function of `(rootSchema,
 * maxRecursionDepth)`: it answers questions about the SCHEMA and holds no form
 * state, so nothing in it can differ between two forms declaring the same
 * schema. One per `useForm()` callsite mints 19 methods, 18 service closures,
 * 5 memos and 3 flags per form, 3,457 B, to hold the answers the form next
 * door already has.
 *
 * The map is weak on the schema, so a runtime-built schema still releases with
 * the last form that referenced it. Sharing also raises the hit rate on the
 * memos, so a second form on a known schema starts warm.
 *
 * Each adapter calls this once at module scope for its own store, so two
 * majors can never answer for each other's schema objects.
 */
export function createSharedSchemaStore(): <Built>(
  rootSchema: object,
  maxRecursionDepth: number,
  build: () => Built
) => Built {
  const bySchema = new WeakMap<object, Map<number, unknown>>()
  return <Built>(rootSchema: object, maxRecursionDepth: number, build: () => Built): Built => {
    let byDepth = bySchema.get(rootSchema)
    if (byDepth === undefined) {
      byDepth = new Map<number, unknown>()
      bySchema.set(rootSchema, byDepth)
    }
    const hit = byDepth.get(maxRecursionDepth)
    // The one unchecked step, sound by construction: a caller's `Built`
    // derives from the schema it passes, v4's `Form` being
    // `z.input<FormSchema>`, so one key cannot produce two built types.
    // Nothing weaker than a dependent type expresses that, and a `WeakMap` has
    // none.
    if (hit !== undefined) return hit as Built
    const built = build()
    byDepth.set(maxRecursionDepth, built)
    return built
  }
}

/**
 * Build a runtime `AbstractSchema` for `rootSchema`, composing the shared
 * uniform-method implementations with the per-adapter introspector and
 * services. The returned object, its three caches and its two memoised lazy
 * flags live as long as the schema does; see `sharedAbstractSchema`.
 */
export function createAbstractSchema<Schema, Form, GetValueFormType>(
  rootSchema: Schema,
  intro: SchemaIntrospector<Schema>,
  services: AbstractSchemaServices<Schema, Form, GetValueFormType>,
  options: SchemaFactoryOptions
): AbstractSchema<Form, GetValueFormType> {
  const maxRecursionDepth = options.maxRecursionDepth

  // Per-schema caches over the walks the proxy traps and reactive computeds
  // hit on every read, so the schema is not re-walked per keystroke or per
  // field-state get.
  //
  // Their lifetime is the SCHEMA's, not a form's, since `sharedAbstractSchema`
  // hands one instance to every form on that schema. That makes bounding them
  // load-bearing rather than tidy: a path can carry a record key or an array
  // index the consumer invents at runtime, so the key domain is unbounded even
  // though the schema is finite, and growth here is released never rather than
  // on unmount. See `memoPut`.
  const leafCache = new Map<PathKey, boolean>()
  const preprocessOrCoerceCache = new Map<PathKey, boolean>()
  const opaqueLeafCache = new Map<PathKey, boolean>()
  const discriminatorCache = new Map<PathKey, UnionDiscriminatorContext | undefined>()
  const entryKeyKindCache = new Map<PathKey, 'string' | 'number' | undefined>()
  // The accept-set at a path is a pure function of the schema and is asked for
  // on the hot path: once per write by the slim-primitive gate, again per
  // segment by the schema-filling writer, two or three more times by coercion.
  // Computing it fresh re-walks from the root and allocates a Set each time.
  // Memoising is what makes the set shared rather than copied, which is why
  // the contract returns a `ReadonlySet`: the answer belongs to the schema,
  // not to the caller.
  const slimKindsCache = new Map<PathKey, ReadonlySet<SlimPrimitiveKind>>()
  // Memoised one-shot tree walks. The store queries `needsAsyncValidation` at
  // construction, driving the async seed, and `hasContainerOrRootRefine` per
  // keystroke, driving the subtree-against-whole-form scope cut.
  let asyncValidationFlag: boolean | null = null
  let containerRefineFlag: boolean | null = null
  let discriminatedUnionFlag: boolean | null = null

  /**
   * The segment kind that can spell a key of the map `schema`, or
   * `undefined` when no segment kind can.
   *
   * A path segment is a string or a non-negative integer, so only a
   * map whose declared key type accepts one of those has addressable
   * entries. The slim primitive set is the authority rather than the
   * key schema's kind: it already collapses every wrapper, enum,
   * literal and union spelling of "this key is a string" down to the
   * kinds a key value can actually take, so the test stays closed over
   * key types nobody here enumerated.
   *
   * A key type admitting BOTH, `z.union([z.string(), z.number()])`, has no
   * single spelling, and a segment reaching it could mean either entry, so it
   * is not addressable either.
   */
  function mapKeySegmentKind(schema: Schema): 'string' | 'number' | undefined {
    const keyType = intro.getMapKeyType(schema)
    if (keyType === undefined) return undefined
    const kinds = services.slimPrimitivesOf(keyType, maxRecursionDepth)
    const string = kinds.has('string')
    const number = kinds.has('number')
    if (string === number) return undefined
    return string ? 'string' : 'number'
  }

  function computeDiscriminator(path: Path): UnionDiscriminatorContext | undefined {
    const candidates =
      path.length === 0
        ? [rootSchema]
        : services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
    // `unwrapToDiscriminatedUnion` peels every transparent wrapper and
    // descends intersection sides looking for a single discriminated union.
    // Two distinct DUs reachable across candidates is ambiguous and bails, and
    // the runtime falls back to a plain write.
    let matchedUnion: Schema | undefined
    for (const candidate of candidates) {
      const du = services.unwrapToDiscriminatedUnion(candidate)
      if (du === undefined) continue
      if (matchedUnion !== undefined && matchedUnion !== du) return undefined
      matchedUnion = du
    }
    if (matchedUnion === undefined) return undefined
    const discKey = intro.getDiscriminator(matchedUnion)
    if (discKey === undefined) return undefined
    const unionOptions = intro.getDiscriminatedOptions(matchedUnion)
    const literalSet = new Set<unknown>()
    for (const opt of unionOptions) {
      const shape = intro.getObjectShape(opt)
      const litSchema = shape[discKey]
      if (litSchema === undefined) continue
      if (intro.kindOf(litSchema) !== 'literal') continue
      // Multi-value literals (`z.literal(['a','b'])`) register every
      // member as a selectable variant.
      for (const v of intro.getLiteralValues(litSchema)) literalSet.add(v)
    }
    return {
      discriminatorKey: discKey,
      getVariantDefault(value: unknown): unknown {
        for (const opt of unionOptions) {
          const shape = intro.getObjectShape(opt)
          const litSchema = shape[discKey]
          if (litSchema === undefined) continue
          if (intro.kindOf(litSchema) !== 'literal') continue
          const literalValues = intro.getLiteralValues(litSchema)
          if (literalValues.includes(value)) {
            return services.deriveDefault(opt, true, maxRecursionDepth)
          }
        }
        return undefined
      },
      isVariantSelected(value: unknown): boolean {
        return literalSet.has(value)
      },
    }
  }

  const abstractSchema: AbstractSchema<Form, GetValueFormType> = {
    needsAsyncValidation(): boolean {
      asyncValidationFlag ??=
        intro.containsAsyncRefine(rootSchema) || intro.containsAsyncTransform(rootSchema)
      return asyncValidationFlag
    },

    hasContainerOrRootRefine(): boolean {
      containerRefineFlag ??= intro.hasContainerOrRootRefine(rootSchema)
      return containerRefineFlag
    },

    hasDiscriminatedUnions(): boolean {
      discriminatedUnionFlag ??= intro.containsDiscriminatedUnion(rootSchema)
      return discriminatedUnionFlag
    },

    getDefaultValues(config: GetDefaultValuesConfig<Form>): SchemaDefaultsResult<Form> {
      return services.runGetDefaults(rootSchema, config, maxRecursionDepth)
    },

    getDefaultAtPath(path) {
      // Empty path → root default. Reuses the same generator used at
      // form construction so refines / wrappers behave consistently.
      if (path.length === 0) {
        return services.deriveDefault(rootSchema, true, maxRecursionDepth)
      }
      const [first] = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (first === undefined) return undefined
      // STRUCTURAL default: peel `.optional()` and `.nullable()`, so a partial
      // object write through an optional sub-schema fills from the inner
      // shape's defaults. `.default(x)` is preserved, so `deriveDefault`
      // returns the explicit default. Taking the first candidate matches
      // `validateAtPath`'s first-success semantic.
      const peeled = services.unwrapStructuralWrappers(first)
      return services.deriveDefault(peeled, true, maxRecursionDepth)
    },

    getEmptyValueAtPath(path) {
      // `clear`'s underlying value lookup. The same path resolution as
      // `getDefaultAtPath` with `useDefault=false`, so `.default(x)` and
      // `.catch(x)` are skipped and the walker yields the inner schema's empty
      // concrete. Structural wrappers are NOT peeled: clearing an
      // `.optional()` slot is legitimately `undefined` and a `.nullable()` one
      // is `null`.
      if (path.length === 0) {
        return services.deriveDefault(rootSchema, false, maxRecursionDepth)
      }
      const [first] = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (first === undefined) return undefined
      return services.deriveDefault(first, false, maxRecursionDepth)
    },

    arrayShapeAtPath(path) {
      // `null` means "not a tuple": an unbounded array, a path that does not
      // resolve, or a non-array kind, the root included. Callers consult it
      // only while descending an array branch and read `null` as consumer
      // length plus one shared element default.
      if (path.length === 0) return null
      const [first] = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (first === undefined) return null
      const peeled = services.peelAllWrappers(first)
      if (intro.kindOf(peeled) === 'tuple') return intro.getTupleItems(peeled).length
      return null
    },

    isFixedObjectAtPath(path) {
      // At the root, consult the root schema's own kind. A fixed-shape
      // object has a closed top-level key set, so the proxy descends
      // into its declared keys. A record / discriminated-union / array
      // root is an open container, so the proxy falls back to live keys
      // (record entries, the active variant's fields) there.
      if (path.length === 0) {
        return intro.kindOf(services.peelAllWrappers(rootSchema)) === 'object'
      }
      const resolved = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      // A path the schema doesn't declare is not a fixed object; the
      // proxy falls back to live keys there.
      if (resolved.length === 0) return false
      // The walker returns the NODE itself at a terminal path, splitting a
      // union or DU into variants only while descending THROUGH one, so a
      // record, array, set, union or DU surfaces as its own single non-object
      // kind. Several candidates appear only where the path descended through
      // a union and landed on a key several variants declare, and that key is
      // a fixed object iff it is an object in every variant. Peel wrappers
      // first, so `z.object().optional()` still reads as an object.
      return resolved.every((s) => intro.kindOf(services.peelAllWrappers(s)) === 'object')
    },

    entryKeyKindAtPath(path) {
      const cacheKey = canonicalizePath(path).key
      if (entryKeyKindCache.has(cacheKey)) return entryKeyKindCache.get(cacheKey)
      const resolved =
        path.length === 0
          ? [rootSchema]
          : services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      let answer: 'string' | 'number' | undefined
      // One candidate only. A union landing here means the same segment
      // addresses a different container in each arm, and the arms can disagree
      // about what spells a key, so no single answer is true.
      const only = resolved.length === 1 ? resolved[0] : undefined
      if (only !== undefined) {
        switch (intro.kindOf(services.peelAllWrappers(only))) {
          case 'array':
          case 'tuple':
            answer = 'number'
            break
          case 'object':
          case 'record':
            answer = 'string'
            break
          case 'map':
            answer = mapKeySegmentKind(services.peelAllWrappers(only))
            break
          default:
            // Leaf, set, union, opaque leaf, or a path the schema does
            // not declare. None of them has an entry a segment can name.
            answer = undefined
        }
      }
      return memoPut(entryKeyKindCache, cacheKey, answer)
    },

    getSchemasAtPath(path) {
      // Slim-mode walk: v3 strips refinements, defaults and wrappers off the
      // root so the sub-schemas reflect the shape the slim-primitive gate
      // consults, while v4 aliases the slim and unstripped walks to one call.
      // Both `getSlimPrimitiveTypesAtPath` and `getSchemasAtPath` go through
      // this one hook.
      const resolved = services.getNestedSchemasInSlimMode(rootSchema, path, maxRecursionDepth)
      // An empty list is a valid result for a path the schema does not
      // declare; `getValue`, `register` and custom introspection all read it
      // as "no sub-schema here".
      if (resolved.length === 0) return []
      return resolved.map((sub) => services.makeSubSchema(sub, maxRecursionDepth))
    },

    getSlimPrimitiveTypesAtPath(path): ReadonlySet<SlimPrimitiveKind> {
      // Empty path is the root form: always an object.
      if (path.length === 0) return ROOT_KINDS
      const cacheKey = canonicalizePath(path).key
      const hit = slimKindsCache.get(cacheKey)
      if (hit !== undefined) return hit
      const resolved = services.getNestedSchemasInSlimMode(rootSchema, path, maxRecursionDepth)
      // A path the schema does not resolve accepts no kinds, so the gate's
      // membership check rejects every one and a write to a typo'd or unknown
      // path is blocked.
      if (resolved.length === 0) return memoPut(slimKindsCache, cacheKey, NO_KINDS)
      const out = new Set<SlimPrimitiveKind>()
      for (const candidate of resolved) {
        for (const k of services.slimPrimitivesOf(candidate, maxRecursionDepth)) {
          out.add(k)
        }
      }
      return memoPut(slimKindsCache, cacheKey, out)
    },

    isLeafAtPath(path): boolean {
      const cacheKey = canonicalizePath(path).key
      const cached = leafCache.get(cacheKey)
      if (cached !== undefined) return cached
      // An opaque leaf declares a value without describing its shape, so it
      // admits every kind INCLUDING the container ones and the slim-primitive
      // test below would read it as a container. It has no sub-paths to
      // descend into, which is what leafness answers, so it resolves ahead of
      // that test. The root stays a container even when the adapter hands back
      // an opaque root schema.
      const opaque = path.length > 0 && this.isOpaqueLeafAtPath(path)
      const prim = opaque ? undefined : this.getSlimPrimitiveTypesAtPath(path)
      // An empty set means the path is not in the schema, so descend
      // permissively and treat it as a container, keeping schema-named
      // reserved keys at depth 2 and below from shadowing. Any container kind
      // in the set also descends; a set of primitives only is a leaf.
      const isLeaf =
        opaque ||
        (prim !== undefined &&
          prim.size > 0 &&
          !prim.has('object') &&
          !prim.has('array') &&
          !prim.has('map') &&
          !prim.has('set'))
      return memoPut(leafCache, cacheKey, isLeaf)
    },

    isPreprocessOrCoerceLeaf(path): boolean {
      // Walks prefixes of `path` for either shape a schema-side input
      // normalizer takes, `z.preprocess(...)` or `z.coerce.X()`. True at such a
      // node and anywhere under it, which is how the slim-primitive gate knows
      // to accept raw consumer writes verbatim throughout that subtree.
      const cacheKey = canonicalizePath(path).key
      const cached = preprocessOrCoerceCache.get(cacheKey)
      if (cached !== undefined) return cached
      let hit = false
      for (let i = 0; i <= path.length && !hit; i++) {
        const prefix = path.slice(0, i)
        const candidates: Schema[] =
          prefix.length === 0
            ? [rootSchema]
            : services.getNestedSchemasAtPath(rootSchema, prefix, maxRecursionDepth)
        for (const candidate of candidates) {
          if (intro.isCoercePrimitive(candidate) || intro.isPreprocessNode(candidate)) {
            hit = true
            break
          }
        }
      }
      return memoPut(preprocessOrCoerceCache, cacheKey, hit)
    },

    isOpaqueLeafAtPath(path): boolean {
      const cacheKey = canonicalizePath(path).key
      const cached = opaqueLeafCache.get(cacheKey)
      if (cached !== undefined) return cached
      const resolved =
        path.length === 0
          ? [rootSchema]
          : services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      // Every candidate must be opaque. A union with one opaque arm still has
      // arms that describe a shape, and their sub-paths are real, so the gate
      // has to keep checking them.
      const opaque =
        resolved.length > 0 &&
        resolved.every((candidate) =>
          isOpaqueKind(intro.kindOf(services.peelAllWrappers(candidate)))
        )
      return memoPut(opaqueLeafCache, cacheKey, opaque)
    },

    isRequiredAtPath(path): boolean {
      // The root form is structurally required, being the parsed object. The
      // required-empty check tracks primitive leaves only, so this branch is
      // academic for the call sites that matter.
      if (path.length === 0) return true
      const resolved = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (resolved.length === 0) return false
      // Every candidate must be required for the path to be, which is the
      // union's any-branch-permissive rule where the path traverses one.
      return resolved.every((candidate) => services.isLeafRequired(candidate))
    },

    getFieldMetaAtPath(path): ResolvedFieldMeta {
      return services.resolveFieldMetaAtPath(rootSchema, path, maxRecursionDepth)
    },

    getUnionDiscriminatorAtPath(path): UnionDiscriminatorContext | undefined {
      const cacheKey = canonicalizePath(path).key
      if (discriminatorCache.has(cacheKey)) {
        return discriminatorCache.get(cacheKey)
      }
      return memoPut(discriminatorCache, cacheKey, computeDiscriminator(path))
    },

    validateAtPath(
      data: unknown,
      path: Path | undefined,
      validateOptions?: ValidateOptions
    ): ReturnType<AbstractSchema<Form, GetValueFormType>['validateAtPath']> {
      // With `options.sync === true`, try the sync parse first. It throws on
      // async refines, pipes and transforms, which is caught here before
      // falling through to async. Without the flag the adapter goes straight
      // to async, which is what every callsite but the DU reshape wants.
      const trySync = validateOptions?.sync === true
      if (trySync) {
        try {
          return runSync()
        } catch {
          // Async-only schema. Fall through to the async path.
        }
      }
      return runAsync()

      // Shared by the sync and async runners: map one safe-parse result to a
      // `SchemaParseResult`. The parse call and its try/catch stay in each
      // runner, and only the response shaping is shared.
      function parseResultToResponse(
        result: { success: true; data: unknown } | { success: false; issues: readonly unknown[] }
      ): SchemaParseResult<GetValueFormType> {
        return result.success
          ? { data: result.data as GetValueFormType, errors: undefined, success: true }
          : {
              data: undefined,
              errors: services.issuesToValidationErrors(result.issues),
              success: false,
            }
      }

      function runSync(): SchemaParseResult<GetValueFormType> {
        if (path === undefined) {
          return parseResultToResponse(services.safeParseSync(rootSchema, data))
        }
        const resolved = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
        if (resolved.length === 0) return pathNotFound(path)
        const aggregated: ValidationError[] = []
        for (const candidate of resolved) {
          const response = parseResultToResponse(services.safeParseSync(candidate, data))
          if (response.success) return response
          aggregated.push(...response.errors)
        }
        return { data: undefined, errors: aggregated, success: false }
      }

      async function runAsync(): Promise<SchemaParseResult<GetValueFormType>> {
        if (path === undefined) {
          let result: Awaited<ReturnType<typeof services.safeParseAsync>>
          try {
            result = await services.safeParseAsync(rootSchema, data)
          } catch (err) {
            return validatorThrewResponse(err, [])
          }
          return parseResultToResponse(result)
        }
        const resolved = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
        if (resolved.length === 0) return pathNotFound(path)
        // Sequential await: parallelising would run every branch's
        // async side effects on a value only one branch should see.
        const aggregated: ValidationError[] = []
        for (const candidate of resolved) {
          let result: Awaited<ReturnType<typeof services.safeParseAsync>>
          try {
            result = await services.safeParseAsync(candidate, data)
          } catch (err) {
            return validatorThrewResponse(err, path)
          }
          const response = parseResultToResponse(result)
          if (response.success) return response
          aggregated.push(...response.errors)
        }
        return { data: undefined, errors: aggregated, success: false }
      }

      // User code inside `z.preprocess`, `.refine` or `.transform` can throw
      // or reject, and Zod does NOT wrap those into issues: they propagate out
      // of `safeParse` and `safeParseAsync`. Uncaught, the throw bubbles
      // through `validateAtPath` into the submit and change-mode pipelines as
      // either a `submitError` or an unhandled rejection, and the consumer
      // never sees a path-scoped message. Surface as a `ValidationError` at
      // the field path so the form's normal error pipeline handles it.
      function validatorThrewResponse(
        err: unknown,
        errPath: Path
      ): SchemaParseResult<GetValueFormType> {
        const message =
          err instanceof Error ? err.message : typeof err === 'string' ? err : 'Validator threw'
        return {
          data: undefined,
          errors: [
            {
              message,
              path: [...errPath],
              code: AttaformErrorCode.ValidatorThrew,
            },
          ],
          success: false,
        }
      }

      function pathNotFound(p: Path): SchemaParseResult<GetValueFormType> {
        return {
          data: undefined,
          errors: [
            {
              message: `Path '${p.join(PATH_SEPARATOR)}' did not resolve to any schema`,
              path: [...p],
              code: AttaformErrorCode.PathNotFound,
            },
          ],
          success: false,
        }
      }
    },
  }

  return abstractSchema
}
