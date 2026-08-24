/**
 * The single file that reads Zod v4's internal `def` shape. Every other
 * file in the zod-v4 adapter uses these public-shaped accessors — future
 * Zod minor bumps that reshape internals touch only this file.
 *
 * Design principle: treat `schema.def.*` as an unstable surface, even when
 * Zod's docs say otherwise. Each helper returns a narrow, well-typed slice;
 * no adapter code outside this file does shape-based pattern matching on
 * `def`.
 */
import type { z } from 'zod'

/**
 * Stable kind discriminant for a Zod v4 schema. Returned by
 * `kindOf(schema)`. Use when building a custom integration that
 * needs to branch on schema shape — most consumers don't need this.
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
  // Enumerated so `assert-supported.ts` can reject them at construction
  // (none are form-representable — see the rationale on `UNSUPPORTED`).
  // Without explicit cases they would fall to `'unknown'` and the assert
  // step would treat them as opaque leaves.
  | 'map'
  | 'symbol'
  | 'function'

// Narrow accessor for the unstable `def` surface. All reads from this
// object go through helpers below — never inline.
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
    // ZodTransform's user-supplied function (preprocess uses this
    // shape internally — `z.preprocess(fn, inner)` desugars to a pipe
    // whose `def.in` is a ZodTransform with `def.transform = fn`).
    transform?: unknown
    // `z.coerce.X()` in Zod v4 is a primitive schema (ZodString /
    // ZodNumber / etc.) with `def.coerce === true`. It is NOT a pipe;
    // the flag drives Zod's internal `safeParse` to cast the input.
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
])

/**
 * Inspect a Zod v4 schema and return its `ZodKind`. Returns
 * `'unknown'` for non-Zod inputs and unrecognised shapes.
 *
 * Useful when writing introspection helpers that branch on schema
 * structure (e.g. custom error formatters or doc generators).
 */
export function kindOf(schema: unknown): ZodKind {
  const def = readDef(schema)
  const rawType = def?.type
  if (rawType === undefined) return 'unknown'
  // v4 stores `z.discriminatedUnion(...)` as `type: 'union'` with an
  // extra `discriminator: string` field — differentiate here.
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
 * Returns the element schema of a `z.set(...)`. Symmetric to
 * `getArrayElement`; v4 stores the set's element type on `def.valueType`.
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

/** Input side of a pipe — for preprocess detection, this is the transform. */
export function unwrapPipeIn(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.in as z.ZodType | undefined
}

/**
 * Detect `z.coerce.X()` — a primitive schema (ZodString / ZodNumber /
 * etc.) carrying `def.coerce === true`. Zod v4 does NOT wrap coerce in
 * a pipe; the flag drives `safeParse` to cast the input. Returns true
 * for any schema whose def opted into coerce, regardless of kind.
 */
export function isCoercePrimitive(schema: z.ZodType): boolean {
  return readDef(schema)?.coerce === true
}

/**
 * Detect `z.preprocess(fn, inner)` — v4 desugars this to a pipe whose
 * `def.in` is a `ZodTransform`. The factory's `isPreprocessOrCoerceLeaf`
 * consults this alongside `isCoercePrimitive` to gate raw consumer
 * writes verbatim through the wrapped subtree.
 */
export function isPreprocessNode(schema: z.ZodType): boolean {
  if (kindOf(schema) !== 'pipe') return false
  const pipeIn = unwrapPipeIn(schema)
  return pipeIn !== undefined && kindOf(pipeIn) === 'transform'
}

/** Output side of a pipe — the inner schema in `z.preprocess(fn, inner)`. */
export function unwrapPipeOut(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return def?.out as z.ZodType | undefined
}

/**
 * Resolve a `z.lazy(() => inner)` to its inner schema by invoking the
 * factory. Each invocation runs the arrow function fresh, so the returned
 * schema is a distinct object on each call — cycle detection must track
 * the getter function identity, not the resulting schema.
 */
export function unwrapLazy(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  const getter = def?.getter
  if (typeof getter !== 'function') return undefined
  return getter() as z.ZodType
}

/** Getter function reference on a `z.lazy()` — used for recursion detection. */
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
 * Materialise the fallback value of a `z.catch(inner, value)` wrapper.
 * v4 stores the catch as a function `(ctx) => value` on `def.catchValue`;
 * we invoke it with a placeholder context. Consumer catch functions that
 * inspect `ctx.input` / `ctx.error` during default-values derivation are
 * rare — if the function throws, we surface `undefined` and let the
 * validate-then-fix loop find a fallback.
 */
export function getCatchDefault(schema: z.ZodType): unknown {
  const def = readDef(schema)
  const cv = def?.catchValue
  if (typeof cv !== 'function') return undefined
  try {
    return cv({ error: new Error('atta:default-values'), input: undefined })
  } catch {
    return undefined
  }
}

/** True iff the schema carries a callable `z.catch(...)` fallback. */
export function hasCatchValue(schema: z.ZodType): boolean {
  const def = readDef(schema)
  return typeof def?.catchValue === 'function'
}

export function getDefaultValue(schema: z.ZodType): unknown {
  const def = readDef(schema)
  // In v4, defaultValue is stored as a getter that returns the value directly
  // (v3 stored a function that had to be called). We read the property via
  // normal access so the getter fires.
  return def?.defaultValue
}

/**
 * v3-parity stub: Zod v4 folds `z.nativeEnum(E)` into the regular `enum`
 * kind, so a v4 schema never returns a reverse-mapped values object.
 * Kept on the introspect surface so the shared `SchemaIntrospector`
 * contract is uniform between v3 and v4; the core walkers consult this
 * for the v3-specific native-enum branch and silently skip on v4.
 */
export function getNativeEnumValues(_schema: z.ZodType): Record<string, unknown> | undefined {
  return undefined
}

/**
 * v3-parity stub: Zod v4 has no `ZodEffects` wrapper — refinements live
 * on the schema's `def.checks`, transforms are pipe `def.in`, and
 * preprocess is pipe-with-transform-on-`in`. Returns undefined so the
 * shared walkers treat any v4 schema as "no effects source to peel".
 */
export function unwrapEffectsSource(_schema: z.ZodType): z.ZodType | undefined {
  return undefined
}

/**
 * v3-parity stub: Zod v4 has no `ZodBranded` wrapper — brand types
 * carry their brand on the type level only and don't introduce a
 * runtime wrapper. Returns undefined so the shared walkers treat
 * any v4 schema as "no branded inner to peel".
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
export function getChecks(schema: z.ZodType): readonly unknown[] {
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
 * Verify a schema is Zod v4. Throws a clear error if it's a v3
 * schema mistakenly imported through `attaform/zod`.
 *
 * Most consumers never call this directly — the v4 adapter calls it
 * internally on every schema. Reach for it only when wiring a custom
 * adapter that needs the same guard.
 */
export function assertZodVersion(schema: unknown): void {
  const def = readDef(schema)
  if (def?.type === undefined) {
    throw new Error(
      '[attaform/zod-v4] Schema is not a Zod v4 schema. The `attaform/zod-v4` adapter requires ' +
        'zod@^4. Either: (a) install zod@^4 in your project; (b) import from `attaform/zod`, ' +
        'which auto-detects the Zod version (and tree-shakes to a single adapter when the ' +
        '`attaform/vite` plugin is active); or (c) import from `attaform/zod-v3` if you are ' +
        'staying on Zod v3.'
    )
  }
}

/**
 * Generalized depth-first walk over Zod v4's schema tree. The visitor
 * decides per-node whether the predicate fires; this walker handles
 * recursion through every descendable `def.*` child (innerType, element,
 * pipe in/out, intersection sides, record key/value, object shape, DU
 * entries, union options, tuple items, lazy getter).
 *
 * First `visit(node) === true` short-circuits the whole walk. The
 * shared `WeakSet<object>` guards against cycles (lazy schemas whose
 * resolver returns the SAME instance on repeat calls). The lazy
 * resolver invocation is wrapped in try/catch because some
 * recursively-defined schemas throw before their inner is constructed
 * — treated as no-match for that branch and walk continues.
 *
 * Three top-level predicates (`containsAsyncRefine`,
 * `containsAsyncTransform`, `hasContainerOrRootRefine`) all express
 * "walk the tree, short-circuit on first hit" — the walker hosts that
 * shape once, the predicates contribute only the per-node test.
 */
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

export function walkSchemaTree(
  schema: z.ZodType,
  visit: (node: z.ZodType) => boolean,
  seen?: WeakSet<object>
): boolean {
  const visited = seen ?? new WeakSet<object>()
  // Defensive guard: sub-adapters cast through `as` and a malformed leaf
  // could land here as a non-object. The TS signature claims object, but
  // runtime safety beats the conditional-narrowing lint complaint.
  const candidate = schema as unknown
  if (typeof candidate !== 'object' || candidate === null) return false
  if (visited.has(candidate)) return false
  visited.add(candidate)

  if (visit(schema)) return true

  const def = readDef(schema)
  if (def === undefined) return false
  const slots = def as Record<string, unknown>

  for (const key of DESCEND_SINGLE) {
    const child = slots[key]
    if (child !== undefined && walkSchemaTree(child as z.ZodType, visit, visited)) return true
  }
  for (const key of DESCEND_RECORD) {
    const record = slots[key]
    if (record !== undefined) {
      for (const sub of Object.values(record as Record<string, unknown>)) {
        if (walkSchemaTree(sub as z.ZodType, visit, visited)) return true
      }
    }
  }
  for (const key of DESCEND_LIST) {
    const list = slots[key]
    if (list !== undefined) {
      for (const sub of list as readonly unknown[]) {
        if (walkSchemaTree(sub as z.ZodType, visit, visited)) return true
      }
    }
  }
  if (typeof def.getter === 'function') {
    try {
      const inner = def.getter() as z.ZodType
      if (walkSchemaTree(inner, visit, visited)) return true
    } catch {
      // Lazy schemas may throw on resolution before their referenced
      // schema is constructed; treat as no match and continue.
    }
  }

  return false
}

/**
 * True iff any refinement check on the schema (or any descendant
 * subschema) is async. Detection: walks the tree once via
 * `walkSchemaTree`, inspecting each `def.checks[].def.fn` for
 * `constructor.name === 'AsyncFunction'`. Direct `async (v) => …`
 * refinements are caught; sync functions that happen to return a
 * Promise (rare; we'd recommend marking them `async`) are NOT.
 *
 * Used by the adapter's `needsAsyncValidation()` to drive the
 * runtime's construction-time async-validation seed (see
 * create-form-store's strict-mode block). False negatives just delay
 * async refines until first mutation — matches the pre-detection
 * behavior. False positives are unlikely (the AsyncFunction check is
 * precise) and cost only one extra microtask of validation work.
 */
/**
 * True iff the schema tree holds at least one discriminated union at
 * any depth — `walkSchemaTree` reaches unions inside arrays, tuples,
 * records, intersections, pipes, and (cycle-capped) lazy schemas.
 * Queried once per form at construction to set the DU capability flag.
 */
export function containsDiscriminatedUnion(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(schema, (node) => kindOf(node) === 'discriminated-union', seen)
}

export function containsAsyncRefine(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(
    schema,
    (node) => {
      for (const check of getChecks(node)) {
        if (isAsyncCheck(check)) return true
      }
      return false
    },
    seen
  )
}

/**
 * True iff the schema tree carries any refine / check / transform at
 * the root or at a non-leaf node. False means every check is at a leaf
 * — a per-keystroke subtree pass will catch the same verdicts as a
 * whole-form pass, and the runtime can scope leaf validation to the
 * edited path. True forces whole-form (correct, just slower).
 *
 * "Non-leaf" is detected by the presence of descendable children on
 * `def`: `shape` / `entries` / `element` / `options` / `items` /
 * `keyType` / `valueType` / `left` / `right`. The root is always
 * eligible — its checks ARE root refines. Transparent wrappers
 * (Optional / Nullable / Default / Catch / Readonly / Pipe / Lazy)
 * peel through to their inner without re-flagging — a `.refine` added
 * on top of a wrapper lands its check on the WRAPPER node itself, so
 * the wrapper's own `def.checks` is what's inspected.
 *
 * Bias conservative: a missed wrapper variant or an exotic `def`
 * shape we don't yet recognise returns false ONLY for that node,
 * but `walkSchemaTree`'s descent continues, so a container refine
 * nested inside still triggers `true`. Unknown wrappers we forget
 * to peel only lose the perf win, never correctness.
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

export function hasContainerOrRootRefine(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(
    schema,
    (node) => {
      const def = readDef(node)
      if (def === undefined) return false
      const slots = def as Record<string, unknown>
      if (!CONTAINER_SLOTS.some((key) => slots[key] !== undefined)) return false
      return getChecks(node).length > 0
    },
    seen
  )
}

/**
 * True iff any `ZodTransform` in the schema tree wraps an async
 * function. `z.preprocess(fn, inner)` desugars to a pipe whose
 * `def.in` is a `ZodTransform` with `def.transform = fn`; an async
 * `fn` makes the input side async-only, so a sync `safeParse` cannot
 * run it cleanly. The function gets invoked synchronously, returns
 * a Promise, and any throw / rejection inside it propagates as an
 * unhandled rejection because nothing's listening.
 *
 * Distinct from `containsAsyncRefine`: that one walks
 * `def.checks[].def.fn` (refinement predicates). This walks
 * `def.transform` (the transform's payload). The two flags are OR'd
 * by the adapter to drive `needsAsyncValidation()`, but the
 * construction-time strict-mode pass treats them differently:
 * async refines can be stripped and the parse retried; async
 * transforms cannot, so the strict pass skips entirely and defers
 * to the post-mount `safeParseAsync` pass.
 */
export function containsAsyncTransform(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(
    schema,
    (node) => {
      const def = readDef(node)
      if (def === undefined) return false
      const fn = def.transform
      if (typeof fn !== 'function') return false
      return (fn as { constructor: { name: string } }).constructor.name === 'AsyncFunction'
    },
    seen
  )
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
