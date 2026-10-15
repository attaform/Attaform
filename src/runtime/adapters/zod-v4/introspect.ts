/**
 * The ONE file that reads Zod v4's internal `def` shape. Every other file
 * in the adapter goes through these public-shaped accessors, so a Zod
 * minor bump that reshapes internals touches only this file.
 *
 * Treat `schema.def.*` as unstable whatever Zod's docs say. Each helper
 * returns a narrow, well-typed slice, and no adapter code outside this
 * file pattern-matches on `def`.
 */
import type { z } from 'zod'
import type { SchemaCapabilities } from '../../core/abstract-schema-factory'
import { callConsumerFn } from '../../core/consumer-code'
import { __DEV__ } from '../../core/dev'

/**
 * Stable kind discriminant for a Zod v4 schema, returned by `kindOf`.
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
  | 'literal'
  | 'null'
  | 'undefined'
  | 'any'
  | 'unknown'
  | 'optional'
  | 'nullable'
  | 'default'
  | 'pipe'
  | 'readonly'
  | 'nan'
  | 'void'
  | 'never'
  | 'lazy'
  | 'intersection'
  | 'catch'
  | 'promise'
  | 'custom'
  | 'template-literal'
  | 'transform'
  | 'file'
  // Both carry their subject on `def.innerType`, so the walkers treat
  // them as transparent wrappers. `nonoptional` additionally subtracts
  // `undefined`, which is the whole point of it.
  | 'nonoptional'
  | 'success'
  // Enumerated so `assert-supported.ts` can reject them at construction;
  // none is form-representable, and `UNSUPPORTED` carries the reasoning.
  // Without explicit cases they would fall to `'unknown'` and the assert
  // step would read them as opaque leaves.
  | 'map'
  | 'symbol'
  | 'function'

// The unstable `def` surface. Every read of it goes through a helper
// below, never inline.
interface ZodInternalShape {
  def?: {
    type?: string
    element?: unknown
    innerType?: unknown
    options?: readonly unknown[]
    shape?: Record<string, unknown>
    keyType?: unknown
    valueType?: unknown
    items?: readonly unknown[]
    values?: readonly unknown[]
    entries?: Record<string, unknown>
    discriminator?: string
    defaultValue?: unknown
    in?: unknown
    out?: unknown
    checks?: readonly unknown[]
    // Added for the extended kind coverage. `getter` on z.lazy(),
    // `left`/`right` on z.intersection(), `catchValue` on z.catch(),
    // `parts` on z.templateLiteral().
    getter?: () => unknown
    left?: unknown
    right?: unknown
    catchValue?: (ctx: { error: unknown; input: unknown }) => unknown
    parts?: readonly unknown[]
    // ZodTransform's user-supplied function, which is also how
    // preprocess is stored: `z.preprocess(fn, inner)` desugars to a pipe
    // whose `def.in` is a ZodTransform with `def.transform = fn`.
    transform?: unknown
    // `z.coerce.X()` is a plain primitive with `def.coerce === true`,
    // NOT a pipe; the flag is what drives Zod's own `safeParse` to
    // cast.
    coerce?: boolean
  }
}

function readDef(schema: unknown): ZodInternalShape['def'] | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  return (schema as ZodInternalShape).def
}

// The handful of `def.type` spellings that don't match their `ZodKind`
// verbatim. Everything else is identity-mapped via `IDENTITY_KINDS`.
const KIND_ALIAS: ReadonlyMap<string, ZodKind> = new Map([
  ['discriminated_union', 'discriminated-union'],
  ['discriminatedUnion', 'discriminated-union'],
  ['prefault', 'default'],
  ['template_literal', 'template-literal'],
  ['templateLiteral', 'template-literal'],
])

const IDENTITY_KINDS = new Set<string>([
  'object',
  'array',
  'set',
  'record',
  'tuple',
  'string',
  'number',
  'boolean',
  'bigint',
  'date',
  'enum',
  'literal',
  'null',
  'undefined',
  'any',
  'unknown',
  'optional',
  'nullable',
  'default',
  'pipe',
  'readonly',
  'nan',
  'void',
  'never',
  'lazy',
  'intersection',
  'catch',
  'promise',
  'custom',
  'transform',
  'file',
  'map',
  'symbol',
  'function',
  'nonoptional',
  'success',
])

/**
 * The `ZodKind` of a Zod v4 schema; `'unknown'` for a non-Zod input or an
 * unrecognised shape. Useful in an introspection helper that branches on
 * structure, a custom error formatter or a doc generator.
 */
export function kindOf(schema: unknown): ZodKind {
  const def = readDef(schema)
  const rawType = def?.type
  if (rawType === undefined) return 'unknown'
  // v4 stores `z.discriminatedUnion(...)` as `type: 'union'` with an
  // extra `discriminator: string`, so the two separate here.
  if (rawType === 'union') {
    return def?.discriminator !== undefined ? 'discriminated-union' : 'union'
  }
  const alias = KIND_ALIAS.get(rawType)
  if (alias !== undefined) return alias
  return IDENTITY_KINDS.has(rawType) ? (rawType as ZodKind) : 'unknown'
}

/** Returns schema.shape as Record<string, ZodTypeAny>. */
export function getObjectShape(schema: z.ZodObject): Record<string, z.ZodType> {
  const s = schema as unknown as { shape: Record<string, z.ZodType> }
  return s.shape
}

export function getArrayElement(schema: z.ZodArray): z.ZodType {
  const def = readDef(schema)
  return def?.element as z.ZodType
}

/**
 * The element schema of a `z.set(...)`, on `def.valueType`. Symmetric to
 * `getArrayElement`.
 */
export function getSetValueType(schema: z.ZodType): z.ZodType {
  const def = readDef(schema)
  return def?.valueType as z.ZodType
}

export function getRecordKeyType(schema: z.ZodType): z.ZodType {
  const def = readDef(schema)
  return def?.keyType as z.ZodType
}

export function getRecordValueType(schema: z.ZodType): z.ZodType {
  const def = readDef(schema)
  return def?.valueType as z.ZodType
}

/**
 * Key / value schemas of a `z.map(K, V)`. Both majors store a map's
 * halves under the same `def` slots a record uses, so these read
 * exactly what the record accessors read. They keep their own names
 * because the two kinds answer different questions: a record's keys
 * are strings by construction, a map's are whatever `K` declares, and
 * only a key `K` admits that a path segment can spell is addressable.
 */
export const getMapKeyType = getRecordKeyType
export const getMapValueType = getRecordValueType

export function getTupleItems(schema: z.ZodType): readonly z.ZodType[] {
  const def = readDef(schema)
  return (def?.items as readonly z.ZodType[] | undefined) ?? []
}

export function getUnionOptions(schema: z.ZodType): readonly z.ZodType[] {
  const def = readDef(schema)
  return (def?.options as readonly z.ZodType[] | undefined) ?? []
}

export function getLiteralValues(schema: z.ZodType): readonly unknown[] {
  const def = readDef(schema)
  return def?.values ?? []
}

export function getEnumValues(schema: z.ZodType): readonly (string | number)[] {
  const def = readDef(schema)
  const entries = def?.entries
  if (entries === undefined) return []
  return Object.values(entries) as (string | number)[]
}

export function unwrapInner(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.innerType as z.ZodType | undefined
}

export function unwrapPipe(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return (def?.in as z.ZodType | undefined) ?? (def?.out as z.ZodType | undefined)
}

/** A pipe's input side, which for a preprocess is the transform. */
export function unwrapPipeIn(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.in as z.ZodType | undefined
}

/**
 * Detect `z.coerce.X()`: a primitive carrying `def.coerce === true`. v4
 * does NOT wrap coerce in a pipe; the flag is what drives `safeParse` to
 * cast. True for any schema whose def opted in, whatever its kind.
 */
export function isCoercePrimitive(schema: unknown): boolean {
  return readDef(schema)?.coerce === true
}

/**
 * Detect `z.preprocess(fn, inner)`, which v4 desugars to a pipe whose
 * `def.in` is a `ZodTransform`. The factory's `isPreprocessOrCoerceLeaf`
 * reads it beside `isCoercePrimitive` to pass raw consumer writes
 * through the wrapped subtree verbatim.
 */
export function isPreprocessNode(schema: unknown): boolean {
  return kindOf(schema) === 'pipe' && kindOf(readDef(schema)?.in) === 'transform'
}

/** A pipe's output side, the `inner` of `z.preprocess(fn, inner)`. */
export function unwrapPipeOut(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.out as z.ZodType | undefined
}

/**
 * Resolve a `z.lazy(() => inner)` by invoking its factory. Each call runs
 * the arrow fresh, so the schema that comes back is a distinct object
 * every time: cycle detection has to track the GETTER's identity, never
 * the resulting schema.
 */
export function unwrapLazy(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  const getter = def?.getter
  if (typeof getter !== 'function') return undefined
  return callConsumerFn(() => getter() as z.ZodType | undefined, undefined, 'lazy-getter')
}

/** The getter function on a `z.lazy()`, which is what cycle detection keys on. */
export function getLazyGetter(schema: z.ZodType): (() => unknown) | undefined {
  const def = readDef(schema)
  return typeof def?.getter === 'function' ? def.getter : undefined
}

export function getIntersectionLeft(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.left as z.ZodType | undefined
}

export function getIntersectionRight(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.right as z.ZodType | undefined
}

/**
 * Materialise a `z.catch(inner, value)`'s fallback. v4 stores the catch
 * as a `(ctx) => value` function on `def.catchValue`, and this invokes it
 * with a placeholder context. A catch function that inspects `ctx.input`
 * or `ctx.error` during default derivation is rare; if one throws, the
 * result is `undefined`, and the derivation takes that as the slot's default.
 */
export function getCatchDefault(schema: z.ZodType): unknown {
  const def = readDef(schema)
  const cv = def?.catchValue
  if (typeof cv !== 'function') return undefined
  return callConsumerFn(
    () => cv({ error: new Error('atta:default-values'), input: undefined }),
    undefined,
    'catch-factory'
  )
}

/** True iff the schema carries a callable `z.catch(...)` fallback. */
export function hasCatchValue(schema: z.ZodType): boolean {
  const def = readDef(schema)
  return typeof def?.catchValue === 'function'
}

export function getDefaultValue(schema: z.ZodType): unknown {
  const def = readDef(schema)
  // v4 stores `defaultValue` as a getter returning the value directly,
  // where v3 stored a function to call. Reading the property normally
  // fires that getter, which means a consumer's `.default(() => ...)`
  // factory runs right here, inside a walk `useForm(...)` is waiting on.
  // Unguarded, a throwing factory comes out of `useForm` and takes the
  // host component with it.
  return callConsumerFn(() => def?.defaultValue, undefined, 'default-factory')
}

/**
 * v3-parity stub. v4 folds `z.nativeEnum(E)` into the regular `enum`
 * kind, so a v4 schema never has a reverse-mapped values object. It stays
 * on the introspect surface to keep the shared `SchemaIntrospector`
 * contract uniform across the two adapters; the core walkers read it for
 * the v3-only native-enum branch and skip silently here.
 *
 * The three stubs read as one helper waiting to happen. Folding them
 * into a shared `noV3Construct` was measured 5 B LARGER: gzip already
 * collects three adjacent identical bodies, while the shared name and
 * its re-exports are new tokens.
 */
export function getNativeEnumValues(_schema: z.ZodType): Record<string, unknown> | undefined {
  return undefined
}

/**
 * v3-parity stub. v4 has no `ZodEffects`: refinements live on
 * `def.checks`, a transform is a pipe's `def.in`, and preprocess is a
 * pipe with a transform on `in`. `undefined` here tells the shared
 * walkers there is no effects source to peel.
 */
export function unwrapEffectsSource(_schema: z.ZodType): z.ZodType | undefined {
  return undefined
}

/**
 * v3-parity stub. v4 has no `ZodBranded`: a brand is type-level only and
 * introduces no runtime wrapper. `undefined` here tells the shared
 * walkers there is no branded inner to peel.
 */
export function unwrapBranded(_schema: z.ZodType): z.ZodType | undefined {
  return undefined
}

/** True if the schema's `def` carries refinement checks (e.g. `.min(3)`). */
export function hasChecks(schema: z.ZodType): boolean {
  const def = readDef(schema)
  const checks = def?.checks
  return Array.isArray(checks) && checks.length > 0
}

/** Raw checks array. Empty when the schema has no refinements. */
export function getChecks(schema: unknown): readonly unknown[] {
  const def = readDef(schema)
  const checks = def?.checks
  return Array.isArray(checks) ? (checks as readonly unknown[]) : []
}

/** ZodDiscriminatedUnion: the discriminator key (e.g. 'status'). */
export function getDiscriminator(schema: z.ZodType): string | undefined {
  const def = readDef(schema)
  return def?.discriminator
}

/** ZodDiscriminatedUnion: the option objects (typed narrowly as ZodObject). */
export function getDiscriminatedOptions(schema: z.ZodType): readonly z.ZodObject[] {
  const def = readDef(schema)
  const options = def?.options
  return Array.isArray(options) ? (options as readonly z.ZodObject[]) : []
}

/**
 * Verify a schema is Zod v4, throwing a clear error for a v3 schema
 * imported through `attaform/zod` by mistake. The adapter calls it on
 * every schema; reach for it directly only in a custom adapter that
 * wants the same guard.
 */
export function assertZodVersion(schema: unknown): void {
  const def = readDef(schema)
  if (def?.type === undefined) {
    throw new Error(
      __DEV__
        ? '[attaform/zod-v4] Schema is not a Zod v4 schema. The `attaform/zod-v4` adapter requires ' +
            'zod@^4. Either: (a) install zod@^4 in your project; (b) import from `attaform/zod`, ' +
            'which auto-detects the Zod version (and tree-shakes to a single adapter when the ' +
            '`attaform/vite` plugin is active); or (c) import from `attaform/zod-v3` if you are ' +
            'staying on Zod v3.'
        : '[attaform] AF01 attaform.dev/e/af01'
    )
  }
}

// Every descendable `def.*` child slot, as data: single sub-schemas,
// record-shaped maps of sub-schemas, and list-shaped option/item arrays.
const DESCEND_SINGLE = [
  'innerType',
  'element',
  'in',
  'out',
  'left',
  'right',
  'keyType',
  'valueType',
] as const
const DESCEND_RECORD = ['shape', 'entries'] as const
const DESCEND_LIST = ['options', 'items'] as const

/**
 * The descendable slots whose presence makes a node a container, for
 * `containerOrRootRefine`. A form root is always a container, so its
 * checks count as root refines.
 */
const CONTAINER_SLOTS = [
  'shape',
  'entries',
  'element',
  'options',
  'items',
  'keyType',
  'valueType',
  'left',
  'right',
] as const

/** Answers already walked, keyed by the node each query started from. */
const capabilityMemo = new WeakMap<object, SchemaCapabilities>()

/**
 * Every capability bit for the tree under `schema`, memoized per node for
 * the life of the process: a root schema's questions are asked by every
 * form built on it, and by its verdict.
 *
 * Only the node a query started from is memoized. Inside a lazy cycle a
 * descendant's walk stops where it meets a node already visited, so
 * what the walk saw below a descendant is not that descendant's answer.
 */
export function capabilitiesOf(schema: z.ZodType): SchemaCapabilities {
  let capabilities = capabilityMemo.get(schema)
  if (capabilities === undefined) {
    capabilities = scanCapabilities(schema)
    const key: unknown = schema
    if (typeof key === 'object' && key !== null) capabilityMemo.set(key, capabilities)
  }
  return capabilities
}

/**
 * Every capability bit for the tree under `schema`, from one depth-first
 * walk and without the memo. A sub-schema built for one path query asks
 * through this: it is asked once, and a `WeakMap` insert costs more than
 * walking the few nodes under a path.
 *
 * Per node:
 * - `asyncRefine`: a check in `def.checks` whose `def.fn` is an
 *   `AsyncFunction` (`isAsyncCheck`). A direct `async (v) => ...`
 *   refinement is caught; a sync function that merely RETURNS a promise
 *   is not, and is better written `async` anyway. A false negative only
 *   delays async refines until the first mutation.
 * - `asyncTransform`: a `ZodTransform` whose `def.transform` is an
 *   `AsyncFunction`. `z.preprocess(fn, inner)` desugars to a pipe whose
 *   `def.in` is that transform, and an async `fn` makes the input side
 *   async-only: a sync `safeParse` invokes it, gets a promise back, and
 *   a rejection inside it goes unhandled.
 * - `discriminatedUnion`: `kindOf` reads `'discriminated-union'`.
 * - `preprocessOrCoerce`: `isCoercePrimitive` or `isPreprocessNode`.
 * - `containerOrRootRefine`: the node carries checks and holds one of
 *   `CONTAINER_SLOTS`. A `.refine` added on top of a transparent wrapper
 *   lands its check on the WRAPPER node, so the wrapper's own
 *   `def.checks` is what gets inspected and wrappers need no case of
 *   their own. An unrecognised `def` shape answers false for that node
 *   while the walk descends, so a nested container check still surfaces:
 *   a miss costs the subtree scoping, never correctness.
 */
export function scanCapabilities(schema: z.ZodType): SchemaCapabilities {
  const capabilities: Capabilities = {
    asyncRefine: false,
    asyncTransform: false,
    discriminatedUnion: false,
    containerOrRootRefine: false,
    preprocessOrCoerce: false,
  }
  walkCapabilities(schema, capabilities, new WeakSet<object>())
  return capabilities
}

type Capabilities = { -readonly [K in keyof SchemaCapabilities]: SchemaCapabilities[K] }

/**
 * The walk behind `scanCapabilities`. It descends every `def.*` child slot
 * (innerType, element, pipe in and out, intersection sides, record key
 * and value, object shape, DU entries, union options, tuple items and
 * the lazy getter) and sets each bit a node earns. It walks the whole
 * tree: a schema rarely earns every bit, so stopping early buys nothing
 * a reader would notice.
 *
 * `visited` guards cycles: a lazy schema whose resolver returns the SAME
 * instance on repeat calls. A malformed child that is not an object
 * counts as no match. Resolving a lazy is wrapped in try/catch, because
 * a recursively-defined schema can throw before its inner is
 * constructed; that branch counts as no match and the walk continues.
 */
function walkCapabilities(
  node: unknown,
  capabilities: Capabilities,
  visited: WeakSet<object>
): void {
  if (typeof node !== 'object' || node === null || visited.has(node)) return
  visited.add(node)
  const def = readDef(node)
  if (def === undefined) return

  const checks = getChecks(node)
  if (checks.some(isAsyncCheck)) capabilities.asyncRefine = true
  if (checks.length > 0 && CONTAINER_SLOTS.some((key) => def[key] !== undefined)) {
    capabilities.containerOrRootRefine = true
  }
  if (typeof def.transform === 'function' && def.transform.constructor.name === 'AsyncFunction') {
    capabilities.asyncTransform = true
  }
  if (kindOf(node) === 'discriminated-union') capabilities.discriminatedUnion = true
  if (isCoercePrimitive(node) || isPreprocessNode(node)) capabilities.preprocessOrCoerce = true

  for (const key of DESCEND_SINGLE) walkCapabilities(def[key], capabilities, visited)
  for (const key of DESCEND_RECORD) {
    for (const sub of Object.values(def[key] ?? {})) walkCapabilities(sub, capabilities, visited)
  }
  for (const key of DESCEND_LIST) {
    for (const sub of def[key] ?? []) walkCapabilities(sub, capabilities, visited)
  }
  if (typeof def.getter === 'function') {
    try {
      walkCapabilities(def.getter(), capabilities, visited)
    } catch {
      // A lazy may throw on resolution before its referenced schema is
      // constructed; no match, and continue.
    }
  }
}

interface ZodCheckInternals {
  _def?: { fn?: unknown }
  def?: { fn?: unknown }
  _zod?: { def?: { fn?: unknown } }
}

export function isAsyncCheck(check: unknown): boolean {
  if (typeof check !== 'object' || check === null) return false
  const c = check as ZodCheckInternals
  const fn = c._def?.fn ?? c.def?.fn ?? c._zod?.def?.fn
  if (typeof fn !== 'function') return false
  return fn.constructor.name === 'AsyncFunction'
}
