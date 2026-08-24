// P7 rep sketch: sign-off 6 — prototype ZodSchemaAdapter absorbing
// abstract-schema-factory. One class hosts the 17 AbstractSchema
// methods calling the v4 helpers directly; the AbstractSchemaServices
// record and createAbstractSchema are gone from the graph.
import type { z } from 'zod'
import type {
  AbstractSchema,
  DefaultValuesResponse,
  FormKey,
  GetDefaultValuesConfig,
  ResolvedFieldMeta,
  SchemaFactoryOptions,
  SlimPrimitiveKind,
  UnionDiscriminatorContext,
  ValidationError,
  ValidationResponse,
  ValidateOptions,
} from 'TYPES/types-api'
import type { DeepPartial, GenericForm } from 'TYPES/types-core'
import { AttaformErrorCode } from 'CORE/error-codes'
import { canonicalizePath, type Path, type PathKey } from 'CORE/paths'
import {
  buildFieldMetaPathMap,
  getFieldMetaForSchema,
  getFieldMetaListForSchema,
} from 'CORE/field-meta-store'
import { humanize } from 'CORE/humanize'
import { assertSupportedKinds } from 'V4/assert-supported'
import { unwrapToDiscriminatedUnion } from 'V4/discriminator'
import { zodIssuesToValidationErrors } from 'V4/errors'
import { deriveDefault, getDefaultValuesFromZodSchema } from 'V4/default-values'
import type { SupportedRootSchema } from 'V4/types-root'
import {
  assertZodVersion,
  containsAsyncRefine,
  containsAsyncTransform,
  containsDiscriminatedUnion,
  getDiscriminatedOptions,
  getDiscriminator,
  getLiteralValues,
  getObjectShape,
  getTupleItems,
  getUnionOptions,
  hasContainerOrRootRefine,
  isCoercePrimitive,
  isPreprocessNode,
  kindOf,
  unwrapInner,
  unwrapLazy,
  unwrapPipe,
} from 'V4/introspect'
import { getNestedZodSchemasAtPath } from 'V4/path-walker'
import { slimPrimitivesOf } from 'V4/slim-primitives'
import { stripAsyncChecks } from 'V4/strip'
import { V4_INTROSPECTOR } from 'V4/walker-introspector'

const PATH_SEPARATOR = '.'

function unwrapStructuralWrappers(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema
  for (let i = 0; i < 64; i++) {
    const outerKind = kindOf(current)
    if (outerKind !== 'optional' && outerKind !== 'nullable') break
    const inner = unwrapInner(current)
    if (inner === undefined) return current
    if (!STRUCTURAL_KINDS.has(kindOf(inner))) break
    current = inner
  }
  return current
}

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

const MAX_REQUIRED_DEPTH = 64

function isLeafRequired(schema: z.ZodType, depth = 0): boolean {
  if (depth > MAX_REQUIRED_DEPTH) return true
  const kind = kindOf(schema)
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
  if (kind === 'readonly') {
    const inner = unwrapInner(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'pipe') {
    const inner = unwrapPipe(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'lazy') {
    const inner = unwrapLazy(schema)
    return inner === undefined ? true : isLeafRequired(inner, depth + 1)
  }
  if (kind === 'union' || kind === 'discriminated-union') {
    const options =
      kind === 'discriminated-union' ? getDiscriminatedOptions(schema) : getUnionOptions(schema)
    if (options.length === 0) return true
    return options.every((opt) => isLeafRequired(opt as z.ZodType, depth + 1))
  }
  if (kind === 'intersection') {
    const left = V4_INTROSPECTOR.getIntersectionLeft(schema)
    const right = V4_INTROSPECTOR.getIntersectionRight(schema)
    const leftReq = left === undefined ? true : isLeafRequired(left, depth + 1)
    const rightReq = right === undefined ? true : isLeafRequired(right, depth + 1)
    return leftReq || rightReq
  }
  return true
}

async function lazyFingerprint(schema: z.ZodType): Promise<string> {
  const { fingerprintZodSchema } = await import('V4/fingerprint')
  return fingerprintZodSchema(schema)
}

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

function runStrictGetDefaults<Form>(
  rootSchema: z.ZodType,
  config: GetDefaultValuesConfig<Form>,
  formKey: FormKey,
  maxRecursionDepth: number
): DefaultValuesResponse<Form> {
  const { data } = getDefaultValuesFromZodSchema<Form>({
    schema: rootSchema,
    useDefaultSchemaValues: config.useDefaultSchemaValues,
    constraints: config.constraints,
    maxRecursionDepth,
  })

  if (config.strict === false) {
    return { data, errors: undefined, success: true, formKey }
  }
  if (containsAsyncTransform(rootSchema)) {
    return { data, errors: undefined, success: true, formKey }
  }

  const parseTarget = containsAsyncRefine(rootSchema) ? stripAsyncChecks(rootSchema) : rootSchema
  try {
    const strictResult = parseTarget.safeParse(data) as z.ZodSafeParseResult<Form>
    if (strictResult.success) {
      return { data, errors: undefined, success: true, formKey }
    }
    return {
      data,
      errors: zodIssuesToValidationErrors(strictResult.error.issues),
      success: false,
      formKey,
    }
  } catch {
    return { data, errors: undefined, success: true, formKey }
  }
}

function buildSubSchemaStub<GetValueFormType extends GenericForm>(
  schema: z.ZodType,
  formKey: FormKey,
  maxRecursionDepth: number
): AbstractSchema<unknown, GetValueFormType> {
  return {
    fingerprint: () => lazyFingerprint(schema),
    needsAsyncValidation: () => containsAsyncRefine(schema),
    getDefaultValues: () => ({
      data: deriveDefault(schema, true, maxRecursionDepth) as unknown,
      errors: undefined,
      success: true,
      formKey,
    }),
    getSchemasAtPath: () => [],
    validateAtPath: async (data: unknown) => {
      const result = await schema.safeParseAsync(data)
      if (result.success) {
        return { data: result.data as GetValueFormType, errors: undefined, success: true, formKey }
      }
      return {
        data: undefined,
        errors: zodIssuesToValidationErrors(result.error.issues),
        success: false,
        formKey,
      }
    },
  } as unknown as AbstractSchema<unknown, GetValueFormType>
}

class ZodV4AbstractSchema<Form, GetValueFormType> {
  private readonly root: z.ZodType
  private readonly formKey: FormKey
  private readonly maxDepth: number
  private readonly leafCache = new Map<PathKey, boolean>()
  private readonly preprocessOrCoerceCache = new Map<PathKey, boolean>()
  private readonly discriminatorCache = new Map<PathKey, UnionDiscriminatorContext | undefined>()
  private asyncValidationFlag: boolean | null = null
  private containerRefineFlag: boolean | null = null
  private discriminatedUnionFlag: boolean | null = null

  constructor(rootSchema: z.ZodType, formKey: FormKey, options: SchemaFactoryOptions) {
    this.root = rootSchema
    this.formKey = formKey
    this.maxDepth = options.maxRecursionDepth
  }

  private resolveAt(path: Path): z.ZodType[] {
    return path.length === 0
      ? [this.root]
      : getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
  }

  fingerprint(): Promise<string> {
    return lazyFingerprint(this.root)
  }

  needsAsyncValidation(): boolean {
    this.asyncValidationFlag ??= containsAsyncRefine(this.root) || containsAsyncTransform(this.root)
    return this.asyncValidationFlag
  }

  hasContainerOrRootRefine(): boolean {
    this.containerRefineFlag ??= hasContainerOrRootRefine(this.root)
    return this.containerRefineFlag
  }

  hasDiscriminatedUnions(): boolean {
    this.discriminatedUnionFlag ??= containsDiscriminatedUnion(this.root)
    return this.discriminatedUnionFlag
  }

  getDefaultValues(config: GetDefaultValuesConfig<Form>): DefaultValuesResponse<Form> {
    return runStrictGetDefaults(this.root, config, this.formKey, this.maxDepth)
  }

  getDefaultAtPath(path: Path): unknown {
    if (path.length === 0) return deriveDefault(this.root, true, this.maxDepth)
    const [first] = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (first === undefined) return undefined
    return deriveDefault(unwrapStructuralWrappers(first), true, this.maxDepth)
  }

  getEmptyValueAtPath(path: Path): unknown {
    if (path.length === 0) return deriveDefault(this.root, false, this.maxDepth)
    const [first] = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (first === undefined) return undefined
    return deriveDefault(first, false, this.maxDepth)
  }

  arrayShapeAtPath(path: Path): number | null {
    if (path.length === 0) return null
    const [first] = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (first === undefined) return null
    const peeled = peelAllWrappers(first)
    if (kindOf(peeled) === 'tuple') return getTupleItems(peeled).length
    return null
  }

  isFixedObjectAtPath(path: Path): boolean {
    if (path.length === 0) return kindOf(peelAllWrappers(this.root)) === 'object'
    const resolved = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (resolved.length === 0) return false
    return resolved.every((s) => kindOf(peelAllWrappers(s)) === 'object')
  }

  getSchemasAtPath(path: Path): AbstractSchema<unknown, GetValueFormType>[] {
    const resolved = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (resolved.length === 0) return []
    return resolved.map((sub) =>
      buildSubSchemaStub<GetValueFormType & GenericForm>(sub, this.formKey, this.maxDepth)
    ) as AbstractSchema<unknown, GetValueFormType>[]
  }

  getSlimPrimitiveTypesAtPath(path: Path): Set<SlimPrimitiveKind> {
    if (path.length === 0) return new Set<SlimPrimitiveKind>(['object'])
    const resolved = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (resolved.length === 0) return new Set<SlimPrimitiveKind>()
    const out = new Set<SlimPrimitiveKind>()
    for (const candidate of resolved) {
      for (const k of slimPrimitivesOf(candidate, this.maxDepth)) out.add(k)
    }
    return out
  }

  isLeafAtPath(path: Path): boolean {
    const cacheKey = canonicalizePath(path).key
    const cached = this.leafCache.get(cacheKey)
    if (cached !== undefined) return cached
    const prim = this.getSlimPrimitiveTypesAtPath(path)
    const isLeaf =
      prim.size > 0 &&
      !prim.has('object') &&
      !prim.has('array') &&
      !prim.has('map') &&
      !prim.has('set')
    this.leafCache.set(cacheKey, isLeaf)
    return isLeaf
  }

  isPreprocessOrCoerceLeaf(path: Path): boolean {
    const cacheKey = canonicalizePath(path).key
    const cached = this.preprocessOrCoerceCache.get(cacheKey)
    if (cached !== undefined) return cached
    let hit = false
    for (let i = 0; i <= path.length && !hit; i++) {
      const candidates = this.resolveAt(path.slice(0, i))
      for (const candidate of candidates) {
        if (isCoercePrimitive(candidate) || isPreprocessNode(candidate)) {
          hit = true
          break
        }
      }
    }
    this.preprocessOrCoerceCache.set(cacheKey, hit)
    return hit
  }

  isRequiredAtPath(path: Path): boolean {
    if (path.length === 0) return true
    const resolved = getNestedZodSchemasAtPath(this.root, path, this.maxDepth)
    if (resolved.length === 0) return false
    return resolved.every((candidate) => isLeafRequired(candidate))
  }

  getFieldMetaAtPath(path: Path): ResolvedFieldMeta {
    return resolveFieldMetaAtPath(this.root, path, this.maxDepth)
  }

  getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined {
    const cacheKey = canonicalizePath(path).key
    if (this.discriminatorCache.has(cacheKey)) {
      return this.discriminatorCache.get(cacheKey)
    }
    const result = this.computeDiscriminator(path)
    this.discriminatorCache.set(cacheKey, result)
    return result
  }

  private computeDiscriminator(path: Path): UnionDiscriminatorContext | undefined {
    const candidates = this.resolveAt(path)
    let matchedUnion: z.ZodType | undefined
    for (const candidate of candidates) {
      const du = unwrapToDiscriminatedUnion(candidate)
      if (du === undefined) continue
      if (matchedUnion !== undefined && matchedUnion !== du) return undefined
      matchedUnion = du
    }
    if (matchedUnion === undefined) return undefined
    const discKey = getDiscriminator(matchedUnion)
    if (discKey === undefined) return undefined
    const unionOptions = getDiscriminatedOptions(matchedUnion)
    const literalSet = new Set<unknown>()
    for (const opt of unionOptions) {
      const shape = getObjectShape(opt)
      const litSchema = shape[discKey]
      if (litSchema === undefined) continue
      if (kindOf(litSchema) !== 'literal') continue
      for (const v of getLiteralValues(litSchema)) literalSet.add(v)
    }
    const maxDepth = this.maxDepth
    return {
      discriminatorKey: discKey,
      getVariantDefault(value: unknown): unknown {
        for (const opt of unionOptions) {
          const shape = getObjectShape(opt)
          const litSchema = shape[discKey]
          if (litSchema === undefined) continue
          if (kindOf(litSchema) !== 'literal') continue
          if (getLiteralValues(litSchema).includes(value)) {
            return deriveDefault(opt, true, maxDepth)
          }
        }
        return undefined
      },
      isVariantSelected(value: unknown): boolean {
        return literalSet.has(value)
      },
    }
  }

  validateAtPath(
    data: unknown,
    path: Path | undefined,
    validateOptions?: ValidateOptions
  ): ValidationResponse<GetValueFormType> | Promise<ValidationResponse<GetValueFormType>> {
    const formKey = this.formKey
    const resolveAt = (p: Path) => this.resolveAt(p)

    function parseResultToResponse(
      result: z.ZodSafeParseResult<unknown>
    ): ValidationResponse<GetValueFormType> {
      return result.success
        ? { data: result.data as GetValueFormType, errors: undefined, success: true, formKey }
        : {
            data: undefined,
            errors: zodIssuesToValidationErrors(result.error.issues),
            success: false,
            formKey,
          }
    }

    function runSync(): ValidationResponse<GetValueFormType> {
      if (path === undefined) {
        return parseResultToResponse(
          resolveAt([])[0]!.safeParse(data) as z.ZodSafeParseResult<unknown>
        )
      }
      const resolved = resolveAt(path)
      if (resolved.length === 0) return pathNotFound(path)
      const aggregated: ValidationError[] = []
      for (const candidate of resolved) {
        const response = parseResultToResponse(
          candidate.safeParse(data) as z.ZodSafeParseResult<unknown>
        )
        if (response.success) return response
        aggregated.push(...response.errors)
      }
      return { data: undefined, errors: aggregated, success: false, formKey }
    }

    async function runAsync(): Promise<ValidationResponse<GetValueFormType>> {
      const targets = path === undefined ? resolveAt([]) : resolveAt(path)
      if (targets.length === 0 && path !== undefined) return pathNotFound(path)
      const aggregated: ValidationError[] = []
      for (const candidate of targets) {
        let result: z.ZodSafeParseResult<unknown>
        try {
          result = (await candidate.safeParseAsync(data)) as z.ZodSafeParseResult<unknown>
        } catch (err) {
          return validatorThrewResponse(err, path ?? [])
        }
        const response = parseResultToResponse(result)
        if (response.success) return response
        aggregated.push(...response.errors)
      }
      return { data: undefined, errors: aggregated, success: false, formKey }
    }

    function validatorThrewResponse(
      err: unknown,
      errPath: Path
    ): ValidationResponse<GetValueFormType> {
      const message =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Validator threw'
      return {
        data: undefined,
        errors: [{ message, path: [...errPath], code: AttaformErrorCode.ValidatorThrew }],
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
            code: AttaformErrorCode.PathNotFound,
          },
        ],
        success: false,
        formKey,
      }
    }

    if (validateOptions?.sync === true) {
      try {
        return runSync()
      } catch {
        // Async-only schema — fall through.
      }
    }
    return runAsync()
  }
}

export function zodV4Adapter<
  FormSchema extends SupportedRootSchema,
  Form extends z.input<FormSchema>,
  GetValueFormType extends z.output<FormSchema> = z.output<FormSchema>,
>(
  rootSchema: FormSchema
): (formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, GetValueFormType> {
  assertZodVersion(rootSchema)
  assertSupportedKinds(rootSchema)
  return (formKey: FormKey, options: SchemaFactoryOptions) =>
    new ZodV4AbstractSchema<Form, GetValueFormType>(
      rootSchema,
      formKey,
      options
    ) as unknown as AbstractSchema<Form, GetValueFormType>
}

export type { DeepPartial, GenericForm }
