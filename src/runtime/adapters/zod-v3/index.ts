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

// Shared cap for every wrapper-peeling helper here. A pathological
// schema, a deep `.refine()` chain or a self-referential lazy loop,
// would otherwise stack-overflow or hang. 64 is generous for a real form
// schema, and past it the helpers bail rather than crash.
const MAX_UNWRAP_STEPS = 64

import { __DEV__ } from '../../core/dev'
import { AttaformError } from '../../core/errors'
import type { TypeWithNullableDynamicKeys } from './types-zod'
// `ZodTypeWithInnerType` lives in `types-zod.ts` and is re-exported from
// `attaform/zod-v3` as a narrow accessor type for anyone writing
// adapter-shaped code. The adapter itself reads `_def` only through
// `introspect.ts`.
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
 * Wrap a Zod v3 form-root schema, a `ZodObject` or `ZodRecord`, in an
 * `AbstractSchema` factory.
 *
 * `useForm` from `attaform/zod-v3` does this for you, so reach for it
 * only to use the adapter outside `useForm`. Throws if the schema is not
 * a supported form root.
 */
export function zodAdapter<
  FormSchema extends z.ZodSchema,
  Form extends z.input<FormSchema>,
  GetValueFormType extends TypeWithNullableDynamicKeys<FormSchema>,
>(
  zodSchema: FormSchema
): (formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, GetValueFormType> {
  // A form root has to hold keys, a form being a set of addressable
  // fields. This is the ONE place the adapter refuses a schema, and it
  // refuses on the absence of that single property rather than on a list
  // of kinds; every kind stays welcome under a key. v4's
  // `assertKeyedRoot` is the same check, down to the AF15 code.
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

  // Caps `z.lazy(...)` descent in `getNestedZodSchemasAtPath`: once the
  // walker has crossed `maxRecursionDepth + 1` lazy boundaries it returns
  // `[]`, so a write at a recursive path deeper than the cap falls back
  // to a permissive type gate. Same contract as v4's path walker.
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

/**
 * Build the v3 `AbstractSchemaServices` instance. The services are
 * stateless: every method takes the schema it acts on plus the
 * factory-supplied `formKey` and `maxRecursionDepth`. Generic in `Form`
 * and `GetValueFormType` so `runGetDefaults` and `makeSubSchema`
 * propagate the form shape.
 */
function buildV3Services<Form extends GenericForm, GetValueFormType extends GenericForm>(
  maxRecursionDepth: number
): AbstractSchemaServices<z.ZodTypeAny, Form, GetValueFormType> {
  // v3 files a map entry's issue at `[entryIndex, 'key' | 'value']` and
  // a set member's at its index, neither of which is a path the runtime
  // addresses; v4 files both where Attaform reads them. The rewrite
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
    // The shared path walker peels wrappers and effects inline, so the
    // slim and unstripped walks coincide and the root needs no slim
    // projection of its own. Same aliasing v4 has.
    getNestedSchemasInSlimMode: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodSchema, path, maxRecursionDepth),
    slimPrimitivesOf: (schema, _maxRecursionDepth) => slimPrimitivesV3(schema),
    deriveDefault: (schema, useDefault) =>
      getDefaultValuesFromZodSchema(schema as z.ZodSchema, useDefault),
    runGetDefaults: (schema, config, maxRecursionDepth) =>
      runGetDefaultsV3<Form>(schema as z.ZodSchema, config, maxRecursionDepth),
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
    // A `getSchemasAtPath` consumer may probe any method on the result,
    // so a sub-schema comes back as a full recursive AbstractSchema: the
    // factory call rebuilds the whole surface against it, with its own
    // per-form caches.
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
      // `ValidationError.path` is `(string | number)[]` publicly, and
      // v3's `issue.path` matches in the standard case, but a custom
      // check calling `ctx.addIssue({ path: [...] })` can smuggle a
      // Symbol through. Coerce to keep the promise. v4 does the same
      // here.
      //
      // Adapter-side paths stay schema-RELATIVE: the validation pipeline
      // in `core/create-form-store.ts` prepends the parent path to
      // absolutise, then routes form-level entries, those whose absolute
      // path is empty, to the empty-string bucket at storage time.
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

/**
 * Walk a structured path through a Zod v3 schema tree and return the
 * subschema or subschemas living at that path. It takes a canonical
 * `Segment[]`, so a field literally named `"user.email"` is one segment
 * and cannot collide with the sibling pair `['user', 'email']`.
 *
 * - A union returns every candidate, and the caller tries each.
 * - A discriminated union keeps only the options whose shape holds the
 *   next segment, so a path into `{ status: 'error', message: string }`
 *   resolves to the 'error' branch alone.
 * - A wrapper (optional / nullable / default / readonly / catch /
 *   effects / pipeline / branded) is transparent: the walker descends
 *   without consuming a path segment.
 * - A leaf with path still left returns `[]`, so asking for
 *   `firstName.middle` against a string yields an empty resolution
 *   rather than the wrong schema.
 *
 * Peeling happens only while DESCENDING. Once the loop exits, the schema
 * at the target segment comes back with its own wrapper intact, because
 * that wrapper is what carries parse-time meaning: `.optional()` admits
 * `undefined`, `.default(x)` substitutes, `.refine(...)` runs its
 * predicate. An empty path returns the root unchanged, so a whole-form
 * `validateAtPath` keeps the root's refine.
 *
 * `maxRecursionDepth` caps descent through `z.lazy()`; past
 * `maxRecursionDepth + 1` lazy boundaries the walk returns `[]` and a
 * write there falls back to a permissive type gate. v4's `walkSegments`
 * in `zod-v4/path-walker.ts` has the same kind switch, own-property
 * check and depth gate, so both adapters resolve a path identically.
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
 * Peel `.optional()` and `.nullable()` off a leaf ONLY when the inner
 * type is structurally fillable: an object, array, tuple, record or
 * union, or a peelable wrapper resolving to one.
 *
 * Over a primitive inner the wrapper IS the meaningful schema:
 * `.optional()` says absence is allowed, so it means `undefined`, and
 * peeling to the inner string's `''` would let `mergeStructural`
 * overwrite that honest absence with a non-empty marker while filling
 * sibling keys on the parent object. v4's matching helper carries the
 * long-form reasoning.
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
 * The kinds whose inner `mergeStructural` can recurse into. Anything else
 * is a primitive leaf, where the wrapper carries the default semantic.
 * v4's `isStructuralKind` is the same list.
 */
function isStructuralV3Kind(schema: z.ZodTypeAny): boolean {
  return (
    isZodSchemaType(schema, 'ZodObject') ||
    isZodSchemaType(schema, 'ZodArray') ||
    isZodSchemaType(schema, 'ZodRecord') ||
    isZodSchemaType(schema, 'ZodTuple') ||
    isZodSchemaType(schema, 'ZodUnion') ||
    isZodSchemaType(schema, 'ZodDiscriminatedUnion') ||
    // Wrappers that themselves resolve to a structural type; keep
    // peeling next iteration.
    isZodSchemaType(schema, 'ZodOptional') ||
    isZodSchemaType(schema, 'ZodNullable') ||
    isZodSchemaType(schema, 'ZodDefault') ||
    isZodSchemaType(schema, 'ZodEffects') ||
    // Newer transparent wrappers (v3.23+), each wrapping one inner
    // schema with no structural impact. `peelV3Wrappers` resolves them.
    isZodSchemaType(schema, 'ZodPipeline') ||
    isZodSchemaType(schema, 'ZodReadonly') ||
    isZodSchemaType(schema, 'ZodBranded')
  )
}

/**
 * Peel transparent wrappers off a v3 schema to reach its structural
 * core, for the schema-aware path walker behind `getDefaultAtPath`. v4's
 * `unwrapInner` chain peels the same set, so both adapters resolve the
 * same sub-schema for a shape like `{ profile: z.object({...}).optional()
 * }`. A schema with no peelable wrapper comes back unchanged, and
 * `MAX_UNWRAP_STEPS` bounds a runaway.
 *
 * Each kind reads through its accessor in `./introspect.ts`:
 * `unwrapInner` for `ZodOptional` / `ZodNullable` / `ZodDefault` /
 * `ZodReadonly`, `unwrapEffectsSource` for `ZodEffects`, `unwrapPipeIn`
 * for `ZodPipeline` (the input shape, which is the structural form a
 * consumer sees), and `unwrapBranded` for `ZodBranded`.
 *
 * `ZodCatch` is deliberately NOT peeled: the caught fallback is
 * load-bearing, and `unwrapDefault` reads it directly.
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
      // The source schema is at `_def.schema`; prefer it.
      const inner = unwrapEffectsSource(current)
      if (!inner) return current
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodPipeline')) {
      // A pipeline goes `in -> out`, and for default extraction and
      // structural traversal the INPUT is the anchor: it is what the
      // consumer wrote, the output being a derived shape they never
      // construct values for.
      const inner = unwrapPipeIn(current)
      if (!inner) return current
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodBranded')) {
      // A brand is type-level only; at runtime it is the wrapped schema.
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
 * `true` when the v3 leaf is required, `false` when any wrapper layer
 * admits empty through `.optional()`, `.nullable()`, `.default(N)` or
 * `.catch(N)`. The v4 adapter's `isLeafRequired` answers the same way.
 *
 * - `ZodOptional` / `ZodNullable` / `ZodDefault` / `ZodCatch`: `false`.
 * - `ZodReadonly` / `ZodPipeline` / `ZodBranded` / `ZodLazy`, and a
 *   transform or refinement `ZodEffects`: peel and re-check the inner.
 * - A `z.preprocess` `ZodEffects` is opaque and counts as required: its
 *   fn can reshape the input arbitrarily before the inner validates, so
 *   required-ness is undecidable. v4 agrees, desugaring preprocess to a
 *   pipe whose input is a transform.
 * - A union is `false` if ANY branch admits empty, matching
 *   first-success semantics.
 * - An intersection is `true` if EITHER side is required, the parse
 *   having to satisfy both.
 * - Anything else is required.
 */
function isLeafRequiredV3(schema: z.ZodTypeAny, depth = 0): boolean {
  if (depth > MAX_UNWRAP_STEPS) return true
  // The wrappers that accept empty outright, plus the bare empty-marker
  // leaves: `z.undefined()`, `z.null()` and `z.void()` inside a union are
  // how an author says a field may be absent without reaching for a
  // wrapper. v4 short-circuits on the same list.
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
  // Transparent wrappers: peel and re-check.
  if (isZodSchemaType(schema, 'ZodReadonly')) {
    const inner = unwrapInner(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodBranded')) {
    const inner = unwrapBranded(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodPipeline')) {
    // The input side, blank being a write-time concern.
    const inner = unwrapPipeIn(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodEffects')) {
    // Opaque: the fn can reshape the input before the inner validates,
    // so required-ness cannot be read off the inner. Required leaf, as in
    // v4. Transform and refinement effects stay transparent.
    if (getEffectsKind(schema) === 'preprocess') return true
    const inner = unwrapEffectsSource(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  if (isZodSchemaType(schema, 'ZodLazy')) {
    // Transparent for required-ness, so resolve and re-check the inner;
    // v4 peels lazy too. `unwrapLazy` swallows a throwing getter, and the
    // depth cap above bounds a self-referential lazy.
    const inner = unwrapLazy(schema)
    return inner === undefined ? true : isLeafRequiredV3(inner, depth + 1)
  }
  // Required only if EVERY branch is.
  if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    const options = getUnionOptions(schema)
    if (options.length === 0) return true
    return options.every((opt) => isLeafRequiredV3(opt, depth + 1))
  }
  // Required if either side rejects empty.
  if (isZodSchemaType(schema, 'ZodIntersection')) {
    const left = getIntersectionLeft(schema)
    const right = getIntersectionRight(schema)
    const leftReq = left === undefined ? true : isLeafRequiredV3(left, depth + 1)
    const rightReq = right === undefined ? true : isLeafRequiredV3(right, depth + 1)
    return leftReq || rightReq
  }
  // Primitive or unsupported leaf: required.
  return true
}

function unwrapToDiscriminatedUnion(
  schema: z.ZodTypeAny,
  depth = 0
): z.ZodDiscriminatedUnion<string, readonly z.ZodDiscriminatedUnionOption<string>[]> | undefined {
  // Bounded so a pathological lazy self-reference cannot hang the
  // lookup; the recursive intersection branch threads through it too.
  if (depth > MAX_UNWRAP_STEPS) return undefined
  let currentSchema: z.ZodTypeAny = schema

  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    // If the schema is a discriminated union, return it
    if (isZodSchemaType(currentSchema, 'ZodDiscriminatedUnion')) {
      return currentSchema
    }

    // Catch is load-bearing here: a `.catch(...)` fallback exists to
    // fail OPEN to a usable variant, so the runtime still has to know
    // which variant it selects. Without this peel the variant-aware
    // reshape never fires on a catch-wrapped DU.
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
    // Newer transparent wrappers; peel through to any discriminated
    // union at the structural core.
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
    // `.refine` and `.transform` are transparent for structural
    // traversal, so a discriminated union may sit on the source schema.
    // `z.preprocess` is not: its fn can reshape a write before the union
    // sees it, which makes a variant-aware reshape through it unsound.
    // Bail, as v4 does, and let the runtime fall back to a plain write.
    if (isZodSchemaType(currentSchema, 'ZodEffects')) {
      if (getEffectsKind(currentSchema) === 'preprocess') return undefined
      const inner = unwrapEffectsSource(currentSchema)
      if (!inner) return undefined
      currentSchema = inner
      continue
    }
    // Try each side. A DU on EXACTLY one side resolves to that side;
    // distinct DUs on both is ambiguous, the reshape having no
    // non-arbitrary way to pick, so bail to a plain write. v4's
    // intersection branch in `zod-v4/discriminator.ts` agrees.
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

    // Anything else: give up.
    return undefined
  }
  return undefined
}

/**
 * Peel EVERY transparent wrapper to expose a schema's structural inner:
 * Optional, Nullable, Default, Readonly and Catch, plus Effects,
 * Pipeline, Branded and Lazy. More aggressive than `peelV3Wrappers`,
 * which keeps catch for `unwrapDefault`'s direct read; the metadata
 * walker wants the structural shape whatever the catch wrapper says, so
 * a registration on the inner under `.catch(...)` still matches. The
 * iteration is bounded against a pathological wrapper chain.
 */
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
  // v3 and v4 dispatch through one body, each supplying its own
  // `SchemaIntrospector`; `core/walk-derive-default.ts` holds the
  // per-kind rules and the `peelEmbeddedDefault` chain walk. The 64 is
  // the v3 lazy-descent cap, fixed here rather than threaded, and the v3
  // suites pin it.
  return deriveDefaultWalk(formSchema, useDefaultSchemaValues, V3_INTROSPECTOR, 64) as Form
}

/**
 * Resolve the field metadata at `path` against the user's ORIGINAL
 * schema, never the stripped or slim derivative: stripping builds new
 * schema instances, and the registry is keyed on reference identity, so
 * the entries would be lost. Reads the WeakMap-backed `fieldMeta` shim
 * under the v4 adapter's precedence:
 *
 *   - label: registry, else `humanize(lastSegment)`
 *   - description: registry, else `.describe()`, else undefined
 *   - placeholder: registry, else undefined
 *   - meta: the frozen registry payload, `{}` when absent
 *
 * One schema instance registered at several paths, as in
 * `fieldMeta.add(addr, A); fieldMeta.add(addr, B); z.object({a: addr, b:
 * addr})`, goes through a per-rootSchema path-to-payload map
 * (`getPathMetaMapV3`) built by walking the tree once, counting
 * per-schema visits and pairing them with the registration list in
 * declaration order. A path the walker cannot statically enumerate, a
 * dynamic DU sub-path or a record-value path past the canonical '*'
 * slot, falls back to the schema-keyed registry. v4's `walkForMeta`,
 * `getPathMetaMap` and `consumePayload` do the same.
 */
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
  // Built once per rootSchema, and what disambiguates a shared schema
  // registered at several paths; a path the walker never visits falls
  // back to the schema-keyed registry. The walk sits behind the store's
  // builder slot, installed by `withMeta` and `fieldMeta.add`, so a
  // consumer who registers no metadata gets neither the walk nor the
  // map.
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
 * v3's construction-time `getDefaultValues` flow: derive the default seed
 * through `getDefaultValuesFromZodSchema`, merge constraints with the
 * shared `mergeDeep` (NOT lodash merge, so arrays replace wholesale and
 * an explicit `null` or `undefined` override survives), run the DU-aware
 * structural fix walk from `core/walk-fix-structural.ts`, then parse
 * against the REAL schema so refines and container or leaf checks seed at
 * construction.
 *
 * A sync parse that throws over an async refine mounts clean and leaves
 * the verdict to the post-mount async pass; v3 cannot tell a sync refine
 * from an async one without invoking the wrapper. A user refine that
 * throws raw is treated the same way.
 */
function runGetDefaultsV3<Form>(
  rootSchema: z.ZodSchema,
  config: GetDefaultValuesConfig<Form>,
  maxRecursionDepth: number
): SchemaDefaultsResult<Form> {
  const defaultValuesWithoutConstraints = getDefaultValuesFromZodSchema(
    rootSchema,
    config.useDefaultSchemaValues
  )

  // The shared `mergeDeep`, NOT lodash `merge`, so arrays replace
  // wholesale and an explicit `null` or `undefined` override survives.
  // v3 and v4 call the same helper. A primitive base yields the override
  // wholesale, or the base when no constraints were supplied, and the
  // structural fix walk below patches any mismatch that introduces.
  // Structural completeness BEFORE the parse, as v4 does inside
  // `getDefaultValuesFromZodSchema`. Without it, a constraint supplying
  // a primitive where the schema declares an object stays a primitive,
  // and the parse below reports an error about a shape the adapter was
  // supposed to have repaired.
  //
  // The walk parses nothing, so user refines and transforms still do not
  // fire at construction and the parse below stays the only thing that
  // enforces them. It is skipped when there are no constraints: it
  // repairs what constraints broke, and the derivation above is already
  // a fixed point of it. Same branch as v4's, pinned by the same corpus
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

  // Against the REAL schema, so refines and container or leaf checks
  // (`.min(n)`, `.max(n)`, `.email()`) seed at construction. v4's
  // equivalent arm in `zod-v4/adapter.ts` does the same.

  // An async transform cannot be stripped, its output shape being
  // load-bearing for the inner schema's input. Skip the construction
  // parse; the post-mount async pass picks the verdicts up through
  // `safeParseAsync`.
  if (containsAsyncTransform(rootSchema)) {
    return {
      data: rawDefaultValues as Form,
      errors: undefined,
      success: true,
    }
  }

  try {
    // Through `syncSafe`, because this is the parse that discovers an
    // async refinement by RUNNING it, and so the one that would leak the
    // predicate's rejection into the host app.
    const parseResult = syncSafe(rootSchema).safeParse(rawDefaultValues)
    if (parseResult.success) {
      // Storage holds the pre-transform `z.input` view, so return the
      // raw defaults rather than `parseResult.data`, which is the
      // post-transform `z.output`. The two coincide without a
      // `.transform()`; with one, storage stays the honest input view
      // that `form.values` reflects.
      return {
        data: rawDefaultValues as Form,
        errors: undefined,
        success: true,
      }
    }
    return {
      data: rawDefaultValues as Form,
      errors: zodIssuesToValidationErrors(parseResult.error.issues),
      success: false,
    }
  } catch {
    // A throw here is either v3's async-detect, a standard `Error`
    // reading "Async refinement encountered during synchronous parse",
    // or a consumer validator throwing outright. Both mount clean and
    // leave the verdict to the post-mount async pass, which is the
    // source of truth for either case. Neither seeds the sync checks
    // sitting beside an async refine, and v4 does not either; the two
    // adapters agreeing about one schema matters more than the seed.
    // A non-async throw, meaning a user validator threw raw. Defensive
    // floor, as in v4's catch.
    return {
      data: rawDefaultValues as Form,
      errors: undefined,
      success: true,
    }
  }
}
