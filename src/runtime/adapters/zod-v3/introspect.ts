/**
 * The single file that reads Zod v3's internal `_def` shape. Every
 * other file in the zod-v3 adapter uses these public-shaped accessors
 * — future Zod v3 minor bumps that reshape internals touch only this
 * file. Mirrors the v4 adapter's introspect surface, with v3-only
 * accessors for kinds the v3 line carries that v4 dropped
 * (`ZodEffects`, `ZodPipeline`, `ZodBranded`, `ZodNativeEnum`).
 *
 * Design principle: treat `schema._def.*` as an unstable surface, even
 * when Zod's docs say otherwise. Each helper returns a narrow,
 * well-typed slice; no adapter code outside this file does
 * shape-based pattern matching on `_def`.
 */
import type { z } from 'zod-v3'
import { isZodSchemaType } from './helpers'

// Shared cap for every wrapper-peeling helper. Pathological schemas
// (deep `.refine()` chains, self-referential lazy loops) would
// otherwise stack-overflow or hang. 64 is generous for any realistic
// form schema; past it we bail conservatively rather than crash.
const MAX_UNWRAP_STEPS = 64

/**
 * Stable kind discriminant for a Zod v3 schema. Mirrors the v4
 * adapter's `ZodKind` for the kinds both versions carry, with the
 * v3-only additions (`'effects'`, `'pipeline'`, `'branded'`,
 * `'native-enum'`, `'function'`, `'map'`, `'symbol'`, `'promise'`)
 * for kinds the v3 line still exposes that v4 dropped or renamed.
 * Useful when building a custom integration that needs to branch on
 * schema shape — most consumers don't need this.
 */
export type ZodKind =
  | 'object'
  | 'array'
  | 'set'
  | 'record'
  | 'tuple'
  | 'union'
  | 'discriminated-union'
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'date'
  | 'enum'
  | 'native-enum'
  | 'literal'
  | 'null'
  | 'undefined'
  | 'optional'
  | 'nullable'
  | 'default'
  | 'catch'
  | 'readonly'
  | 'branded'
  | 'effects'
  | 'pipeline'
  | 'lazy'
  | 'intersection'
  | 'any'
  | 'unknown'
  | 'never'
  | 'nan'
  | 'void'
  | 'promise'
  | 'function'
  | 'map'
  | 'symbol'

// Narrow accessor for the unstable `_def` surface. All reads from this
// object go through helpers below — never inline.
interface ZodV3InternalShape {
  _def?: {
    typeName?: string
    // Wrapper inners.
    innerType?: unknown
    type?: unknown // ZodBranded inner; ZodArray element
    schema?: unknown // ZodEffects structural source
    effect?: { type?: string; refinement?: unknown; transform?: unknown }
    in?: unknown // ZodPipeline input side
    out?: unknown // ZodPipeline output side
    getter?: () => unknown // ZodLazy resolver
    // Containers.
    shape?: (() => Record<string, unknown>) | Record<string, unknown>
    valueType?: unknown // ZodRecord value / ZodSet element
    keyType?: unknown // ZodRecord key
    items?: readonly unknown[] // ZodTuple
    options?: readonly unknown[] // ZodUnion / ZodDiscriminatedUnion / ZodEnum
    discriminator?: string // ZodDiscriminatedUnion
    left?: unknown // ZodIntersection
    right?: unknown // ZodIntersection
    // Value carriers.
    value?: unknown // ZodLiteral
    values?: Record<string, unknown> // ZodNativeEnum
    defaultValue?: () => unknown // ZodDefault thunk
    catchValue?: (ctx: { error: unknown; input: unknown }) => unknown
    // Refinement payload.
    checks?: readonly unknown[]
  }
}

function readDef(schema: unknown): ZodV3InternalShape['_def'] | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  return (schema as ZodV3InternalShape)._def
}

/**
 * Inspect a Zod v3 schema and return its `ZodKind`. Returns
 * `'unknown'` for non-Zod inputs and unrecognised shapes (collides
 * with `ZodUnknown` → `'unknown'` by design; `ZodUnknown` is rarely
 * used in form schemas).
 */
export function kindOf(schema: unknown): ZodKind {
  const def = readDef(schema)
  const typeName = def?.typeName
  if (typeName === undefined) return 'unknown'
  switch (typeName) {
    case 'ZodObject':
      return 'object'
    case 'ZodArray':
      return 'array'
    case 'ZodSet':
      return 'set'
    case 'ZodRecord':
      return 'record'
    case 'ZodTuple':
      return 'tuple'
    case 'ZodUnion':
      return 'union'
    case 'ZodDiscriminatedUnion':
      return 'discriminated-union'
    case 'ZodString':
      return 'string'
    case 'ZodNumber':
      return 'number'
    case 'ZodBoolean':
      return 'boolean'
    case 'ZodBigInt':
      return 'bigint'
    case 'ZodDate':
      return 'date'
    case 'ZodEnum':
      return 'enum'
    case 'ZodNativeEnum':
      return 'native-enum'
    case 'ZodLiteral':
      return 'literal'
    case 'ZodNull':
      return 'null'
    case 'ZodUndefined':
      return 'undefined'
    case 'ZodOptional':
      return 'optional'
    case 'ZodNullable':
      return 'nullable'
    case 'ZodDefault':
      return 'default'
    case 'ZodCatch':
      return 'catch'
    case 'ZodReadonly':
      return 'readonly'
    case 'ZodBranded':
      return 'branded'
    case 'ZodEffects':
      return 'effects'
    case 'ZodPipeline':
      return 'pipeline'
    case 'ZodLazy':
      return 'lazy'
    case 'ZodIntersection':
      return 'intersection'
    case 'ZodAny':
      return 'any'
    case 'ZodUnknown':
      return 'unknown'
    case 'ZodNever':
      return 'never'
    case 'ZodNaN':
      return 'nan'
    case 'ZodVoid':
      return 'void'
    case 'ZodPromise':
      return 'promise'
    case 'ZodFunction':
      return 'function'
    case 'ZodMap':
      return 'map'
    case 'ZodSymbol':
      return 'symbol'
    default:
      return 'unknown'
  }
}

/** Read the typeName discriminant directly. Convenience for callers that already branch on the raw string. */
export function getTypeName(schema: unknown): string | undefined {
  return readDef(schema)?.typeName
}

/**
 * Verify a schema is Zod v3. Throws a clear error if it's a v4
 * schema (which carries `def.type` instead of `_def.typeName`) or a
 * non-Zod value mistakenly imported through `attaform/zod-v3`.
 *
 * Most consumers never call this directly — the v3 adapter calls it
 * internally on every schema. Reach for it only when wiring a custom
 * adapter that needs the same guard.
 */
export function assertZodVersion(schema: unknown): void {
  const def = readDef(schema)
  if (def?.typeName === undefined) {
    throw new Error(
      '[attaform/zod-v3] Schema is not a Zod v3 schema. The `attaform/zod-v3` adapter requires ' +
        'zod@^3. Either: (a) install zod@^3 in your project; (b) import from `attaform/zod`, ' +
        'which auto-detects the Zod version (and tree-shakes to a single adapter when the ' +
        '`attaform/vite` plugin is active); or (c) import from `attaform/zod-v4` if you are ' +
        'on Zod v4.'
    )
  }
}

// ---------- Container accessors ----------

/**
 * Returns the object's `Record<string, ZodTypeAny>` shape. v3 stores
 * shape as a thunk on `_def.shape` (lazy evaluation for self-referential
 * schemas); the instance's `.shape` getter and the thunk both resolve
 * to the same record. Prefers the thunk so cases without an instance
 * getter (rare; defensive) still resolve.
 */
export function getObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const def = readDef(schema)
  const raw = def?.shape
  if (typeof raw === 'function') return raw() as Record<string, z.ZodTypeAny>
  if (raw !== undefined) return raw as Record<string, z.ZodTypeAny>
  // Fallback to the instance getter — only reached when the schema was
  // constructed via a path that didn't populate `_def.shape`.
  return (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {}
}

/**
 * Returns the element schema of a `z.array(...)`. v3 stores the
 * element on `_def.type` (not `_def.element` — that's v4's name).
 */
export function getArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.type as z.ZodTypeAny | undefined
}

/**
 * Returns the element schema of a `z.set(...)`. v3 stores it on
 * `_def.valueType` (parity with v4).
 */
export function getSetValueType(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.valueType as z.ZodTypeAny | undefined
}

export function getRecordKeyType(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.keyType as z.ZodTypeAny | undefined
}

export function getRecordValueType(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.valueType as z.ZodTypeAny | undefined
}

export function getTupleItems(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const def = readDef(schema)
  return (def?.items as readonly z.ZodTypeAny[] | undefined) ?? []
}

export function getUnionOptions(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const def = readDef(schema)
  return (def?.options as readonly z.ZodTypeAny[] | undefined) ?? []
}

/** ZodDiscriminatedUnion options typed narrowly as ZodObject (v3's DU options are always objects). */
export function getDiscriminatedOptions(schema: z.ZodTypeAny): readonly z.AnyZodObject[] {
  const def = readDef(schema)
  return (def?.options as readonly z.AnyZodObject[] | undefined) ?? []
}

/** ZodDiscriminatedUnion: the discriminator key (e.g. 'status'). */
export function getDiscriminator(schema: z.ZodTypeAny): string | undefined {
  const def = readDef(schema)
  return def?.discriminator
}

export function getIntersectionLeft(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.left as z.ZodTypeAny | undefined
}

export function getIntersectionRight(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.right as z.ZodTypeAny | undefined
}

// ---------- Wrapper unwrap (return inner schema) ----------

/**
 * Reads `_def.innerType` — the inner schema for transparent wrappers
 * (Optional / Nullable / Default / Catch / Readonly). Returns
 * undefined for kinds that don't carry an inner (Branded uses
 * `_def.type`; use `unwrapBranded` instead; Effects uses
 * `_def.schema`, use `unwrapEffectsSource`).
 */
export function unwrapInner(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.innerType as z.ZodTypeAny | undefined
}

/**
 * `ZodBranded`'s inner schema lives on `_def.type` (v3 quirk; v4 uses
 * `_def.innerType` for branded). Returns undefined for non-Branded.
 */
export function unwrapBranded(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.type as z.ZodTypeAny | undefined
}

/**
 * `ZodEffects` structural source — the inner schema being refined /
 * transformed / preprocessed. v3 stores this on `_def.schema`
 * (v4 has no ZodEffects equivalent; refinements live on the schema
 * directly).
 */
export function unwrapEffectsSource(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.schema as z.ZodTypeAny | undefined
}

/**
 * Kind of effect carried by a `ZodEffects` — `'refinement'`,
 * `'transform'`, `'preprocess'`, or undefined when the def shape is
 * malformed. Used by the preprocess-or-coerce-leaf detector to scope
 * the slim-primitive write gate.
 */
export function getEffectsKind(
  schema: z.ZodTypeAny
): 'refinement' | 'transform' | 'preprocess' | undefined {
  const def = readDef(schema)
  const type = def?.effect?.type
  if (type === 'refinement' || type === 'transform' || type === 'preprocess') return type
  return undefined
}

/** ZodPipeline input schema. */
export function unwrapPipeIn(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.in as z.ZodTypeAny | undefined
}

/** ZodPipeline output schema. */
export function unwrapPipeOut(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.out as z.ZodTypeAny | undefined
}

/**
 * Convenience: returns the pipeline's input side, falling back to the
 * output side. Mirrors v4's `unwrapPipe`. For most adapter call sites
 * the input side is the right anchor (consumers write values for
 * the input schema; the output is derived).
 */
export function unwrapPipe(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  return unwrapPipeIn(schema) ?? unwrapPipeOut(schema)
}

/**
 * Resolve a `z.lazy(() => inner)` to its inner schema by invoking the
 * getter. Each invocation runs the factory fresh, so the returned
 * schema may be a distinct object per call — cycle detection should
 * track the getter function identity (see `getLazyGetter`), not the
 * resulting schema. Returns undefined when the getter is absent or
 * throws.
 */
export function unwrapLazy(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  const getter = def?.getter
  if (typeof getter !== 'function') return undefined
  try {
    return getter() as z.ZodTypeAny
  } catch {
    return undefined
  }
}

/** Getter function reference on a `z.lazy()` — used for recursion detection. */
export function getLazyGetter(schema: z.ZodTypeAny): (() => unknown) | undefined {
  const def = readDef(schema)
  return typeof def?.getter === 'function' ? def.getter : undefined
}

// ---------- Value carriers ----------

export function getLiteralValue(schema: z.ZodTypeAny): unknown {
  const def = readDef(schema)
  return def?.value
}

/**
 * Raw values object on a `z.nativeEnum(E)` — the TypeScript enum
 * object itself. Numeric enums have a reverse mapping
 * (`enum E { A } → { A: 0, '0': 'A' }`); callers that need the valid
 * runtime members must filter the reverse-mapped numeric keys
 * themselves.
 */
export function getNativeEnumValues(schema: z.ZodTypeAny): Record<string, unknown> | undefined {
  const def = readDef(schema)
  return def?.values
}

/**
 * Resolve a `z.default(...)` wrapper's value by invoking the v3
 * `_def.defaultValue` thunk. v3 stores the default as a function
 * (lazy evaluation, useful for `new Date()` defaults); v4 stores the
 * value directly. Returns undefined when the field is missing.
 */
export function getDefaultValue(schema: z.ZodTypeAny): unknown {
  const def = readDef(schema)
  const thunk = def?.defaultValue
  if (typeof thunk !== 'function') return undefined
  try {
    return thunk()
  } catch {
    return undefined
  }
}

/**
 * Materialise the fallback value of a `z.catch(inner, value)` wrapper.
 * v3 stores the catch as a function `(ctx) => value` on
 * `_def.catchValue` (parity with v4); we invoke it with a placeholder
 * context. Consumer catch functions that inspect `ctx.input` / `ctx.error`
 * during default-values derivation are rare — if the function throws,
 * we surface `undefined` and let the validate-then-fix loop find a
 * fallback.
 */
export function getCatchDefault(schema: z.ZodTypeAny): unknown {
  const def = readDef(schema)
  const cv = def?.catchValue
  if (typeof cv !== 'function') return undefined
  try {
    return cv({ error: null, input: undefined })
  } catch {
    return undefined
  }
}

// ---------- Refinement payload ----------

/** True if the schema's `_def` carries refinement checks (e.g. `.min(3)`). */
export function hasChecks(schema: z.ZodTypeAny): boolean {
  const def = readDef(schema)
  const checks = def?.checks
  return Array.isArray(checks) && checks.length > 0
}

/** Raw checks array. Empty when the schema has no refinements. */
export function getChecks(schema: z.ZodTypeAny): readonly unknown[] {
  const def = readDef(schema)
  const checks = def?.checks
  return Array.isArray(checks) ? (checks as readonly unknown[]) : []
}

// ---------- Walkers ----------

/**
 * True iff the v3 schema tree carries a refine / transform / preprocess
 * (`ZodEffects`) whose effect target is a container — Object / Array /
 * Tuple / Union / DU / Intersection / Record / Set — or the root
 * itself. Drives the runtime's per-keystroke scope cut: a tree with
 * leaf-only effects can be re-validated at the edited subtree alone
 * (subtree pass catches the leaf effect at the same depth); a
 * container effect can be moved by sibling writes and forces a
 * whole-form pass.
 *
 * Transparent wrappers (Optional / Nullable / Default / Catch /
 * Readonly / Branded / Lazy) peel through to their inner before
 * container detection — `.refine` on `.optional()` over a
 * `z.object(...)` is still a root-scoped effect. Pipelines walk both
 * sides.
 *
 * Bias conservative: an unrecognised wrapper or a malformed leaf
 * returns `false` for THAT node, but the recurse continues, so
 * nested container effects still surface. False negatives only lose
 * the perf win; correctness preserved by the caller's whole-form
 * default when the predicate isn't reached.
 */
export function hasContainerOrRootRefine(schema: z.ZodTypeAny, seen?: WeakSet<object>): boolean {
  const visited = seen ?? new WeakSet<object>()
  const candidate = schema as unknown
  if (typeof candidate !== 'object' || candidate === null) return false
  if (visited.has(candidate)) return false
  visited.add(candidate)

  // ZodEffects: refine / transform / preprocess. Peel transparent
  // wrappers off the inner so `.refine()` applied to `.optional()`
  // over a container still flags as a container-level effect.
  if (isZodSchemaType(schema, 'ZodEffects')) {
    const inner = unwrapEffectsSource(schema)
    if (inner === undefined) return false
    if (isContainerAfterWrapperPeel(inner)) return true
    return hasContainerOrRootRefine(inner, visited)
  }

  // Transparent wrappers: recurse into the inner without flagging.
  if (
    isZodSchemaType(schema, 'ZodOptional') ||
    isZodSchemaType(schema, 'ZodNullable') ||
    isZodSchemaType(schema, 'ZodDefault') ||
    isZodSchemaType(schema, 'ZodCatch') ||
    isZodSchemaType(schema, 'ZodReadonly')
  ) {
    const inner = unwrapInner(schema)
    return inner !== undefined && hasContainerOrRootRefine(inner, visited)
  }
  if (isZodSchemaType(schema, 'ZodBranded')) {
    const inner = unwrapBranded(schema)
    return inner !== undefined && hasContainerOrRootRefine(inner, visited)
  }
  if (isZodSchemaType(schema, 'ZodLazy')) {
    const inner = unwrapLazy(schema)
    return inner !== undefined && hasContainerOrRootRefine(inner, visited)
  }
  if (isZodSchemaType(schema, 'ZodPipeline')) {
    const inSide = unwrapPipeIn(schema)
    if (inSide !== undefined && hasContainerOrRootRefine(inSide, visited)) return true
    const outSide = unwrapPipeOut(schema)
    if (outSide !== undefined && hasContainerOrRootRefine(outSide, visited)) return true
    return false
  }

  // Container types: recurse into children.
  if (isZodSchemaType(schema, 'ZodObject')) {
    for (const sub of Object.values(getObjectShape(schema))) {
      if (hasContainerOrRootRefine(sub, visited)) return true
    }
    return false
  }
  if (isZodSchemaType(schema, 'ZodArray')) {
    const elem = getArrayElement(schema)
    return elem !== undefined && hasContainerOrRootRefine(elem, visited)
  }
  if (isZodSchemaType(schema, 'ZodTuple')) {
    for (const it of getTupleItems(schema)) {
      if (hasContainerOrRootRefine(it, visited)) return true
    }
    return false
  }
  if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    for (const opt of getUnionOptions(schema)) {
      if (hasContainerOrRootRefine(opt, visited)) return true
    }
    return false
  }
  if (isZodSchemaType(schema, 'ZodIntersection')) {
    const left = getIntersectionLeft(schema)
    if (left !== undefined && hasContainerOrRootRefine(left, visited)) return true
    const right = getIntersectionRight(schema)
    if (right !== undefined && hasContainerOrRootRefine(right, visited)) return true
    return false
  }
  if (isZodSchemaType(schema, 'ZodRecord')) {
    const keyType = getRecordKeyType(schema)
    if (keyType !== undefined && hasContainerOrRootRefine(keyType, visited)) return true
    const valueType = getRecordValueType(schema)
    if (valueType !== undefined && hasContainerOrRootRefine(valueType, visited)) return true
    return false
  }
  if (isZodSchemaType(schema, 'ZodSet')) {
    const elem = getSetValueType(schema)
    return elem !== undefined && hasContainerOrRootRefine(elem, visited)
  }

  // Leaves (ZodString / ZodNumber / ZodBoolean / ZodLiteral / ZodEnum /
  // ZodNativeEnum / ZodDate / ...) — no descendable structure, no
  // container effect possible.
  return false
}

/**
 * Peel transparent wrappers off a v3 schema up to MAX_UNWRAP_STEPS,
 * then report whether the result is a container kind (Object / Array
 * / Tuple / Intersection / Union / DU / Record / Set). Used by
 * `hasContainerOrRootRefine` to classify the inner side of a
 * ZodEffects.
 */
export function isContainerAfterWrapperPeel(schema: z.ZodTypeAny): boolean {
  let cur: z.ZodTypeAny = schema
  for (let i = 0; i < MAX_UNWRAP_STEPS; i++) {
    if (
      isZodSchemaType(cur, 'ZodOptional') ||
      isZodSchemaType(cur, 'ZodNullable') ||
      isZodSchemaType(cur, 'ZodDefault') ||
      isZodSchemaType(cur, 'ZodCatch') ||
      isZodSchemaType(cur, 'ZodReadonly')
    ) {
      const inner = unwrapInner(cur)
      if (inner === undefined) return false
      cur = inner
    } else if (isZodSchemaType(cur, 'ZodBranded')) {
      const inner = unwrapBranded(cur)
      if (inner === undefined) return false
      cur = inner
    } else if (isZodSchemaType(cur, 'ZodLazy')) {
      const inner = unwrapLazy(cur)
      if (inner === undefined) return false
      cur = inner
    } else {
      break
    }
  }
  return (
    isZodSchemaType(cur, 'ZodObject') ||
    isZodSchemaType(cur, 'ZodArray') ||
    isZodSchemaType(cur, 'ZodTuple') ||
    isZodSchemaType(cur, 'ZodIntersection') ||
    isZodSchemaType(cur, 'ZodUnion') ||
    isZodSchemaType(cur, 'ZodDiscriminatedUnion') ||
    isZodSchemaType(cur, 'ZodRecord') ||
    isZodSchemaType(cur, 'ZodSet')
  )
}
