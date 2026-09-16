// Type-only import of zod v3. The adapter constructs zero schema nodes
// through the ambient `z`; every slim / strip rebuild goes through
// `rebuild-schema.ts`, which reconstructs from the consumer's own
// (correct-version) node. That keeps the adapter immune to a second,
// mismatched zod hoisted alongside the one a schema was authored with.
// `attaform/zod-v3` consumers install zod@3 themselves; only its types
// are referenced here.
import type { z } from 'zod-v3'
import type {
  AbstractSchema,
  SchemaDefaultsResult,
  FormKey,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
  ValidationError,
  SchemaFactoryOptions,
} from '../../types/types-api'
import {
  createAbstractSchema,
  createSharedSchemaStore,
  type AbstractSchemaServices,
} from '../../core/abstract-schema-factory'
import { mergeDeep } from '../../core/merge-deep'
import { walkPathSegments } from '../../core/walk-path-segments'
import { normalizeIssuePaths } from './normalize-issue-paths'
import { fixStructuralDefaults } from '../../core/walk-fix-structural'
import { deriveDefaultWalk } from '../../core/walk-derive-default'
import {
  buildFieldMetaPathMap,
  getFieldMetaForSchema,
  getFieldMetaListForSchema,
} from '../../core/field-meta-store'
import { humanize } from '../../core/humanize'
import { canonicalizePath, type Path } from '../../core/paths'
import type { GenericForm } from '../../types/types-core'

// Shared cap for every wrapper-peeling / unwrap helper in this file.
// Pathological schemas (deep `.refine()` chains, self-referential lazy
// loops) would otherwise stack-overflow or hang. 64 is generous for any
// realistic form schema; past it we bail conservatively rather than
// crash.
const MAX_UNWRAP_STEPS = 64

import { __DEV__ } from '../../core/dev'
import { AttaformError } from '../../core/errors'
import type { TypeWithNullableDynamicKeys } from './types-zod'
// `ZodTypeWithInnerType` lives in types-zod.ts and is re-exported from
// `attaform/zod-v3` as a narrow accessor type for custom-adapter
// authors. Phase 7's introspect chokepoint means the v3 adapter no
// longer reads `_def` directly inline; the public type stays available
// for downstream consumers writing adapter-shaped code.
import { isZodSchemaType } from './helpers'
import {
  containsAsyncTransform,
  getEffectsKind,
  getIntersectionLeft,
  getIntersectionRight,
  getTypeName,
  getUnionOptions,
  unwrapBranded,
  unwrapEffectsSource,
  containsMapOrSet,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
} from './introspect'
import { slimPrimitivesV3 } from './slim-primitives'
import { wrapAsyncSafeRefinements } from './strip-async'
import { V3_INTROSPECTOR } from './walker-introspector'

let warnedZodCodeMissing = false

/**
 * Wrap a Zod v3 form-root schema (`ZodObject` or `ZodRecord`) in an
 * `AbstractSchema` factory.
 *
 * Most consumers never call this directly — `useForm` from
 * `attaform/zod-v3` does the wrapping automatically. Reach
 * for it only when integrating with a custom code path that needs
 * the adapter outside of `useForm`.
 *
 * Throws if the underlying schema isn't a supported form root.
 */
export function zodAdapter<
  FormSchema extends z.ZodSchema,
  Form extends z.input<FormSchema>,
  GetValueFormType extends TypeWithNullableDynamicKeys<FormSchema>,
>(
  zodSchema: FormSchema
): (formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, GetValueFormType> {
  // The root of a form has to be able to hold keys, because a form IS
  // a set of addressable fields. This is the one place the adapter
  // refuses a schema, and it rejects on the absence of the single
  // property the form engine requires rather than on a list of kinds.
  // Every kind stays welcome UNDER a key. Mirrors v4's
  // `assertKeyedRoot`, down to the AF15 code.
  const peeledRoot = peelAllV3Wrappers(zodSchema)
  if (
    !isZodSchemaType(peeledRoot, 'ZodObject') &&
    !isZodSchemaType(peeledRoot, 'ZodRecord') &&
    !isZodSchemaType(peeledRoot, 'ZodDiscriminatedUnion')
  ) {
    const name = getTypeName(peeledRoot) ?? 'unknown'
    throw new AttaformError(
      __DEV__
        ? `[attaform/zod-v3] useForm schema root must be a ZodObject, ZodRecord, or ` +
            `ZodDiscriminatedUnion (got '${name}'). Wrap other shapes under a key.`
        : `[attaform] AF15 attaform.dev/e/af15 '${name}'`
    )
  }

  // `options.maxRecursionDepth` caps `z.lazy(...)` descent in
  // `getNestedZodSchemasAtPath` — once the walker has crossed
  // `maxRecursionDepth + 1` lazy boundaries it returns `[]`, so writes
  // at recursive paths deeper than the cap fall back to a permissive
  // type gate. Matches the v4 adapter's path-walker contract.
  return (_formKey: FormKey, options: SchemaFactoryOptions) =>
    sharedV3Schemas(zodSchema, options.maxRecursionDepth, () =>
      createAbstractSchema<z.ZodTypeAny, Form, GetValueFormType>(
        zodSchema,
        V3_INTROSPECTOR,
        buildV3Services<Form, GetValueFormType>(options.maxRecursionDepth),
        options
      )
    )
}

/**
 * v3's store of shared `AbstractSchema` instances, keyed weakly on the
 * root schema. See `createSharedSchemaStore`.
 */
const sharedV3Schemas = createSharedSchemaStore()

/**
 * Build the v3 `AbstractSchemaServices` instance. Services are stateless
 * — every method receives the schema it acts on plus the factory-supplied
 * `formKey` / `maxRecursionDepth`. Generic in `Form` / `GetValueFormType`
 * so the typed methods (`runStrictGetDefaults` / `makeSubSchema`)
 * propagate the form shape correctly.
 */
/**
 * Cache of promise-safe schema variants, keyed by the node handed in.
 *
 * Every SYNCHRONOUS parse the adapter performs has to go through here.
 * A sync parse of a schema holding an async refinement makes Zod v3 run
 * that refinement, see a Promise, discard it, and throw its
 * "Async refinement encountered" error; a predicate that rejects then
 * surfaces in the host app as an unhandled rejection from a parse the
 * consumer never asked for. `wrapAsyncSafeRefinements` attaches a
 * handler to that promise before Zod can drop it, changing nothing
 * else about the parse.
 *
 * Cached because the rebuild is a full tree walk and the sync paths
 * (mount, `reset()`, a discriminated-union variant switch) re-parse the
 * same nodes. A `WeakMap` keeps it keyed to schema lifetime, so a form
 * that is torn down takes its entry with it.
 */
const syncSafeCache = new WeakMap<object, z.ZodTypeAny>()

function syncSafe(schema: z.ZodTypeAny): z.ZodTypeAny {
  const cached = syncSafeCache.get(schema)
  if (cached !== undefined) return cached
  const wrapped = wrapAsyncSafeRefinements(schema)
  syncSafeCache.set(schema, wrapped)
  return wrapped
}

function buildV3Services<Form extends GenericForm, GetValueFormType extends GenericForm>(
  maxRecursionDepth: number
): AbstractSchemaServices<z.ZodTypeAny, Form, GetValueFormType> {
  // v3 files a map entry's issue at `[entryIndex, 'key' | 'value']` and
  // a set member's at its index, neither of which is a path the runtime
  // addresses — v4 files both where Attaform reads them. The rewrite
  // below re-files them, and this flag keeps it free for the schemas
  // that hold neither: one tree walk on a schema's first parse failure,
  // then a lookup. Keyed by the schema NODE, not by the services
  // instance: a path-scoped validation parses a sub-schema through this
  // same instance, so one shared flag would answer for the root using
  // whichever node happened to fail first.
  const mapOrSetBySchema = new WeakMap<object, boolean>()
  const refileIssues = (
    schema: z.ZodTypeAny,
    data: unknown,
    issues: readonly z.ZodIssue[]
  ): readonly z.ZodIssue[] => {
    let hasMapOrSet = mapOrSetBySchema.get(schema)
    if (hasMapOrSet === undefined) {
      hasMapOrSet = containsMapOrSet(schema)
      mapOrSetBySchema.set(schema, hasMapOrSet)
    }
    if (!hasMapOrSet) return issues
    return normalizeIssuePaths(issues, schema, data, maxRecursionDepth, peelAllV3Wrappers)
  }
  return {
    getNestedSchemasAtPath: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodSchema, path, maxRecursionDepth),
    // v3 pre-strips refinements / defaults / wrappers off the root for
    // slim-mode walks — `getSlimPrimitiveTypesAtPath` and
    // `getSchemasAtPath` both consume this variant so the yielded
    // candidates reflect the slim shape.
    // The slim-root projection is gone (size-teardown P7): the shared
    // path walker peels wrappers / effects inline, so the slim and
    // unstripped walks coincide — same aliasing v4 always had.
    getNestedSchemasInSlimMode: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodSchema, path, maxRecursionDepth),
    slimPrimitivesOf: (schema, _maxRecursionDepth) => slimPrimitivesV3(schema),
    deriveDefault: (schema, useDefault) =>
      getDefaultValuesFromZodSchema(schema as z.ZodSchema, useDefault),
    runStrictGetDefaults: (schema, config, maxRecursionDepth) =>
      runStrictGetDefaultsV3<Form>(schema as z.ZodSchema, config, maxRecursionDepth),
    unwrapStructuralWrappers: (schema) => unwrapStructuralLeafV3(schema),
    unwrapToDiscriminatedUnion: (schema) =>
      unwrapToDiscriminatedUnion(schema) as z.ZodTypeAny | undefined,
    peelAllWrappers: (schema) => peelAllV3Wrappers(schema),
    isLeafRequired: (schema) => isLeafRequiredV3(schema),
    resolveFieldMetaAtPath: (schema, path, maxRecursionDepth) =>
      resolveFieldMetaAtPathV3(schema as z.ZodSchema, path, maxRecursionDepth),
    issuesToValidationErrors: (issues) => zodIssuesToValidationErrors(issues as z.ZodIssue[]),
    safeParseSync: (schema, data) => {
      const result = syncSafe(schema).safeParse(data)
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: refileIssues(schema, data, result.error.issues) }
    },
    safeParseAsync: async (schema, data) => {
      const result = await schema.safeParseAsync(data)
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: refileIssues(schema, data, result.error.issues) }
    },
    // v3 returns the full recursive AbstractSchema for sub-schemas (the
    // historical shape) — `getSchemasAtPath` consumers may probe any
    // method on the result. The factory call rebuilds the full surface
    // against the sub-schema with its own per-form caches.
    makeSubSchema: (sub, maxRecursionDepth) =>
      createAbstractSchema<z.ZodTypeAny, unknown, GetValueFormType>(
        sub,
        V3_INTROSPECTOR,
        buildV3Services<GenericForm, GetValueFormType>(maxRecursionDepth),
        { maxRecursionDepth }
      ),
  }
}

function zodIssuesToValidationErrors(issues: z.ZodIssue[]): ValidationError[] {
  const validationErrors: ValidationError[] = []
  for (const issue of issues) {
    let code: string
    if (typeof issue.code === 'string' && issue.code.length > 0) {
      code = `zod:${issue.code}`
    } else {
      code = 'zod:unknown'
      if (__DEV__ && !warnedZodCodeMissing) {
        warnedZodCodeMissing = true
        console.warn(
          '[attaform] zod-v3 adapter received an issue with no string `code`; ' +
            "stamping `'zod:unknown'`. This usually means a custom Zod plugin emitted " +
            'an issue without the standard code field.'
        )
      }
    }
    validationErrors.push({
      message: issue.message,
      // `ValidationError.path` is `(string | number)[]` per the
      // public type. v3's `issue.path` is the same in the standard
      // case, but a custom check via `ctx.addIssue({ path: [...] })`
      // can smuggle a Symbol through — the public surface promised
      // strings/numbers, so coerce defensively to keep the contract.
      // Mirrors v4's behaviour at the same site.
      //
      // Adapter-side paths stay schema-relative — the validation
      // pipeline in `create-form-store.ts` prepends the parent path
      // to absolutise, then routes form-level (absolute path length 0)
      // entries to the empty-string bucket at storage time.
      path: coercePathSegments(issue.path),
      code,
    })
  }

  return validationErrors
}

function coercePathSegments(path: readonly (string | number | symbol)[]): (string | number)[] {
  const out: (string | number)[] = []
  for (const seg of path) {
    out.push(typeof seg === 'number' ? seg : typeof seg === 'string' ? seg : String(seg))
  }
  return out
}

// Walks a canonical `Segment[]` directly — every literal-dot key is
// treated as a single segment, so a field named `"user.email"` no
// longer collides with the sibling pair `['user', 'email']`.
//
// Each iteration peels transparent wrappers (`peelV3Wrappers` —
// optional / nullable / default / effects / pipeline / readonly /
// branded) BEFORE checking the kind for descent. Peeling is what
// lets the walker step through e.g. `z.object({...}).refine(...)`
// (a `ZodEffects` at the root) into the inner shape without
// requiring callers to pre-strip wrappers. Importantly the peel is
// applied only when descending — once the loop exits, the schema
// at the target segment is returned as-is (including its own
// wrapper, since that wrapper carries semantic meaning at parse
// time, e.g. `.optional()` admits `undefined`, `.default(x)`
// substitutes, `.refine(...)` runs the predicate). For path = []
// (no segments) the original schema is returned unchanged so
// whole-form `validateAtPath` keeps the root's refine intact.
/**
 * Walk a structured path through a Zod v3 schema tree and return the
 * subschema(s) that live at that path.
 *
 * - Unions return multiple candidates (caller tries each).
 * - Discriminated unions filter options to those whose shape contains the
 *   next segment, so a path into `{ status: 'error', message: string }`
 *   resolves only to the 'error' branch.
 * - Wrappers (optional / nullable / default / readonly / catch / effects /
 *   pipeline / branded) are transparent — the walker descends into the
 *   inner schema without consuming a path segment.
 * - Leaf types (string / number / literal / ...) return `[]` when there's
 *   still path left, so a caller that asked for `firstName.middle` against
 *   a string schema gets an empty resolution rather than a wrong schema.
 *
 * `maxRecursionDepth` caps descent through `z.lazy()`. Once the walker has
 * crossed `maxRecursionDepth + 1` lazy boundaries it returns `[]`, so
 * writes at recursive paths deeper than the cap fall back to a permissive
 * type gate.
 *
 * Mirrors v4's `walkSegments` (`zod-v4/path-walker.ts`) — same kind-switch
 * structure, same Own-property check on objects, same lazy depth gate, so
 * `getSchemasAtPath` / `getSlimPrimitiveTypesAtPath` / `validateAtPath`
 * resolve identically across both adapters.
 */
function getNestedZodSchemasAtPath(
  schema: z.ZodTypeAny,
  segments: readonly (string | number)[],
  maxRecursionDepth: number
): z.ZodTypeAny[] {
  if (segments.length === 0) return [schema]
  return walkPathSegments(schema, segments.map(String), V3_INTROSPECTOR, maxRecursionDepth, 0)
}

/**
 * Peel `.optional()` / `.nullable()` wrappers off a leaf schema ONLY
 * when the inner type is structurally fillable (object, array, tuple,
 * record, discriminated/plain union — or itself a peelable wrapper
 * that resolves to one of those). For primitive inner (ZodString,
 * ZodNumber, etc.), the wrapper IS the meaningful schema:
 * `.optional()` means "absent is allowed" → undefined; peeling to
 * the inner string default `''` would let mergeStructural overwrite
 * the optional's honest "absent" with a non-empty marker when filling
 * sibling keys at the parent object. See v4's matching helper for
 * the long-form rationale.
 */
function unwrapStructuralLeafV3(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema
  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    if (!(isZodSchemaType(current, 'ZodOptional') || isZodSchemaType(current, 'ZodNullable'))) {
      break
    }
    const inner = unwrapInner(current)
    if (!inner) return current
    if (!isStructuralV3Kind(inner)) break
    current = inner
  }
  return current
}

/**
 * v3 mirror of v4's `isStructuralKind` — kinds for which the inner is
 * recursable by mergeStructural. Anything else is a primitive leaf
 * where the wrapper carries the meaningful default semantic.
 */
function isStructuralV3Kind(schema: z.ZodTypeAny): boolean {
  return (
    isZodSchemaType(schema, 'ZodObject') ||
    isZodSchemaType(schema, 'ZodArray') ||
    isZodSchemaType(schema, 'ZodRecord') ||
    isZodSchemaType(schema, 'ZodTuple') ||
    isZodSchemaType(schema, 'ZodUnion') ||
    isZodSchemaType(schema, 'ZodDiscriminatedUnion') ||
    // Wrappers that themselves resolve to a structural type — keep
    // peeling at the next iteration.
    isZodSchemaType(schema, 'ZodOptional') ||
    isZodSchemaType(schema, 'ZodNullable') ||
    isZodSchemaType(schema, 'ZodDefault') ||
    isZodSchemaType(schema, 'ZodEffects') ||
    // Newer transparent wrappers (v3.23+). Each wraps a single inner
    // schema with no structural impact — `peelV3Wrappers` resolves them.
    isZodSchemaType(schema, 'ZodPipeline') ||
    isZodSchemaType(schema, 'ZodReadonly') ||
    isZodSchemaType(schema, 'ZodBranded')
  )
}

/**
 * Peel transparent wrappers off a v3 schema to reach the structural
 * "core" — used by the schema-aware path walker that powers
 * `getDefaultAtPath`. Mirrors v4's `unwrapInner` chain so `getDefaultAtPath`
 * resolves the same sub-schemas across both adapters for shapes like
 * `{ profile: z.object({...}).optional() }`.
 *
 * Bounded by `MAX_UNWRAP_STEPS` as a cycle/runaway guard. Returns the
 * original schema unchanged if it has no peelable wrapper.
 *
 * Peeled wrappers (each kind reads through its matching introspect
 * accessor — see `./introspect.ts`):
 *   - `ZodOptional` / `ZodNullable` / `ZodDefault` / `ZodReadonly` —
 *     `unwrapInner`
 *   - `ZodEffects` — `unwrapEffectsSource` (structural source)
 *   - `ZodPipeline` — `unwrapPipeIn` (input shape; consumers see
 *     structural form)
 *   - `ZodBranded` — `unwrapBranded`
 *
 * `ZodCatch` is intentionally NOT peeled here — its presence carries
 * load-bearing semantic (the caught fallback), and `unwrapDefault`
 * reads it directly. See A3 fix.
 */
function peelV3Wrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema
  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    if (
      isZodSchemaType(current, 'ZodOptional') ||
      isZodSchemaType(current, 'ZodNullable') ||
      isZodSchemaType(current, 'ZodDefault') ||
      isZodSchemaType(current, 'ZodReadonly')
    ) {
      const inner = unwrapInner(current)
      if (!inner) return current
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodEffects')) {
      // v3 ZodEffects: source schema is at `_def.schema`. Prefer the
      // structural source.
      const inner = unwrapEffectsSource(current)
      if (!inner) return current
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodPipeline')) {
      // ZodPipeline transforms `in -> out`; for default extraction and
      // structural traversal, the input schema is the right anchor —
      // it's what the consumer wrote, and the output is a derived
      // shape they don't construct values for directly.
      const inner = unwrapPipeIn(current)
      if (!inner) return current
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodBranded')) {
      // ZodBranded annotates a brand at the type level; runtime is the
      // wrapped schema unchanged.
      const inner = unwrapBranded(current)
      if (!inner) return current
      current = inner
      continue
    }
    break
  }
  return current
}

/**
 * `true` if the v3 leaf schema is required — `false` if any wrapper
 * layer admits "empty" via `.optional()`, `.nullable()`, `.default(N)`,
 * or `.catch(N)`. Mirrors the v4 adapter's `isLeafRequired`.
 *
 * - `ZodOptional` / `ZodNullable` / `ZodDefault` / `ZodCatch` →
 *   directly `false`.
 * - `ZodReadonly` / `ZodPipeline` / `ZodBranded` / `ZodLazy` and
 *   `transform` / `refinement` `ZodEffects` → transparent peel and
 *   re-check inner.
 * - `z.preprocess` `ZodEffects` → opaque, treated as a required leaf:
 *   the preprocess fn can reshape input arbitrarily before the inner
 *   validates, so required-ness is undecidable. Matches v4, which
 *   desugars preprocess to a pipe whose input is a transform.
 * - `ZodUnion` / `ZodDiscriminatedUnion` → `false` if ANY branch
 *   admits empty (matches union "first-success" semantic).
 * - `ZodIntersection` → `true` if EITHER side is required (parse
 *   must satisfy both).
 * - Direct primitive / unknown kinds → `true` (required by default).
 */
function isLeafRequiredV3(schema: z.ZodTypeAny, depth = 0): boolean {
  if (depth > MAX_UNWRAP_STEPS) return true
  // Direct "schema accepts empty" wrappers and bare empty-marker leaves.
  // `z.undefined()` / `z.null()` / `z.void()` inside a union are how
  // schema authors express "this field can be absent" without a wrapper,
  // so they count as not-required. Mirrors v4's `isLeafRequired`
  // short-circuit list.
  if (
    isZodSchemaType(schema, 'ZodOptional') ||
    isZodSchemaType(schema, 'ZodNullable') ||
    isZodSchemaType(schema, 'ZodDefault') ||
    isZodSchemaType(schema, 'ZodCatch') ||
    isZodSchemaType(schema, 'ZodUndefined') ||
    isZodSchemaType(schema, 'ZodNull') ||
    isZodSchemaType(schema, 'ZodVoid')
  ) {
    return false
  }
  // Transparent wrappers — peel and re-check.
  if (isZodSchemaType(schema, 'ZodReadonly')) {
    const inner = unwrapInner(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodBranded')) {
    const inner = unwrapBranded(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodPipeline')) {
    // Use the input side: blank is a write-time concern.
    const inner = unwrapPipeIn(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodEffects')) {
    // `z.preprocess` is opaque: the fn can reshape the input before the
    // inner validates, so required-ness can't be read off the inner.
    // Treat it as a required leaf, matching v4. `transform` /
    // `refinement` effects stay transparent and peel to the source.
    if (getEffectsKind(schema) === 'preprocess') return true
    const inner = unwrapEffectsSource(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodLazy')) {
    // `z.lazy(() => inner)` is transparent for required-ness; resolve
    // and re-check the inner. Matches v4's isLeafRequired, which peels
    // lazy too. `unwrapLazy` swallows a throwing getter, and the depth
    // cap above bounds a self-referential lazy.
    const inner = unwrapLazy(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  // Union — required only if EVERY branch is required.
  if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    const options = getUnionOptions(schema)
    if (options.length === 0) return true
    return options.every((opt) => isLeafRequiredV3(opt, depth + 1))
  }
  // Intersection — required if either side rejects empty.
  if (isZodSchemaType(schema, 'ZodIntersection')) {
    const left = getIntersectionLeft(schema)
    const right = getIntersectionRight(schema)
    const leftReq = left === undefined ? true : isLeafRequiredV3(left, depth + 1)
    const rightReq = right === undefined ? true : isLeafRequiredV3(right, depth + 1)
    return leftReq || rightReq
  }
  // Direct primitive / unsupported leaf — required by default.
  return true
}

function unwrapToDiscriminatedUnion(
  schema: z.ZodTypeAny,
  depth = 0
): z.ZodDiscriminatedUnion<string, readonly z.ZodDiscriminatedUnionOption<string>[]> | undefined {
  // Bounded descent so a pathological lazy self-reference can't hang
  // the lookup. The recursive intersection branch also threads through
  // this cap.
  if (depth > MAX_UNWRAP_STEPS) return undefined
  let currentSchema: z.ZodTypeAny = schema

  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    // If the schema is a discriminated union, return it
    if (isZodSchemaType(currentSchema, 'ZodDiscriminatedUnion')) {
      return currentSchema
    }

    // Handle ZodDefault, ZodOptional, ZodNullable, and ZodCatch. Catch
    // is load-bearing: the consumer's `.catch(...)` fallback exists to
    // fail open to a usable variant, so the runtime must still know
    // which variant the fallback selects. Without this peel the
    // variant-aware reshape never fires on a catch-wrapped DU.
    if (
      isZodSchemaType(currentSchema, 'ZodDefault') ||
      isZodSchemaType(currentSchema, 'ZodOptional') ||
      isZodSchemaType(currentSchema, 'ZodNullable') ||
      isZodSchemaType(currentSchema, 'ZodCatch')
    ) {
      const inner = unwrapInner(currentSchema)
      if (!inner) return undefined
      currentSchema = inner
      continue
    }
    // Newer transparent wrappers — peel through to expose any
    // discriminated union that lives at the structural core.
    if (isZodSchemaType(currentSchema, 'ZodReadonly')) {
      const inner = unwrapInner(currentSchema)
      if (!inner) return undefined
      currentSchema = inner
      continue
    }
    if (isZodSchemaType(currentSchema, 'ZodBranded')) {
      const inner = unwrapBranded(currentSchema)
      if (!inner) return undefined
      currentSchema = inner
      continue
    }
    if (isZodSchemaType(currentSchema, 'ZodPipeline')) {
      const inner = unwrapPipeIn(currentSchema)
      if (!inner) return undefined
      currentSchema = inner
      continue
    }
    // ZodEffects: `.refine` / `.transform` are transparent for
    // structural traversal, so a discriminated union may live on the
    // source schema. `z.preprocess` is opaque, though — its fn can
    // reshape a write before the union sees it, so variant-aware reshape
    // through it is unsound. Bail on preprocess (matching v4, which
    // treats it as a leaf) so the runtime falls back to a plain write.
    if (isZodSchemaType(currentSchema, 'ZodEffects')) {
      if (getEffectsKind(currentSchema) === 'preprocess') return undefined
      const inner = unwrapEffectsSource(currentSchema)
      if (!inner) return undefined
      currentSchema = inner
      continue
    }
    // ZodIntersection — try each side. Intersections with a DU on
    // EXACTLY one side resolve to that side; both sides yielding
    // distinct DUs is ambiguous (the discriminator-aware reshape can't
    // pick one without arbitrary preference), so bail and let the
    // runtime fall through to a plain write. Mirrors v4's
    // intersection branch in `discriminator.ts:35`.
    if (isZodSchemaType(currentSchema, 'ZodIntersection')) {
      const left = getIntersectionLeft(currentSchema)
      const right = getIntersectionRight(currentSchema)
      const leftDU = left ? unwrapToDiscriminatedUnion(left, depth + 1) : undefined
      const rightDU = right ? unwrapToDiscriminatedUnion(right, depth + 1) : undefined
      if (leftDU !== undefined && rightDU !== undefined) {
        return leftDU === rightDU ? leftDU : undefined
      }
      return leftDU ?? rightDU
    }

    // Any other type: give up.
    return undefined
  }
  return undefined
}

/**
 * Resolve the field metadata for the schema node at `path` against
 * the user's ORIGINAL schema (not the stripped / slim derivative —
 * stripping creates new schema instances which would lose registry
 * entries keyed by reference identity). Reads the WeakMap-backed
 * `fieldMeta` shim and applies the same precedence rules as the v4
 * adapter:
 *
 *   - label: registry → humanize(lastSegment)
 *   - description: registry → schema.description (.describe()) → undefined
 *   - placeholder: registry → undefined
 *   - meta: registry payload (frozen) — empty object when absent
 *
 * For schemas registered at multiple paths (shared instance — e.g.
 * `fieldMeta.add(addr, A); fieldMeta.add(addr, B); z.object({a: addr, b: addr})`),
 * consults a per-rootSchema path → payload map (`getPathMetaMapV3`)
 * built by walking the schema tree once, counting per-schema visits,
 * and pairing them with the registration list in declaration order.
 * Falls back to the schema-keyed registry for paths the walker can't
 * statically enumerate (dynamic discriminated-union sub-paths,
 * record-value paths beyond the canonical '*' slot). Mirrors v4's
 * `walkForMeta` / `getPathMetaMap` / `consumePayload`
 * (`adapter.ts:773-989`).
 */
// Peel every transparent wrapper around a schema to expose its
// structural inner — Optional / Nullable / Default / Readonly / Catch
// (catch matters here so registrations on the inner under `.catch(...)`
// still match) plus Effects / Pipeline / Branded / Lazy. More
// aggressive than `peelV3Wrappers` which preserves catch for the
// `unwrapDefault` direct read; the metadata walker needs the
// structural shape regardless of the catch wrapper. Bounded iteration
// as a runaway guard for pathological wrappers.
function peelAllV3Wrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema
  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    let inner: z.ZodTypeAny | undefined
    if (
      isZodSchemaType(current, 'ZodOptional') ||
      isZodSchemaType(current, 'ZodNullable') ||
      isZodSchemaType(current, 'ZodDefault') ||
      isZodSchemaType(current, 'ZodReadonly') ||
      isZodSchemaType(current, 'ZodCatch')
    ) {
      inner = unwrapInner(current)
    } else if (isZodSchemaType(current, 'ZodEffects')) {
      inner = unwrapEffectsSource(current)
    } else if (isZodSchemaType(current, 'ZodPipeline')) {
      inner = unwrapPipeIn(current)
    } else if (isZodSchemaType(current, 'ZodBranded')) {
      inner = unwrapBranded(current)
    } else if (isZodSchemaType(current, 'ZodLazy')) {
      try {
        inner = unwrapLazy(current)
      } catch {
        return current
      }
    } else {
      return current
    }
    if (!inner) return current
    current = inner
  }
  return current
}

function getDefaultValuesFromZodSchema<
  FormSchema extends z.ZodSchema,
  Form extends z.infer<FormSchema>,
>(formSchema: FormSchema, useDefaultSchemaValues: boolean): Form {
  // Thin wrapper around the shared `deriveDefaultWalk` core walker;
  // v3 and v4 dispatch through the same body via their respective
  // `SchemaIntrospector` instance. See `core/walk-derive-default.ts`
  // for the per-kind dispatch rules and the `peelEmbeddedDefault`
  // chain-walk that previously lived here as `unwrapDefault`.
  //
  // `maxRecursionDepth` is the historical v3 cap (64); the v3
  // adapter doesn't thread the consumer-supplied cap into this
  // call site — every existing v3 test passes against the embedded
  // 64-cap so the dedup preserves the prior behavior.
  return deriveDefaultWalk(formSchema, useDefaultSchemaValues, V3_INTROSPECTOR, 64) as Form
}

function resolveFieldMetaAtPathV3(
  rootSchema: z.ZodSchema,
  path: Path,
  maxRecursionDepth: number
): ResolvedFieldMeta {
  const lastSegment = path.length === 0 ? '' : (path[path.length - 1] as string | number)
  const target =
    path.length === 0
      ? (rootSchema as z.ZodTypeAny)
      : getNestedZodSchemasAtPath(rootSchema, path, maxRecursionDepth)[0]
  if (target === undefined) {
    return {
      label: humanize(lastSegment),
      description: undefined,
      placeholder: undefined,
      meta: Object.freeze({}),
    }
  }
  // Path-keyed payload map (built once per rootSchema) disambiguates
  // shared schemas registered at multiple paths. Falls back to the
  // schema-keyed registry for paths not visited by the walker. The
  // walk itself lives behind the store's builder slot — installed by
  // the registration surfaces (`withMeta` / `fieldMeta.add`), absent
  // (and the map with it) when the consumer never registers metadata.
  const pathMap = buildFieldMetaPathMap(rootSchema as z.ZodTypeAny, {
    intro: V3_INTROSPECTOR,
    peelAllWrappers: peelAllV3Wrappers,
    getFieldMetaList: getFieldMetaListForSchema,
  })
  const pathKey = canonicalizePath(path).key
  const peeled = peelV3Wrappers(target)
  const payload =
    pathMap?.get(pathKey) ??
    getFieldMetaForSchema(target) ??
    (peeled !== target ? getFieldMetaForSchema(peeled) : undefined)
  const targetDescription =
    typeof (target as { description?: unknown }).description === 'string'
      ? ((target as { description?: string }).description as string)
      : undefined
  const peeledDescription =
    peeled !== target && typeof (peeled as { description?: unknown }).description === 'string'
      ? ((peeled as { description?: string }).description as string)
      : undefined
  const schemaDescription = targetDescription ?? peeledDescription
  return {
    label: payload?.label ?? humanize(lastSegment),
    description: payload?.description ?? schemaDescription ?? undefined,
    placeholder: payload?.placeholder ?? undefined,
    meta: Object.freeze({ ...(payload ?? {}) }),
  }
}

/**
 * v3's construction-time `getDefaultValues` flow. Builds the derived
 * default seed via `getDefaultValuesFromZodSchema`, merges
 * constraints, then runs:
 *
 *   - Strict mode (default): parse against the REAL schema so refines
 *     and container / leaf checks surface at construction. If a sync
 *     parse throws because of an async refine, strip every ZodEffects
 *     and re-parse (v3 cannot tell sync from async refines without
 *     invoking the wrapper). If a user refine throws raw, fall back
 *     to mount-clean success.
 *
 *   - Lax mode: the shared DU-aware structural fix walk
 *     (`core/walk-fix-structural.ts`, sign-off 7) — primitive /
 *     structural mismatches get patched with the node's derived
 *     default; refinement-level state is invisible to the walk so the
 *     user's defaultValues are preserved verbatim and no user fn runs
 *     at construction.
 *
 * Both arms compose with the shared core `mergeDeep` (NOT lodash merge)
 * so arrays replace wholesale and explicit `null` / `undefined`
 * overrides survive. v3 and v4 now call the same helper.
 */
function runStrictGetDefaultsV3<Form>(
  rootSchema: z.ZodSchema,
  config: GetDefaultValuesConfig<Form>,
  maxRecursionDepth: number
): SchemaDefaultsResult<Form> {
  const defaultValuesWithoutConstraints = getDefaultValuesFromZodSchema(
    rootSchema,
    config.useDefaultSchemaValues
  )

  // Shared core `mergeDeep` (NOT lodash `merge`) so arrays replace
  // wholesale and explicit `null`/`undefined` overrides survive; v3
  // and v4 call the same helper. A primitive base yields the override
  // wholesale (or the base when no constraints were supplied), which
  // also covers the old slim-validated primitive-root branch — the
  // structural fix walk below patches any mismatch the replacement
  // introduces.
  // Structural completeness BEFORE the mode split, matching v4, which
  // applies the same walk inside `getDefaultValuesFromZodSchema` and so
  // covers both modes. v3 applied it only in the lax tail, which meant
  // STRICT mode — the default — never ran it: a constraint supplying a
  // primitive where the schema declares an object stayed a primitive,
  // and the strict parse below then reported an error about a shape the
  // adapter was supposed to have repaired. The parity suites missed it
  // because 19 of their 27 cases set `strict: false`.
  //
  // Nothing parses in the walk, so user refines and transforms still do
  // not fire at construction and the strict pass below remains the only
  // thing that enforces them.
  //
  // Skipped entirely when there are no constraints: the walk repairs
  // what the constraints broke, and the derivation above is already a
  // fixed point of it. Same branch as v4's, pinned by the same corpus
  // in `test/adapters/structural-walk-is-constraint-repair.test.ts`.
  const rawDefaultValues =
    config.constraints === undefined
      ? defaultValuesWithoutConstraints
      : fixStructuralDefaults<Form, z.ZodTypeAny>(
          rootSchema as z.ZodTypeAny,
          mergeDeep(defaultValuesWithoutConstraints, config.constraints),
          config.useDefaultSchemaValues,
          maxRecursionDepth,
          {
            intro: V3_INTROSPECTOR,
            slimPrimitivesOf: (s: z.ZodTypeAny) => slimPrimitivesV3(s),
            deriveDefault: (s: z.ZodTypeAny, useDefault: boolean) =>
              getDefaultValuesFromZodSchema(s as z.ZodSchema, useDefault),
            unwrapToDiscriminatedUnion: (s: z.ZodTypeAny) => unwrapToDiscriminatedUnion(s),
          }
        ).data

  // Strict-mode path: parse against the REAL schema so refines and
  // container / leaf checks (`.min(n)` / `.max(n)` / `.email()` etc.)
  // seed at construction. Mirrors v4 (`zod-v4/adapter.ts`'s strict
  // arm). The lax-mode validate-then-fix loop below stays untouched
  // — it's the right shape for "seed a permissive partial state at
  // mount."
  if ((config.strict ?? true) !== false) {
    // Async transforms can't be stripped: the transform's output shape
    // is load-bearing for the inner schema's input. Skip the strict
    // pass entirely; the post-mount async pass picks up verdicts via
    // `safeParseAsync`.
    if (containsAsyncTransform(rootSchema)) {
      return {
        data: rawDefaultValues as Form,
        errors: undefined,
        success: true,
      }
    }

    try {
      // Through `syncSafe`: this is the parse that discovers an async
      // refinement by running it, so it is the one that would leak the
      // predicate's rejection into the host app.
      const strictResult = syncSafe(rootSchema).safeParse(rawDefaultValues)
      if (strictResult.success) {
        // Storage holds the pre-transform `z.input` view, so we return
        // the raw defaults (already filled by
        // `getDefaultValuesFromZodSchema`) rather than
        // `strictResult.data` (the post-transform `z.output`). For
        // schemas without `.transform()` the two coincide; for schemas
        // with one the storage stays the honest input view that
        // `form.values` reflects.
        return {
          data: rawDefaultValues as Form,
          errors: undefined,
          success: true,
        }
      }
      return {
        data: rawDefaultValues as Form,
        errors: zodIssuesToValidationErrors(strictResult.error.issues),
        success: false,
      }
    } catch {
      // A throw here is either v3's async-detect (a standard `Error`
      // reading "Async refinement encountered during synchronous
      // parse") or a consumer validator throwing outright. Both mount
      // clean and leave the verdict to the post-mount async pass, which
      // was always the source of truth for either case.
      //
      // The async-detect arm used to strip every `ZodEffects` off the
      // schema and re-parse the copy, so the sync checks beside an async
      // refine could still seed at construction. That walker is gone —
      // v4's equivalent was deleted first and this is what keeps the two
      // adapters saying the same thing about the same schema, which is
      // the rule that matters more than the seed did.
      // Non-async throw at construction (user validator threw a raw
      // exception): defensive floor, matches v4's catch.
      return {
        data: rawDefaultValues as Form,
        errors: undefined,
        success: true,
      }
    }
  }

  // Lax mode: the structural fix already ran above, so there is nothing
  // left to do but hand back the completed shape. Nothing parsed, so
  // user refines and transforms did not fire at construction, which is
  // the whole point of the lax arm.
  return {
    data: rawDefaultValues as Form,
    errors: undefined,
    success: true,
  }
}
