import type { z } from 'zod-v3'

/**
 * Peel `.optional()` / `.nullable()` / `.default()` / `.refine()` /
 * `.transform()` wrappers off a Zod v3 schema to reach the inner
 * `ZodObject`. Returns `never` if no `ZodObject` is found.
 *
 * Used internally by the v3 `useForm` overload to verify the
 * supplied schema bottoms out at a `ZodObject`.
 */
export type UnwrapZodObject<T> =
  T extends z.ZodEffects<infer Inner>
    ? UnwrapZodObject<Inner>
    : T extends z.ZodOptional<infer Inner>
      ? UnwrapZodObject<Inner>
      : T extends z.ZodNullable<infer Inner>
        ? UnwrapZodObject<Inner>
        : T extends z.ZodDefault<infer Inner>
          ? UnwrapZodObject<Inner>
          : T extends z.ZodObject<infer Shape>
            ? z.ZodObject<Shape>
            : never
