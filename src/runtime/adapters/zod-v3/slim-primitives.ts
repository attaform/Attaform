import type { z } from 'zod-v3'
import type { SlimPrimitiveKind } from '../../types/types-api'
import { slimPrimitivesWalk } from '../../core/walk-slim-primitives'
import { V3_INTROSPECTOR } from './walker-introspector'

/**
 * Slim-primitive walker for v3. Returns the set of `SlimPrimitiveKind`s
 * a schema accepts at write time. Wrappers (`ZodOptional`,
 * `ZodNullable`, `ZodDefault`, `ZodEffects`, `ZodPipeline`,
 * `ZodReadonly`, `ZodBranded`, `ZodCatch`, `ZodLazy`) are peeled;
 * refinement-level constraints are ignored.
 *
 * Thin wrapper around the shared `slimPrimitivesWalk` core walker; v3
 * and v4 dispatch through the same body via their respective
 * `SchemaIntrospector` instance. See `core/walk-slim-primitives.ts`
 * for the per-kind dispatch rules.
 */
export function slimPrimitivesV3(schema: z.ZodTypeAny): Set<SlimPrimitiveKind> {
  // The 64-step lazy-recursion cap matches the v3-only `MAX_LAZY_DEPTH_V3`
  // sentinel the prior inline walker used; consumers historically called
  // this without a depth arg, so the cap stays embedded here.
  return new Set(slimPrimitivesWalk(schema, V3_INTROSPECTOR, 64))
}
