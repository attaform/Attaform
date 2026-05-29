/**
 * Slim-primitive walker for the zod-v4 adapter. Returns the set of
 * `SlimPrimitiveKind`s a schema accepts at write time — wrappers are
 * peeled, refinement-level constraints (`.email()`, `.min(N)`, enum
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
import type { z } from 'zod'
import type { SlimPrimitiveKind } from '../../types/types-api'
import { PERMISSIVE_SLIM_KINDS, slimPrimitivesWalk } from '../../core/walk-slim-primitives'
import { V4_INTROSPECTOR } from './walker-introspector'

export const PERMISSIVE: ReadonlySet<SlimPrimitiveKind> = PERMISSIVE_SLIM_KINDS

/**
 * Walk a v4 schema, emitting the union of slim primitive kinds it
 * accepts. Clones once at the public boundary so callers get a
 * fresh mutable Set; the internal walk reuses frozen singletons for
 * leaf kinds.
 */
export function slimPrimitivesOf(
  schema: z.ZodType,
  maxRecursionDepth: number
): Set<SlimPrimitiveKind> {
  return new Set(slimPrimitivesWalk(schema, V4_INTROSPECTOR, maxRecursionDepth))
}
