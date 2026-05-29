import { cloneDeep, isFunction } from 'lodash-es'
// Imports zod v3 via the pnpm alias defined in devDependencies; the
// published bundle rewrites this specifier back to 'zod' via the build
// step (see build.config.ts). Consumers of `attaform/zod-v3`
// install zod@3 themselves and the resolved import works.
import { z } from 'zod-v3'
import type {
  AbstractSchema,
  FormKey,
  ResolvedFieldMeta,
  SlimPrimitiveKind,
  UnionDiscriminatorContext,
  ValidationError,
  ValidationResponse,
} from '../../types/types-api'
import { getAtPath, isPlainRecord, setAtPath } from '../../core/path-walker'
import type { SchemaFactoryOptions } from '../../core/get-computed-schema'
import { humanize } from '../../core/humanize'
import { canonicalizePath, type Path, type PathKey } from '../../core/paths'
import { slimKindOf } from '../../core/slim-primitive-gate'
import type { FieldMetaPayload } from '../../core/field-meta'
import { getFieldMeta, getFieldMetaList } from './field-meta'

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

/**
 * Deep-merge two values for default-derivation. Mirrors v4's
 * `mergeDeep` (`default-values.ts:308`) exactly so the v3 + v4
 * constraint-merge semantic matches:
 *
 *   - `undefined` override → keep base
 *   - non-plain-record override (primitive, array, `Date`, `Map`,
 *     class instance, `null`) → REPLACE base wholesale (NOT lodash's
 *     element-wise array merge; explicit `null` clears a nullable
 *     default rather than being silently dropped)
 *   - plain-record override + plain-record base → recurse per-key
 *   - plain-record override + non-plain-record base → replace
 *     wholesale
 *
 * Local duplication of v4's helper; Phase 12's `createAbstractSchema`
 * factory will dedup against `ADAPT-D5` (validate-then-fix
 * `getDefaultValues` loop). Pre-1.0 with no users so the temporary
 * duplication carries no compat tail.
 */
function mergeDeepV3(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (!isPlainRecord(override)) return override
  if (!isPlainRecord(base)) return override
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const oVal = override[key]
    const bVal = base[key]
    if (isPlainRecord(oVal) && isPlainRecord(bVal)) {
      result[key] = mergeDeepV3(bVal, oVal)
    } else {
      result[key] = oVal
    }
  }
  return result
}

import { __DEV__ } from '../../core/dev'
import { AttaformErrorCode } from '../../core/error-codes'
import type { TypeWithNullableDynamicKeys } from './types-zod'
// `ZodTypeWithInnerType` lives in types-zod.ts and is re-exported from
// `attaform/zod-v3` as a narrow accessor type for custom-adapter
// authors. Phase 7's introspect chokepoint means the v3 adapter no
// longer reads `_def` directly inline; the public type stays available
// for downstream consumers writing adapter-shaped code.
import { assertSupportedKinds } from './assert-supported'
import { fingerprintZodSchema } from './fingerprint'
import { isZodSchemaType } from './helpers'
import {
  containsAsyncRefine,
  containsAsyncTransform,
  getArrayElement,
  getCatchDefault,
  getDefaultValue as getDefaultValueFromIntrospect,
  getDiscriminatedOptions,
  getDiscriminator,
  getEffectsKind,
  getIntersectionLeft,
  getIntersectionRight,
  getLiteralValue,
  getLiteralValues,
  getNativeEnumValues,
  getObjectShape,
  getRecordKeyType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getTypeName,
  getUnionOptions,
  hasCatchValue,
  hasChecks,
  hasContainerOrRootRefine,
  isCoercePrimitive,
  kindOf,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
} from './introspect'
import { slimPrimitivesV3 } from './slim-primitives'

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
  function getAbstractSchema(
    _formKey: FormKey,
    _zodSchema: FormSchema,
    _isRootSchema: boolean,
    _maxRecursionDepth: number
  ): AbstractSchema<Form, GetValueFormType> {
    if (_isRootSchema) {
      // Walk the original schema (not the stripped one) so the assert
      // descends through user-declared wrappers (`.optional()`,
      // `.nullable()`, `.default()`) before checking each leaf. Throws
      // for kinds we can't represent — `z.promise`, `z.function`,
      // `z.map`, `z.symbol` — and for self-referencing `z.lazy(...)`.
      assertSupportedKinds(_zodSchema)
      const [_schema] = stripRootSchema(_zodSchema, {
        stripDefaultValues: true,
        stripNullable: true,
        stripOptional: true,
        stripZodEffects: true,
        stripZodRefinements: true,
      })
      if (!isZodSchemaType(_schema, 'ZodObject')) {
        const name = getTypeName(_schema)
        throw new Error(`ZodAdapter: expected ZodObject, got ${name}`)
      }
    }
    // Per-adapter `isLeafAtPath` cache. Lifetime = one adapter instance
    // (one per `useForm()` call). Memoises the slim-primitive walk so
    // the leaf-aware proxy traps don't re-walk the schema on every read.
    const leafCache = new Map<PathKey, boolean>()
    // Per-adapter cache for the preprocess predicate. The slim-primitive
    // write gate consults it at every level of value-tree descent.
    const preprocessOrCoerceCache = new Map<PathKey, boolean>()
    // Per-adapter cache for `getUnionDiscriminatorAtPath`. The walker
    // path is consulted on every `setValue` and every `form.meta` read
    // (every ancestor segment, every time), and the result is a pure
    // function of (schema, path) — once computed it never changes for
    // the lifetime of the adapter. Caches both positive and negative
    // (no-DU) results so the common no-DU schema pays the walk cost
    // once per path instead of per keystroke.
    const discriminatorCache = new Map<PathKey, UnionDiscriminatorContext | undefined>()

    function computeDiscriminator(path: Path): UnionDiscriminatorContext | undefined {
      const candidates =
        path.length === 0
          ? [_zodSchema as z.ZodTypeAny]
          : (getNestedZodSchemasAtPath(_zodSchema, path, _maxRecursionDepth) as z.ZodTypeAny[])
      // `unwrapToDiscriminatedUnion` peels every transparent wrapper
      // (Optional / Nullable / Default / Readonly / Catch / Effects /
      // Pipeline / Branded) and descends ZodIntersection sides looking
      // for a single discriminated union. Ambiguous resolutions (two
      // distinct DUs both reachable across candidates) bail — the
      // runtime then falls back to a plain write.
      let matchedUnion: z.ZodTypeAny | undefined
      for (const candidate of candidates) {
        const du = unwrapToDiscriminatedUnion(candidate)
        if (du === undefined) continue
        if (matchedUnion !== undefined && matchedUnion !== du) return undefined
        matchedUnion = du
      }
      if (matchedUnion === undefined) return undefined
      const discKey = getDiscriminator(matchedUnion)
      if (discKey === undefined) return undefined
      const options = getDiscriminatedOptions(matchedUnion)
      const literalSet = new Set<unknown>()
      for (const opt of options) {
        const litSchema = opt.shape[discKey] as z.ZodTypeAny | undefined
        if (!litSchema) continue
        if (!isZodSchemaType(litSchema, 'ZodLiteral')) continue
        // `getLiteralValues` returns every value the literal admits as
        // an array, so multi-value `z.literal(['a','b'])` registers
        // both 'a' and 'b' as selectable variants.
        for (const v of getLiteralValues(litSchema)) literalSet.add(v)
      }
      return {
        discriminatorKey: discKey,
        getVariantDefault(value: unknown): unknown {
          for (const opt of options) {
            const litSchema = opt.shape[discKey] as z.ZodTypeAny | undefined
            if (!litSchema) continue
            if (!isZodSchemaType(litSchema, 'ZodLiteral')) continue
            const values = getLiteralValues(litSchema)
            if (values.includes(value)) {
              return getDefaultValuesFromZodSchema(opt as unknown as z.ZodSchema, true, _formKey)
            }
          }
          return undefined
        },
        isVariantSelected(value: unknown): boolean {
          return literalSet.has(value)
        },
      }
    }

    // Memoised one-shot walk; `hasContainerOrRootRefine` is queried at
    // every per-keystroke schedule to pick whole-form vs subtree
    // scope, so the walk pays for itself within the first few
    // mutations.
    let containerRefineFlag: boolean | null = null
    // Same lazy-memo pattern as the container-refine flag.
    // `needsAsyncValidation` is queried at construction by the store to
    // gate `firstValidationDone` + the construction-time async seed,
    // and possibly again from devtools; one tree traversal earns its
    // keep across the adapter's lifetime.
    let asyncValidationFlag: boolean | null = null

    const abstractSchema: AbstractSchema<Form, GetValueFormType> = {
      fingerprint: () => fingerprintZodSchema(_zodSchema),

      needsAsyncValidation(): boolean {
        asyncValidationFlag ??=
          containsAsyncRefine(_zodSchema) || containsAsyncTransform(_zodSchema)
        return asyncValidationFlag
      },

      hasContainerOrRootRefine(): boolean {
        containerRefineFlag ??= hasContainerOrRootRefine(_zodSchema)
        return containerRefineFlag
      },
      getDefaultValues(config) {
        const defaultValuesWithoutConstraints = getDefaultValuesFromZodSchema(
          _zodSchema,
          config.useDefaultSchemaValues,
          _formKey
        )

        const slimSchema = getSlimSchema({
          schema: _zodSchema,
          stripConfig: {
            stripZodEffects: true,
            stripDefaultValues: true,
            // `strict: false` strips refinements (so empty defaults
            // pass); strict keeps them so the slim parse below
            // surfaces refinement errors. Async refines are guarded
            // by the try/catch below — they can't be surfaced
            // synchronously regardless.
            stripZodRefinements: (config.strict ?? true) === false,
          },
        })

        let rawDefaultValues = defaultValuesWithoutConstraints
        if (!isPrimitive(rawDefaultValues)) {
          // `mergeDeepV3` (NOT lodash `merge`) so arrays replace
          // wholesale and explicit `null`/`undefined` overrides survive,
          // matching v4's `mergeDeep` semantic.
          rawDefaultValues = mergeDeepV3(defaultValuesWithoutConstraints, config.constraints)
        } else if (constraintsAreSlimValid(slimSchema, config.constraints)) {
          rawDefaultValues = config.constraints
        }

        // `safeParse` throws synchronously when the schema contains an
        // async refine ("Async refinement encountered during synchronous
        // parse"). Async refines can't be surfaced synchronously
        // regardless — the abstract `getDefaultValues` contract is sync.
        // Degrade gracefully: treat the schema as if it parsed cleanly,
        // so the form mounts. The first user mutation kicks off
        // `validateAtPath`, which uses `safeParseAsync`.
        //
        // Note on parity with the v4 adapter: v4 ships a sync-only
        // retry path (`stripAsyncChecks`) so sync refinement errors
        // on `defaultValues` still seed at construction even when an
        // async sibling poisons the sync entry point. v3 carries the
        // same conceptual bug, but its slim-schema strategy strips
        // ALL `ZodEffects` wrappers at construction time and v3
        // stores refinements in a wrapper whose sync-vs-async
        // character can only be observed at parse time (not via
        // static introspection — the wrapper itself is a regular
        // function regardless of the user's predicate). Lifting v3
        // to v4's seeding contract requires either a probe-and-parse
        // detection scheme (with user-predicate side-effect risk) or
        // a slim-schema redesign that preserves effects in strict
        // mode. Both are larger work items than this fix targets and
        // are tracked for follow-up.
        let parseResult: ReturnType<typeof slimSchema.safeParse>
        try {
          parseResult = slimSchema.safeParse(rawDefaultValues)
        } catch {
          return {
            data: rawDefaultValues as Form,
            errors: undefined,
            success: true,
            formKey: _formKey,
          }
        }
        const { data, success, error } = parseResult

        if (success) {
          return {
            data: data as Form,
            errors: undefined,
            success,
            formKey: _formKey,
          }
        }

        let fixedData = {}

        // `if (success) return ...` above handles the happy path; below we're
        // always in the failure case.
        //
        // Under the slim-primitive write contract, the validate-then-fix
        // loop only patches issues that violate STRUCTURAL or PRIMITIVE-TYPE
        // shape. Refinement-level issues (invalid_enum_value, invalid_literal,
        // invalid_string, too_small, too_big, custom, unrecognized_keys)
        // pass THROUGH unchanged — the user's defaultValues are preserved
        // verbatim and the strict-mode validation pass downstream surfaces
        // the error at construction.
        //
        // The classifier: look up the actual offending value at the issue's
        // path and check its slim primitive kind against the candidate
        // schema's slim primitive set. If the value's kind IS in the set,
        // the issue is refinement-level → skip. If it's NOT in the set,
        // the issue is primitive/structural → fix. Unifies every issue
        // code under one check.
        {
          for (const issue of error.issues) {
            const schemasAtPath = getNestedZodSchemasAtPath(
              slimSchema,
              issue.path,
              _maxRecursionDepth
            )
            // `set` from lodash accepts a Segment[] directly; keeps the
            // literal-dot case (`['user.name']`) from being flattened
            // into two key accesses. Coerce in case a custom check
            // smuggled a Symbol — `path.join` would throw on it.
            const path = coercePathSegments(issue.path)
            if (!schemasAtPath.length) {
              console.error(
                `[attaform] zod-v3 adapter: no schema at path ` +
                  `'${path.join(PATH_SEPARATOR)}' for key '${_formKey}'. ` +
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
                      formKey: _formKey,
                      discriminator: {
                        isDiscriminatorKey: true,
                        schema: schemaAtPath,
                        useDefaultSchemaValues: false,
                      },
                    }
                  : {
                      formKey: _formKey,
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
              // against a string-enum). Fall back to the schema's default.
              const [defaultValue, found] = unwrapDefault(schemaAtPath)
              if (found) {
                fixedData = setAtPath(fixedData, path, defaultValue) as Record<string, unknown>
                continue
              }
              // Last-ditch: derive a default for the schema kind at this
              // path. Skips if no useful default emerges.
              const ctx: DefaultValueContext = {
                formKey: _formKey,
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
          // `mergeDeepV3` so the fix-up overrides the raw defaults
          // with copy-on-write semantics matching v4 (array replace,
          // null/undefined clears honored).
          fixedData = mergeDeepV3(rawDefaultValues, fixedData) as Record<string, unknown>
        }

        // Best-effort re-parse: if the fix-up loop couldn't fully
        // reconcile the data (nested unions whose branches don't match
        // the defaulted shape, bigint edge cases), return the partial
        // data instead of throwing. Matches the v4 adapter's lax
        // semantics — a partially-valid initial state is preferable
        // to a mount-time exception.
        const secondParse = slimSchema.safeParse(fixedData)
        const finalData = secondParse.success ? secondParse.data : fixedData

        if ((config.strict ?? true) === false) {
          return {
            data: finalData as Form,
            errors: undefined,
            success: true,
            formKey: _formKey,
          }
        }

        // Strict mode: if the second parse succeeded, the fix-up loop
        // reconciled the data and the issues from the first parse no
        // longer apply. Report success. Only surface the first-parse
        // issues when the fix-up couldn't resolve them.
        if (secondParse.success) {
          return {
            data: finalData as Form,
            errors: undefined,
            success: true,
            formKey: _formKey,
          }
        }

        return {
          data: finalData as Form,
          errors: zodIssuesToValidationErrors(error.issues, _formKey),
          success: false,
          formKey: _formKey,
        }
      },
      getDefaultAtPath(path) {
        // Empty path → root default. Reuses the same generator used at
        // form construction so refines / wrappers behave consistently.
        if (path.length === 0) {
          return getDefaultValuesFromZodSchema(_zodSchema, true, _formKey)
        }
        const [leaf] = getNestedZodSchemasAtPath(_zodSchema, path, _maxRecursionDepth)
        if (!leaf) return undefined
        // STRUCTURAL default: peel `.optional()` / `.nullable()` at the
        // leaf so partial-object writes through optional sub-schemas
        // (`{ profile: z.object({...}).optional() }`) get the inner
        // shape's defaults filled in. `.default(x)` is preserved so
        // `getDefaultValuesFromZodSchema` returns the explicit default.
        const peeled = unwrapStructuralLeafV3(leaf)
        return getDefaultValuesFromZodSchema(peeled as z.ZodSchema, true, _formKey)
      },
      getEmptyValueAtPath(path) {
        // `clear`'s underlying value lookup. Same path-resolution flow
        // as `getDefaultAtPath` but with `useDefaultSchemaValues=false`
        // so `.default(x)` / `.catch(x)` wrappers are skipped — the
        // walker yields the inner-schema's empty concrete instead.
        // Structural wrappers (`.optional()` / `.nullable()`) are NOT
        // peeled here: clearing an `.optional()` slot is legitimately
        // `undefined`, clearing a `.nullable()` slot is `null`.
        if (path.length === 0) {
          return getDefaultValuesFromZodSchema(_zodSchema, false, _formKey)
        }
        const [leaf] = getNestedZodSchemasAtPath(_zodSchema, path, _maxRecursionDepth)
        if (!leaf) return undefined
        return getDefaultValuesFromZodSchema(leaf as z.ZodSchema, false, _formKey)
      },
      arrayShapeAtPath(path) {
        if (path.length === 0) return undefined
        const [leaf] = getNestedZodSchemasAtPath(_zodSchema, path, _maxRecursionDepth)
        if (!leaf) return undefined
        // The walker preserves the TERMINAL wrapper at the leaf — peel
        // every transparent wrapper here so we see the structural kind.
        // `peelV3Wrappers` peels Optional / Nullable / Default / Readonly
        // / Effects / Pipeline / Branded; catch is peeled by hand since
        // `peelV3Wrappers` preserves it for `unwrapDefault`'s use.
        let peeled = peelV3Wrappers(leaf)
        for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
          if (!isZodSchemaType(peeled, 'ZodCatch')) break
          const inner = unwrapInner(peeled)
          if (!inner) break
          peeled = peelV3Wrappers(inner)
        }
        if (isZodSchemaType(peeled, 'ZodTuple')) return getTupleItems(peeled).length
        if (isZodSchemaType(peeled, 'ZodArray')) return null
        return undefined
      },
      getSchemasAtPath(path) {
        const [strippedSchema] = stripRootSchema(_zodSchema, {
          stripDefaultValues: true,
          stripNullable: true,
          stripOptional: true,
          stripZodEffects: true,
        })
        const slimSchema = getSlimSchema({
          schema: strippedSchema,
          stripConfig: {
            stripDefaultValues: true,
            stripZodEffects: true,
          },
        })
        const nestedZodSchemas = getNestedZodSchemasAtPath(slimSchema, path, _maxRecursionDepth)

        // Empty list is a valid result for paths the schema doesn't
        // declare — callers (getValue / register / custom introspection)
        // treat `[]` as "no sub-schema here". No warning needed.
        if (!nestedZodSchemas.length) return []

        return nestedZodSchemas.map((n) =>
          getAbstractSchema(_formKey, n as unknown as FormSchema, false, _maxRecursionDepth)
        ) as unknown as AbstractSchema<unknown, GetValueFormType>[]
      },
      isRequiredAtPath(path) {
        // Root form is structurally required (it's the parsed object).
        // The required-empty check tracks primitive leaves only, so this
        // branch is academic for the call sites that matter.
        if (path.length === 0) return true
        // The unified walker descends through structural shapes and peels
        // wrappers between segments while preserving the terminal
        // wrapper at the path's leaf — `path: ['name']` against
        // `z.object({ name: z.optional(z.string()) })` returns the
        // optional wrapper itself, which is what we need to inspect.
        //
        // For paths that traverse a union the walker returns one
        // resolution per branch. The slot is required only if EVERY
        // branch is required at that path — any permissive branch
        // makes the union permissive at parse time. Mirrors v4's
        // `resolved.every(isLeafRequired)`.
        const resolved = getNestedZodSchemasAtPath(_zodSchema, path, _maxRecursionDepth)
        if (resolved.length === 0) return false
        return resolved.every((candidate) => isLeafRequiredV3(candidate))
      },
      getFieldMetaAtPath(path): ResolvedFieldMeta {
        return resolveFieldMetaAtPathV3(_zodSchema, path, _maxRecursionDepth)
      },

      getUnionDiscriminatorAtPath(path): UnionDiscriminatorContext | undefined {
        // Resolve every candidate at `path`; pick the unique one that
        // is (or wraps) a discriminated union. `peelV3Wrappers` peels
        // optional / nullable / default / effects / pipeline / readonly
        // / branded.
        const cacheKey = canonicalizePath(path).key
        if (discriminatorCache.has(cacheKey)) {
          return discriminatorCache.get(cacheKey)
        }
        const result = computeDiscriminator(path)
        discriminatorCache.set(cacheKey, result)
        return result
      },
      getSlimPrimitiveTypesAtPath(path) {
        if (path.length === 0) return new Set(['object'])
        const [strippedSchema] = stripRootSchema(_zodSchema, {
          stripDefaultValues: true,
          stripNullable: true,
          stripOptional: true,
          stripZodEffects: true,
        })
        const slimSchema = getSlimSchema({
          schema: strippedSchema,
          stripConfig: { stripDefaultValues: true, stripZodEffects: true },
        })
        const resolved = getNestedZodSchemasAtPath(slimSchema, path, _maxRecursionDepth)
        // Path doesn't resolve in the schema → no kinds accepted.
        // The gate's membership check rejects every kind against an
        // empty set, blocking writes to typo / unknown paths.
        if (resolved.length === 0) return new Set()
        const out = new Set<SlimPrimitiveKind>()
        for (const candidate of resolved) {
          for (const k of slimPrimitivesV3(candidate as z.ZodTypeAny)) out.add(k)
        }
        return out
      },
      isLeafAtPath(path) {
        const cacheKey = canonicalizePath(path).key
        const cached = leafCache.get(cacheKey)
        if (cached !== undefined) return cached
        const prim = abstractSchema.getSlimPrimitiveTypesAtPath(path)
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
      isPreprocessOrCoerceLeaf(path) {
        // Walks prefixes of `path` looking for either shape v3 uses for
        // schema-side input normalizers:
        //   - `z.preprocess(fn, inner)` — a `ZodEffects` whose
        //     `effect.type === 'preprocess'` (`getEffectsKind`).
        //   - `z.coerce.X()` — a primitive schema (ZodString /
        //     ZodNumber / etc.) carrying `_def.coerce === true`
        //     (`isCoercePrimitive`). v3's coerce is a flag on the
        //     wrapped primitive's def rather than a wrapper, so the
        //     typeName stays `ZodString` etc.; the gate still needs to
        //     recognise the coerce intent so raw consumer writes pass
        //     through verbatim, matching v4.
        // Returns true at such a node OR anywhere underneath it; the
        // slim-primitive gate uses this to accept raw consumer writes
        // verbatim throughout that subtree.
        const cacheKey = canonicalizePath(path).key
        const cached = preprocessOrCoerceCache.get(cacheKey)
        if (cached !== undefined) return cached
        let hit = false
        for (let i = 0; i <= path.length && !hit; i++) {
          const prefix = path.slice(0, i)
          const candidates: z.ZodTypeAny[] =
            prefix.length === 0
              ? [_zodSchema as z.ZodTypeAny]
              : (getNestedZodSchemasAtPath(
                  _zodSchema,
                  prefix,
                  _maxRecursionDepth
                ) as z.ZodTypeAny[])
          for (const candidate of candidates) {
            if (isCoercePrimitive(candidate)) {
              hit = true
              break
            }
            if (!isZodSchemaType(candidate, 'ZodEffects')) continue
            if (getEffectsKind(candidate) === 'preprocess') {
              hit = true
              break
            }
          }
        }
        preprocessOrCoerceCache.set(cacheKey, hit)
        return hit
      },
      validateAtPath(data, path, options) {
        // Sync attempt: when `options.sync === true`, try `safeParse`
        // (synchronous). It throws on async refines / pipes /
        // transforms; we catch and fall through to `safeParseAsync`.
        // Without the flag the adapter goes straight to async — the
        // historical contract every non-reshape callsite expects.
        const trySync = options?.sync === true
        if (trySync) {
          try {
            return runSync()
          } catch {
            // Async-only schema. Fall through to the async path.
          }
        }
        return runAsync()

        function runSync(): ValidationResponse<GetValueFormType> {
          if (path === undefined) {
            const { success, data: successData, error } = _zodSchema.safeParse(data)
            return success
              ? { data: successData, success, errors: undefined, formKey: _formKey }
              : {
                  success,
                  data: undefined,
                  errors: zodIssuesToValidationErrors(error.issues, _formKey),
                  formKey: _formKey,
                }
          }
          const nestedZodSchemas = nestedSchemasAtPath(path)
          if (!nestedZodSchemas.length) return pathNotFound(path)
          const accumulatedErrors: z.ZodError<unknown>[] = []
          for (const nestedSchema of nestedZodSchemas) {
            const { data: successData, success, error } = nestedSchema.safeParse(data)
            if (!success) {
              accumulatedErrors.push(error)
              continue
            }
            return { data: successData, errors: undefined, success: true, formKey: _formKey }
          }
          return aggregatedFailure(accumulatedErrors)
        }

        async function runAsync(): Promise<ValidationResponse<GetValueFormType>> {
          if (path === undefined) {
            const { success, data: successData, error } = await _zodSchema.safeParseAsync(data)
            return success
              ? { data: successData, success, errors: undefined, formKey: _formKey }
              : {
                  success,
                  data: undefined,
                  errors: zodIssuesToValidationErrors(error.issues, _formKey),
                  formKey: _formKey,
                }
          }
          const nestedZodSchemas = nestedSchemasAtPath(path)
          if (!nestedZodSchemas.length) return pathNotFound(path)
          // Sequential await — parallelising would run every branch's
          // async side effects on a value only one branch should see.
          const accumulatedErrors: z.ZodError<unknown>[] = []
          for (const nestedSchema of nestedZodSchemas) {
            const { data: successData, success, error } = await nestedSchema.safeParseAsync(data)
            if (!success) {
              accumulatedErrors.push(error)
              continue
            }
            return { data: successData, errors: undefined, success: true, formKey: _formKey }
          }
          return aggregatedFailure(accumulatedErrors)
        }

        function nestedSchemasAtPath(p: Path): z.ZodTypeAny[] {
          // Walk the ORIGINAL schema. The walker peels transparent
          // wrappers (optional / nullable / default / effects /
          // pipeline / readonly / branded) inline as it descends,
          // preserving every check (`.min` / `.max` / `.length` /
          // `.nonempty` / `.refine` / etc.) at the target path so
          // path-targeted re-validation surfaces issues that depend
          // on the schema node itself (e.g. an array's `.min(1)`
          // after a structural mutation, or a leaf's `.min(1)` when
          // the parent has a refine). The slim-schema pipeline used
          // for default-value derivation deliberately strips checks
          // at re-creation sites — appropriate for "here's a
          // permissive shape to seed defaults," wrong for "here's
          // the schema we should validate against."
          return getNestedZodSchemasAtPath(_zodSchema, p, _maxRecursionDepth)
        }

        function pathNotFound(p: Path): ValidationResponse<GetValueFormType> {
          return {
            data: undefined,
            errors: NO_SCHEMAS_FOUND_AT_PATH_OF_CONCRETE_SCHEMA([...p], _formKey),
            success: false,
            formKey: _formKey,
          }
        }

        function aggregatedFailure(
          errors: z.ZodError<unknown>[]
        ): ValidationResponse<GetValueFormType> {
          const allIssues = errors.reduce<z.ZodIssue[]>((acc, e) => [...acc, ...e.issues], [])
          return {
            data: undefined,
            errors: zodIssuesToValidationErrors(allIssues, _formKey),
            success: false,
            formKey: _formKey,
          }
        }
      },
    }

    return abstractSchema
  }

  // `options.maxRecursionDepth` caps `z.lazy(...)` descent in
  // `getNestedZodSchemasAtPath` — once the walker has crossed
  // `maxRecursionDepth + 1` lazy boundaries it returns `[]`, so writes
  // at recursive paths deeper than the cap fall back to a permissive
  // type gate. Matches the v4 adapter's path-walker contract.
  return (formKey: FormKey, _options: SchemaFactoryOptions) =>
    getAbstractSchema(formKey, zodSchema, true, _options.maxRecursionDepth)
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

const NO_SCHEMAS_FOUND_AT_PATH_OF_CONCRETE_SCHEMA = (path: (string | number)[], formKey: FormKey) =>
  [
    {
      message: `Programming Error: useForm.validateAtPath failed to find 1 or more schemas corresponding to the path ${path} in the concrete schema. Does the nested schema exist on form with key '${formKey}'?`,
      path,
      formKey,
      code: AttaformErrorCode.PathNotFound,
    },
  ] satisfies ValidationError[]

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
  return walkSegments(schema, segments.map(String), maxRecursionDepth, 0)
}

function walkSegments(
  schema: z.ZodTypeAny,
  segments: readonly string[],
  maxDepth: number,
  lazyDepth: number
): z.ZodTypeAny[] {
  if (segments.length === 0) return [schema]
  const [head, ...rest] = segments
  if (head === undefined) return [schema]
  const kind = kindOf(schema)
  switch (kind) {
    case 'object': {
      const shape = getObjectShape(schema)
      // Own-property check: `shape` is a plain object whose prototype is
      // `Object.prototype`, so a bare `shape[head]` for `head ===
      // 'toString'` / `'valueOf'` / `'hasOwnProperty'` etc. returns the
      // inherited Function and the walker treats it as a schema. Filter
      // to OWN keys so unknown segments resolve to "doesn't exist."
      if (!Object.hasOwn(shape, head)) return []
      const next = shape[head]
      return next === undefined ? [] : walkSegments(next, rest, maxDepth, lazyDepth)
    }
    case 'array': {
      const inner = getArrayElement(schema)
      return inner === undefined ? [] : walkSegments(inner, rest, maxDepth, lazyDepth)
    }
    case 'set': {
      // Sets aren't position-indexed; the head segment is a synthetic
      // indexer (`[...path, 0]`) used to query the element type. Descend
      // into the value schema and consume the segment.
      const inner = getSetValueType(schema)
      return inner === undefined ? [] : walkSegments(inner, rest, maxDepth, lazyDepth)
    }
    case 'record': {
      const inner = getRecordValueType(schema)
      return inner === undefined ? [] : walkSegments(inner, rest, maxDepth, lazyDepth)
    }
    case 'tuple': {
      const index = Number(head)
      if (!Number.isInteger(index)) return []
      const items = getTupleItems(schema)
      const item = items[index]
      return item === undefined ? [] : walkSegments(item, rest, maxDepth, lazyDepth)
    }
    case 'union':
      return getUnionOptions(schema).flatMap((opt) =>
        walkSegments(opt, segments, maxDepth, lazyDepth)
      )
    case 'discriminated-union': {
      // Filter options whose shape contains this segment. Fallback: if no
      // option matches (e.g. the discriminator key itself), try every
      // option. `Object.hasOwn` (not `in`) so `Object.prototype` keys
      // don't leak.
      const options = getDiscriminatedOptions(schema)
      const matching = options.filter((opt) => Object.hasOwn(getObjectShape(opt), head))
      const candidates = matching.length > 0 ? matching : options
      return candidates.flatMap((opt) => walkSegments(opt, segments, maxDepth, lazyDepth))
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch': {
      // `catch` peels like a wrapper — descend into the inner schema. The
      // catch fallback only matters at parse time, not path lookup.
      const inner = unwrapInner(schema)
      return inner === undefined ? [] : walkSegments(inner, segments, maxDepth, lazyDepth)
    }
    case 'branded': {
      const inner = unwrapBranded(schema)
      return inner === undefined ? [] : walkSegments(inner, segments, maxDepth, lazyDepth)
    }
    case 'effects': {
      const inner = unwrapEffectsSource(schema)
      return inner === undefined ? [] : walkSegments(inner, segments, maxDepth, lazyDepth)
    }
    case 'pipeline': {
      const inner = unwrapPipeIn(schema)
      return inner === undefined ? [] : walkSegments(inner, segments, maxDepth, lazyDepth)
    }
    case 'lazy': {
      // Bump the lazy counter. Past the cap, return [] so callers fall
      // back to permissive behaviour at recursive paths beyond the cap.
      if (lazyDepth >= maxDepth) return []
      const inner = unwrapLazy(schema)
      return inner === undefined ? [] : walkSegments(inner, segments, maxDepth, lazyDepth + 1)
    }
    case 'intersection': {
      // Union of both sides' resolutions — callers try each candidate,
      // matching parse-time semantics where a value must satisfy both.
      const left = getIntersectionLeft(schema)
      const right = getIntersectionRight(schema)
      const leftResults =
        left === undefined ? [] : walkSegments(left, segments, maxDepth, lazyDepth)
      const rightResults =
        right === undefined ? [] : walkSegments(right, segments, maxDepth, lazyDepth)
      return [...leftResults, ...rightResults]
    }
    // Leaf types — can't descend further. The unsupported kinds
    // (`promise` / `function` / `map` / `symbol`) are rejected at
    // adapter construction by `assertSupportedKinds`; this fallthrough
    // keeps the walker defensive in case construction is skipped (e.g.
    // a downstream test instantiates a subschema directly).
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'date':
    case 'enum':
    case 'native-enum':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'void':
    case 'never':
    case 'any':
    case 'unknown':
    case 'nan':
    case 'promise':
    case 'function':
    case 'map':
    case 'symbol':
      return []
    default: {
      const _exhaustive: never = kind
      throw new Error(`walkSegments (v3): unhandled ZodKind '${_exhaustive as string}'`)
    }
  }
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
 * - `ZodReadonly` / `ZodPipeline` / `ZodBranded` / `ZodEffects` →
 *   transparent peel and re-check inner.
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
    const inner = unwrapEffectsSource(schema)
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
    // ZodEffects (`z.preprocess` / `.refine` / `.transform`) is a
    // transparent wrapper for structural traversal; the discriminated
    // union may live on the source schema.
    if (isZodSchemaType(currentSchema, 'ZodEffects')) {
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

function unwrapDefault(schema: z.ZodTypeAny): [unknown, boolean] {
  // Iterative peel: a chain of `.refine()` calls produces a deep
  // ZodEffects(ZodEffects(...)) tree, and stack-based recursion runs
  // out before MAX_UNWRAP_STEPS does. The bound also acts as a
  // self-reference guard for pathological lazy loops.
  let current: z.ZodTypeAny = schema
  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    if (isZodSchemaType(current, 'ZodDefault')) {
      return [getDefaultValueFromIntrospect(current), true]
    }
    if (isZodSchemaType(current, 'ZodCatch')) {
      // ZodCatch supplies a fallback value when its inner schema rejects
      // parse. For default extraction the caught fallback IS the
      // construction-time default — it's the consumer's explicit
      // statement of "this is what to render when nothing else fits."
      // Preserves the value across submit failures, hydration, and
      // history (a `.catch()` should resurface the same fallback).
      // `hasCatchValue` lets us distinguish a legitimate `undefined`
      // return from a missing wrapper — both surface as `undefined`
      // from `getCatchDefault` alone.
      if (hasCatchValue(current)) return [getCatchDefault(current), true]
      // Defensive: fall through to the inner schema if the field is
      // missing on this v3 minor version.
      const inner = unwrapInner(current)
      if (!inner) break
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodNullable') || isZodSchemaType(current, 'ZodOptional')) {
      const inner = unwrapInner(current)
      if (!inner) break
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodReadonly')) {
      const inner = unwrapInner(current)
      if (!inner) break
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodBranded')) {
      const inner = unwrapBranded(current)
      if (!inner) break
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodPipeline')) {
      const inner = unwrapPipeIn(current)
      if (!inner) break
      current = inner
      continue
    }
    if (isZodSchemaType(current, 'ZodEffects')) {
      // v3 ZodEffects' structural source lives on `_def.schema`
      // (preferred); older v3 builds exposed `.innerType()` on the
      // instance as an alternative resolver. The introspect helper
      // reads `_def.schema`, and falling back to the instance method
      // here preserves the historical robustness.
      const inner = unwrapEffectsSource(current)
      if (inner) {
        current = inner
        continue
      }
      const innerFromMethod = (current as { innerType?: () => z.ZodTypeAny }).innerType?.()
      if (innerFromMethod) {
        current = innerFromMethod
        continue
      }
      break
    }
    break
  }
  return [null, false]
}

/**
 * Walk through transparent wrappers (Optional / Nullable / Readonly /
 * Catch) looking for a `ZodDefault` in the chain. Used by the preprocess
 * branch of `generateValue` to decide whether the inner has a
 * consumer-declared default the adapter should honor (return the inner
 * walk) or whether the slot is fully consumer-owned (return `undefined`).
 * Mirrors v4's `hasDeclaredDefaultInChain`.
 *
 * Bounded loop matches the surrounding `unwrapDefault`/`unwrapTo*`
 * patterns — a deeper wrapper stack is almost certainly a recursive
 * cycle, not legitimate schema construction.
 */
function hasDeclaredDefaultInChainV3(schema: z.ZodTypeAny): boolean {
  let current: z.ZodTypeAny | undefined = schema
  for (let i = 0; i < 32; i++) {
    if (current === undefined) return false
    if (isZodSchemaType(current, 'ZodDefault')) return true
    if (
      isZodSchemaType(current, 'ZodOptional') ||
      isZodSchemaType(current, 'ZodNullable') ||
      isZodSchemaType(current, 'ZodReadonly') ||
      isZodSchemaType(current, 'ZodCatch')
    ) {
      current = unwrapInner(current)
      continue
    }
    return false
  }
  return false
}

function getDefaultValuesFromZodSchema<
  FormSchema extends z.ZodSchema,
  Form extends z.infer<FormSchema>,
>(formSchema: FormSchema, useDefaultSchemaValues: boolean, formKey: FormKey): Form {
  // Recursive function to generate the initial value based on schema type
  function generateValue(schema: z.ZodTypeAny): unknown {
    // Recursive helper to unwrap layers and detect ZodDefault
    // Check if the schema (or any wrapped version) has a ZodDefault
    if (useDefaultSchemaValues) {
      const [defaultValue, foundDefaultValue] = unwrapDefault(schema)
      if (foundDefaultValue) {
        return defaultValue // Prioritize the 1st default value (if it exists)
      }
    }

    // `z.coerce.X()` flags the wrapped primitive's def with `coerce:
    // true`; the consumer's input pre-conversion shape is unknown so
    // synthesising the primitive's slim concrete (`''` / `0` / etc.)
    // would claim a value the consumer never supplied. Leave the slot
    // `undefined` so `defaultValues` or a later `setValue` owns what
    // lands in storage. A consumer-declared `.default(x)` on the coerce
    // primitive was already honored by the `unwrapDefault` check above.
    // Mirrors v4's `isCoercePrimitive` early-return.
    if (isCoercePrimitive(schema)) return undefined

    // Handle nullable
    if (isZodSchemaType(schema, 'ZodNullable')) {
      return null // No default, so return null
    }

    // Handle objects
    if (isZodSchemaType(schema, 'ZodObject')) {
      const shape = schema.shape
      return Object.keys(shape).reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = generateValue(shape[key])
        return acc
      }, {})
    }

    // Handle arrays
    if (isZodSchemaType(schema, 'ZodArray')) {
      return []
    }

    // Handle strings
    if (isZodSchemaType(schema, 'ZodString')) {
      return ''
    }

    // Handle numbers
    if (isZodSchemaType(schema, 'ZodNumber')) {
      return 0
    }

    // Handle bigints — must be a bigint literal; z.bigint() rejects
    // number 0. Without this branch we fall through to the warn-path
    // and the fix-up loop has to reconcile it via getDefaultValue.
    if (isZodSchemaType(schema, 'ZodBigInt')) {
      return 0n
    }

    // Handle dates — matches v4's `new Date(0)` so SSR round-trip is
    // deterministic across server + client.
    if (isZodSchemaType(schema, 'ZodDate')) {
      return new Date(0)
    }

    // Handle booleans
    if (isZodSchemaType(schema, 'ZodBoolean')) {
      return false
    }

    // Handle enums
    if (isZodSchemaType(schema, 'ZodEnum')) {
      return schema.options[0]
    }

    // Handle null
    if (isZodSchemaType(schema, 'ZodNull')) {
      return null
    }

    // Handle undefined
    if (isZodSchemaType(schema, 'ZodUndefined')) {
      return undefined
    }

    // Handle literals
    if (isZodSchemaType(schema, 'ZodLiteral')) {
      return getLiteralValue(schema)
    }

    // Handle optional
    if (isZodSchemaType(schema, 'ZodOptional')) {
      return undefined
    }

    // Handle unions (use the first option as the default)
    if (isZodSchemaType(schema, 'ZodUnion')) {
      const first = getUnionOptions(schema)[0]
      return first === undefined ? undefined : generateValue(first)
    }

    // Handle tuples
    if (isZodSchemaType(schema, 'ZodTuple')) {
      return getTupleItems(schema).map((item) => generateValue(item))
    }

    // Handle records
    if (isZodSchemaType(schema, 'ZodRecord')) {
      return {}
    }

    // Finding ZodDefault here means we should suppress defaults
    // Can only happen if useDefaultSchemaValues is false
    if (isZodSchemaType(schema, 'ZodDefault')) {
      const inner = unwrapInner(schema)
      if (inner) return generateValue(inner)
    }

    if (isZodSchemaType(schema, 'ZodEffects')) {
      const inner = unwrapEffectsSource(schema)
      // `z.preprocess(fn, _)` declares an input normalizer; the input
      // side is the user-supplied `fn` and the slot has no canonical
      // empty value the adapter can honestly synthesise. Mirror v4's
      // pipe-with-transform case: when the inner carries a consumer-
      // declared default it takes priority (recurse so the `unwrapDefault`
      // check at the top of `generateValue` picks it up under
      // `useDefaultSchemaValues`, or the inner `ZodDefault` branch
      // resolves to the leaf empty under strict mode); otherwise leave
      // the slot `undefined`. `refinement` / `transform` keep the
      // original behavior — they wrap a real source schema.
      if (getEffectsKind(schema) === 'preprocess') {
        if (inner && hasDeclaredDefaultInChainV3(inner)) return generateValue(inner)
        return undefined
      }
      if (inner) return generateValue(inner)
    }

    if (isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
      const discriminantKey = undefined // select default option schema
      const discriminantSchema = getSchemaByDiscriminatorKey(schema, discriminantKey)
      return generateValue(discriminantSchema as z.ZodTypeAny)
    }

    // ZodCatch — even when default extraction is suppressed
    // (`useDefaultSchemaValues=false`), the consumer-supplied fallback
    // is the most reasonable construction-time value to surface; the
    // alternative is the inner schema's bare default, which the
    // .catch() author specifically chose to override. `hasCatchValue`
    // preserves the legitimate-undefined-return path.
    if (isZodSchemaType(schema, 'ZodCatch')) {
      if (hasCatchValue(schema)) return getCatchDefault(schema)
      const inner = unwrapInner(schema)
      if (inner) return generateValue(inner)
    }

    // Newer transparent wrappers (v3.23+ for Pipeline/Readonly; Branded
    // pre-existed). Each wraps a single inner schema with no structural
    // impact at value-construction time.
    if (isZodSchemaType(schema, 'ZodReadonly')) {
      const inner = unwrapInner(schema)
      if (inner) return generateValue(inner)
    }
    if (isZodSchemaType(schema, 'ZodBranded')) {
      const inner = unwrapBranded(schema)
      if (inner) return generateValue(inner)
    }
    if (isZodSchemaType(schema, 'ZodPipeline')) {
      // Pipeline transforms in -> out; pre-transform default is the
      // input schema's natural default.
      const inner = unwrapPipeIn(schema)
      if (inner) return generateValue(inner)
    }

    // ZodLazy — recursive schemas (comment trees, file system shapes).
    // Resolve the getter once; the inner schema's own ZodOptional /
    // base-case branch terminates the recursion.
    if (isZodSchemaType(schema, 'ZodLazy')) {
      const inner = unwrapLazy(schema)
      if (inner) return generateValue(inner)
    }

    // ZodIntersection — `z.intersection(A, B)` must satisfy both sides
    // at parse time, so the merged shape carries both halves' defaults.
    // `mergeDeepV3` (NOT lodash `merge`) so leaves replace wholesale and
    // explicit `null` overrides survive — matches v4's intersection
    // branch (`default-values.ts:228-244`).
    if (isZodSchemaType(schema, 'ZodIntersection')) {
      const leftSchema = getIntersectionLeft(schema)
      const rightSchema = getIntersectionRight(schema)
      const left = leftSchema ? generateValue(leftSchema) : undefined
      const right = rightSchema ? generateValue(rightSchema) : undefined
      return mergeDeepV3(left, right)
    }

    // ZodNativeEnum — TS-enum-backed selects. Numeric enums get
    // reverse-mapped (`enum E { A }` → `{ A: 0, '0': 'A' }`); the valid
    // runtime members are the keys whose VALUE'S key isn't itself a
    // number. String enums have no reverse mapping, so every key is
    // valid. Pick the first valid value as the default.
    if (isZodSchemaType(schema, 'ZodNativeEnum')) {
      const values = getNativeEnumValues(schema)
      if (values) {
        const validKeys = Object.keys(values).filter(
          (k) => typeof values[values[k] as string] !== 'number'
        )
        if (validKeys.length > 0) {
          const first = validKeys[0]
          if (first !== undefined) return values[first]
        }
      }
    }

    // ZodSet — empty Set; populated entries would have to reach into
    // the element schema's defaults, but a Set's only meaningful
    // empty state is `new Set()`.
    if (isZodSchemaType(schema, 'ZodSet')) {
      return new Set()
    }

    // ZodNaN — the only valid value `z.nan()` accepts is `NaN`. v4
    // returns `NaN` here; mirror that so the default seeds a schema-
    // valid slot instead of falling through to the warn-path.
    if (isZodSchemaType(schema, 'ZodNaN')) {
      return NaN
    }

    // `z.void()` / `z.any()` / `z.unknown()` / `z.never()` carry no
    // canonical empty value beyond `undefined`. v4 returns `undefined`
    // for all four; returning `null` here (the warn-path fallback)
    // misrepresented the slot and triggered a noisy console warning for
    // a schema kind we can actually handle.
    if (
      isZodSchemaType(schema, 'ZodVoid') ||
      isZodSchemaType(schema, 'ZodAny') ||
      isZodSchemaType(schema, 'ZodUnknown') ||
      isZodSchemaType(schema, 'ZodNever')
    ) {
      return undefined
    }

    console.warn(
      `[attaform] zod-v3 adapter: unsupported schema kind ` +
        `'${schema.constructor.name}' on form '${formKey}'. Defaulting the field to null. ` +
        `Use a supported zod kind (object/array/record/string/number/etc.) at this path.`
    )
    return null
  }

  return generateValue(formSchema) as unknown as Form
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
      // Rebuild a ZodString without checks
      return z.string()
    }

    if (isZodSchemaType(_schema, 'ZodNumber') && hasChecks(_schema)) {
      // Rebuild a ZodNumber without checks
      return z.number()
    }

    if (isZodSchemaType(_schema, 'ZodArray')) {
      // Recursively process the array's inner type
      const inner = getArrayElement(_schema)
      if (!inner) return _schema
      return z.array(_stripRefinements(inner, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodObject')) {
      // Recursively process each property of the object
      const strippedShape = Object.fromEntries(
        Object.entries(getObjectShape(_schema)).map(([key, value]) => [
          key,
          _stripRefinements(value, depth + 1),
        ])
      )
      return z.object(strippedShape)
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
      return z.optional(_stripRefinements(inner, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodNullable')) {
      // Recursively strip nullable's inner type
      const inner = unwrapInner(_schema)
      if (!inner) return _schema
      return z.nullable(_stripRefinements(inner, depth + 1))
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
      return z.set(_stripRefinements(valueType, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodTuple')) {
      const items = getTupleItems(_schema)
      if (items.length === 0) return _schema
      const stripped = items.map((it) => _stripRefinements(it, depth + 1))
      return z.tuple(stripped as [z.ZodTypeAny, ...z.ZodTypeAny[]])
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
        return z.record(keyType as z.ZodString, value)
      }
      return z.record(value)
    }

    if (isZodSchemaType(_schema, 'ZodUnion')) {
      const options = getUnionOptions(_schema)
      if (options.length === 0) return _schema
      const stripped = options.map((o) => _stripRefinements(o, depth + 1))
      return z.union(stripped as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
    }

    if (isZodSchemaType(_schema, 'ZodDiscriminatedUnion')) {
      const discKey = getDiscriminator(_schema)
      const options = getDiscriminatedOptions(_schema)
      if (discKey === undefined || options.length === 0) return _schema
      const stripped = options.map(
        (o) => _stripRefinements(o, depth + 1) as z.ZodObject<z.ZodRawShape>
      )
      return z.discriminatedUnion(
        discKey,
        stripped as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]]
      )
    }

    if (isZodSchemaType(_schema, 'ZodIntersection')) {
      const left = getIntersectionLeft(_schema)
      const right = getIntersectionRight(_schema)
      if (!left || !right) return _schema
      return z.intersection(_stripRefinements(left, depth + 1), _stripRefinements(right, depth + 1))
    }

    if (isZodSchemaType(_schema, 'ZodLazy')) {
      const inner = unwrapLazy(_schema)
      if (!inner) return _schema
      // Eagerly resolve once and capture the stripped target so the
      // returned lazy resolves to a stable schema. assertSupportedKinds
      // has already rejected self-referencing lazies, so this is finite.
      const stripped = _stripRefinements(inner, depth + 1)
      return z.lazy(() => stripped)
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

  return isFunction(stripValueOrCallback) ? stripValueOrCallback(schema) : stripValueOrCallback
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
      return z.object(newShape)
    }

    if (isZodSchemaType(_schema, 'ZodArray')) {
      const inner = getArrayElement(_schema)
      if (!inner) return _schema
      return z.array(_getSlimSchema(inner as z.ZodSchema))
    }

    if (isZodSchemaType(_schema, 'ZodRecord')) {
      const keyType = getRecordKeyType(_schema)
      const valueType = getRecordValueType(_schema)
      if (!keyType || !valueType) return _schema
      const key = _getSlimSchema(keyType as z.ZodSchema)
      const value = _getSlimSchema(valueType as z.ZodSchema)
      return z.record(key as z.ZodString, value)
    }

    // same way we go into records, objects, and arrays, go into discriminated unions
    if (isZodSchemaType(_schema, 'ZodDiscriminatedUnion')) {
      const slimmedSchemas = []
      const discKey = getDiscriminator(_schema)
      if (discKey === undefined) return _schema

      for (const option of getDiscriminatedOptions(_schema)) {
        const slimmedSchema = _getSlimSchema(option as unknown as z.ZodSchema)
        // slimmedSchema will be a structurally deep object, so break pointer refs to prevent recursion bugs
        const deepCloneSlimmedSchema = cloneDeep(slimmedSchema)
        slimmedSchemas.push(deepCloneSlimmedSchema)
      }

      return z.discriminatedUnion(
        discKey,
        slimmedSchemas as unknown as readonly [
          z.ZodDiscriminatedUnionOption<string>,
          ...z.ZodDiscriminatedUnionOption<string>[],
        ]
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

// Per-rootSchema cache of path → payload maps. Build is a single tree
// walk; lookups are O(1) thereafter. WeakMap keyed on the root schema
// so entries GC with the form. Mirrors v4's `pathMetaCache`.
const pathMetaCacheV3 = new WeakMap<z.ZodTypeAny, Map<PathKey, FieldMetaPayload>>()

function getPathMetaMapV3(rootSchema: z.ZodTypeAny): Map<PathKey, FieldMetaPayload> {
  const cached = pathMetaCacheV3.get(rootSchema)
  if (cached !== undefined) return cached
  const map = new Map<PathKey, FieldMetaPayload>()
  const counters = new Map<z.ZodTypeAny, number>()
  const lastPathPerSchema = new Map<z.ZodTypeAny, PathKey>()
  const inProgress = new WeakSet<z.ZodTypeAny>()
  walkForMetaV3(rootSchema, [], map, counters, lastPathPerSchema, inProgress)
  // Absorb surplus registrations into the schema's last-visited path
  // — covers chains like `withMeta(s, {label}).register(fieldMeta, {desc})`
  // where one path consumes list[0] and list[1] would otherwise go
  // unread. Mirrors v4's surplus-merge step in `getPathMetaMap`.
  for (const [schema, lastPath] of lastPathPerSchema) {
    const list = getFieldMetaList(schema)
    const consumed = counters.get(schema) ?? 0
    if (list.length <= consumed) continue
    const surplus = list
      .slice(consumed)
      .reduce<FieldMetaPayload>((acc, p) => ({ ...acc, ...p }), {})
    const existing = map.get(lastPath) ?? {}
    map.set(lastPath, { ...existing, ...surplus })
  }
  pathMetaCacheV3.set(rootSchema, map)
  return map
}

function consumePayloadV3(
  schema: z.ZodTypeAny,
  counters: Map<z.ZodTypeAny, number>
): FieldMetaPayload | undefined {
  const list = getFieldMetaList(schema)
  if (list.length === 0) return undefined
  const idx = counters.get(schema) ?? 0
  // Clamp to last entry — schemas reused MORE times than they're
  // registered (e.g. an array element schema registered once, visited
  // per-index) all share the single registration. Mirrors v4's clamp.
  const payload = list[Math.min(idx, list.length - 1)]
  counters.set(schema, idx + 1)
  return payload
}

/**
 * Walk the v3 schema tree from `rootSchema`, emitting a payload for
 * each path that has registered metadata. For schemas registered at
 * multiple paths the per-schema counter advances each visit and
 * selects the i-th payload from the schema's registration list — when
 * registrations happen in declaration order they pair correctly with
 * tree-walk order. Mirrors v4's `walkForMeta` shape.
 *
 * Visits the schema first (terminal-position registration), then the
 * peeled inner if different (inner-then-wrap registration). At each
 * point the FIRST list-payload found wins for that path.
 */
function walkForMetaV3(
  schema: z.ZodTypeAny,
  path: Path,
  map: Map<PathKey, FieldMetaPayload>,
  counters: Map<z.ZodTypeAny, number>,
  lastPathPerSchema: Map<z.ZodTypeAny, PathKey>,
  inProgress: WeakSet<z.ZodTypeAny>
): void {
  if (inProgress.has(schema)) return
  inProgress.add(schema)
  try {
    const pathKey = canonicalizePath(path).key
    if (!map.has(pathKey)) {
      const payload = consumePayloadV3(schema, counters)
      if (payload !== undefined) {
        map.set(pathKey, payload)
        lastPathPerSchema.set(schema, pathKey)
      }
    }
    const peeled = peelAllV3Wrappers(schema)
    if (peeled !== schema && !map.has(pathKey)) {
      const payload = consumePayloadV3(peeled, counters)
      if (payload !== undefined) {
        map.set(pathKey, payload)
        lastPathPerSchema.set(peeled, pathKey)
      }
    }
    // Descend
    if (isZodSchemaType(schema, 'ZodObject')) {
      const shape = getObjectShape(schema)
      for (const [key, child] of Object.entries(shape)) {
        walkForMetaV3(
          child as z.ZodTypeAny,
          [...path, key],
          map,
          counters,
          lastPathPerSchema,
          inProgress
        )
      }
      return
    }
    if (isZodSchemaType(schema, 'ZodArray')) {
      const inner = getArrayElement(schema)
      if (inner) walkForMetaV3(inner, [...path, 0], map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodTuple')) {
      const items = getTupleItems(schema)
      items.forEach((item, i) => {
        walkForMetaV3(
          item as z.ZodTypeAny,
          [...path, i],
          map,
          counters,
          lastPathPerSchema,
          inProgress
        )
      })
      return
    }
    if (isZodSchemaType(schema, 'ZodSet')) {
      const inner = getSetValueType(schema)
      if (inner) walkForMetaV3(inner, [...path, 0], map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodRecord')) {
      const inner = getRecordValueType(schema)
      if (inner) walkForMetaV3(inner, [...path, '*'], map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
      for (const opt of getUnionOptions(schema)) {
        walkForMetaV3(opt as z.ZodTypeAny, path, map, counters, lastPathPerSchema, inProgress)
      }
      return
    }
    if (isZodSchemaType(schema, 'ZodIntersection')) {
      const left = getIntersectionLeft(schema)
      const right = getIntersectionRight(schema)
      if (left) walkForMetaV3(left, path, map, counters, lastPathPerSchema, inProgress)
      if (right) walkForMetaV3(right, path, map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (
      isZodSchemaType(schema, 'ZodOptional') ||
      isZodSchemaType(schema, 'ZodNullable') ||
      isZodSchemaType(schema, 'ZodDefault') ||
      isZodSchemaType(schema, 'ZodReadonly') ||
      isZodSchemaType(schema, 'ZodCatch')
    ) {
      const inner = unwrapInner(schema)
      if (inner) walkForMetaV3(inner, path, map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodEffects')) {
      const inner = unwrapEffectsSource(schema)
      if (inner) walkForMetaV3(inner, path, map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodPipeline')) {
      const inner = unwrapPipeIn(schema)
      if (inner) walkForMetaV3(inner, path, map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodBranded')) {
      const inner = unwrapBranded(schema)
      if (inner) walkForMetaV3(inner, path, map, counters, lastPathPerSchema, inProgress)
      return
    }
    if (isZodSchemaType(schema, 'ZodLazy')) {
      try {
        const inner = unwrapLazy(schema)
        if (inner) walkForMetaV3(inner, path, map, counters, lastPathPerSchema, inProgress)
      } catch {
        // Recursive z.lazy() — the inProgress guard at the top of
        // walkForMetaV3 stops the descent, but a getter that throws
        // before reaching that check shouldn't crash the walk.
      }
      return
    }
    // Leaf kinds — nothing more to descend into; metadata for the path
    // itself was captured above.
  } finally {
    inProgress.delete(schema)
  }
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
  const pathMap = getPathMetaMapV3(rootSchema as z.ZodTypeAny)
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
