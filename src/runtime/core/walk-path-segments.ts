/**
 * Shared path walker — descends a dotted segment array through a Zod
 * schema tree and returns the sub-schemas reachable at that path.
 *
 * One body, two adapters: v3 and v4 each invoke `walkPathSegments`
 * with their `SchemaIntrospector` instance. Wrapper / container kinds
 * (Optional / Nullable / Default / Readonly / Catch / Pipe / Pipeline /
 * Effects / Branded / Lazy / Intersection / Union / DiscriminatedUnion /
 * Object / Array / Set / Map / Record / Tuple) all dispatch through the
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
 *  - `map` descends into the declared VALUE type and consumes the
 *    segment, the same shape `record` uses. The two differ only in
 *    what spells a key, which `entryKeyKindAtPath` answers; here they
 *    are both "one segment addresses one entry".
 *  - Kinds with no sub-schema to descend into (`symbol` / `function` /
 *    `promise`, and the opaque leaves) return `[]`, which is the
 *    truthful answer: the schema declares no sub-paths there, so none
 *    are fabricated. No kind is refused at adapter construction any
 *    more (#607) — `[]` is the whole story.
 */
import type { SchemaIntrospector } from './abstract-schema-factory'
import { SET_MEMBER_SEGMENT } from './paths'

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
      // A set's members are not addressable: a member IS its own key,
      // so no address survives writing to one. The single question a
      // set answers here is what a member looks like, asked by the
      // coercion layer through the reserved `SET_MEMBER_SEGMENT`, and
      // every other segment gets the truthful `[]`.
      //
      // A plain index used to be accepted for that question, which
      // made `tags.0` resolve for everyone: it surfaced on
      // `form.fields` as a node holding nothing, and it cleared the
      // write gate, where the numeric rebuild replaced the whole `Set`
      // with an `Array` holding the one written member (#614).
      if (head !== SET_MEMBER_SEGMENT) return []
      const inner = intro.getSetValueType(schema)
      return inner === undefined ? [] : walkPathSegments(inner, rest, intro, maxDepth, lazyDepth)
    }
    case 'record': {
      const inner = intro.getRecordValueType(schema)
      return inner === undefined ? [] : walkPathSegments(inner, rest, intro, maxDepth, lazyDepth)
    }
    case 'map': {
      // One segment addresses one entry, exactly as `record` does. The
      // segment's own spelling against the map's declared key type is
      // `entryKeyKindAtPath`'s question, not this walker's: resolving
      // the value schema is the same answer for every entry.
      const inner = intro.getMapValueType(schema)
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
    // Leaves — can't descend further. Opaque leaves (`any` /
    // `unknown` / `custom`) land here too and `[]` is the truthful
    // answer: the schema declares no sub-paths under them, so none are
    // fabricated. `symbol` / `function` / `promise` hold a value
    // without declaring anything inside it and land here for the same
    // reason. No kind is refused at construction (#607), so this is
    // the only branch they ever take.
    default:
      return []
  }
}
