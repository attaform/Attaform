/**
 * Re-file Zod v3's map and set issue paths at the paths Attaform
 * addresses (#614).
 *
 * The two majors disagree about where a container's contents live in an
 * issue path. Against
 * `z.object({ scores: z.map(z.string(), z.number()), tags: z.set(z.string()) })`:
 *
 * | bad value        | v4 issue path       | v3 issue path              |
 * | ---------------- | ------------------- | -------------------------- |
 * | `scores` entry   | `['scores', 'ann']` | `['scores', 0, 'value']`   |
 * | `scores` key     | `['scores', 'ann']` | `['scores', 0, 'key']`     |
 * | `tags` member    | `['tags']`          | `['tags', 1]`              |
 *
 * v4 already speaks the path spelling the rest of the runtime uses, so
 * only v3 is translated, and the result is that an error at a map entry
 * reaches `form.errors.scores.ann`, `form.meta.errors` and the field's
 * `firstError` identically on both majors. Before this, a v3 map form
 * stored its schema errors at a path nothing resolves: they vanished
 * from every read surface including the validation summary, while the
 * submit they blocked reported no reason.
 *
 * Two rewrites, both truthful rather than cosmetic:
 *
 * - **Map.** `[entryIndex, 'key' | 'value']` becomes the entry's own
 *   key, resolved against the data the parse ran on. A `'key'` issue
 *   and a `'value'` issue at the same entry both land on the entry:
 *   the key is not separately addressable, and an entry whose key is
 *   invalid is the entry the consumer has to fix.
 * - **Set.** The member index is dropped and the error stays on the
 *   set. A set's members are not addressable at all, so the set is the
 *   finest path that exists, which is exactly where v4 files it.
 *
 * Cost is gated on the schema actually holding a map or a set, checked
 * once per adapter: a schema with neither returns the issues by
 * reference without walking anything.
 */
import type { z } from 'zod-v3'
import { getAtPath } from '../../core/path-walker'
import { walkPathSegments } from '../../core/walk-path-segments'
import { V3_INTROSPECTOR } from './walker-introspector'

/**
 * Peels every transparent wrapper off a node. Supplied by the adapter
 * rather than imported: the one implementation lives beside the rest of
 * the v3 unwrap helpers, and taking it as an argument keeps this module
 * off the adapter's import cycle.
 */
export type PeelWrappers = (schema: z.ZodTypeAny) => z.ZodTypeAny

/**
 * The key at position `index` in `value`'s iteration order, or
 * `undefined` when `value` is not a map or the index is out of range.
 * Map iteration order is insertion order and the parse that produced
 * the issue walked the same map, so the index and the key agree.
 */
function mapKeyAt(value: unknown, index: unknown): unknown {
  if (!(value instanceof Map)) return undefined
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined
  let i = 0
  for (const key of value.keys()) {
    if (i === index) return key
    i += 1
  }
  return undefined
}

/** Descend one segment through the schema tree, or `undefined`. */
function stepSchema(
  schema: z.ZodTypeAny | undefined,
  segment: unknown,
  maxRecursionDepth: number
): z.ZodTypeAny | undefined {
  if (schema === undefined) return undefined
  return walkPathSegments(schema, [String(segment)], V3_INTROSPECTOR, maxRecursionDepth, 0)[0]
}

/**
 * Rewrite each issue's `path` so a map entry is addressed by its key
 * and a set member is not addressed at all. Returns `issues` by
 * reference when no path changed.
 */
export function normalizeIssuePaths(
  issues: readonly z.ZodIssue[],
  rootSchema: z.ZodTypeAny,
  data: unknown,
  maxRecursionDepth: number,
  peel: PeelWrappers
): readonly z.ZodIssue[] {
  let out: z.ZodIssue[] | null = null
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i] as z.ZodIssue
    const next = normalizeOne(issue.path, rootSchema, data, maxRecursionDepth, peel)
    if (next === null) continue
    out ??= [...issues]
    out[i] = { ...issue, path: next }
  }
  return out ?? issues
}

/**
 * The re-filed path, or `null` when it is already correct. Walks the
 * schema and the parsed data alongside the issue path, one segment at
 * a time, so the cost is linear in the path's depth.
 */
function normalizeOne(
  path: readonly (string | number)[],
  rootSchema: z.ZodTypeAny,
  data: unknown,
  maxRecursionDepth: number,
  peel: PeelWrappers
): (string | number)[] | null {
  const out: (string | number)[] = []
  let schema: z.ZodTypeAny | undefined = rootSchema
  let value: unknown = data
  let changed = false
  let i = 0
  while (i < path.length) {
    const peeled = schema === undefined ? undefined : peel(schema)
    const kind = peeled === undefined ? undefined : V3_INTROSPECTOR.kindOf(peeled)
    if (kind === 'set') {
      // The set itself is the finest address there is.
      changed = true
      break
    }
    if (kind === 'map') {
      const key = mapKeyAt(value, path[i])
      // An index that resolves to no entry means the issue is about
      // the map as a whole (a size check, a refine); leave it here.
      if (key === undefined) {
        changed = true
        break
      }
      // Only a key a path segment can spell is addressable. An
      // object-keyed map's entry has no path, so the map keeps it.
      if (typeof key !== 'string' && typeof key !== 'number') {
        changed = true
        break
      }
      out.push(key)
      value = (value as Map<unknown, unknown>).get(key)
      schema = V3_INTROSPECTOR.getMapValueType(peeled as z.ZodTypeAny)
      changed = true
      // Skip the entry index AND the `'key'` / `'value'` half that
      // follows it. A half-less path (a custom issue filed straight at
      // the entry) consumes the index alone.
      const half = path[i + 1]
      i += half === 'key' || half === 'value' ? 2 : 1
      continue
    }
    const segment = path[i] as string | number
    out.push(segment)
    value = getAtPath(value, [segment])
    schema = stepSchema(schema, segment, maxRecursionDepth)
    i += 1
  }
  return changed ? out : null
}
