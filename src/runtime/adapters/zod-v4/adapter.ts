import type { z } from 'zod'
import type {
  AbstractSchema,
  DefaultValuesResponse,
  FormKey,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
} from '../../types/types-api'
import {
  createAbstractSchema,
  type AbstractSchemaServices,
} from '../../core/abstract-schema-factory'
import { getFieldMeta, getFieldMetaList } from './field-meta'
import type { SchemaFactoryOptions } from '../../core/get-computed-schema'
import { humanize } from '../../core/humanize'
import { canonicalizePath, type Path } from '../../core/paths'
import type { DeepPartial, GenericForm } from '../../types/types-core'
import { assertSupportedKinds } from './assert-supported'
import { unwrapToDiscriminatedUnion } from './discriminator'
import { zodIssuesToValidationErrors } from './errors'
import { fingerprintZodSchema } from './fingerprint'
import { deriveDefault, getDefaultValuesFromZodSchema } from './default-values'
import {
  assertZodVersion,
  containsAsyncRefine,
  containsAsyncTransform,
  getDiscriminatedOptions,
  getIntersectionLeft,
  getIntersectionRight,
  getUnionOptions,
  kindOf,
  unwrapInner,
  unwrapLazy,
  unwrapPipe,
} from './introspect'
import { getNestedZodSchemasAtPath } from './path-walker'
import { slimPrimitivesOf } from './slim-primitives'
import { stripAsyncChecks } from './strip'
import { getFieldMetaPathMap } from '../../core/walk-field-meta'
import { V4_INTROSPECTOR } from './walker-introspector'

/**
 * Zod v4 adapter — implements `AbstractSchema` against Zod v4's public
 * surface. Internal (`def.*`) access is quarantined to introspect.ts and
 * the co-located modules (default-values, strip, path-walker, discriminator,
 * errors). This file is the wiring layer between those modules and the
 * framework's AbstractSchema contract.
 *
 * Feature parity with the v3 adapter:
 * - getDefaultValues: validate-then-fix loop (delegated to default-values.ts)
 *   with refinement stripping in lax mode; discriminated-union-aware
 *   first-option fallback for invalid_type issues.
 * - getSchemasAtPath: discriminated-union-aware path walker.
 * - validateAtPath: per-union-branch parse with aggregated errors.
 */

/**
 * Peel `.optional()` / `.nullable()` wrappers off a leaf schema ONLY
 * when the inner type is structurally fillable (object, array, tuple,
 * record, discriminated/plain union, intersection — or itself a
 * peelable wrapper that resolves to one of those). Peeling exposes
 * the inner shape's default so consumer-supplied partial writes
 * through optional sub-schemas (`{ profile: z.object({...}).optional() }`,
 * `setValue('profile', { name: 'X' })`) get the inner shape's
 * structural defaults filled in.
 *
 * For PRIMITIVE inner (ZodString, ZodNumber, ZodBoolean, ZodLiteral,
 * etc.), the wrapper IS the meaningful schema — `optional` means
 * "missing is allowed", `nullable` means "null is allowed". Peeling
 * an optional string to its inner string would default the leaf to
 * `''` and cause mergeStructural to write `notes: ''` instead of
 * `notes: undefined` when filling sibling keys at the parent object
 * — the runtime would silently overwrite the optional's "absent"
 * intent with a non-empty marker.
 *
 * `.default(x)` is left intact at every level so deriveDefault
 * returns the explicit default value. Bounded iteration cap as a
 * runaway guard for pathological wrappers.
 */
function unwrapStructuralWrappers(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema
  for (let i = 0; i < 64; i++) {
    const outerKind = kindOf(current)
    if (outerKind !== 'optional' && outerKind !== 'nullable') break
    const inner = unwrapInner(current)
    if (inner === undefined) return current
    if (!isStructuralKind(kindOf(inner))) break
    current = inner
  }
  return current
}

/**
 * Peel every transparent wrapper (optional / nullable / default /
 * readonly / catch / pipe / lazy) off `schema`. Stops on the first
 * non-wrapper kind. Used by `arrayShapeAtPath` for shape
 * introspection where we want the inner kind regardless of what the
 * default-value semantic is — different from
 * `unwrapStructuralWrappers`, which preserves `.default()` so the
 * runtime fill returns the explicit default.
 *
 * Bounded iteration cap as a runaway guard for pathological wrappers.
 */
function peelAllWrappers(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema
  for (let i = 0; i < 64; i++) {
    const k = kindOf(current)
    let inner: z.ZodType | undefined
    if (
      k === 'optional' ||
      k === 'nullable' ||
      k === 'default' ||
      k === 'readonly' ||
      k === 'catch'
    ) {
      inner = unwrapInner(current)
    } else if (k === 'pipe') {
      inner = unwrapPipe(current)
    } else if (k === 'lazy') {
      inner = unwrapLazy(current)
    } else {
      return current
    }
    if (inner === undefined) return current
    current = inner
  }
  return current
}

/**
 * Kinds for which mergeStructural can recurse to fill missing keys
 * or pad missing positions. Primitive leaves (string / number / etc.)
 * and opaque non-recursable wrappers fall outside this set, so
 * peeling Optional / Nullable around them would lose information
 * (the wrapper's "absent / null" semantic) without enabling any fill.
 *
 * Wrappers themselves count as structural — `unwrapStructuralWrappers`
 * recurses to re-check their inner kind.
 */
const STRUCTURAL_KINDS: ReadonlySet<ReturnType<typeof kindOf>> = new Set([
  'object',
  'array',
  'tuple',
  'record',
  'discriminated-union',
  'union',
  'intersection',
  'optional',
  'nullable',
  'default',
  'readonly',
  'catch',
  'pipe',
  'lazy',
])

function isStructuralKind(kind: ReturnType<typeof kindOf>): boolean {
  return STRUCTURAL_KINDS.has(kind)
}

const MAX_REQUIRED_DEPTH = 64

/**
 * `true` if the leaf is required — `false` if any wrapper layer admits
 * "empty" via `.optional()`, `.nullable()`, `.default(N)`, or
 * `.catch(N)`. See `AbstractSchema.isRequiredAtPath` for the full
 * semantic specification (union → permissive, intersection → strict,
 * readonly/pipe/lazy → transparent peel).
 */
function isLeafRequired(schema: z.ZodType, depth = 0): boolean {
  if (depth > MAX_REQUIRED_DEPTH) return true
  const kind = kindOf(schema)
  // Direct "schema accepts empty" wrappers and bare empty-marker leaves —
  // short-circuit. `z.undefined()` / `z.null()` / `z.void()` inside a
  // union (`z.union([z.number(), z.undefined()])`) are how schema authors
  // express "this field can be absent" without a wrapper, so they count
  // as not-required here.
  if (
    kind === 'optional' ||
    kind === 'nullable' ||
    kind === 'default' ||
    kind === 'catch' ||
    kind === 'undefined' ||
    kind === 'null' ||
    kind === 'void'
  ) {
    return false
  }
  // Transparent wrappers — peel and re-check.
  if (kind === 'readonly') {
    const inner = unwrapInner(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'pipe') {
    // Use the input side: blank is a write-time concern.
    const inner = unwrapPipe(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'lazy') {
    const inner = unwrapLazy(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  // Union — required only if EVERY branch is required (any permissive
  // branch makes the union permissive at parse time).
  if (kind === 'union' || kind === 'discriminated-union') {
    const options =
      kind === 'discriminated-union' ? getDiscriminatedOptions(schema) : getUnionOptions(schema)
    if (options.length === 0) return true
    return options.every((opt) => isLeafRequired(opt as z.ZodType, depth + 1))
  }
  // Intersection — required if EITHER side is required (a parse must
  // satisfy both; the strict side governs).
  if (kind === 'intersection') {
    const left = getIntersectionLeft(schema)
    const right = getIntersectionRight(schema)
    const leftReq = left === undefined ? true : isLeafRequired(left, depth + 1)
    const rightReq = right === undefined ? true : isLeafRequired(right, depth + 1)
    return leftReq || rightReq
  }
  // Direct primitive leaf or unsupported kind — required by default.
  return true
}

/**
 * Wrap a Zod v4 `ZodObject` schema in an `AbstractSchema` factory.
 *
 * Most consumers never call this directly — `useForm` from
 * `attaform/zod` does the wrapping automatically. Reach for
 * it when you need an adapter outside of `useForm` (e.g. validating
 * data with the same library used elsewhere in the form runtime, or
 * exposing the adapter to a custom integration).
 *
 * The returned factory accepts per-form `SchemaFactoryOptions` (notably
 * `maxRecursionDepth`); the adapter closure bakes them into every
 * downstream walk so a per-form override can lift the cap without
 * touching the app-level default.
 *
 * Throws if the schema isn't Zod v4 or contains kinds the adapter
 * cannot represent (`z.promise`, `z.custom`, `z.templateLiteral`).
 * Recursive `z.lazy(...)` is supported — the runtime walks bound their
 * descent via `maxRecursionDepth`.
 */
export function zodV4Adapter<
  FormSchema extends z.ZodObject,
  Form extends z.input<FormSchema>,
  GetValueFormType extends z.output<FormSchema> = z.output<FormSchema>,
>(
  rootSchema: FormSchema
): (formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, GetValueFormType> {
  assertZodVersion(rootSchema)
  // Fail fast at adapter construction if the schema uses kinds we can't
  // represent (z.promise / z.custom / z.templateLiteral). Errors carry
  // the dotted path to the offending node. Recursive lazies pass — the
  // runtime walks cap their descent via `maxRecursionDepth`.
  assertSupportedKinds(rootSchema)

  return (formKey: FormKey, options: SchemaFactoryOptions) =>
    createAbstractSchema<z.ZodType, Form, GetValueFormType>(
      rootSchema,
      V4_INTROSPECTOR,
      buildV4Services<Form, GetValueFormType>(),
      formKey,
      options
    )
}

/**
 * Build the v4 `AbstractSchemaServices` instance. The services are
 * stateless — every method receives the schema it acts on plus the
 * factory-supplied `formKey` / `maxRecursionDepth`. The function is
 * generic in `Form` / `GetValueFormType` so the typed methods
 * (`runStrictGetDefaults` / `makeSubSchema`) propagate the form
 * shape correctly.
 */
function buildV4Services<
  Form extends GenericForm,
  GetValueFormType extends GenericForm,
>(): AbstractSchemaServices<z.ZodType, Form, GetValueFormType> {
  return {
    fingerprint: (schema) => fingerprintZodSchema(schema),
    getNestedSchemasAtPath: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodObject, path, maxRecursionDepth),
    // v4 doesn't pre-strip for the slim-mode walk — its path walker
    // already peels every transparent wrapper inline, so the slim and
    // unstripped walks coincide.
    getNestedSchemasInSlimMode: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodObject, path, maxRecursionDepth),
    slimPrimitivesOf: (schema, maxRecursionDepth) => slimPrimitivesOf(schema, maxRecursionDepth),
    deriveDefault: (schema, useDefault, maxRecursionDepth) =>
      deriveDefault(schema, useDefault, maxRecursionDepth),
    runStrictGetDefaults: (schema, config, fk, maxRecursionDepth) =>
      runStrictGetDefaultsV4<Form>(schema as FormSchemaAlias<Form>, config, fk, maxRecursionDepth),
    unwrapStructuralWrappers: (schema) => unwrapStructuralWrappers(schema),
    unwrapToDiscriminatedUnion: (schema) => unwrapToDiscriminatedUnion(schema),
    peelAllWrappers: (schema) => peelAllWrappers(schema),
    isLeafRequired: (schema) => isLeafRequired(schema),
    resolveFieldMetaAtPath: (schema, path, maxRecursionDepth) =>
      resolveFieldMetaAtPath(schema, path, maxRecursionDepth),
    issuesToValidationErrors: (issues, fk) =>
      zodIssuesToValidationErrors(issues as z.core.$ZodIssue[], fk),
    safeParseSync: (schema, data) => {
      const result = schema.safeParse(data) as z.ZodSafeParseResult<unknown>
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: result.error.issues }
    },
    safeParseAsync: async (schema, data) => {
      const result = (await schema.safeParseAsync(data)) as z.ZodSafeParseResult<unknown>
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: result.error.issues }
    },
    makeSubSchema: (schema, fk, maxRecursionDepth) =>
      buildSubSchemaStubV4<GetValueFormType>(schema, fk, maxRecursionDepth),
  }
}

// `runStrictGetDefaultsV4` infers its target shape from a single schema
// argument; this alias lets the service signature compose without the
// adapter having to repeat the ZodObject constraint inline.
type FormSchemaAlias<Form> = z.ZodType & { _output: Form }

/**
 * v4's construction-time `getDefaultValues` flow. Wraps the slim
 * default-value derivation (`getDefaultValuesFromZodSchema`) with a
 * strict-mode parse that surfaces refinement errors at construction,
 * with two pre-flight gates:
 *
 *   1. Async transforms (`z.preprocess(async fn, T)`) cannot be
 *      stripped — the transform's output shape is load-bearing for
 *      the inner schema's input. Skip the strict pass; the post-mount
 *      async pass picks up verdicts via `safeParseAsync`.
 *
 *   2. Async refines CAN be stripped (the predicate is detachable
 *      from the schema's shape). Strip them up front so the sync
 *      parse runs cleanly; sync-refinement seeds on supplied defaults
 *      still surface.
 *
 * Lax mode short-circuits: the validate-then-fix loop inside the slim
 * derivation has done everything it can; partial-valid state ships
 * over a mount-time exception.
 */
function runStrictGetDefaultsV4<Form>(
  rootSchema: z.ZodType & { _output: Form },
  config: GetDefaultValuesConfig<Form>,
  formKey: FormKey,
  maxRecursionDepth: number
): DefaultValuesResponse<Form> {
  const { data } = getDefaultValuesFromZodSchema<Form>({
    schema: rootSchema as unknown as z.ZodObject,
    useDefaultSchemaValues: config.useDefaultSchemaValues,
    constraints: config.constraints,
    maxRecursionDepth,
  })

  if (config.strict === false) {
    // Lax mode: see docblock — partial-valid initial state preferred
    // to a mount-time exception.
    return { data, errors: undefined, success: true, formKey }
  }

  if (containsAsyncTransform(rootSchema)) {
    return { data, errors: undefined, success: true, formKey }
  }

  const parseTarget = containsAsyncRefine(rootSchema) ? stripAsyncChecks(rootSchema) : rootSchema
  try {
    const strictResult = parseTarget.safeParse(data) as z.ZodSafeParseResult<Form>
    if (strictResult.success) {
      // Storage holds the pre-transform `z.input` view, so we return
      // the original `data` (already filled by
      // `getDefaultValuesFromZodSchema`) rather than `strictResult.data`
      // (the post-transform `z.output`). For schemas without
      // `.transform()` the two coincide; for schemas with one the
      // storage stays the honest input view that `form.values` reflects.
      return { data, errors: undefined, success: true, formKey }
    }
    return {
      data,
      errors: zodIssuesToValidationErrors(strictResult.error.issues, formKey),
      success: false,
      formKey,
    }
  } catch {
    // Defensive floor: the strip walker covers every ZodKind, but a
    // future Zod construct or a user-defined sync refine that itself
    // throws would land here. Mount cleanly; the post-mount async
    // pass is the source of truth for any verdict this code path
    // can't surface.
    return { data, errors: undefined, success: true, formKey }
  }
}

/**
 * Build the 5-method sub-schema stub that v4 returns from
 * `getSchemasAtPath`. Mirrors the shape consumers expect
 * (`fingerprint`, `needsAsyncValidation`, `getDefaultValues`,
 * `getSchemasAtPath: () => []`, `validateAtPath`) without re-walking
 * through the full factory — sub-schemas in the runtime are only
 * queried for `needsAsyncValidation`, so the stub is observationally
 * interchangeable with the recursive shape v3 returns.
 */
function buildSubSchemaStubV4<GetValueFormType extends GenericForm>(
  schema: z.ZodType,
  formKey: FormKey,
  maxRecursionDepth: number
): AbstractSchema<unknown, GetValueFormType> {
  return {
    fingerprint: () => fingerprintZodSchema(schema),
    needsAsyncValidation: () => containsAsyncRefine(schema),
    getDefaultValues: () => ({
      data: deriveDefault(schema, true, maxRecursionDepth) as unknown,
      errors: undefined,
      success: true,
      formKey,
    }),
    getSchemasAtPath: () => [],
    validateAtPath: async (data: unknown) => {
      // safeParseAsync accepts both sync and async refinements — sync
      // check perf is a microtask slower than safeParse but we trade
      // that for the ability to express .refine(async).
      const result = await schema.safeParseAsync(data)
      if (result.success) {
        return {
          data: result.data as GetValueFormType,
          errors: undefined,
          success: true,
          formKey,
        }
      }
      return {
        data: undefined,
        errors: zodIssuesToValidationErrors(result.error.issues, formKey),
        success: false,
        formKey,
      }
    },
  } as unknown as AbstractSchema<unknown, GetValueFormType>
}

/**
 * Resolve the field metadata for the schema node at `path`. Reads
 * the `fieldMeta` registry on the resolved Zod schema and applies
 * the precedence rules in `getFieldMetaAtPath`'s docblock:
 *
 *   - label: registry → humanize(lastSegment)
 *   - description: registry → schema.description (.describe()) → undefined
 *   - placeholder: registry → undefined
 *   - meta: registry payload (frozen) — empty object when absent
 *
 * Returns the empty resolution when the path doesn't resolve in the
 * schema. DU branches: first candidate wins (matches the existing
 * first-success precedent in `getDefaultAtPath` / `validateAtPath`).
 *
 * For shared schemas registered at multiple paths (the canonical
 * `addressSchema.register(fieldMeta, A); addressSchema.register(fieldMeta, B)`
 * footgun), the path-resolver builds a per-rootSchema path → payload
 * map by walking the schema tree once, counting per-schema
 * occurrences and pairing them with the registration list in
 * declaration order. Object literals evaluate left-to-right, so
 * registration order matches tree-walk order, and the mapping pairs
 * correctly.
 */
function resolveFieldMetaAtPath(
  rootSchema: z.ZodType,
  path: Path,
  maxRecursionDepth: number
): ResolvedFieldMeta {
  const lastSegment = path.length === 0 ? '' : (path[path.length - 1] as string | number)
  const candidates =
    path.length === 0
      ? [rootSchema]
      : getNestedZodSchemasAtPath(rootSchema, path, maxRecursionDepth)
  const target = candidates[0]
  if (target === undefined) {
    return {
      label: humanize(lastSegment),
      description: undefined,
      placeholder: undefined,
      meta: Object.freeze({}),
    }
  }
  // Path-keyed payload map (built once per rootSchema) disambiguates
  // shared schemas. Falls back to the schema-keyed registry for paths
  // not visited by the walker (e.g. dynamic discriminated-union
  // sub-paths the walker can't statically enumerate).
  const pathMap = getFieldMetaPathMap(rootSchema, {
    intro: V4_INTROSPECTOR,
    peelAllWrappers,
    getFieldMetaList,
  })
  const pathKey = canonicalizePath(path).key
  const peeled = peelAllWrappers(target)
  const payload =
    pathMap.get(pathKey) ??
    getFieldMeta(target) ??
    (peeled !== target ? getFieldMeta(peeled) : undefined)
  // `description` is exposed as a public property on Zod 4 schemas;
  // when set via `.describe('...')` or `.meta({ description })`, it
  // reads back as a string. Read from the target first; fall back to
  // the peeled inner so a `.describe()` on `z.string()` is still
  // visible when wrapped in `.optional()`.
  const targetDescription = readDescription(target)
  const peeledDescription = peeled !== target ? readDescription(peeled) : undefined
  const schemaDescription = targetDescription ?? peeledDescription
  return {
    label: payload?.label ?? humanize(lastSegment),
    description: payload?.description ?? schemaDescription ?? undefined,
    placeholder: payload?.placeholder ?? undefined,
    meta: Object.freeze({ ...(payload ?? {}) }),
  }
}

function readDescription(schema: z.ZodType): string | undefined {
  const candidate = (schema as z.ZodType & { description?: unknown }).description
  return typeof candidate === 'string' ? candidate : undefined
}

// Type-only re-export so downstream code can reference the Form shape.
export type { DeepPartial, GenericForm }
