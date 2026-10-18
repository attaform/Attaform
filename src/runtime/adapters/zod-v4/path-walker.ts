import { walkPathSegments } from '../../core/walk-path-segments'
import type { ZodV4Node } from './introspect'
import { V4_INTROSPECTOR } from './walker-introspector'

const PATH_SEPARATOR = '.'

/**
 * Walk a dotted path through a Zod v4 schema tree and return the
 * subschema(s) that live at that path.
 *
 * Thin wrapper around the shared `walkPathSegments` core walker; both
 * v3 and v4 dispatch through the same body via their respective
 * `SchemaIntrospector` instance. See `core/walk-path-segments.ts` for
 * the per-kind dispatch rules.
 *
 * `maxRecursionDepth` caps descent through `z.lazy()`. Once the walker
 * has crossed `maxRecursionDepth + 1` lazy boundaries it returns `[]`,
 * so writes at recursive paths deeper than the cap fall back to a
 * permissive type gate.
 */
export function getNestedZodSchemasAtPath(
  schema: ZodV4Node,
  path: string | readonly (string | number)[],
  maxRecursionDepth: number
): ZodV4Node[] {
  if (Array.isArray(path)) {
    return walkPathSegments(schema, path.map(String), V4_INTROSPECTOR, maxRecursionDepth, 0)
  }
  const pathString = path as string
  if (pathString.length === 0) return [schema]
  return walkPathSegments(
    schema,
    pathString.split(PATH_SEPARATOR),
    V4_INTROSPECTOR,
    maxRecursionDepth,
    0
  )
}
