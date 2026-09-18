/**
 * The ONE file that reads Zod v3's internal `_def` shape. Every other
 * file in the adapter goes through these public-shaped accessors, so a
 * v3 minor bump that reshapes internals touches only this file. The v4
 * adapter has the same surface, plus this one carries accessors for the
 * kinds v4 dropped: `ZodEffects`, `ZodPipeline`, `ZodBranded` and
 * `ZodNativeEnum`.
 *
 * Treat `schema._def.*` as unstable whatever Zod's docs say. Each helper
 * returns a narrow, well-typed slice, and no adapter code outside this
 * file pattern-matches on `_def`.
 */
import type { z } from 'zod-v3'
import { callConsumerSchemaFn } from '../../core/consumer-code'
import { __DEV__ } from '../../core/dev'
import { isZodSchemaType } from './helpers'

// Shared cap for every wrapper-peeling helper. A pathological schema, a
// deep `.refine()` chain or a self-referential lazy loop, would
// otherwise stack-overflow or hang. 64 is generous for a real form
// schema, and past it the helpers bail rather than crash.
const MAX_UNWRAP_STEPS = 64

/**
 * Stable kind discriminant for a Zod v3 schema. It matches the v4
 * adapter's `ZodKind` wherever both majors carry a kind, and adds
 * `'effects'`, `'pipeline'`, `'branded'`, `'native-enum'`, `'function'`,
 * `'map'`, `'symbol'` and `'promise'` for the ones only v3 exposes.
 * Reach for it in a custom integration that branches on schema shape.
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

// The unstable `_def` surface. Every read of it goes through a helper
// below, never inline.
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
    // ZodUnion / ZodDiscriminatedUnion / ZodEnum. A discriminated union
    // carried its options as a `Map` before zod 3.20.0 and as an array
    // since, so `readOptionList` normalises both rather than asserting
    // either.
    options?: readonly unknown[] | Map<unknown, unknown>
    optionsMap?: Map<unknown, unknown> // ZodDiscriminatedUnion parse routing
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
    // `z.coerce.X()` sets `coerce: true` on the wrapped primitive's def:
    // the constructor hands back a plain ZodString or ZodNumber rather
    // than a wrapper, and the flag is what drives Zod's own safeParse to
    // cast. Read by `isCoercePrimitive`.
    coerce?: boolean
  }
}

function readDef(schema: unknown): ZodV3InternalShape['_def'] | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  return (schema as ZodV3InternalShape)._def
}

/**
 * The `ZodKind` of a Zod v3 schema. A non-Zod input or an unrecognised
 * shape is `'unknown'`, which collides with `ZodUnknown` deliberately;
 * `ZodUnknown` is rare in a form schema.
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
 * Verify a schema is Zod v3, throwing a clear error for a v4 schema,
 * which carries `def.type` rather than `_def.typeName`, or for a non-Zod
 * value imported through `attaform/zod-v3` by mistake. The adapter calls
 * it on every schema; reach for it directly only in a custom adapter
 * that wants the same guard.
 */
export function assertZodVersion(schema: unknown): void {
  const def = readDef(schema)
  if (def?.typeName === undefined) {
    throw new Error(
      __DEV__
        ? '[attaform/zod-v3] Schema is not a Zod v3 schema. The `attaform/zod-v3` adapter requires ' +
            'zod@^3. Either: (a) install zod@^3 in your project; (b) import from `attaform/zod`, ' +
            'which auto-detects the Zod version (and tree-shakes to a single adapter when the ' +
            '`attaform/vite` plugin is active); or (c) import from `attaform/zod-v4` if you are ' +
            'on Zod v4.'
        : '[attaform] AF01 attaform.dev/e/af01'
    )
  }
}

// ---------- Container accessors ----------

/**
 * The object's `Record<string, ZodTypeAny>` shape. v3 keeps it as a
 * thunk on `_def.shape`, for lazy evaluation of self-referential
 * schemas, and the instance's `.shape` getter resolves to the same
 * record. The thunk comes first, so a schema built without the getter
 * still resolves.
 */
export function getObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const def = readDef(schema)
  const raw = def?.shape
  if (typeof raw === 'function') return raw() as Record<string, z.ZodTypeAny>
  if (raw !== undefined) return raw as Record<string, z.ZodTypeAny>
  // Only reached when the schema was built along a path that left
  // `_def.shape` unpopulated.
  return (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {}
}

/**
 * The element schema of a `z.array(...)`. v3 keeps it on `_def.type`;
 * `_def.element` is v4's spelling.
 */
export function getArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.type as z.ZodTypeAny | undefined
}

/**
 * The element schema of a `z.set(...)`, on `_def.valueType` as in v4.
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

/**
 * Key / value schemas of a `z.map(K, V)`. Both majors store a map's
 * halves under the same `_def` slots a record uses, so these read
 * exactly what the record accessors read. They keep their own names
 * because the two kinds answer different questions: a record's keys
 * are strings by construction, a map's are whatever `K` declares, and
 * only a key `K` admits that a path segment can spell is addressable.
 */
export const getMapKeyType = getRecordKeyType
export const getMapValueType = getRecordValueType

export function getTupleItems(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const def = readDef(schema)
  return (def?.items as readonly z.ZodTypeAny[] | undefined) ?? []
}

/**
 * Read `_def.options` as a list whichever container zod put it in.
 *
 * A discriminated union's options were a `Map` keyed by discriminator
 * value until zod 3.20.0 and an array since. A cast to the array shape
 * compiles against either, which is how an older zod could silently drop
 * every consumer `.default()` inside a DU branch: the walk read a Map as
 * an array, saw no entries, and derived defaults from nothing.
 *
 * Normalising both is what supports zod v3 at its own declared floor
 * rather than at whichever version this repo installs.
 * `peerDependencies.zod` says `>=3.0.0` and now means it.
 */
function readOptionList(
  options: readonly unknown[] | Map<unknown, unknown> | undefined
): unknown[] {
  if (options === undefined) return []
  if (options instanceof Map) return [...options.values()]
  return [...options]
}

export function getUnionOptions(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  return readOptionList(readDef(schema)?.options) as readonly z.ZodTypeAny[]
}

/** ZodDiscriminatedUnion options typed narrowly as ZodObject (v3's DU options are always objects). */
export function getDiscriminatedOptions(schema: z.ZodTypeAny): readonly z.AnyZodObject[] {
  return readOptionList(readDef(schema)?.options) as readonly z.AnyZodObject[]
}

/** ZodDiscriminatedUnion: the discriminator key (e.g. 'status'). */
export function getDiscriminator(schema: z.ZodTypeAny): string | undefined {
  const def = readDef(schema)
  return def?.discriminator
}

/**
 * ZodDiscriminatedUnion: the `discriminatorValue -> option` map zod
 * builds at construction and reads in `_parse` to route a value to its
 * branch. Reused when rebuilding a slimmed DU so the new map keys off
 * zod's own discriminator extraction rather than re-deriving it.
 */
export function getDiscriminatedOptionsMap(
  schema: z.ZodTypeAny
): Map<unknown, z.AnyZodObject> | undefined {
  const def = readDef(schema)
  // Before zod 3.20.0 there was no separate `_def.optionsMap`: the
  // routing map WAS `_def.options`.
  const map = def?.optionsMap ?? def?.options
  return map instanceof Map ? (map as Map<unknown, z.AnyZodObject>) : undefined
}

/**
 * Whether this zod keeps a discriminated union's branches in the `Map` at
 * `_def.options` (before 3.20.0) rather than in an array beside a separate
 * `_def.optionsMap` (3.20.0 on). A rebuild has to write the replacement
 * back in the shape the installed zod's `_parse` reads, or the rebuilt
 * schema rejects every value.
 */
export function discriminatedOptionsAreMapped(schema: z.ZodTypeAny): boolean {
  return readDef(schema)?.options instanceof Map
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
 * `_def.innerType`, the inner schema of a transparent wrapper: Optional,
 * Nullable, Default, Catch or Readonly. `undefined` for a kind that
 * carries no inner there; Branded uses `_def.type` (`unwrapBranded`) and
 * Effects uses `_def.schema` (`unwrapEffectsSource`).
 */
export function unwrapInner(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.innerType as z.ZodTypeAny | undefined
}

/**
 * `ZodBranded`'s inner schema, on `_def.type`; v4 puts it on
 * `_def.innerType`. `undefined` for anything else.
 */
export function unwrapBranded(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.type as z.ZodTypeAny | undefined
}

/**
 * A `ZodEffects`' structural source, the inner schema being refined,
 * transformed or preprocessed, on `_def.schema`. v4 has no equivalent
 * kind; its refinements live on the schema itself.
 */
export function unwrapEffectsSource(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  return def?.schema as z.ZodTypeAny | undefined
}

/**
 * The raw `_def.effect` record of a `ZodEffects`.
 *
 * `getEffectsKind` answers what KIND of effect it is; this returns the
 * record itself, for the one caller that needs to rebuild a node with a
 * replacement effect rather than merely classify it.
 */
export function getEffect(schema: z.ZodTypeAny): Record<string, unknown> | undefined {
  const def = readDef(schema)
  // `readDef` already types `effect` as an optional object, so
  // `undefined` is the only non-record it can be.
  return def?.effect as Record<string, unknown> | undefined
}

/**
 * Which effect a `ZodEffects` carries: `'refinement'`, `'transform'`,
 * `'preprocess'`, or `undefined` on a malformed def. The
 * preprocess-or-coerce-leaf detector reads it to scope the
 * slim-primitive write gate.
 */
export function getEffectsKind(
  schema: z.ZodTypeAny
): 'refinement' | 'transform' | 'preprocess' | undefined {
  const def = readDef(schema)
  const type = def?.effect?.type
  if (type === 'refinement' || type === 'transform' || type === 'preprocess') return type
  return undefined
}

/**
 * Detect `z.coerce.X()`: a primitive carrying `_def.coerce === true`. v3
 * records coerce as a flag on the primitive's own def rather than as a
 * wrapper, so the typeName reads as a plain `ZodString` or `ZodNumber`
 * and a caller still has to ask. It matters because default-derivation
 * leaves a coerce slot `undefined` and the slim-primitive write gate
 * passes raw consumer writes through the coerce subtree verbatim. v4's
 * `isCoercePrimitive` is the same test.
 */
export function isCoercePrimitive(schema: z.ZodTypeAny): boolean {
  return readDef(schema)?.coerce === true
}

/**
 * Detect `z.preprocess(fn, inner)`, which v3 wraps in a `ZodEffects`
 * with `effect.type === 'preprocess'`. The factory's
 * `isPreprocessOrCoerceLeaf` reads it beside `isCoercePrimitive` to pass
 * raw consumer writes through the wrapped subtree verbatim.
 */
export function isPreprocessNode(schema: z.ZodTypeAny): boolean {
  if (!isZodSchemaType(schema, 'ZodEffects')) return false
  return getEffectsKind(schema) === 'preprocess'
}

/**
 * True when a `ZodEffects` carries an `async` predicate, and it can only
 * answer for HALF of them. That asymmetry is intrinsic to v3's runtime
 * model:
 *
 *  - `.transform(asyncFn)` and `z.preprocess(asyncFn, ...)` store the
 *    user fn at `_def.effect.transform`, where `constructor.name ===
 *    'AsyncFunction'` is the standard signal, the same one v4's
 *    `isAsyncCheck` reads.
 *  - `.refine(asyncFn, ...)` wraps the predicate in a SYNC closure,
 *    `(val, ctx) => { const result = check(val); if (result instanceof
 *    Promise) return result.then(...) }`, whose `constructor.name` is
 *    always `'Function'`. The user fn is captured with no static
 *    accessor, so async-ness shows up only at parse time, through the
 *    "Async refinement encountered during synchronous parse" throw.
 *
 * So this flags async transforms and preprocesses reliably, and returns
 * `false` for every refinement effect whatever the user fn does. Pair it
 * with `containsAsyncRefine`, which is conservative for exactly this
 * reason, to cover the refine side.
 */
export function isAsyncEffect(schema: z.ZodTypeAny): boolean {
  const def = readDef(schema)
  const effect = def?.effect
  if (effect === undefined) return false
  // A refinement wrapper is always sync at the outer layer, the user fn
  // living in a closure with nothing statically observable.
  if (effect.type === 'refinement') return false
  const fn = effect.transform
  if (typeof fn !== 'function') return false
  return (fn as { constructor: { name: string } }).constructor.name === 'AsyncFunction'
}

/**
 * True when the v3 schema tree carries a `.refine` anywhere, sync or
 * async. Conservative by necessity: v3 wraps the user predicate in a
 * sync closure (see `isAsyncEffect`), so the two cannot be told apart
 * without invoking the wrapper, and every refinement effect therefore
 * counts as potentially async. That is what keeps the runtime from
 * missing a post-mount async pass.
 *
 * It drives `needsAsyncValidation` alongside `containsAsyncTransform`. A
 * schema whose refines are all sync pays one extra post-mount
 * `safeParseAsync` of the same shape as the sync parse, and nothing a
 * consumer can observe beyond timing changes.
 *
 * `zod-v4/introspect.ts` has the same-named predicate in the same role,
 * except the v4 walker is exact, testing each check with `isAsyncCheck`.
 */
export function containsAsyncRefine(schema: z.ZodTypeAny, seen?: WeakSet<object>): boolean {
  return walkForTarget(schema, 'refinement', seen ?? new WeakSet<object>())
}

/**
 * True iff the v3 schema tree holds a `z.map` or a `z.set` anywhere.
 *
 * Gates the issue-path rewrite in `normalize-issue-paths.ts`: v3 files
 * a map entry's issue under the entry INDEX and a set member's under
 * the member index, neither of which is a path Attaform addresses, so
 * those issues have to be re-filed before they reach the error stores.
 * A schema holding neither skips the rewrite entirely.
 */
export function containsMapOrSet(schema: z.ZodTypeAny, seen?: WeakSet<object>): boolean {
  return walkForTarget(schema, 'map-or-set', seen ?? new WeakSet<object>())
}

/**
 * True when the v3 schema tree holds a `ZodDiscriminatedUnion` at ANY
 * depth: the walk reaches unions inside arrays, tuples, records,
 * intersections, pipelines and cycle-capped lazy schemas. Asked once per
 * form at construction, to set the DU capability flag.
 */
export function containsDiscriminatedUnion(schema: z.ZodTypeAny, seen?: WeakSet<object>): boolean {
  return walkForTarget(schema, 'discriminated-union', seen ?? new WeakSet<object>())
}

/**
 * True when the v3 schema tree carries an async `.transform` or
 * `z.preprocess`. Statically accurate, unlike `containsAsyncRefine`: the
 * user's fn sits at `_def.effect.transform`, and `isAsyncEffect` reads
 * its `constructor.name` just as v4's `isAsyncCheck` does.
 *
 * It gates the `getDefaultValues` path on its own, because an async
 * transform cannot be stripped: the transform's output shape is
 * load-bearing for the inner schema's input, so the construction parse
 * is skipped outright and the post-mount `safeParseAsync` pass takes
 * over. `zod-v4/introspect.ts` carries the same-named predicate.
 */
export function containsAsyncTransform(schema: z.ZodTypeAny, seen?: WeakSet<object>): boolean {
  return walkForTarget(schema, 'transform-or-preprocess', seen ?? new WeakSet<object>())
}

type SchemaWalkTarget =
  'refinement' | 'transform-or-preprocess' | 'discriminated-union' | 'map-or-set'

function walkForTarget(
  schema: z.ZodTypeAny,
  target: SchemaWalkTarget,
  visited: WeakSet<object>
): boolean {
  const candidate = schema as unknown
  if (typeof candidate !== 'object' || candidate === null) return false
  if (visited.has(candidate)) return false
  visited.add(candidate)

  // A refinement effect counts as potentially async unconditionally, v3
  // wrapping the user fn in a sync closure; a transform or preprocess
  // needs a real AsyncFunction at the user payload, which is
  // statically detectable. Recurse through the source either way, so a
  // nested effect deeper in the tree still surfaces.
  if (isZodSchemaType(schema, 'ZodEffects')) {
    const kind = getEffectsKind(schema)
    if (target === 'refinement' && kind === 'refinement') return true
    if (
      target === 'transform-or-preprocess' &&
      (kind === 'transform' || kind === 'preprocess') &&
      isAsyncEffect(schema)
    ) {
      return true
    }
    const inner = unwrapEffectsSource(schema)
    return inner !== undefined && walkForTarget(inner, target, visited)
  }

  // Transparent wrappers: recurse without flagging.
  if (
    isZodSchemaType(schema, 'ZodOptional') ||
    isZodSchemaType(schema, 'ZodNullable') ||
    isZodSchemaType(schema, 'ZodDefault') ||
    isZodSchemaType(schema, 'ZodCatch') ||
    isZodSchemaType(schema, 'ZodReadonly')
  ) {
    const inner = unwrapInner(schema)
    return inner !== undefined && walkForTarget(inner, target, visited)
  }
  if (isZodSchemaType(schema, 'ZodBranded')) {
    const inner = unwrapBranded(schema)
    return inner !== undefined && walkForTarget(inner, target, visited)
  }
  if (isZodSchemaType(schema, 'ZodLazy')) {
    const inner = unwrapLazy(schema)
    return inner !== undefined && walkForTarget(inner, target, visited)
  }
  if (isZodSchemaType(schema, 'ZodPipeline')) {
    const inSide = unwrapPipeIn(schema)
    if (inSide !== undefined && walkForTarget(inSide, target, visited)) return true
    const outSide = unwrapPipeOut(schema)
    if (outSide !== undefined && walkForTarget(outSide, target, visited)) return true
    return false
  }

  // Container types: recurse into children.
  if (isZodSchemaType(schema, 'ZodObject')) {
    for (const sub of Object.values(getObjectShape(schema))) {
      if (walkForTarget(sub, target, visited)) return true
    }
    return false
  }
  if (isZodSchemaType(schema, 'ZodArray')) {
    const elem = getArrayElement(schema)
    return elem !== undefined && walkForTarget(elem, target, visited)
  }
  if (isZodSchemaType(schema, 'ZodTuple')) {
    for (const it of getTupleItems(schema)) {
      if (walkForTarget(it, target, visited)) return true
    }
    return false
  }
  if (isZodSchemaType(schema, 'ZodUnion') || isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    if (target === 'discriminated-union' && isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
      return true
    }
    for (const opt of getUnionOptions(schema)) {
      if (walkForTarget(opt, target, visited)) return true
    }
    return false
  }
  if (isZodSchemaType(schema, 'ZodIntersection')) {
    const left = getIntersectionLeft(schema)
    if (left !== undefined && walkForTarget(left, target, visited)) return true
    const right = getIntersectionRight(schema)
    if (right !== undefined && walkForTarget(right, target, visited)) return true
    return false
  }
  if (isZodSchemaType(schema, 'ZodRecord')) {
    const keyType = getRecordKeyType(schema)
    if (keyType !== undefined && walkForTarget(keyType, target, visited)) return true
    const valueType = getRecordValueType(schema)
    if (valueType !== undefined && walkForTarget(valueType, target, visited)) return true
    return false
  }
  if (isZodSchemaType(schema, 'ZodSet')) {
    if (target === 'map-or-set') return true
    const elem = getSetValueType(schema)
    return elem !== undefined && walkForTarget(elem, target, visited)
  }
  if (isZodSchemaType(schema, 'ZodMap')) {
    if (target === 'map-or-set') return true
    // Both halves are real sub-schemas, so an async refine parked in a
    // map's value type is reachable and has to be found like any other.
    const keyType = getMapKeyType(schema)
    if (keyType !== undefined && walkForTarget(keyType, target, visited)) return true
    const valueType = getMapValueType(schema)
    return valueType !== undefined && walkForTarget(valueType, target, visited)
  }

  // Leaves and unrecognised wrappers: nothing to descend into.
  return false
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
 * The pipeline's input side, falling back to its output side. The input
 * is the right anchor at almost every adapter call site: a consumer
 * writes values for the input schema, the output being derived. v4's
 * `unwrapPipe` is the same.
 */
export function unwrapPipe(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  return unwrapPipeIn(schema) ?? unwrapPipeOut(schema)
}

/**
 * Resolve a `z.lazy(() => inner)` by invoking its getter. Each call runs
 * the factory fresh, so the schema that comes back may be a distinct
 * object every time: cycle detection has to track the GETTER's identity
 * (see `getLazyGetter`), never the resulting schema. `undefined` when the
 * getter is absent or throws.
 */
export function unwrapLazy(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = readDef(schema)
  const getter = def?.getter
  if (typeof getter !== 'function') return undefined
  return callConsumerSchemaFn(() => getter() as z.ZodTypeAny | undefined, undefined, 'lazy-getter')
}

/** The getter function on a `z.lazy()`, which is what cycle detection keys on. */
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
 * Every value a `z.literal(...)` admits, always as an array. v3 puts a
 * single-value literal's value on `_def.value` and a multi-value
 * literal's array on the same slot, so returning one shape lets a caller
 * iterate without testing `Array.isArray`. v4's `getLiteralValues` does
 * the same.
 */
export function getLiteralValues(schema: z.ZodTypeAny): readonly unknown[] {
  const def = readDef(schema)
  const v = def?.value
  if (Array.isArray(v)) return v
  if (v === undefined) return []
  return [v]
}

/**
 * The raw values object on a `z.nativeEnum(E)`, which is the TypeScript
 * enum itself. A numeric enum carries a reverse mapping, so `enum E { A
 * }` reads as `{ A: 0, '0': 'A' }`, and a caller who wants the valid
 * runtime members has to filter the reverse-mapped numeric keys.
 */
export function getNativeEnumValues(schema: z.ZodTypeAny): Record<string, unknown> | undefined {
  const def = readDef(schema)
  return def?.values
}

/**
 * The value behind a `z.default(...)`, read by invoking v3's
 * `_def.defaultValue` thunk. v3 stores a default as a function, which is
 * what makes a `new Date()` default work; v4 stores the value directly.
 * `undefined` when the field is missing.
 */
export function getDefaultValue(schema: z.ZodTypeAny): unknown {
  const def = readDef(schema)
  const thunk = def?.defaultValue
  if (typeof thunk !== 'function') return undefined
  return callConsumerSchemaFn(() => thunk(), undefined, 'default-factory')
}

/**
 * Materialise a `z.catch(inner, value)`'s fallback. v3 stores the catch
 * as a `(ctx) => value` function on `_def.catchValue`, as v4 does, and
 * this invokes it with a placeholder context. A catch function that
 * inspects `ctx.input` or `ctx.error` during default derivation is rare;
 * if one throws, the result is `undefined` and the validate-then-fix
 * loop finds a fallback.
 *
 * This helper collapses a legitimate `undefined` and a missing wrapper
 * into the same answer, so pair it with `hasCatchValue` to tell them
 * apart.
 */
export function getCatchDefault(schema: z.ZodTypeAny): unknown {
  const def = readDef(schema)
  const cv = def?.catchValue
  if (typeof cv !== 'function') return undefined
  return callConsumerSchemaFn(
    () => cv({ error: null, input: undefined }),
    undefined,
    'catch-factory'
  )
}

/** True iff the schema carries a callable `_def.catchValue` (ZodCatch wrapper). */
export function hasCatchValue(schema: z.ZodTypeAny): boolean {
  const def = readDef(schema)
  return typeof def?.catchValue === 'function'
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
 * True when the v3 tree carries a refine, transform or preprocess whose
 * target is a container (Object, Array, Tuple, Union, DU, Intersection,
 * Record or Set) or the root itself.
 *
 * This is the runtime's per-keystroke scope cut. A tree whose effects
 * are all leaf-level can be re-validated at the edited subtree alone,
 * the subtree pass catching the leaf effect at the same depth. A
 * container effect can be moved by a SIBLING write, so it forces a
 * whole-form pass.
 *
 * A transparent wrapper (Optional, Nullable, Default, Catch, Readonly,
 * Branded, Lazy) peels through to its inner before the container test,
 * so `.refine` on `.optional()` over a `z.object(...)` is still
 * root-scoped. A pipeline walks both sides.
 *
 * It biases conservative: an unrecognised wrapper or a malformed leaf
 * answers `false` for THAT node while the recursion continues, so a
 * nested container effect still surfaces. A false negative costs only
 * the perf win, the caller's whole-form default keeping correctness.
 */
export function hasContainerOrRootRefine(schema: z.ZodTypeAny, seen?: WeakSet<object>): boolean {
  const visited = seen ?? new WeakSet<object>()
  const candidate = schema as unknown
  if (typeof candidate !== 'object' || candidate === null) return false
  if (visited.has(candidate)) return false
  visited.add(candidate)

  // Peel transparent wrappers off the inner, so `.refine()` applied to
  // `.optional()` over a container still reads as container-level.
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

  // Leaves: no descendable structure, so no container effect possible.
  return false
}

/**
 * Peel transparent wrappers up to `MAX_UNWRAP_STEPS`, then report
 * whether what is left is a container kind. `hasContainerOrRootRefine`
 * uses it to classify the inner side of a `ZodEffects`.
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
