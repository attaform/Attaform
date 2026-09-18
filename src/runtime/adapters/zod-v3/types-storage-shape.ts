import type { z } from 'zod-v3'

/**
 * The v3 mirror of Zod v4's `StorageShape`. Each top-level key defaults
 * to `z.output<Shape[K]>`, the post-init view, where defaults have fired
 * and Zod's own recursion has peeled nested defaults inside structural
 * containers. A transform or pipe carrier (`ZodEffects`, `ZodPipeline`)
 * falls back to `z.input<Shape[K]>`, storage there holding the
 * pre-transform input: a transform runs at submission or validation, not
 * at the write boundary.
 *
 * A v3 quirk sharpens this: `ZodEffects` covers BOTH `.transform()` and
 * `z.preprocess()` at the TS level, v3 carrying no separate preprocess
 * class. So deferring to `z.input` there makes a top-level
 * `z.preprocess(fn, T)` leaf read as the preprocess input, commonly
 * `unknown`; reach for the
 * `AbstractSchema` escape hatch if a stronger type is needed.
 * Transforms preserve their pre-transform input shape, which matches
 * storage.
 */
export type StorageShape<S extends z.ZodTypeAny> =
  S extends z.ZodObject<infer Shape>
    ? {
        [K in keyof Shape]-?: Shape[K] extends
          z.ZodEffects<z.ZodTypeAny> | z.ZodPipeline<z.ZodTypeAny, z.ZodTypeAny>
          ? z.input<Shape[K]>
          : z.output<Shape[K]>
      }
    : z.input<S>
