/**
 * Shared path walker — descends a dotted segment array through a Zod
 * schema tree and returns the sub-schemas reachable at that path.
 *
 * One body, two adapters: v3 and v4 each invoke `walkPathSegments`
 * with their `SchemaIntrospector` instance. Wrapper / container kinds
 * (Optional / Nullable / Default / Readonly / Catch / Pipe / Pipeline /
 * Effects / Branded / Lazy / Intersection / Union / DiscriminatedUnion /
 * Object / Array / Set / Record / Tuple) all dispatch through the
 * introspector accessors, so the walker stays agnostic to per-version
 * `def.*` shape.
 *
 * Semantics (preserved verbatim from the prior per-adapter
 * implementations — characterised by `test/adapters/zod-v3/path-walker.test.ts`
 * and `test/adapters/zod-v4/path-walker.test.ts`):
 *
 *  - Unions return multiple candidates (caller tries each).
 *  - Discriminated unions filter options to those whose shape owns the
 *    next segment (`Object.hasOwn`, NOT `in`, so `Object.prototype` keys
 *    don't leak); fall back to every option when no shape matches
 *    (the segment is the discriminator key itself).
 *  - Object shape access uses `Object.hasOwn` for the same reason: a
 *    bare `shape[head]` would resolve `'toString'` / `'valueOf'` etc.
 *    to the inherited Function and treat it as a schema.
 *  - Transparent wrappers (optional / nullable / default / readonly /
 *    catch / pipe / pipeline / effects / branded) descend without
 *    consuming a segment.
 *  - `lazy` bumps the lazy counter; past the cap the walker returns
 *    `[]` so writes at recursive paths deeper than `maxRecursionDepth`
 *    fall back to a permissive type gate.
 *  - Intersection unions both sides' resolutions — callers try each
 *    candidate, matching parse-time semantics where a value must
 *    satisfy both.
 *  - Leaf kinds (string / number / boolean / literal / enum / etc.)
 *    return `[]` when path remains, so a caller that asked for
 *    `firstName.middle` against a string schema gets an empty
 *    resolution rather than a wrong schema.
 *  - Unsupported kinds (`map` / `symbol` / `function` / `promise`) are
 *    rejected at adapter construction by `assertSupportedKinds`; the
 *    walker's exhaustiveness on those kinds returns `[]` defensively
 *    so a downstream caller that instantiates a sub-schema directly
 *    isn't crashed.
 */
import type { SchemaIntrospector } from './abstract-schema-factory'

export function walkPathSegments<Schema>(
  schema: Schema,
  segments: readonly string[],
  intro: SchemaIntrospector<Schema>,
  maxDepth: number,
  lazyDepth: number
): Schema[] {
  if (segments.length === 0) return [schema]
  const [head, ...rest] = segments
  if (head === undefined) return [schema]
  const kind = intro.kindOf(schema)
  switch (kind) {
    case 'object': {
      const shape = intro.getObjectShape(schema)
      if (!Object.hasOwn(shape, head)) return []
      const next = shape[head]
      return next === undefined ? [] : walkPathSegments(next, rest, intro, maxDepth, lazyDepth)
    }
    case 'array': {
      const inner = intro.getArrayElement(schema)
      return inner === undefined ? [] : walkPathSegments(inner, rest, intro, maxDepth, lazyDepth)
    }
    case 'set': {
      // Sets aren't position-indexed; the head segment is a synthetic
      // indexer (`[...path, 0]`) used to query the element type. Descend
      // into the value schema and consume the segment.
      const inner = intro.getSetValueType(schema)
      return inner === undefined ? [] : walkPathSegments(inner, rest, intro, maxDepth, lazyDepth)
    }
    case 'record': {
      const inner = intro.getRecordValueType(schema)
      return inner === undefined ? [] : walkPathSegments(inner, rest, intro, maxDepth, lazyDepth)
    }
    case 'tuple': {
      const index = Number(head)
      if (!Number.isInteger(index)) return []
      const items = intro.getTupleItems(schema)
      const item = items[index]
      return item === undefined ? [] : walkPathSegments(item, rest, intro, maxDepth, lazyDepth)
    }
    case 'union':
      return intro
        .getUnionOptions(schema)
        .flatMap((opt) => walkPathSegments(opt, segments, intro, maxDepth, lazyDepth))
    case 'discriminated-union': {
      const options = intro.getDiscriminatedOptions(schema)
      const matching = options.filter((opt) => Object.hasOwn(intro.getObjectShape(opt), head))
      const candidates = matching.length > 0 ? matching : options
      return candidates.flatMap((opt) =>
        walkPathSegments(opt, segments, intro, maxDepth, lazyDepth)
      )
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch': {
      // `catch` peels like a wrapper — descend into the inner schema.
      // The catch fallback only matters at parse time, not path lookup.
      const inner = intro.unwrapInner(schema)
      return inner === undefined
        ? []
        : walkPathSegments(inner, segments, intro, maxDepth, lazyDepth)
    }
    case 'pipe': {
      // v4: `z.pipe(IN, OUT)` / `z.preprocess(fn, inner)` desugars to
      // pipe-with-transform-on-`in`. Both sides are sub-schemas; the
      // walker peeks at either, preferring `in`.
      const inner = intro.unwrapPipeIn(schema) ?? intro.unwrapPipeOut(schema)
      return inner === undefined
        ? []
        : walkPathSegments(inner, segments, intro, maxDepth, lazyDepth)
    }
    case 'pipeline': {
      // v3: `z.pipeline(...)` — peel to the input side.
      const inner = intro.unwrapPipeIn(schema)
      return inner === undefined
        ? []
        : walkPathSegments(inner, segments, intro, maxDepth, lazyDepth)
    }
    case 'effects': {
      // v3: `ZodEffects` (refine / transform / preprocess) — peel to
      // the structural source schema. Path resolution lands on the
      // inner shape regardless of effect type.
      const inner = intro.unwrapEffectsSource(schema)
      return inner === undefined
        ? []
        : walkPathSegments(inner, segments, intro, maxDepth, lazyDepth)
    }
    case 'branded': {
      // v3: `ZodBranded` — peel to the inner schema. Brands are
      // compile-time tags with no runtime structural impact.
      const inner = intro.unwrapBranded(schema)
      return inner === undefined
        ? []
        : walkPathSegments(inner, segments, intro, maxDepth, lazyDepth)
    }
    case 'lazy': {
      // Bump the lazy counter. Past the cap, return [] so callers fall
      // back to permissive behaviour at recursive paths beyond the cap.
      if (lazyDepth >= maxDepth) return []
      const inner = intro.unwrapLazy(schema)
      return inner === undefined
        ? []
        : walkPathSegments(inner, segments, intro, maxDepth, lazyDepth + 1)
    }
    case 'intersection': {
      const left = intro.getIntersectionLeft(schema)
      const right = intro.getIntersectionRight(schema)
      const leftResults =
        left === undefined ? [] : walkPathSegments(left, segments, intro, maxDepth, lazyDepth)
      const rightResults =
        right === undefined ? [] : walkPathSegments(right, segments, intro, maxDepth, lazyDepth)
      return [...leftResults, ...rightResults]
    }
    // Leaves — can't descend further. The unsupported kinds (`map` /
    // `symbol` / `function` / `promise`) are rejected at adapter
    // construction by `assertSupportedKinds`; falling through to `[]`
    // keeps the walker defensive in case construction is skipped
    // (e.g. a downstream test instantiates a sub-schema directly).
    default:
      return []
  }
}
