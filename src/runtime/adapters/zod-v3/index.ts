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
  DefaultValuesResponse,
  FormKey,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
  ValidationError,
  SchemaFactoryOptions,
} from '../../types/types-api'
import {
  createAbstractSchema,
  type AbstractSchemaServices,
} from '../../core/abstract-schema-factory'
import { mergeDeep } from '../../core/merge-deep'
import { getAtPath, setAtPath } from '../../core/path-walker'
import { walkPathSegments } from '../../core/walk-path-segments'
import {
  deriveDefaultWalk,
  peelEmbeddedDefault,
  NO_EMBEDDED_DEFAULT,
} from '../../core/walk-derive-default'
import { humanize } from '../../core/humanize'
import { canonicalizePath, type Path } from '../../core/paths'
import { slimKindOf } from '../../core/slim-primitive-gate'
import { getFieldMeta, getFieldMetaList } from './field-meta'
import { cloneSchemaDeep } from './clone-schema'
import {
  rebuildArray,
  rebuildDiscriminatedUnion,
  rebuildIntersection,
  rebuildLazy,
  rebuildObject,
  rebuildRecord,
  rebuildSet,
  rebuildTuple,
  rebuildUnion,
  rebuildWrapperInner,
  stripLeafChecks,
} from './rebuild-schema'
import type { GenericForm } from '../../types/types-core'

// The adapter exchanges dotted-string paths with core at the
// AbstractSchema boundary (`validateAtPath`, `getSchemasAtPath`).
// A future revision may migrate the adapter to structured `Path`
// (Segment[]) without changing the public surface.
const PATH_SEPARATOR = '.'

// Shared cap for every wrapper-peeling / unwrap helper in this file.
// Pathological schemas (deep `.refine()` chains, self-referential lazy
// loops) would otherwise stack-overflow or hang. 64 is generous for any
// realistic form schema; past it we bail conservatively rather than
// crash.
const MAX_UNWRAP_STEPS = 64

function isPrimitive(input: unknown): boolean {
  const type = typeof input
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'bigint' ||
    type === 'undefined'
  )
    return true
  return input === null
}

// Probe whether a primitive constraint passes the slim schema. Wrapped
// in try/catch because strict mode keeps refinements on the slim schema,
// and `safeParse` throws synchronously if any refine on the root is
// async.
function constraintsAreSlimValid(slimSchema: z.ZodSchema, constraints: unknown): boolean {
  try {
    return slimSchema.safeParse(constraints).success
  } catch {
    return false
  }
}

import { __DEV__ } from '../../core/dev'
import type { TypeWithNullableDynamicKeys } from './types-zod'
// `ZodTypeWithInnerType` lives in types-zod.ts and is re-exported from
// `attaform/zod-v3` as a narrow accessor type for custom-adapter
// authors. Phase 7's introspect chokepoint means the v3 adapter no
// longer reads `_def` directly inline; the public type stays available
// for downstream consumers writing adapter-shaped code.
import { assertSupportedKinds } from './assert-supported'
import { isZodSchemaType } from './helpers'
import {
  containsAsyncTransform,
  getArrayElement,
  getDiscriminatedOptions,
  getDiscriminator,
  getEffectsKind,
  getIntersectionLeft,
  getIntersectionRight,
  getLiteralValue,
  getObjectShape,
  getRecordKeyType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getTypeName,
  getUnionOptions,
  hasChecks,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
} from './introspect'
import { slimPrimitivesV3 } from './slim-primitives'
import { stripAsyncChecks } from './strip-async'
import { getFieldMetaPathMap } from '../../core/walk-field-meta'
import { V3_INTROSPECTOR } from './walker-introspector'

let warnedZodCodeMissing = false

/**
 * Wrap a Zod v3 `ZodObject` schema in an `AbstractSchema` factory.
 *
 * Most consumers never call this directly — `useForm` from
 * `attaform/zod-v3` does the wrapping automatically. Reach
 * for it only when integrating with a custom code path that needs
 * the adapter outside of `useForm`.
 *
 * Throws if the underlying schema isn't a `ZodObject`.
 */
export function zodAdapter<
  FormSchema extends z.ZodSchema,
  Form extends z.input<FormSchema>,
  GetValueFormType extends TypeWithNullableDynamicKeys<FormSchema>,
>(
  zodSchema: FormSchema
): (formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, GetValueFormType> {
  // Walk the original schema (not the stripped one) so the assert
  // descends through user-declared wrappers (`.optional()`,
  // `.nullable()`, `.default()`) before checking each leaf. Throws
  // for kinds we can't represent — `z.promise`, `z.function`,
  // `z.map`, `z.symbol` — and for self-referencing `z.lazy(...)`.
  assertSupportedKinds(zodSchema)
  const [_strippedRoot] = stripRootSchema(zodSchema, {
    stripDefaultValues: true,
    stripNullable: true,
    stripOptional: true,
    stripZodEffects: true,
    stripZodRefinements: true,
  })
  if (!isZodSchemaType(_strippedRoot, 'ZodObject')) {
    const name = getTypeName(_strippedRoot)
    throw new Error(`ZodAdapter: expected ZodObject, got ${name}`)
  }

  // `options.maxRecursionDepth` caps `z.lazy(...)` descent in
  // `getNestedZodSchemasAtPath` — once the walker has crossed
  // `maxRecursionDepth + 1` lazy boundaries it returns `[]`, so writes
  // at recursive paths deeper than the cap fall back to a permissive
  // type gate. Matches the v4 adapter's path-walker contract.
  return (formKey: FormKey, options: SchemaFactoryOptions) =>
    createAbstractSchema<z.ZodTypeAny, Form, GetValueFormType>(
      zodSchema,
      V3_INTROSPECTOR,
      buildV3Services<Form, GetValueFormType>(),
      formKey,
      options
    )
}

/**
 * Build the v3 `AbstractSchemaServices` instance. Services are stateless
 * — every method receives the schema it acts on plus the factory-supplied
 * `formKey` / `maxRecursionDepth`. Generic in `Form` / `GetValueFormType`
 * so the typed methods (`runStrictGetDefaults` / `makeSubSchema`)
 * propagate the form shape correctly.
 */
// Lazy fingerprint: the only consumers are opt-in async features
// (multi-tab channel name, persistence storage key) plus a dev-only
// mismatch warning, so the structural walk + its `canonicalStringify`
// helper load on demand off the eager `useForm` path instead of being
// anchored eager by a static import.
async function lazyFingerprint(schema: z.ZodSchema): Promise<string> {
  const { fingerprintZodSchema } = await import('./fingerprint')
  return fingerprintZodSchema(schema)
}

function buildV3Services<
  Form extends GenericForm,
  GetValueFormType extends GenericForm,
>(): AbstractSchemaServices<z.ZodTypeAny, Form, GetValueFormType> {
  return {
    fingerprint: (schema) => lazyFingerprint(schema as z.ZodSchema),
    getNestedSchemasAtPath: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodSchema, path, maxRecursionDepth),
    // v3 pre-strips refinements / defaults / wrappers off the root for
    // slim-mode walks — `getSlimPrimitiveTypesAtPath` and
    // `getSchemasAtPath` both consume this variant so the yielded
    // candidates reflect the slim shape.
    getNestedSchemasInSlimMode: (schema, path, maxRecursionDepth) =>
      getNestedSchemasInSlimModeV3(schema as z.ZodSchema, path, maxRecursionDepth),
    slimPrimitivesOf: (schema, _maxRecursionDepth) => slimPrimitivesV3(schema),
    deriveDefault: (schema, useDefault, _maxRecursionDepth, formKey) =>
      getDefaultValuesFromZodSchema(schema as z.ZodSchema, useDefault, formKey),
    runStrictGetDefaults: (schema, config, formKey, maxRecursionDepth) =>
      runStrictGetDefaultsV3<Form>(schema as z.ZodSchema, config, formKey, maxRecursionDepth),
    unwrapStructuralWrappers: (schema) => unwrapStructuralLeafV3(schema),
    unwrapToDiscriminatedUnion: (schema) =>
      unwrapToDiscriminatedUnion(schema) as z.ZodTypeAny | undefined,
    peelAllWrappers: (schema) => peelAllV3Wrappers(schema),
    isLeafRequired: (schema) => isLeafRequiredV3(schema),
    resolveFieldMetaAtPath: (schema, path, maxRecursionDepth) =>
      resolveFieldMetaAtPathV3(schema as z.ZodSchema, path, maxRecursionDepth),
    issuesToValidationErrors: (issues, formKey) =>
      zodIssuesToValidationErrors(issues as z.ZodIssue[], formKey),
    safeParseSync: (schema, data) => {
      const result = schema.safeParse(data)
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: result.error.issues }
    },
    safeParseAsync: async (schema, data) => {
      const result = await schema.safeParseAsync(data)
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: result.error.issues }
    },
    // v3 returns the full recursive AbstractSchema for sub-schemas (the
    // historical shape) — `getSchemasAtPath` consumers may probe any
    // method on the result. The factory call rebuilds the full surface
    // against the sub-schema with its own per-form caches.
    makeSubSchema: (sub, formKey, maxRecursionDepth) =>
      createAbstractSchema<z.ZodTypeAny, unknown, GetValueFormType>(
        sub,
        V3_INTROSPECTOR,
        buildV3Services<GenericForm, GetValueFormType>(),
        formKey,
        { maxRecursionDepth }
      ),
  }
}

function zodIssuesToValidationErrors(issues: z.ZodIssue[], formKey: FormKey): ValidationError[] {
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
      formKey: formKey,
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

type DefaultValueContext = {
  formKey: FormKey
  discriminator: { useDefaultSchemaValues: boolean } & {
    isDiscriminatorKey: boolean
    schema:
      | z.ZodDiscriminatedUnion<string, readonly z.ZodDiscriminatedUnionOption<string>[]>
      | undefined
  }
}

function getDefaultValue(
  expected: z.ZodInvalidTypeIssue['expected'],
  context: DefaultValueContext
) {
  // special default value for discriminated unions:
  const discriminatorContext = context.discriminator
  if (discriminatorContext.isDiscriminatorKey) {
    if (!discriminatorContext.schema) {
      throw new Error('discriminatorContext.schema unspecified')
    }

    if (!isZodSchemaType(discriminatorContext.schema, 'ZodDiscriminatedUnion')) {
      throw new TypeError(
        'Programming error: discriminatorContext.schema is not a ZodDiscriminatedUnion schema.'
      )
    }

    const defaultDiscriminatorKey = undefined
    const optionDiscriminator = getSchemaByDiscriminatorKey(
      discriminatorContext.schema,
      defaultDiscriminatorKey
    )

    if (!optionDiscriminator) {
      throw new Error('ZodDiscriminatedUnion: default option not found')
    }

    return getDefaultValuesFromZodSchema(
      optionDiscriminator,
      discriminatorContext.useDefaultSchemaValues,
      context.formKey
    )
  }

  if (expected === 'string') return ''
  if (expected === 'number') return 0
  if (expected === 'array') return []
  if (expected === 'boolean') return false
  if (expected === 'bigint') return 0n
  if (expected === 'float') return 0.0
  if (expected === 'integer') return 0
  if (expected === 'null') return null
  if (expected === 'object') return {}
  if (expected === 'set') return new Set()
  if (expected === 'date') return new Date()
  // ZodMap / ZodPromise / ZodSymbol / ZodFunction are rejected by
  // `assertSupportedKinds` at construction (the four entries in
  // `UNSUPPORTED_TYPE_NAMES` at `assert-supported.ts:34`), so a
  // ZodInvalidTypeIssue with `expected` set to one of those values
  // is unreachable through the public adapter surface. The branches
  // were dead before Phase 9 even started; deleting them now retires
  // the only synthesisers we had for those values, eliminating the
  // risk of someone reaching in privately and discovering an
  // adapter-internal `new Promise` / `Symbol()` instance pinned
  // against a kind the schema couldn't be.
  if (expected === 'undefined') return undefined
  if (expected === 'unknown') return undefined
  if (expected === 'nan') return Number('nan')
  // 'never' and 'void' fall through to the default below.
  return undefined
}

function getDefaultValuesFromZodSchema<
  FormSchema extends z.ZodSchema,
  Form extends z.infer<FormSchema>,
>(formSchema: FormSchema, useDefaultSchemaValues: boolean, formKey: FormKey): Form {
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
  return deriveDefaultWalk(formSchema, useDefaultSchemaValues, V3_INTROSPECTOR, 64, {
    unsupportedKindFallback: (schema) => {
      console.warn(
        `[attaform] zod-v3 adapter: unsupported schema kind ` +
          `'${(schema as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}' ` +
          `on form '${formKey}'. Defaulting the field to null. ` +
          `Use a supported zod kind (object/array/record/string/number/etc.) at this path.`
      )
      return null
    },
    // v3 historically surfaces the `.catch(v)` fallback even when
    // `useDefaultSchemaValues=false`. Pinned by
    // `test/adapters/zod-v3/wrappers.test.ts` ('surfaces the catch
    // fallback even when useDefaultSchemaValues is false').
    catchOnUseDefaultFalse: 'preserveCatch',
  }) as Form
}
// helpful tip: discriminator option schemas are always zod objects (because of discriminant key)
function getSchemaByDiscriminatorKey(
  unionSchema: z.ZodTypeAny | z.ZodSchema,
  key: string | undefined
): z.ZodObject<z.ZodRawShape> | undefined {
  // Check if the schema is a discriminated union
  if (!isZodSchemaType(unionSchema, 'ZodDiscriminatedUnion')) {
    throw new TypeError('Provided schema is not a discriminated union.')
  }

  // return first/default option schema if no key is provided
  if (key === undefined) {
    const options = getDiscriminatedOptions(unionSchema)
    if (!options.length) {
      throw new TypeError('Provided ZodDiscriminatedUnion does not have any options')
    }
    return options[0]
  }

  // Find the schema with the matching discriminator value
  const discKey = getDiscriminator(unionSchema)
  if (discKey === undefined) return undefined
  return getDiscriminatedOptions(unionSchema).find((schema) => {
    const discriminator = schema.shape[discKey] as z.ZodTypeAny | undefined
    return discriminator !== undefined && getLiteralValue(discriminator) === key
  })
}

type StripConfigCallback = (schema: z.ZodTypeAny | z.ZodSchema) => boolean

type StripConfig = {
  stripNullable?: boolean | StripConfigCallback
  stripOptional?: boolean | StripConfigCallback
  stripZodEffects?: boolean | StripConfigCallback
  stripZodRefinements?: boolean | StripConfigCallback
  stripDefaultValues?: boolean | StripConfigCallback
}

function stripRefinements<T extends z.ZodTypeAny>(schema: T) {
  // `depth` bounds the recursion at MAX_UNWRAP_STEPS (per branch). For
  // realistic form schemas the structural depth is in single digits;
  // the bound only matters for pathological chains
  // (`z.string().refine().refine()...` produces nested ZodEffects whose
  // depth is exactly the chain length).
  function _stripRefinements(_schema: z.ZodTypeAny, depth: number): z.ZodTypeAny {
    if (depth >= MAX_UNWRAP_STEPS) return _schema as T
    if (isZodSchemaType(_schema, 'ZodString') && hasChecks(_schema)) {
      // Clear the ZodString's checks, keeping its prototype and coerce
      return stripLeafChecks(_schema)
    }

    if (isZodSchemaType(_schema, 'ZodNumber') && hasChecks(_schema)) {
      // Clear the ZodNumber's checks, keeping its prototype and coerce
      return stripLeafChecks(_schema)
    }

    if (isZodSchemaType(_schema, 'ZodArray')) {
      // Recursively process the array's inner type
      const inner = getArrayElement(_schema)
      if (!inner) return _schema
      return rebuildArray(_schema, _stripRefinements(inner, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodObject')) {
      // Recursively process each property of the object
      const strippedShape = Object.fromEntries(
        Object.entries(getObjectShape(_schema)).map(([key, value]) => [
          key,
          _stripRefinements(value, depth + 1),
        ])
      )
      return rebuildObject(_schema, strippedShape)
    }

    if (isZodSchemaType(_schema, 'ZodEffects')) {
      // Unwrap the inner schema and strip refinements
      const inner = unwrapEffectsSource(_schema)
      if (!inner) return _schema
      return _stripRefinements(inner, depth + 1)
    }

    if (isZodSchemaType(_schema, 'ZodOptional')) {
      // Recursively strip optional's inner type
      const inner = unwrapInner(_schema)
      if (!inner) return _schema
      return rebuildWrapperInner(_schema, _stripRefinements(inner, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodNullable')) {
      // Recursively strip nullable's inner type
      const inner = unwrapInner(_schema)
      if (!inner) return _schema
      return rebuildWrapperInner(_schema, _stripRefinements(inner, depth + 1))
    }

    // Newer transparent wrappers — descend into their inner schema and
    // return that. We don't reconstruct the wrapper because its
    // refinement/branding/pipeline metadata isn't load-bearing for the
    // slim-parse pass that consumes the stripped schema.
    if (isZodSchemaType(_schema, 'ZodReadonly')) {
      const inner = unwrapInner(_schema)
      if (!inner) return _schema
      return _stripRefinements(inner, depth + 1)
    }

    if (isZodSchemaType(_schema, 'ZodBranded')) {
      const inner = unwrapBranded(_schema)
      if (!inner) return _schema
      return _stripRefinements(inner, depth + 1)
    }

    if (isZodSchemaType(_schema, 'ZodPipeline')) {
      const inner = unwrapPipeIn(_schema)
      if (!inner) return _schema
      return _stripRefinements(inner, depth + 1)
    }

    // Container kinds that nest other schemas. Pre-fix, refinements
    // inside these survived into the slim schema and the fix-up loop
    // had to patch each leaf via the second-parse fallback. Mirroring
    // v4's strip.ts means the FIRST slim parse passes for the lax
    // contract, no fix-up needed.

    if (isZodSchemaType(_schema, 'ZodSet')) {
      const valueType = getSetValueType(_schema)
      if (!valueType) return _schema
      return rebuildSet(_schema, _stripRefinements(valueType, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodTuple')) {
      const items = getTupleItems(_schema)
      if (items.length === 0) return _schema
      const stripped = items.map((it) => _stripRefinements(it, depth + 1))
      return rebuildTuple(_schema, stripped)
    }

    if (isZodSchemaType(_schema, 'ZodRecord')) {
      const valueType = getRecordValueType(_schema)
      if (!valueType) return _schema
      const value = _stripRefinements(valueType, depth + 1)
      // z.record's two-arg form preserves the key schema; one-arg form
      // assumes z.string(). Forward the key type unchanged — refinements
      // on record keys aren't load-bearing for slim-schema concerns.
      const keyType = getRecordKeyType(_schema)
      if (keyType) {
        return rebuildRecord(_schema, value, keyType)
      }
      return rebuildRecord(_schema, value)
    }

    if (isZodSchemaType(_schema, 'ZodUnion')) {
      const options = getUnionOptions(_schema)
      if (options.length === 0) return _schema
      const stripped = options.map((o) => _stripRefinements(o, depth + 1))
      return rebuildUnion(_schema, stripped)
    }

    if (isZodSchemaType(_schema, 'ZodDiscriminatedUnion')) {
      const discKey = getDiscriminator(_schema)
      const options = getDiscriminatedOptions(_schema)
      if (discKey === undefined || options.length === 0) return _schema
      const stripped = options.map(
        (o) => _stripRefinements(o, depth + 1) as z.ZodObject<z.ZodRawShape>
      )
      return rebuildDiscriminatedUnion(_schema, stripped)
    }

    if (isZodSchemaType(_schema, 'ZodIntersection')) {
      const left = getIntersectionLeft(_schema)
      const right = getIntersectionRight(_schema)
      if (!left || !right) return _schema
      return rebuildIntersection(
        _schema,
        _stripRefinements(left, depth + 1),
        _stripRefinements(right, depth + 1)
      )
    }

    if (isZodSchemaType(_schema, 'ZodLazy')) {
      const inner = unwrapLazy(_schema)
      if (!inner) return _schema
      // Eagerly resolve once and capture the stripped target so the
      // returned lazy resolves to a stable schema. assertSupportedKinds
      // has already rejected self-referencing lazies, so this is finite.
      const stripped = _stripRefinements(inner, depth + 1)
      return rebuildLazy(_schema, stripped)
    }

    // Return other schema types as-is
    return _schema as T
  }

  return _stripRefinements(schema, 0) as T
}

function stripRootSchema(schema: z.ZodSchema, stripConfig: StripConfig) {
  function recursion(_schema: z.ZodSchema, _stripped = false): [z.ZodSchema, boolean] {
    if (
      getStripInstruction(stripConfig.stripNullable, _schema) &&
      isZodSchemaType(_schema, 'ZodNullable')
    ) {
      return recursion(_schema.unwrap(), true)
    }

    if (
      getStripInstruction(stripConfig.stripOptional, _schema) &&
      isZodSchemaType(_schema, 'ZodOptional')
    ) {
      return recursion(_schema.unwrap(), true)
    }

    if (
      getStripInstruction(stripConfig.stripZodEffects, _schema) &&
      isZodSchemaType(_schema, 'ZodEffects')
    ) {
      const inner = unwrapEffectsSource(_schema)
      if (inner) return recursion(inner as z.ZodSchema, true)
    }

    if (
      getStripInstruction(stripConfig.stripDefaultValues, _schema) &&
      isZodSchemaType(_schema, 'ZodDefault')
    ) {
      const inner = unwrapInner(_schema)
      if (inner) return recursion(inner as z.ZodSchema, true)
    }

    if (getStripInstruction(stripConfig.stripZodRefinements, _schema) && hasChecks(_schema)) {
      return recursion(stripRefinements(_schema))
    }

    return [_schema, _stripped]
  }

  return recursion(schema, false)
}

type SlimSchemaConfig<Schema> = {
  schema: Schema
  stripConfig: StripConfig
}

const getStripInstruction = (
  stripValueOrCallback: boolean | StripConfigCallback | undefined,
  schema: z.ZodTypeAny | z.ZodSchema
): boolean => {
  if (stripValueOrCallback === undefined || stripValueOrCallback === false) return false

  return typeof stripValueOrCallback === 'function'
    ? stripValueOrCallback(schema)
    : stripValueOrCallback
}

// make the schema more relaxed so we can construct a initial form state
// schema is based on ZodType in case we ever work with nested schemas
function getSlimSchema<RS extends z.ZodRawShape, Schema extends z.ZodSchema>(
  config: SlimSchemaConfig<Schema>
) {
  function _getSlimSchema(_schema: z.ZodSchema): z.ZodSchema {
    if (isZodSchemaType(_schema, 'ZodObject')) {
      const newShape: z.ZodRawShape = {}
      for (const [key, value] of Object.entries(getObjectShape(_schema))) {
        newShape[key] = _getSlimSchema(value as z.ZodSchema)
      }
      return rebuildObject(_schema, newShape)
    }

    if (isZodSchemaType(_schema, 'ZodArray')) {
      const inner = getArrayElement(_schema)
      if (!inner) return _schema
      return rebuildArray(_schema, _getSlimSchema(inner as z.ZodSchema))
    }

    if (isZodSchemaType(_schema, 'ZodRecord')) {
      const keyType = getRecordKeyType(_schema)
      const valueType = getRecordValueType(_schema)
      if (!keyType || !valueType) return _schema
      const key = _getSlimSchema(keyType as z.ZodSchema)
      const value = _getSlimSchema(valueType as z.ZodSchema)
      return rebuildRecord(_schema, value, key)
    }

    // same way we go into records, objects, and arrays, go into discriminated unions
    if (isZodSchemaType(_schema, 'ZodDiscriminatedUnion')) {
      const slimmedSchemas = []
      const discKey = getDiscriminator(_schema)
      if (discKey === undefined) return _schema

      for (const option of getDiscriminatedOptions(_schema)) {
        const slimmedSchema = _getSlimSchema(option as unknown as z.ZodSchema)
        // slimmedSchema will be a structurally deep object, so break pointer refs to prevent recursion bugs
        const deepCloneSlimmedSchema = cloneSchemaDeep(slimmedSchema)
        slimmedSchemas.push(deepCloneSlimmedSchema)
      }

      return rebuildDiscriminatedUnion(
        _schema,
        slimmedSchemas as unknown as readonly z.AnyZodObject[]
      )
    }

    if (
      getStripInstruction(config.stripConfig.stripZodEffects, _schema) &&
      isZodSchemaType(_schema, 'ZodEffects')
    ) {
      const inner = unwrapEffectsSource(_schema)
      if (inner) return _getSlimSchema(inner as z.ZodSchema)
    }

    if (
      getStripInstruction(config.stripConfig.stripNullable, _schema) &&
      isZodSchemaType(_schema, 'ZodNullable')
    ) {
      const inner = unwrapInner(_schema)
      if (inner) return _getSlimSchema(inner as z.ZodSchema)
    }

    if (
      getStripInstruction(config.stripConfig.stripOptional, _schema) &&
      isZodSchemaType(_schema, 'ZodOptional')
    ) {
      const inner = unwrapInner(_schema)
      if (inner) return _getSlimSchema(inner as z.ZodSchema)
    }

    if (
      getStripInstruction(config.stripConfig.stripZodRefinements, _schema) &&
      hasChecks(_schema)
    ) {
      return stripRefinements(_schema)
    }

    if (
      getStripInstruction(config.stripConfig.stripDefaultValues, _schema) &&
      isZodSchemaType(_schema, 'ZodDefault')
    ) {
      const inner = unwrapInner(_schema)
      if (inner) return _getSlimSchema(inner as z.ZodSchema)
    }

    // Attempt to unwrap a schema to find a discriminated union (bail if you hit another valid schema type)
    const unionSchema = unwrapToDiscriminatedUnion(_schema)
    if (unionSchema && getStripInstruction(config.stripConfig.stripDefaultValues, unionSchema)) {
      return _getSlimSchema(unionSchema)
    }

    return _schema
  }

  const processedRootSchema = stripRootSchema(config.schema, config.stripConfig)[0]
  return _getSlimSchema(processedRootSchema) as unknown as z.ZodObject<RS>
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
  // schema-keyed registry for paths not visited by the walker.
  const pathMap = getFieldMetaPathMap(rootSchema as z.ZodTypeAny, {
    intro: V3_INTROSPECTOR,
    peelAllWrappers: peelAllV3Wrappers,
    getFieldMetaList,
  })
  const pathKey = canonicalizePath(path).key
  const peeled = peelV3Wrappers(target)
  const payload =
    pathMap.get(pathKey) ??
    getFieldMeta(target) ??
    (peeled !== target ? getFieldMeta(peeled) : undefined)
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
 * v3's construction-time `getDefaultValues` flow. Extracted from the
 * pre-factory inline adapter body. Builds the slim default-value seed
 * via `getDefaultValuesFromZodSchema`, merges constraints, then runs:
 *
 *   - Strict mode (default): parse against the REAL schema so refines
 *     and container / leaf checks surface at construction. If a sync
 *     parse throws because of an async refine, strip every ZodEffects
 *     and re-parse (v3 cannot tell sync from async refines without
 *     invoking the wrapper). If a user refine throws raw, fall back
 *     to mount-clean success.
 *
 *   - Lax mode: validate-then-fix loop against the slim schema —
 *     primitive / structural mismatches get patched with the slim
 *     default; refinement-level issues pass through unchanged so the
 *     downstream strict validation pass surfaces them.
 *
 * Both arms compose with the shared core `mergeDeep` (NOT lodash merge)
 * so arrays replace wholesale and explicit `null` / `undefined`
 * overrides survive. v3 and v4 now call the same helper.
 */
function runStrictGetDefaultsV3<Form>(
  rootSchema: z.ZodSchema,
  config: GetDefaultValuesConfig<Form>,
  formKey: FormKey,
  maxRecursionDepth: number
): DefaultValuesResponse<Form> {
  const defaultValuesWithoutConstraints = getDefaultValuesFromZodSchema(
    rootSchema,
    config.useDefaultSchemaValues,
    formKey
  )

  const slimSchema = getSlimSchema({
    schema: rootSchema,
    stripConfig: {
      stripZodEffects: true,
      stripDefaultValues: true,
      // `strict: false` strips refinements (so empty defaults pass);
      // strict keeps them so the slim parse below surfaces refinement
      // errors. Async refines are guarded by the try/catch — they
      // can't be surfaced synchronously regardless.
      stripZodRefinements: (config.strict ?? true) === false,
    },
  })

  let rawDefaultValues = defaultValuesWithoutConstraints
  if (!isPrimitive(rawDefaultValues)) {
    // Shared core `mergeDeep` (NOT lodash `merge`) so arrays replace
    // wholesale and explicit `null`/`undefined` overrides survive; v3
    // and v4 call the same helper. `safeAssign` inside lands a
    // `__proto__` constraint key as own data rather than reassigning the
    // result's prototype.
    rawDefaultValues = mergeDeep(defaultValuesWithoutConstraints, config.constraints)
  } else if (constraintsAreSlimValid(slimSchema, config.constraints)) {
    rawDefaultValues = config.constraints
  }

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
        formKey,
      }
    }

    try {
      const strictResult = rootSchema.safeParse(rawDefaultValues)
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
          formKey,
        }
      }
      return {
        data: rawDefaultValues as Form,
        errors: zodIssuesToValidationErrors(strictResult.error.issues, formKey),
        success: false,
        formKey,
      }
    } catch (err) {
      // Distinguish the v3 async-detect throw from a generic
      // user-validator throw at construction. The async-detect throw
      // is a standard `Error` with message `"Async refinement
      // encountered during synchronous parse..."`. On that path strip
      // every `ZodEffects` (sync + async — v3 can't tell apart at the
      // predicate level, see `strip-async.ts` docblock) and re-parse
      // to surface container + leaf-check seeds.
      const isAsyncDetect =
        err instanceof Error && err.message.includes('Async refinement encountered')
      if (isAsyncDetect) {
        try {
          const strippedResult = stripAsyncChecks(rootSchema).safeParse(rawDefaultValues)
          if (strippedResult.success) {
            return {
              data: rawDefaultValues as Form,
              errors: undefined,
              success: true,
              formKey,
            }
          }
          return {
            data: rawDefaultValues as Form,
            errors: zodIssuesToValidationErrors(strippedResult.error.issues, formKey),
            success: false,
            formKey,
          }
        } catch {
          // Defensive floor: the stripped schema also threw (e.g. a
          // sync refine that itself throws). Mount cleanly; the
          // post-mount async pass is the source of truth for any
          // verdict this code path can't surface.
          return {
            data: rawDefaultValues as Form,
            errors: undefined,
            success: true,
            formKey,
          }
        }
      }
      // Non-async throw at construction (user validator threw a raw
      // exception): defensive floor, matches v4's catch.
      return {
        data: rawDefaultValues as Form,
        errors: undefined,
        success: true,
        formKey,
      }
    }
  }

  // Lax mode: validate-then-fix loop. The slim schema's structural
  // shape is what the loop patches against — any throw collapses to
  // mount-clean success. The existing try/catch is the slim equivalent
  // of the strict-mode defensive floor above.
  let parseResult: ReturnType<typeof slimSchema.safeParse>
  try {
    parseResult = slimSchema.safeParse(rawDefaultValues)
  } catch {
    return {
      data: rawDefaultValues as Form,
      errors: undefined,
      success: true,
      formKey,
    }
  }
  const { data, success, error } = parseResult

  if (success) {
    return {
      data: data as Form,
      errors: undefined,
      success,
      formKey,
    }
  }

  let fixedData: Record<string, unknown> = {}

  // `if (success) return ...` above handles the happy path; below
  // we're always in the failure case.
  //
  // Under the slim-primitive write contract, the validate-then-fix
  // loop only patches issues that violate STRUCTURAL or
  // PRIMITIVE-TYPE shape. Refinement-level issues
  // (invalid_enum_value, invalid_literal, invalid_string, too_small,
  // too_big, custom, unrecognized_keys) pass THROUGH unchanged — the
  // user's defaultValues are preserved verbatim and the strict-mode
  // validation pass downstream surfaces the error at construction.
  //
  // The classifier: look up the actual offending value at the issue's
  // path and check its slim primitive kind against the candidate
  // schema's slim primitive set. If the value's kind IS in the set,
  // the issue is refinement-level → skip. If it's NOT in the set, the
  // issue is primitive/structural → fix. Unifies every issue code
  // under one check.
  for (const issue of error.issues) {
    const schemasAtPath = getNestedZodSchemasAtPath(slimSchema, issue.path, maxRecursionDepth)
    // `setAtPath` accepts a Segment[] directly; keeps the literal-dot
    // case (`['user.name']`) from being flattened into two key
    // accesses. Coerce in case a custom check smuggled a Symbol —
    // `path.join` would throw on it.
    const path = coercePathSegments(issue.path)
    if (!schemasAtPath.length) {
      console.error(
        `[attaform] zod-v3 adapter: no schema at path ` +
          `'${path.join(PATH_SEPARATOR)}' for key '${formKey}'. ` +
          `Skipping the issue. (This is a library-internal invariant — please file a bug.)`
      )
      continue
    }

    // Refinement-vs-primitive classification.
    const candidate = schemasAtPath[0]
    if (candidate !== undefined) {
      const valueAtPath = getAtPath(rawDefaultValues, path)
      const slimKinds = slimPrimitivesV3(candidate as z.ZodTypeAny)
      if (slimKinds.size > 0 && slimKinds.has(slimKindOf(valueAtPath))) {
        // Refinement-level: pass through unchanged.
        continue
      }
    }

    for (const schemaAtPath of schemasAtPath) {
      if (issue.code === 'invalid_type') {
        const isDiscriminatedUnion = isZodSchemaType(schemaAtPath, 'ZodDiscriminatedUnion')
        const defaultValueContext: DefaultValueContext = isDiscriminatedUnion
          ? {
              formKey,
              discriminator: {
                isDiscriminatorKey: true,
                schema: schemaAtPath as z.ZodDiscriminatedUnion<
                  string,
                  readonly z.ZodDiscriminatedUnionOption<string>[]
                >,
                useDefaultSchemaValues: false,
              },
            }
          : {
              formKey,
              discriminator: {
                isDiscriminatorKey: false,
                schema: undefined,
                useDefaultSchemaValues: false,
              },
            }
        const defaultValue = getDefaultValue(issue.expected, defaultValueContext)
        fixedData = setAtPath(fixedData, path, defaultValue) as Record<string, unknown>
        continue
      }

      // Wrong-primitive issues with non-invalid_type codes (e.g.,
      // invalid_enum_value where the offending value is a number
      // against a string-enum). Fall back to the schema's default —
      // peel the wrapper chain for an embedded `ZodDefault` /
      // `ZodCatch.fallback`. Mirrors the chain-peel that
      // `deriveDefaultWalk` runs at the top of every node visit.
      const peeled = peelEmbeddedDefault(schemaAtPath as z.ZodTypeAny, V3_INTROSPECTOR)
      if (peeled !== NO_EMBEDDED_DEFAULT) {
        fixedData = setAtPath(fixedData, path, peeled) as Record<string, unknown>
        continue
      }
      // Last-ditch: derive a default for the schema kind at this path.
      // Skips if no useful default emerges.
      const ctx: DefaultValueContext = {
        formKey,
        discriminator: {
          isDiscriminatorKey: false,
          schema: undefined,
          useDefaultSchemaValues: false,
        },
      }
      // Use the slim primitive's first kind to derive a default.
      const slimKinds = slimPrimitivesV3(schemaAtPath as z.ZodTypeAny)
      const firstKind = [...slimKinds][0]
      if (firstKind !== undefined) {
        const expected =
          firstKind === 'string'
            ? 'string'
            : firstKind === 'number'
              ? 'number'
              : firstKind === 'boolean'
                ? 'boolean'
                : firstKind === 'bigint'
                  ? 'bigint'
                  : firstKind === 'date'
                    ? 'date'
                    : firstKind === 'array'
                      ? 'array'
                      : firstKind === 'object'
                        ? 'object'
                        : null
        if (expected !== null) {
          fixedData = setAtPath(fixedData, path, getDefaultValue(expected, ctx)) as Record<
            string,
            unknown
          >
        }
      }
    }
  }
  // Shared core `mergeDeep` so the fix-up overrides the raw defaults
  // with copy-on-write semantics matching v4 (array replace,
  // null/undefined clears honored).
  fixedData = mergeDeep(rawDefaultValues, fixedData) as Record<string, unknown>

  // Best-effort re-parse: if the fix-up loop couldn't fully reconcile
  // the data (nested unions whose branches don't match the defaulted
  // shape, bigint edge cases), return the partial data instead of
  // throwing. Matches the v4 adapter's lax semantics — a partially-
  // valid initial state is preferable to a mount-time exception.
  // Strict mode short-circuited earlier via the real-schema parse
  // path, so reaching here implies `config.strict === false`.
  const secondParse = slimSchema.safeParse(fixedData)
  const finalData = secondParse.success ? secondParse.data : fixedData
  return {
    data: finalData as Form,
    errors: undefined,
    success: true,
    formKey,
  }
}

/**
 * The slim-mode root projection (strip refinements / defaults / wrappers,
 * then derive the slim shape) is a pure function of the root schema — the
 * strip and slim configs below are fixed. Memoise it on root identity so the
 * projection runs once per schema instead of once per slim-mode walk.
 *
 * The walk is invoked once per `register()` (via `getSlimPrimitiveTypesAtPath`)
 * and once per field on its first state read (via the factory's `isLeafAtPath`
 * cache miss), always against the form root. Recomputing the whole-root
 * projection on each call made both O(F), i.e. O(F²) to wire an F-field form.
 * Cached, each lookup is the O(D) `getNestedZodSchemasAtPath` walk. WeakMap-keyed
 * so a schema going out of scope releases its slim copy. The projection is
 * read-only walked downstream, so sharing one copy across calls is sound.
 */
const slimRootCacheV3 = new WeakMap<z.ZodSchema, z.ZodTypeAny>()

function getSlimRootV3(rootSchema: z.ZodSchema): z.ZodTypeAny {
  const cached = slimRootCacheV3.get(rootSchema)
  if (cached !== undefined) return cached
  const [strippedSchema] = stripRootSchema(rootSchema, {
    stripDefaultValues: true,
    stripNullable: true,
    stripOptional: true,
    stripZodEffects: true,
  })
  const slimSchema = getSlimSchema({
    schema: strippedSchema,
    stripConfig: { stripDefaultValues: true, stripZodEffects: true },
  })
  slimRootCacheV3.set(rootSchema, slimSchema)
  return slimSchema
}

/**
 * v3's slim-mode path walk for `getSlimPrimitiveTypesAtPath` and
 * `getSchemasAtPath`. Resolves the path against the slim-projected root
 * (memoised by `getSlimRootV3`), so yielded candidates reflect the slim
 * shape the slim-primitive gate consults at write time and consumers expect
 * when introspecting sub-schemas. v4's introspector aliases this to the
 * unstripped walk because its path walker already inlines wrapper peeling,
 * so v4 never pays the projection per call.
 */
function getNestedSchemasInSlimModeV3(
  rootSchema: z.ZodSchema,
  path: Path,
  maxRecursionDepth: number
): z.ZodTypeAny[] {
  return getNestedZodSchemasAtPath(getSlimRootV3(rootSchema), path, maxRecursionDepth)
}
