/**
 * The Zod v4 adapter: `AbstractSchema` implemented against Zod v4's
 * public surface. Internal `def.*` access is quarantined to
 * `introspect.ts` and the modules beside it (default-values,
 * path-walker, discriminator, errors), leaving this file as the wiring
 * between them and the `AbstractSchema` contract.
 *
 * It holds parity with the v3 adapter on three fronts:
 * `getDefaultValues`' validate-then-fix loop, delegated to
 * `default-values.ts`, with a DU-aware first-option fallback for
 * invalid_type issues; `getSchemasAtPath`' DU-aware path walk; and
 * `validateAtPath`'s per-branch parse with aggregated errors.
 */
import type { z } from 'zod'
import type {
  AbstractSchema,
  SchemaDefaultsResult,
  FormKey,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
  SchemaFactoryOptions,
} from '../../types/types-api'
import {
  createAbstractSchema,
  createSharedSchemaStore,
  type AbstractSchemaServices,
} from '../../core/abstract-schema-factory'
import {
  buildFieldMetaPathMap,
  getFieldMetaForSchema,
  getFieldMetaListForSchema,
} from '../../core/field-meta-store'
import { __DEV__ } from '../../core/dev'
import { AttaformError } from '../../core/errors'
import { humanize } from '../../core/humanize'
import { canonicalizePath, type Path } from '../../core/paths'
import type { DeepPartial, GenericForm } from '../../types/types-core'
import { unwrapToDiscriminatedUnion } from './discriminator'
import { zodIssuesToValidationErrors } from './errors'
import { deriveDefault, getDefaultValuesFromZodSchema } from './default-values'
import type { SupportedRootSchema } from './types-root'
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
import { V4_INTROSPECTOR } from './walker-introspector'

/**
 * Peel `.optional()` and `.nullable()` off a leaf ONLY when the inner
 * type is structurally fillable: an object, array, tuple, record, union,
 * intersection, or a peelable wrapper resolving to one. Peeling exposes
 * the inner shape's defaults, which is what lets a partial write through
 * an optional sub-schema fill them in: `setValue('profile', { name: 'X'
 * })` against `{ profile: z.object({...}).optional() }`.
 *
 * Over a PRIMITIVE inner the wrapper IS the meaningful schema:
 * `optional` says missing is allowed, `nullable` says null is. Peeling
 * an optional string to its inner would default the leaf to `''`, and
 * `mergeStructural` would then write `notes: ''` rather than `notes:
 * undefined` while filling sibling keys on the parent, overwriting the
 * optional's "absent" intent with a non-empty marker.
 *
 * `.default(x)` stays intact at every level so `deriveDefault` returns
 * the explicit value. The iteration is bounded against a pathological
 * wrapper chain.
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
 * A form root has to hold keys, a form being a set of addressable
 * fields. `z.object({ ... })` is the fixed-shape case, `z.record(K, V)`
 * the open dictionary, and `z.discriminatedUnion(disc, [...])` the
 * variant form whose active branch lifts its keys into one surface.
 * Everything else, a bare `z.string()` most obviously, has nothing to
 * address.
 *
 * This is the ONE place the adapter refuses a schema, and it refuses on
 * the absence of that single property rather than on a list of kinds
 * someone remembered to write down. Every kind stays welcome under a
 * key.
 *
 * `SupportedRootSchema` says the same thing in the type system, so a
 * TypeScript consumer meets it at the call site. This is the runtime
 * half, for a JavaScript consumer and for a schema reaching `useForm`
 * through a generic that erased the constraint. Without it, `z.string()`
 * builds a form whose entire value is `''`.
 */
function assertKeyedRoot(rootSchema: z.ZodType): void {
  const kind = kindOf(peelAllWrappers(rootSchema))
  if (kind === 'object' || kind === 'record' || kind === 'discriminated-union') return
  throw new AttaformError(
    __DEV__
      ? `[attaform/zod] useForm schema root must be a ZodObject, ZodRecord, or ` +
          `ZodDiscriminatedUnion (got '${kind}'). Wrap other shapes under a key.`
      : `[attaform] AF15 attaform.dev/e/af15 '${kind}'`
  )
}

/**
 * Peel EVERY transparent wrapper (optional, nullable, default, readonly,
 * catch, pipe, lazy) off `schema`, stopping at the first non-wrapper
 * kind. `arrayShapeAtPath` wants the inner kind whatever the
 * default-value semantic is, which is what separates this from
 * `unwrapStructuralWrappers`, where `.default()` survives so the runtime
 * fill returns the explicit value. Bounded against a pathological
 * wrapper chain.
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
 * The kinds `mergeStructural` can recurse into to fill a missing key or
 * pad a missing position. A primitive leaf or an opaque wrapper falls
 * outside, so peeling Optional or Nullable around one would drop the
 * wrapper's absent-or-null semantic and enable no fill in exchange.
 *
 * A wrapper counts as structural itself; `unwrapStructuralWrappers`
 * recurses to re-check its inner kind.
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
 * `true` when the leaf is required, `false` when any wrapper layer
 * admits empty through `.optional()`, `.nullable()`, `.default(N)` or
 * `.catch(N)`. `AbstractSchema.isRequiredAtPath` carries the full
 * semantics: a union is permissive, an intersection strict, and
 * readonly, pipe and lazy peel transparently.
 */
function isLeafRequired(schema: z.ZodType, depth = 0): boolean {
  if (depth > MAX_REQUIRED_DEPTH) return true
  const kind = kindOf(schema)
  // The wrappers that accept empty outright, plus the bare empty-marker
  // leaves: `z.undefined()`, `z.null()` and `z.void()` inside a union,
  // as in `z.union([z.number(), z.undefined()])`, are how an author says
  // a field may be absent without reaching for a wrapper.
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
  // Transparent wrappers: peel and re-check.
  if (kind === 'readonly') {
    const inner = unwrapInner(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'pipe') {
    // The input side, blank being a write-time concern.
    const inner = unwrapPipe(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'lazy') {
    const inner = unwrapLazy(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  // Required only if EVERY branch is: one permissive branch makes the
  // union permissive at parse time.
  if (kind === 'union' || kind === 'discriminated-union') {
    const options =
      kind === 'discriminated-union' ? getDiscriminatedOptions(schema) : getUnionOptions(schema)
    if (options.length === 0) return true
    return options.every((opt) => isLeafRequired(opt as z.ZodType, depth + 1))
  }
  // Required if EITHER side is: a parse has to satisfy both, so the
  // strict side governs.
  if (kind === 'intersection') {
    const left = getIntersectionLeft(schema)
    const right = getIntersectionRight(schema)
    const leftReq = left === undefined ? true : isLeafRequired(left, depth + 1)
    const rightReq = right === undefined ? true : isLeafRequired(right, depth + 1)
    return leftReq || rightReq
  }
  // Primitive leaf or unsupported kind: required.
  return true
}

/**
 * Wrap a Zod v4 schema in an `AbstractSchema` factory.
 *
 * `useForm` from `attaform/zod` does this for you, so reach for it to
 * use the adapter outside `useForm`: validating data with the same
 * library the form runtime uses, or handing the adapter to a custom
 * integration. The factory it returns takes per-form
 * `SchemaFactoryOptions`, and the adapter closure bakes them into every
 * downstream walk, so `maxRecursionDepth` can be lifted for one form
 * alone.
 *
 * Throws if the schema is not Zod v4, or if its root cannot hold keys.
 * No kind is refused anywhere BELOW the root: a leaf the walkers have no
 * case for is carried opaquely rather than rejected, so a schema a newer
 * Zod can parse is one Attaform can mount. Recursive `z.lazy(...)`
 * works, its descent bounded by `maxRecursionDepth`.
 */
export function zodV4Adapter<
  FormSchema extends SupportedRootSchema,
  Form extends z.input<FormSchema>,
  GetValueFormType extends z.output<FormSchema> = z.output<FormSchema>,
>(
  rootSchema: FormSchema
): (formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, GetValueFormType> {
  assertZodVersion(rootSchema)
  assertKeyedRoot(rootSchema)

  return (_formKey: FormKey, options: SchemaFactoryOptions) =>
    sharedV4Schemas(rootSchema, options.maxRecursionDepth, () =>
      createAbstractSchema<z.ZodType, Form, GetValueFormType>(
        rootSchema,
        V4_INTROSPECTOR,
        buildV4Services<Form, GetValueFormType>(),
        options
      )
    )
}

/**
 * v4's store of shared `AbstractSchema` instances, keyed weakly on the
 * root schema. See `createSharedSchemaStore`.
 */
const sharedV4Schemas = createSharedSchemaStore()

/**
 * Build the v4 `AbstractSchemaServices` instance. The services are
 * stateless: every method takes the schema it acts on plus the
 * factory-supplied `formKey` and `maxRecursionDepth`. Generic in `Form`
 * and `GetValueFormType` so `runGetDefaults` and `makeSubSchema`
 * propagate the form shape.
 */
function buildV4Services<
  Form extends GenericForm,
  GetValueFormType extends GenericForm,
>(): AbstractSchemaServices<z.ZodType, Form, GetValueFormType> {
  return {
    getNestedSchemasAtPath: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodObject, path, maxRecursionDepth),
    // No pre-strip for the slim-mode walk: the path walker peels every
    // transparent wrapper inline, so the slim and unstripped walks
    // coincide.
    getNestedSchemasInSlimMode: (schema, path, maxRecursionDepth) =>
      getNestedZodSchemasAtPath(schema as z.ZodObject, path, maxRecursionDepth),
    slimPrimitivesOf: (schema, maxRecursionDepth) => slimPrimitivesOf(schema, maxRecursionDepth),
    deriveDefault: (schema, useDefault, maxRecursionDepth) =>
      deriveDefault(schema, useDefault, maxRecursionDepth),
    runGetDefaults: (schema, config, maxRecursionDepth) =>
      runGetDefaultsV4<Form>(schema as FormSchemaAlias<Form>, config, maxRecursionDepth),
    unwrapStructuralWrappers: (schema) => unwrapStructuralWrappers(schema),
    unwrapToDiscriminatedUnion: (schema) => unwrapToDiscriminatedUnion(schema),
    peelAllWrappers: (schema) => peelAllWrappers(schema),
    isLeafRequired: (schema) => isLeafRequired(schema),
    resolveFieldMetaAtPath: (schema, path, maxRecursionDepth) =>
      resolveFieldMetaAtPath(schema, path, maxRecursionDepth),
    issuesToValidationErrors: (issues) => zodIssuesToValidationErrors(issues as z.core.$ZodIssue[]),
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
    makeSubSchema: (schema, maxRecursionDepth) =>
      buildSubSchemaStubV4<GetValueFormType>(schema, maxRecursionDepth),
  }
}

// `runGetDefaultsV4` infers its target shape from one schema argument,
// and this alias lets the service signature compose without repeating
// the ZodObject constraint inline.
type FormSchemaAlias<Form> = z.ZodType & { _output: Form }

/**
 * v4's construction-time `getDefaultValues` flow: wrap the slim
 * derivation in `getDefaultValuesFromZodSchema` with a parse against the
 * REAL schema, so refinement errors surface at construction.
 *
 * A schema carrying async work of any kind skips that parse and leaves
 * every verdict to the post-mount `safeParseAsync` pass. See the gate
 * below for why the async-refine half is handled the same way as the
 * async-transform half.
 */
function runGetDefaultsV4<Form>(
  rootSchema: z.ZodType & { _output: Form },
  config: GetDefaultValuesConfig<Form>,
  maxRecursionDepth: number
): SchemaDefaultsResult<Form> {
  const { data } = getDefaultValuesFromZodSchema<Form>({
    schema: rootSchema,
    useDefaultSchemaValues: config.useDefaultSchemaValues,
    constraints: config.constraints,
    maxRecursionDepth,
  })

  // Async work of ANY kind skips the construction parse, refine and
  // transform alike. A transform has no choice: its output shape is
  // load-bearing for the inner schema's input, so there is nothing sound
  // to parse against. A refine could in principle be stripped out so the
  // sync checks beside it still seed, but only by carrying a second,
  // parallel understanding of every Zod kind, which drifts from the
  // original with nothing to notice.
  //
  // The cost of not doing that is timing alone, and only on a schema
  // mixing sync and async: its sync violations seed one async pass later
  // than an async-free twin's, so on SSR a submit button bound to
  // `meta.valid` renders enabled and then disables. The post-mount pass
  // is the source of truth for every verdict either way.
  if (containsAsyncTransform(rootSchema) || containsAsyncRefine(rootSchema)) {
    return { data, errors: undefined, success: true }
  }

  try {
    const parseResult = rootSchema.safeParse(data) as z.ZodSafeParseResult<Form>
    if (parseResult.success) {
      // Storage holds the pre-transform `z.input` view, so return the
      // original `data` rather than `parseResult.data`, which is the
      // post-transform `z.output`. The two coincide without a
      // `.transform()`; with one, storage stays the honest input view
      // that `form.values` reflects.
      return { data, errors: undefined, success: true }
    }
    return {
      data,
      errors: zodIssuesToValidationErrors(parseResult.error.issues),
      success: false,
    }
  } catch {
    // Defensive floor for a future Zod construct, or a user sync refine
    // that throws. Mount clean; the post-mount async pass is the source
    // of truth for any verdict this path cannot surface.
    return { data, errors: undefined, success: true }
  }
}

/**
 * The sub-schema stub v4 returns from `getSchemasAtPath`. It carries the
 * shape consumers expect (`needsAsyncValidation`, `getDefaultValues`,
 * `getSchemasAtPath: () => []`, `validateAtPath`) without re-walking the
 * full factory. The runtime only ever asks a sub-schema for
 * `needsAsyncValidation`, so the stub is observationally
 * interchangeable with the recursive shape v3 returns.
 */
function buildSubSchemaStubV4<GetValueFormType extends GenericForm>(
  schema: z.ZodType,
  maxRecursionDepth: number
): AbstractSchema<unknown, GetValueFormType> {
  return {
    needsAsyncValidation: () => containsAsyncRefine(schema),
    getDefaultValues: () => ({
      data: deriveDefault(schema, true, maxRecursionDepth) as unknown,
      errors: undefined,
      success: true,
    }),
    getSchemasAtPath: () => [],
    validateAtPath: async (data: unknown) => {
      // `safeParseAsync` accepts sync and async refinements alike. A
      // sync check costs a microtask more than `safeParse` would, which
      // buys the ability to express `.refine(async)`.
      const result = await schema.safeParseAsync(data)
      if (result.success) {
        return {
          data: result.data as GetValueFormType,
          errors: undefined,
          success: true,
        }
      }
      return {
        data: undefined,
        errors: zodIssuesToValidationErrors(result.error.issues),
        success: false,
      }
    },
  } as unknown as AbstractSchema<unknown, GetValueFormType>
}

/**
 * Resolve the field metadata at `path`, reading the `fieldMeta` registry
 * on the resolved schema under the precedence `getFieldMetaAtPath`
 * documents:
 *
 *   - label: registry, else `humanize(lastSegment)`
 *   - description: registry, else `.describe()`, else undefined
 *   - placeholder: registry, else undefined
 *   - meta: the frozen registry payload, `{}` when absent
 *
 * A path that does not resolve gives the empty resolution. Across DU
 * branches the first candidate wins, as in `getDefaultAtPath` and
 * `validateAtPath`.
 *
 * One schema instance registered at several paths, the canonical
 * `addressSchema.register(fieldMeta, A); addressSchema.register(fieldMeta,
 * B)`, goes through a per-rootSchema path-to-payload map built by
 * walking the tree once, counting per-schema occurrences and pairing
 * them with the registration list in declaration order. Object literals
 * evaluate left to right, so registration order matches tree-walk order
 * and the pairing holds.
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
  // Built once per rootSchema, and what disambiguates a shared schema; a
  // path the walker never visits, a dynamic DU sub-path it cannot
  // statically enumerate say, falls back to the schema-keyed registry.
  // The walk sits behind the store's builder slot, installed by
  // `withMeta` and `fieldMeta.add`, so a consumer who registers no
  // metadata gets neither the walk nor the map.
  const pathMap = buildFieldMetaPathMap(rootSchema, {
    intro: V4_INTROSPECTOR,
    peelAllWrappers,
    getFieldMetaList: getFieldMetaListForSchema,
  })
  const pathKey = canonicalizePath(path).key
  const peeled = peelAllWrappers(target)
  const payload =
    pathMap?.get(pathKey) ??
    getFieldMetaForSchema(target) ??
    (peeled !== target ? getFieldMetaForSchema(peeled) : undefined)
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
