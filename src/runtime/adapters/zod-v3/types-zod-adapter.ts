import type { z } from 'zod-v3'

/**
 * Peel `.optional()` / `.nullable()` / `.default()` / `.refine()` /
 * `.transform()` wrappers off a Zod v3 schema to reach the form root,
 * then return it: a `ZodObject` (fixed-shape form), a `ZodRecord`
 * (dictionary form), or a `ZodDiscriminatedUnion` (variant form).
 * Returns `never` for any other root, which makes the `useForm`
 * projections collapse to `never` so the call fails to typecheck
 * rather than producing a misshapen form type.
 *
 * Used internally by the v3 `useForm` overload to project an arbitrary
 * supported root to its input / output / storage-read shapes.
 */
export type UnwrapZodRoot<T> =
  T extends z.ZodEffects<infer Inner>
    ? UnwrapZodRoot<Inner>
    : T extends z.ZodOptional<infer Inner>
      ? UnwrapZodRoot<Inner>
      : T extends z.ZodNullable<infer Inner>
        ? UnwrapZodRoot<Inner>
        : T extends z.ZodDefault<infer Inner>
          ? UnwrapZodRoot<Inner>
          : T extends z.ZodObject<infer Shape>
            ? z.ZodObject<Shape>
            : T extends z.ZodRecord<infer Key, infer Value>
              ? z.ZodRecord<Key, Value>
              : T extends z.ZodDiscriminatedUnion<infer Disc, infer Options>
                ? z.ZodDiscriminatedUnion<Disc, Options>
                : never
