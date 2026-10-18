/**
 * Slim-primitive walker for the zod-v4 adapter. Returns the set of
 * `SlimPrimitiveKind`s a schema accepts at write time. Wrappers are
 * peeled, and refinement-level constraints (`.email()`, `.min(N)`, enum
 * membership, literal equality, regex) are ignored.
 *
 * Thin wrapper around the shared `slimPrimitivesWalk` core walker; v3
 * and v4 dispatch through the same body via their respective
 * `SchemaIntrospector` instance. See `core/walk-slim-primitives.ts`
 * for the per-kind dispatch rules.
 *
 * The runtime gate (`src/runtime/core/slim-primitive-gate.ts`) calls
 * the adapter method `getSlimPrimitiveTypesAtPath(path)`, which
 * resolves leaf candidates via `getNestedZodSchemasAtPath` and unions
 * `slimPrimitivesOf` across them.
 */
import type { SlimPrimitiveKind } from '../../types/types-api'
import { PERMISSIVE_SLIM_KINDS, slimPrimitivesWalk } from '../../core/walk-slim-primitives'
import type { ZodV4Node } from './introspect'
import { V4_INTROSPECTOR } from './walker-introspector'

export const PERMISSIVE: ReadonlySet<SlimPrimitiveKind> = PERMISSIVE_SLIM_KINDS

/**
 * The union of slim primitive kinds a v4 schema accepts. The walk reuses
 * frozen singletons for leaf kinds, and the set goes to the caller as it
 * is rather than as a copy, so it is read-only.
 */
export function slimPrimitivesOf(
  schema: ZodV4Node,
  maxRecursionDepth: number
): ReadonlySet<SlimPrimitiveKind> {
  return slimPrimitivesWalk(schema, V4_INTROSPECTOR, maxRecursionDepth)
}
