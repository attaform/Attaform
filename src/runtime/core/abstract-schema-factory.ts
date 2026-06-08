/**
 * `createAbstractSchema` — the schema-agnostic factory that hosts every
 * `AbstractSchema` method whose implementation is identical-modulo-
 * introspector between the v3 and v4 adapters.
 *
 * Each adapter wires through two small contracts:
 *
 *   - `SchemaIntrospector<Schema>` — pure, side-effect-free accessors
 *     that read schema shape. The factory branches on `kindOf`, walks
 *     discriminated-union literals via `getLiteralValues` /
 *     `getDiscriminatedOptions`, detects coerce / preprocess nodes,
 *     and consults the three async / container-refine flags.
 *
 *   - `AbstractSchemaServices<Schema, Form, GetValueFormType>` — the
 *     adapter-specific delegates the factory calls for everything that
 *     genuinely diverges per Zod version: fingerprinting, path-walking
 *     (the path walker itself has v3 / v4 quirks), default-value
 *     derivation, the strict-mode `getDefaultValues` flow,
 *     wrapper-peeling that's tied to the per-version wrapper set,
 *     field-meta resolution, and the per-version `safeParse`
 *     boundary.
 *
 * The two-interface split keeps the introspector reusable by any other
 * walker (fingerprint, slim-primitives, default-values) without dragging
 * in the side-effectful services. Services consume the introspector as
 * they wish; the factory consumes both.
 *
 * Behavior-neutral by design: the goal is one set of definitions for
 * the 13 structurally-parallel methods, with no observable change at
 * either adapter's `AbstractSchema` surface. Per-adapter caches keep
 * the same lifetime (one per `useForm()` call); `getSchemasAtPath`
 * preserves each adapter's prior sub-schema shape via the
 * `makeSubSchema` service (v3 recurses; v4 builds the 5-method stub).
 */
import type {
  AbstractSchema,
  DefaultValuesResponse,
  FormKey,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
  SlimPrimitiveKind,
  UnionDiscriminatorContext,
  ValidationError,
  ValidationResponse,
  ValidateOptions,
  SchemaFactoryOptions,
} from '../types/types-api'
import { AttaformErrorCode } from './error-codes'
import { canonicalizePath, type Path, type PathKey } from './paths'

const PATH_SEPARATOR = '.'

/**
 * Stable shape-discriminant the factory branches on. Adapters return
 * the union of v3 + v4 kinds plus `'unknown'` for anything they don't
 * recognise — the factory only inspects a small subset
 * (`'tuple'` / `'array'` for `arrayShapeAtPath`,
 * `'literal'` for the discriminated-union walk), so adapters can return
 * extra version-specific kinds (`'effects'` / `'pipeline'` / `'branded'`
 * / `'native-enum'` on v3) without confusing the factory.
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

/**
 * Pure schema-shape accessors. The factory consults these to branch on
 * structural facts about a schema node. Every member is side-effect-
 * free and idempotent.
 *
 * `kindOf` returns the discriminant; the structural accessors
 * (`getObjectShape`, `getTupleItems`, `getDiscriminatedOptions`,
 * `getLiteralValues`) read a single field of the node's def shape.
 * The three boolean predicates summarise tree-walking detections each
 * adapter already exposes; both adapters memoise them at the
 * AbstractSchema level so calling per construction is cheap.
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
   * Returns the option objects of a `ZodDiscriminatedUnion` — each one
   * is itself a `ZodObject` whose `getObjectShape` includes the
   * discriminator key as a `ZodLiteral`.
   */
  getDiscriminatedOptions(schema: Schema): readonly Schema[]
  /** Returns the discriminator key of a `ZodDiscriminatedUnion`. */
  getDiscriminator(schema: Schema): string | undefined
  /**
   * Returns the literal values a `ZodLiteral` admits. Multi-value
   * literals (`z.literal(['a', 'b'])`) return both; single-value return
   * the one. Empty for non-literals.
   */
  getLiteralValues(schema: Schema): readonly unknown[]
  /**
   * True iff the node is a preprocess-style schema-side normalizer:
   * `z.preprocess(fn, inner)` in either version. v3's `ZodEffects`
   * with `effect.type === 'preprocess'` and v4's `ZodPipe<ZodTransform,
   * inner>` both collapse here. Coerce primitives go through
   * `isCoercePrimitive` instead — they're not pipes in v4 and not
   * effects in v3, but both adapters detect them off the same flag.
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
   * asynchronously. v3 is conservative (every `.refine` flagged because
   * the inner sync wrapper hides the user fn); v4 is exact (inspects
   * `def.checks[].def.fn.constructor.name`). Either way the runtime
   * uses this to decide whether a construction-time async pass is
   * needed.
   */
  containsAsyncRefine(schema: Schema): boolean
  /**
   * True iff the schema tree contains a `.transform(asyncFn)` /
   * `z.preprocess(asyncFn, …)`. Statically detectable in both adapters
   * via the user fn's `constructor.name === 'AsyncFunction'`. Disjoint
   * from `containsAsyncRefine` — refines and transforms live in
   * different slots.
   */
  containsAsyncTransform(schema: Schema): boolean
  /**
   * True iff any refine fires at a container node (object / array /
   * tuple / union / discriminated-union / intersection / record / set)
   * or the root. False means every refine is leaf-local, so per-keystroke
   * subtree validation catches the same verdicts as a whole-form pass.
   */
  hasContainerOrRootRefine(schema: Schema): boolean

  // ---------------------------------------------------------------------
  // Walker accessors — consumed by the shared `core/walk-*` walkers (D2 /
  // D3 / D5) so the path-walking / slim-primitive / default-derivation
  // shapes don't fork per adapter. v3 / v4 each expose the full surface;
  // members not applicable to one adapter return `undefined` (kept on the
  // contract so the walkers don't branch on adapter identity).
  // ---------------------------------------------------------------------

  /** Element schema of a `z.array(...)`. Undefined for non-arrays / malformed defs. */
  getArrayElement(schema: Schema): Schema | undefined
  /** Element schema of a `z.set(...)`. Undefined for non-sets / malformed defs. */
  getSetValueType(schema: Schema): Schema | undefined
  /** Key schema of a `z.record(K, V)`. Undefined for non-records / single-arg records. */
  getRecordKeyType(schema: Schema): Schema | undefined
  /** Value schema of a `z.record(...)`. Undefined for non-records / malformed defs. */
  getRecordValueType(schema: Schema): Schema | undefined
  /** Option array of a `z.union(...)`. Empty for non-unions. */
  getUnionOptions(schema: Schema): readonly Schema[]
  /** Left side of a `z.intersection(L, R)`. Undefined for non-intersections. */
  getIntersectionLeft(schema: Schema): Schema | undefined
  /** Right side of a `z.intersection(L, R)`. Undefined for non-intersections. */
  getIntersectionRight(schema: Schema): Schema | undefined
  /** Values of a `z.enum(...)`. Empty for non-enums. */
  getEnumValues(schema: Schema): readonly (string | number)[]
  /**
   * Raw reverse-mapped values object of a `z.nativeEnum(E)`. v3 returns
   * the TS enum object directly; v4 always returns `undefined` because
   * v4 folds nativeEnum into the regular `enum` kind.
   */
  getNativeEnumValues(schema: Schema): Record<string, unknown> | undefined

  /**
   * Inner schema of any wrapper exposing `def.innerType` — Optional /
   * Nullable / Default / Readonly / Catch in both v3 and v4. Branded
   * (v3-only) uses `def.type` instead — see `unwrapBranded`. Returns
   * `undefined` when no inner is available.
   */
  unwrapInner(schema: Schema): Schema | undefined
  /**
   * v3-only: `ZodBranded`'s inner schema (`_def.type`). Returns
   * `undefined` on v4 (no branded wrapper) and on non-branded schemas.
   */
  unwrapBranded(schema: Schema): Schema | undefined
  /**
   * v3-only: structural source of a `ZodEffects` (refine / transform /
   * preprocess) — `_def.schema`. Returns `undefined` on v4 (no
   * ZodEffects wrapper; effects live as pipe sides / leaf checks).
   */
  unwrapEffectsSource(schema: Schema): Schema | undefined
  /** Input side of v4's `z.pipe(IN, OUT)` (also v3's `z.pipeline(...)`). */
  unwrapPipeIn(schema: Schema): Schema | undefined
  /** Output side of a pipe — undefined on v3's `ZodEffects`. */
  unwrapPipeOut(schema: Schema): Schema | undefined
  /**
   * Inner schema of a `z.lazy(() => inner)`. Each call invokes the
   * getter fresh; if the getter throws (recursive cycle resolved before
   * its target is constructed) returns `undefined`.
   */
  unwrapLazy(schema: Schema): Schema | undefined
  /**
   * Getter function reference of a `z.lazy()` wrapper — used by walkers
   * that track cycle identity by the getter rather than its result
   * (each call returns a distinct schema instance).
   */
  getLazyGetter(schema: Schema): (() => unknown) | undefined

  /**
   * Resolve a `z.default(...)` wrapper to its declared default value.
   * v3 stores the default as a thunk (`() => value`); v4 stores it as
   * a getter that returns the value directly. Both adapters return the
   * resolved value here.
   */
  getDefaultValue(schema: Schema): unknown
  /**
   * Resolve a `z.catch(inner, val)` wrapper to its fallback value.
   * The catch slot stores a `(ctx) => value` function; both adapters
   * invoke it with a placeholder context and surface `undefined` if
   * the consumer's function throws.
   */
  getCatchDefault(schema: Schema): unknown
  /**
   * True iff the schema carries a callable `z.catch(...)` fallback.
   * Lets callers distinguish "no catch wrapper" from "catch wrapper
   * whose value happens to be `undefined`."
   */
  hasCatchValue(schema: Schema): boolean
}

/**
 * Adapter-specific delegates the factory calls for operations that
 * genuinely differ per Zod version (path walking, default-value
 * derivation, wrapper-peeling, error normalization, sub-schema
 * construction). Each service is a thin wrapper around per-adapter
 * helpers; the factory composes them.
 *
 * `safeParseSync` / `safeParseAsync` abstract the per-version
 * `safeParse` / `safeParseAsync` calls so the factory can stay
 * version-agnostic. Both return a uniform success-discriminant shape;
 * `safeParseSync` is allowed to throw when the schema is async-only
 * (the factory catches and falls back to the async path).
 *
 * `makeSubSchema` is the per-adapter sub-schema constructor for
 * `getSchemasAtPath`. v3 recurses through the full adapter factory
 * (sub-schemas expose the entire `AbstractSchema` surface). v4 builds
 * a 5-method stub (fingerprint / needsAsyncValidation /
 * getDefaultValues / getSchemasAtPath / validateAtPath) because none
 * of its consumers reach for the wider surface and the stub keeps
 * sub-walker allocation cheap. The factory preserves each adapter's
 * prior behavior by routing through this service rather than hard-
 * coding one strategy.
 */
export interface AbstractSchemaServices<Schema, Form, GetValueFormType> {
  /**
   * Resolves the deterministic structural fingerprint of the schema.
   * Async so adapters can dynamic-import the fingerprint walker, keeping
   * it off the eager path (only opt-in async features consume it).
   */
  fingerprint(schema: Schema): Promise<string>
  /**
   * Returns every sub-schema reachable at the given path. Multiple
   * results indicate a union / discriminated-union split; empty
   * indicates the path doesn't resolve. Adapters cap descent through
   * `z.lazy(...)` via `maxRecursionDepth`.
   */
  getNestedSchemasAtPath(schema: Schema, path: Path, maxRecursionDepth: number): Schema[]
  /**
   * "Slim-mode" path walk — the variant `getSlimPrimitiveTypesAtPath`
   * and `getSchemasAtPath` consume. v3 strips refinements / defaults /
   * optional / nullable / effects off the root before walking, so the
   * yielded candidates reflect the slim shape (matches what the slim-
   * primitive gate sees and what consumers expect when introspecting
   * sub-schemas). v4 walks the original schema and aliases this to
   * `getNestedSchemasAtPath` — its path walker already inlines the
   * wrapper peeling.
   */
  getNestedSchemasInSlimMode(schema: Schema, path: Path, maxRecursionDepth: number): Schema[]
  /** Returns the slim-primitive accept-set of a single sub-schema. */
  slimPrimitivesOf(schema: Schema, maxRecursionDepth: number): Set<SlimPrimitiveKind>
  /**
   * Returns the schema's prescribed default at the given root. The
   * runtime calls this in `getDefaultAtPath` (`useDefault=true` — honor
   * `.default(x)`) and `getEmptyValueAtPath` (`useDefault=false` —
   * yield the inner-schema's falsy concrete). v3 and v4 each implement
   * their own walker; the factory only consumes the result.
   */
  deriveDefault(
    schema: Schema,
    useDefault: boolean,
    maxRecursionDepth: number,
    formKey: FormKey
  ): unknown
  /**
   * Adapter-owned construction-time default-values flow. v3 runs a
   * validate-then-fix loop against a slim schema with strict-mode
   * refine seeding; v4 runs a strict-pass-or-lax-success against the
   * derived data. Both honour `config.strict ?? true` and
   * `config.constraints`.
   */
  runStrictGetDefaults(
    schema: Schema,
    config: GetDefaultValuesConfig<Form>,
    formKey: FormKey,
    maxRecursionDepth: number
  ): DefaultValuesResponse<Form>
  /**
   * Peels `.optional()` / `.nullable()` only when the inner is
   * structurally fillable (object / array / tuple / record /
   * union / intersection or a chain of peelable wrappers that resolve
   * to one of those). Used by `getDefaultAtPath` so partial writes
   * through optional sub-schemas fill from the inner shape's defaults.
   * `.default(x)` is preserved at every layer.
   */
  unwrapStructuralWrappers(schema: Schema): Schema
  /**
   * Peels every transparent wrapper (optional / nullable / default /
   * readonly / catch / pipe / lazy / branded / effects) and descends
   * intersection sides looking for a single discriminated union.
   * Returns the matching DU or `undefined` when no DU is found or
   * when ambiguity bails (two different DUs both reachable).
   */
  unwrapToDiscriminatedUnion(schema: Schema): Schema | undefined
  /**
   * Peels every transparent wrapper off a schema — for `arrayShapeAtPath`
   * the goal is the structural kind regardless of default-value
   * semantics, so `.default(x)` / `.catch(x)` are peeled here whereas
   * `unwrapStructuralWrappers` preserves them.
   */
  peelAllWrappers(schema: Schema): Schema
  /**
   * Returns `true` iff the leaf schema is "required" at the
   * union-aware sense documented on `AbstractSchema.isRequiredAtPath`:
   * `.optional()` / `.nullable()` / `.default()` / `.catch()` at any
   * wrapper layer make the leaf permissive; union requires every
   * branch; intersection requires either side.
   */
  isLeafRequired(schema: Schema): boolean
  /** Returns the resolved field-meta payload for the schema at `path`. */
  resolveFieldMetaAtPath(schema: Schema, path: Path, maxRecursionDepth: number): ResolvedFieldMeta
  /**
   * Normalise schema-library issues into the runtime's
   * `ValidationError[]` shape. v3 and v4 have slightly different
   * `ZodIssue` payloads; each adapter knows how to map its own.
   */
  issuesToValidationErrors(issues: readonly unknown[], formKey: FormKey): ValidationError[]
  /**
   * Run a sync `safeParse` against the schema. Returns a tagged result
   * the factory aggregates into a `ValidationResponse`. MAY throw when
   * the schema contains async-only refines / transforms (the factory
   * catches and falls back to the async path).
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
   * Per-adapter sub-schema constructor for `getSchemasAtPath`. v3
   * recurses through the full factory (sub-schemas carry the entire
   * `AbstractSchema` surface). v4 returns a 5-method stub. The factory
   * delegates here to preserve each adapter's prior shape; consumers
   * across the runtime only reach for `needsAsyncValidation()` on
   * sub-schemas, so both shapes are observationally interchangeable.
   */
  makeSubSchema(
    schema: Schema,
    formKey: FormKey,
    maxRecursionDepth: number
  ): AbstractSchema<unknown, GetValueFormType>
}

/**
 * Build a runtime `AbstractSchema` for `rootSchema` by composing the
 * shared uniform-method implementations with the per-adapter introspector
 * + services. Each adapter calls this once per `useForm({ schema })` —
 * the returned object plus its three caches (`leafCache`,
 * `preprocessOrCoerceCache`, `discriminatorCache`) plus the two memoised
 * lazy flags live for the form's lifetime.
 */
export function createAbstractSchema<Schema, Form, GetValueFormType>(
  rootSchema: Schema,
  intro: SchemaIntrospector<Schema>,
  services: AbstractSchemaServices<Schema, Form, GetValueFormType>,
  formKey: FormKey,
  options: SchemaFactoryOptions
): AbstractSchema<Form, GetValueFormType> {
  const maxRecursionDepth = options.maxRecursionDepth

  // Per-adapter caches. Lifetime = one `createAbstractSchema` call (one
  // per `useForm()`). These memoise the schema walks that the proxy
  // traps + reactive computeds hit on every read so the schema doesn't
  // get re-walked per keystroke / per field-state get.
  const leafCache = new Map<PathKey, boolean>()
  const preprocessOrCoerceCache = new Map<PathKey, boolean>()
  const discriminatorCache = new Map<PathKey, UnionDiscriminatorContext | undefined>()
  // Memoised one-shot tree walks. `needsAsyncValidation` is queried at
  // construction by the store (drives the construction-time async seed);
  // `hasContainerOrRootRefine` is queried per keystroke (drives the
  // subtree-vs-whole-form scope cut).
  let asyncValidationFlag: boolean | null = null
  let containerRefineFlag: boolean | null = null

  function computeDiscriminator(path: Path): UnionDiscriminatorContext | undefined {
    const candidates =
      path.length === 0
        ? [rootSchema]
        : services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
    // `unwrapToDiscriminatedUnion` peels every transparent wrapper
    // (Optional / Nullable / Default / Readonly / Catch / Effects /
    // Pipeline / Branded) and descends Intersection sides looking for a
    // single discriminated union. Ambiguous resolutions (two distinct
    // DUs both reachable across candidates) bail — the runtime then
    // falls back to a plain write.
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
            return services.deriveDefault(opt, true, maxRecursionDepth, formKey)
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
    fingerprint: () => services.fingerprint(rootSchema),

    needsAsyncValidation(): boolean {
      asyncValidationFlag ??=
        intro.containsAsyncRefine(rootSchema) || intro.containsAsyncTransform(rootSchema)
      return asyncValidationFlag
    },

    hasContainerOrRootRefine(): boolean {
      containerRefineFlag ??= intro.hasContainerOrRootRefine(rootSchema)
      return containerRefineFlag
    },

    getDefaultValues(config: GetDefaultValuesConfig<Form>): DefaultValuesResponse<Form> {
      return services.runStrictGetDefaults(rootSchema, config, formKey, maxRecursionDepth)
    },

    getDefaultAtPath(path) {
      // Empty path → root default. Reuses the same generator used at
      // form construction so refines / wrappers behave consistently.
      if (path.length === 0) {
        return services.deriveDefault(rootSchema, true, maxRecursionDepth, formKey)
      }
      const [first] = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (first === undefined) return undefined
      // STRUCTURAL default: peel `.optional()` / `.nullable()` so partial
      // object writes through optional sub-schemas (`{ profile:
      // z.object({...}).optional() }`) get the inner shape's defaults
      // filled in. `.default(x)` is preserved so deriveDefault returns
      // the explicit default. First candidate matches
      // `validateAtPath`'s first-success semantic.
      const peeled = services.unwrapStructuralWrappers(first)
      return services.deriveDefault(peeled, true, maxRecursionDepth, formKey)
    },

    getEmptyValueAtPath(path) {
      // `clear`'s underlying value lookup. Same path-resolution flow as
      // `getDefaultAtPath` but with `useDefault=false` so `.default(x)`
      // / `.catch(x)` wrappers are skipped — the walker yields the
      // inner-schema's empty concrete instead. Structural wrappers
      // (`.optional()` / `.nullable()`) are NOT peeled: clearing an
      // `.optional()` slot is legitimately `undefined`, clearing a
      // `.nullable()` slot is `null`.
      if (path.length === 0) {
        return services.deriveDefault(rootSchema, false, maxRecursionDepth, formKey)
      }
      const [first] = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (first === undefined) return undefined
      return services.deriveDefault(first, false, maxRecursionDepth, formKey)
    },

    arrayShapeAtPath(path) {
      if (path.length === 0) return undefined
      const [first] = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (first === undefined) return undefined
      const peeled = services.peelAllWrappers(first)
      const kind = intro.kindOf(peeled)
      if (kind === 'tuple') return intro.getTupleItems(peeled).length
      if (kind === 'array') return null
      return undefined
    },

    isFixedObjectAtPath(path) {
      // Root form is a fixed object — a closed top-level key set.
      if (path.length === 0) return true
      const resolved = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      // A path the schema doesn't declare is not a fixed object; the
      // proxy falls back to live keys there.
      if (resolved.length === 0) return false
      // The walker returns the NODE itself at a terminal path (it only
      // splits a union / DU into variants while descending THROUGH one),
      // so a record / array / set / union / DU surfaces here as its own
      // single non-object kind. Multiple candidates appear only when the
      // path descended through a union and landed on a key present in
      // several variants; that key is a fixed object iff it's an object
      // in every variant. Peel wrappers first so `z.object().optional()`
      // still reads as an object.
      return resolved.every((s) => intro.kindOf(services.peelAllWrappers(s)) === 'object')
    },

    getSchemasAtPath(path) {
      // Slim-mode walk: v3 strips refinements / defaults / wrappers off
      // the root so the yielded sub-schemas reflect the slim shape (the
      // shape the slim-primitive gate consults). v4 aliases the slim
      // and unstripped walks to the same call. The factory uses one
      // hook for both `getSlimPrimitiveTypesAtPath` and
      // `getSchemasAtPath` — same v3 strip semantic, same v4 alias.
      const resolved = services.getNestedSchemasInSlimMode(rootSchema, path, maxRecursionDepth)
      // Empty list is a valid result for paths the schema doesn't
      // declare — callers (getValue / register / custom introspection)
      // treat `[]` as "no sub-schema here". No warning needed.
      if (resolved.length === 0) return []
      return resolved.map((sub) => services.makeSubSchema(sub, formKey, maxRecursionDepth))
    },

    getSlimPrimitiveTypesAtPath(path): Set<SlimPrimitiveKind> {
      // Empty path is the root form: always an object.
      if (path.length === 0) return new Set<SlimPrimitiveKind>(['object'])
      const resolved = services.getNestedSchemasInSlimMode(rootSchema, path, maxRecursionDepth)
      // Path doesn't resolve in the schema → no kinds accepted. The
      // gate's membership check rejects every kind against an empty
      // set, blocking writes to typo / unknown paths.
      if (resolved.length === 0) return new Set<SlimPrimitiveKind>()
      const out = new Set<SlimPrimitiveKind>()
      for (const candidate of resolved) {
        for (const k of services.slimPrimitivesOf(candidate, maxRecursionDepth)) {
          out.add(k)
        }
      }
      return out
    },

    isLeafAtPath(path): boolean {
      const cacheKey = canonicalizePath(path).key
      const cached = leafCache.get(cacheKey)
      if (cached !== undefined) return cached
      const prim = this.getSlimPrimitiveTypesAtPath(path)
      // Empty set → path doesn't exist in schema → descend permissively
      // (treat as container so schema-named reserved keys at depth 2+
      // don't shadow). Any container kind in the set → descend.
      // Otherwise every kind is a primitive → leaf.
      const isLeaf =
        prim.size > 0 &&
        !prim.has('object') &&
        !prim.has('array') &&
        !prim.has('map') &&
        !prim.has('set')
      leafCache.set(cacheKey, isLeaf)
      return isLeaf
    },

    isPreprocessOrCoerceLeaf(path): boolean {
      // Walks prefixes of `path` looking for either shape adapters
      // use for schema-side input normalizers (`z.preprocess(...)` or
      // `z.coerce.X()`). Returns true at such a node OR anywhere
      // underneath it; the slim-primitive gate uses this to accept
      // raw consumer writes verbatim throughout that subtree.
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
      preprocessOrCoerceCache.set(cacheKey, hit)
      return hit
    },

    isRequiredAtPath(path): boolean {
      // Root form is structurally required (it's the parsed object).
      // The required-empty check tracks primitive leaves only, so this
      // branch is academic for the call sites that matter.
      if (path.length === 0) return true
      const resolved = services.getNestedSchemasAtPath(rootSchema, path, maxRecursionDepth)
      if (resolved.length === 0) return false
      // Every candidate must be required for the path overall to be
      // required — matches the union "any-branch-permissive" rule
      // when the path traverses a union.
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
      const result = computeDiscriminator(path)
      discriminatorCache.set(cacheKey, result)
      return result
    },

    validateAtPath(
      data: unknown,
      path: Path | undefined,
      validateOptions?: ValidateOptions
    ): ReturnType<AbstractSchema<Form, GetValueFormType>['validateAtPath']> {
      // Sync attempt: when `options.sync === true`, try the sync parse.
      // It throws on async refines / pipes / transforms; we catch and
      // fall through to the async path. Without the flag the adapter
      // goes straight to async — the historical contract every non-
      // reshape callsite expects.
      const trySync = validateOptions?.sync === true
      if (trySync) {
        try {
          return runSync()
        } catch {
          // Async-only schema. Fall through to the async path.
        }
      }
      return runAsync()

      // Post-parse aggregation core shared by runSync / runAsync: map a
      // single safe-parse result to a ValidationResponse. The parse call
      // (sync vs async + its try/catch) stays in each runner; only the
      // success/issues -> response shaping is shared here.
      function parseResultToResponse(
        result: { success: true; data: unknown } | { success: false; issues: readonly unknown[] }
      ): ValidationResponse<GetValueFormType> {
        return result.success
          ? { data: result.data as GetValueFormType, errors: undefined, success: true, formKey }
          : {
              data: undefined,
              errors: services.issuesToValidationErrors(result.issues, formKey),
              success: false,
              formKey,
            }
      }

      function runSync(): ValidationResponse<GetValueFormType> {
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
        return { data: undefined, errors: aggregated, success: false, formKey }
      }

      async function runAsync(): Promise<ValidationResponse<GetValueFormType>> {
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
        // Sequential await — parallelising would run every branch's
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
        return { data: undefined, errors: aggregated, success: false, formKey }
      }

      // User code inside `z.preprocess` / `.refine` / `.transform` can
      // throw (sync) or reject (async). Zod does NOT wrap these into
      // issues; they propagate out of `safeParse` / `safeParseAsync`.
      // Without this catch the throw bubbles through `validateAtPath`
      // into the runtime's submit / change-mode pipelines as either a
      // `submitError` (handleSubmit) or an unhandled rejection
      // (scheduleFieldValidation), and the consumer would never see a
      // path-scoped error message. Surface as a `ValidationError` at
      // the field path so the form's normal error pipeline handles it.
      function validatorThrewResponse(
        err: unknown,
        errPath: Path
      ): ValidationResponse<GetValueFormType> {
        const message =
          err instanceof Error ? err.message : typeof err === 'string' ? err : 'Validator threw'
        return {
          data: undefined,
          errors: [
            {
              message,
              path: [...errPath],
              formKey,
              code: AttaformErrorCode.ValidatorThrew,
            },
          ],
          success: false,
          formKey,
        }
      }

      function pathNotFound(p: Path): ValidationResponse<GetValueFormType> {
        return {
          data: undefined,
          errors: [
            {
              message: `Path '${p.join(PATH_SEPARATOR)}' did not resolve to any schema`,
              path: [...p],
              formKey,
              code: AttaformErrorCode.PathNotFound,
            },
          ],
          success: false,
          formKey,
        }
      }
    },
  }

  return abstractSchema
}
