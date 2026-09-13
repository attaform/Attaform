/**
 * Shared slim-primitive walker — returns the set of
 * `SlimPrimitiveKind`s a schema accepts at write time. Wrappers
 * (Optional / Nullable / Default / Readonly / Catch / Pipe /
 * Pipeline / Effects / Branded / Lazy) are peeled; refinement-level
 * constraints (`.email()`, `.min(N)`, enum membership, literal
 * equality, regex) are ignored.
 *
 * Both v3 and v4 adapters dispatch through this body via their
 * `SchemaIntrospector` instance. Their per-version kind sets — v3's
 * `branded` / `effects` / `pipeline` / `native-enum`, v4's `pipe` /
 * `file` — collapse to distinct cases on the SharedZodKind switch;
 * each adapter's `kindOf` returns only the kinds it knows.
 *
 * Semantics (preserved verbatim from the prior per-adapter
 * implementations — characterised by `test/adapters/zod-v{3,4}/
 * slim-primitives.test.ts`):
 *
 *  - Leaves (string / number / boolean / bigint / date / null /
 *    undefined / void / nan) map to their kind singleton.
 *  - Enum walks values, categorising each by typeof (string / number
 *    members register their respective kinds). Empty enum falls back
 *    to string.
 *  - Literal walks values through the shared `slimKindOf` to map each
 *    value to a kind. Multi-value literals (`z.literal(['a', 1])`)
 *    register both.
 *  - Object / record → object; array / tuple → array; set → set;
 *    map → map; template-literal → string; file → file + null (the
 *    directive's "no file selected" sentinel — v4 only).
 *  - symbol → symbol, function → function, promise → object, each
 *    plus 'undefined': their derived blank IS undefined, and the gate
 *    has to admit what `form.clear(path)` writes.
 *  - Optional adds 'undefined' to the inner set; nullable adds 'null'.
 *  - Default / readonly / catch / branded peel transparently.
 *  - Pipe (v4) consults both `in` and `out`: if `in` is a transform,
 *    use `out` (the structural side of a preprocess); else prefer
 *    `in` (the source schema). Pipeline (v3) takes the `in` side.
 *  - Effects (v3) peels to the structural source.
 *  - Lazy bumps the depth counter; past the cap returns `permissive`
 *    so recursive paths beyond the cap aren't false-rejected.
 *  - Union / discriminated-union: union the option sets.
 *  - Intersection: intersect both sides (must satisfy both at parse
 *    time).
 *  - Native-enum (v3) walks values, categorising by typeof.
 *  - Never returns empty; any / unknown / custom / unrecognised return
 *    permissive.
 */
import type { SchemaIntrospector } from './abstract-schema-factory'
import { slimKindOf } from './slim-primitive-gate'
import type { SlimPrimitiveKind } from '../types/types-api'

// The slim-primitive permissive set — kinds the gate accepts when the
// walker can't characterise a schema. Identical between v3 and v4 by
// design; hosted in core for single-source-of-truth.
export const PERMISSIVE_SLIM_KINDS: ReadonlySet<SlimPrimitiveKind> =
  /* @__PURE__ */ new Set<SlimPrimitiveKind>([
    'string',
    'number',
    'boolean',
    'bigint',
    'date',
    'null',
    'undefined',
    'object',
    'array',
    'symbol',
    'function',
    'map',
    'set',
    'file',
  ])

// Module-level frozen singletons for the leaf branches. Returning a
// shared instance instead of `new Set([…])` per call cuts a hot
// allocation when slim-primitives is reached through wrappers and
// collapses the inline literal Set constructions into shared
// references for a small bundle-size win. The walker returns
// `ReadonlySet`; callers that need to mutate (optional / nullable /
// union branches, and the public boundary) clone first.
const KIND_STRING: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['string'])
const KIND_NUMBER: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['number'])
const KIND_BOOLEAN: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['boolean'])
const KIND_BIGINT: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['bigint'])
const KIND_DATE: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['date'])
const KIND_NULL: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['null'])
const KIND_UNDEFINED: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['undefined'])
const KIND_OBJECT: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['object'])
const KIND_ARRAY: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['array'])
const KIND_SET: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['set'])
const KIND_MAP: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['map'])
// The three kinds whose derived blank is `undefined` carry 'undefined'
// in their accept set, for the same reason `z.file()` carries 'null':
// the gate has to admit the value `form.clear(path)` is about to write,
// or clearing the field is a no-op with a "wrong type" warning. It does
// not loosen schema enforcement — the blank-path channel and the
// derived "No value supplied" error still gate submission.
const KIND_SYMBOL: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['symbol', 'undefined'])
const KIND_FUNCTION: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set([
  'function',
  'undefined',
])
const KIND_PROMISE: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set([
  'object',
  'undefined',
])
const KIND_FILE: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set(['file', 'null'])
const EMPTY_KINDS: ReadonlySet<SlimPrimitiveKind> = /* @__PURE__ */ new Set()

export function slimPrimitivesWalk<Schema>(
  schema: Schema,
  intro: SchemaIntrospector<Schema>,
  maxDepth: number,
  lazyDepth = 0
): ReadonlySet<SlimPrimitiveKind> {
  const kind = intro.kindOf(schema)
  switch (kind) {
    case 'string':
      return KIND_STRING
    case 'number':
    case 'nan':
      return KIND_NUMBER
    case 'boolean':
      return KIND_BOOLEAN
    case 'bigint':
      return KIND_BIGINT
    case 'date':
      return KIND_DATE
    case 'file':
      // `z.file()` accepts `File` instances at write time. `null` is
      // also accepted at the slim-primitive level so the directive's
      // canonical blank value (the "no file selected" sentinel) lands
      // even on required-file schemas — the blank-path channel + the
      // derived "No value supplied" error already gates submission, so
      // permitting `null` storage here doesn't loosen schema enforcement.
      return KIND_FILE
    case 'null':
      return KIND_NULL
    case 'undefined':
    case 'void':
      return KIND_UNDEFINED
    case 'enum': {
      const values = intro.getEnumValues(schema)
      const out = new Set<SlimPrimitiveKind>()
      for (const v of values) {
        if (typeof v === 'string') out.add('string')
        else if (typeof v === 'number') out.add('number')
      }
      return out.size === 0 ? KIND_STRING : out
    }
    case 'native-enum': {
      // v3 only — `z.nativeEnum(E)` exposes the reverse-mapped TS enum
      // object on `_def.values`. Categorise each member by typeof.
      // Numeric enums also include reverse-mapped string keys whose
      // value is a number; both string and number kinds get registered.
      const values = intro.getNativeEnumValues(schema)
      if (values === undefined) return KIND_STRING
      const out = new Set<SlimPrimitiveKind>()
      for (const v of Object.values(values)) {
        if (typeof v === 'string') out.add('string')
        else if (typeof v === 'number') out.add('number')
      }
      return out.size === 0 ? KIND_STRING : out
    }
    case 'literal': {
      const values = intro.getLiteralValues(schema)
      const out = new Set<SlimPrimitiveKind>()
      for (const v of values) out.add(slimKindOf(v))
      return out.size === 0 ? PERMISSIVE_SLIM_KINDS : out
    }
    case 'object':
    case 'record':
      return KIND_OBJECT
    case 'array':
    case 'tuple':
      return KIND_ARRAY
    case 'set':
      return KIND_SET
    case 'map':
      return KIND_MAP
    case 'symbol':
      return KIND_SYMBOL
    case 'function':
      // A function value is stored by reference like any other opaque
      // leaf. Note zod's own `parse` returns a VALIDATING WRAPPER for
      // `z.function()`, not the input function, on both majors — the
      // wrapper reaches the consumer through `handleSubmit` / `parse`,
      // while storage keeps the identity the consumer wrote.
      return KIND_FUNCTION
    case 'promise':
      // A Promise is `typeof 'object'` and not a plain record, so
      // `slimKindOf` reports it as `'object'` and the gate accepts it
      // at a promise path. A plain object also passes the gate here
      // and then fails validation, the same split every refinement
      // takes (`z.string().email()` accepts `'x'` at the gate too).
      return KIND_PROMISE
    case 'template-literal':
      // Parses a string against a pattern; the pattern is a
      // refinement-level concern the gate deliberately ignores.
      return KIND_STRING
    case 'optional': {
      const inner = intro.unwrapInner(schema)
      const innerSet =
        inner === undefined ? EMPTY_KINDS : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
      const out = new Set<SlimPrimitiveKind>(innerSet)
      out.add('undefined')
      return out
    }
    case 'nullable': {
      const inner = intro.unwrapInner(schema)
      const innerSet =
        inner === undefined ? EMPTY_KINDS : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
      const out = new Set<SlimPrimitiveKind>(innerSet)
      out.add('null')
      return out
    }
    case 'default':
    case 'readonly':
    case 'catch': {
      const inner = intro.unwrapInner(schema)
      return inner === undefined
        ? PERMISSIVE_SLIM_KINDS
        : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
    }
    case 'branded': {
      // v3-only. Brand wrappers carry their inner on `_def.type`.
      const inner = intro.unwrapBranded(schema)
      return inner === undefined
        ? PERMISSIVE_SLIM_KINDS
        : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
    }
    case 'effects': {
      // v3-only. ZodEffects wraps refines / transforms / preprocess;
      // for slim-primitive purposes the structural source is the
      // pre-transform shape (consumers write to that shape).
      const inner = intro.unwrapEffectsSource(schema)
      return inner === undefined
        ? PERMISSIVE_SLIM_KINDS
        : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
    }
    case 'pipeline': {
      // v3-only. Take the input side.
      const inner = intro.unwrapPipeIn(schema)
      return inner === undefined
        ? PERMISSIVE_SLIM_KINDS
        : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
    }
    case 'pipe': {
      // v4-only. `z.preprocess(fn, inner)` and `z.coerce.X()`
      // (pipe-with-transform-on-input) and `inner.transform(fn)`
      // (transform-on-output) all serialise as ZodPipe, but the
      // "storage shape" lives on opposite sides. For preprocess /
      // coerce, the input side IS the transform (shapeless,
      // PERMISSIVE) and the inner schema sits on the output. For
      // `.transform`, the input side is the source schema. Pick the
      // non-transform side so `isLeafAtPath` and the directive coerce
      // target both resolve against a real shape.
      const pipeIn = intro.unwrapPipeIn(schema)
      const pipeOut = intro.unwrapPipeOut(schema)
      const inner =
        pipeIn !== undefined && intro.kindOf(pipeIn) === 'transform' ? pipeOut : (pipeIn ?? pipeOut)
      return inner === undefined
        ? PERMISSIVE_SLIM_KINDS
        : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth)
    }
    case 'lazy': {
      // Bump on lazy crossing only; past the cap, fall back to
      // permissive so recursive paths beyond the cap aren't gated.
      if (lazyDepth >= maxDepth) return PERMISSIVE_SLIM_KINDS
      const inner = intro.unwrapLazy(schema)
      return inner === undefined
        ? PERMISSIVE_SLIM_KINDS
        : slimPrimitivesWalk(inner, intro, maxDepth, lazyDepth + 1)
    }
    case 'union':
    case 'discriminated-union': {
      // Both adapters store DU options on `def.options` too, so
      // `getUnionOptions` works for either kind.
      const options = intro.getUnionOptions(schema)
      const out = new Set<SlimPrimitiveKind>()
      for (const opt of options) {
        for (const k of slimPrimitivesWalk(opt, intro, maxDepth, lazyDepth)) out.add(k)
      }
      return out.size === 0 ? PERMISSIVE_SLIM_KINDS : out
    }
    case 'intersection': {
      const left = intro.getIntersectionLeft(schema)
      const right = intro.getIntersectionRight(schema)
      const leftSet =
        left === undefined
          ? PERMISSIVE_SLIM_KINDS
          : slimPrimitivesWalk(left, intro, maxDepth, lazyDepth)
      const rightSet =
        right === undefined
          ? PERMISSIVE_SLIM_KINDS
          : slimPrimitivesWalk(right, intro, maxDepth, lazyDepth)
      const out = new Set<SlimPrimitiveKind>()
      for (const k of leftSet) if (rightSet.has(k)) out.add(k)
      return out
    }
    case 'never':
      return EMPTY_KINDS
    // Opaque leaves: the schema says nothing about the value's shape,
    // so every kind is admissible. `custom` is the kind
    // `z.instanceof(X)` and `z.custom<T>()` compile to on v4 (#542);
    // it belongs with `any` / `unknown` rather than in the defensive
    // fallthrough, because it reaches here through the public surface.
    case 'any':
    case 'unknown':
    case 'custom':
      return PERMISSIVE_SLIM_KINDS
    // A kind this walker has no case for — in practice a kind a newer
    // Zod introduced. Be permissive rather than reject: the adapter
    // carries the value opaquely and the schema's own parse is what
    // decides whether it was legal.
    default:
      return PERMISSIVE_SLIM_KINDS
  }
}
