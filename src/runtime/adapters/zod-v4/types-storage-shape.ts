/**
 * The shape `form.values.<key>` returns at runtime. Four cases per leaf:
 *
 * 1. A schema-side input normalizer, meaning `z.preprocess(fn, inner)`
 *    or `z.coerce.X()`. v4 represents the two differently, a
 *    `ZodPipe<ZodTransform, inner>` against a primitive with
 *    `def.coerce === true`, but they share one type-level marker:
 *    `_zod.input` is `unknown`. The normalizer runs at PARSE time, not
 *    at the write boundary, so storage holds the consumer's raw input
 *    and the type collapses to `unknown` to match. `handleSubmit`,
 *    `validate` and `parse` re-parse storage through the wrapper, so
 *    the typed value is reachable there.
 *
 * 2. `inner.transform(fn)`, which compiles to `ZodPipe<inner,
 *    ZodTransform>`. A transform fires at submit or validate, not at the
 *    write boundary, so storage holds whatever `inner` stores.
 *    `StorageShape` recurses on `inner`, so a defaulted leaf inside it
 *    still reads `T` rather than `T | undefined`. A bare top-level
 *    `ZodTransform`, with no `in` schema, reads `_zod.input` directly,
 *    having no inner to recurse into.
 *
 * 3. A codec or generic pipe, where neither side is a transform: read
 *    `_zod.output`. A codec is not write-boundary-synthesized, so the
 *    post-parse view is the only honest storage type.
 *
 * 4. Everything else, defaults, catch, readonly, optional, primitives
 *    and nested objects: read `_zod.output`. Defaults and catches fire
 *    at parse time, so the post-init view is what storage holds, and a
 *    nested object delegates to Zod's own recursion on `_zod.output`,
 *    which peels nested defaults inside structural containers.
 *
 * Case 1 wins first, on the `_zod.input` IsUnknown check, before the
 * pipe and transform cascade can fire. So `z.coerce.number().optional()`
 * (input `unknown | undefined`, collapsing to `unknown`) and
 * `z.preprocess(fn, z.object(...))` (input `unknown`) both land on
 * `unknown` without descending, while the IsAny filter keeps `z.any()`
 * from being read as coerce.
 *
 * The direct `_zod` property access is deliberate, and matches Zod's own
 * `$InferObjectOutput` / `$InferObjectInput`, which read
 * `T[k]['_zod']['output']` rather than wrapping in the top-level
 * `output<T>` conditional. Wrapping per key spawns a fresh conditional
 * instantiation for every key, and Volar's web-worker checker collapses
 * that per-key walk to `any` once the schema is non-trivial. Property
 * access has no conditional and resolves cleanly on the same budget.
 * Shape access goes through `_zod.def.shape` for the same reason: `infer
 * Shape from z.ZodObject<Shape>` collapses to the `$ZodShape` upper
 * bound in that worker, because of `z.ZodObject`'s `out Shape`
 * covariance markers.
 */
export type StorageShape<S> = S extends {
  _zod: { def: { type: 'object'; shape: infer Shape } }
}
  ? { [K in keyof Shape]-?: StorageLeaf<Shape[K]> }
  : StorageLeaf<S>

/**
 * Detect a schema whose `_zod.input` is `unknown`, the marker
 * `z.preprocess(fn, _)` and `z.coerce.X()` share in v4. `any` is
 * excluded through the canonical `0 extends 1 & T` test, so a `z.any()`
 * leaf falls through to the cascade below and keeps its `any`.
 */
type InputIsUnknown<L> = L extends { _zod: { input: infer In } }
  ? 0 extends 1 & In
    ? false
    : unknown extends In
      ? true
      : false
  : false

/**
 * The per-leaf branching behind `StorageShape`. It is exported so the
 * bundled `.d.ts` carries ONE alias body: otherwise every leaf of a Zod
 * object re-emits the full pipe / transform / default conditional
 * ladder, which compounds badly once several complex schemas share a
 * scope. Reach for `StorageShape` instead.
 */
export type StorageLeaf<L> =
  InputIsUnknown<L> extends true
    ? unknown
    : L extends { _zod: { def: { type: 'pipe'; in: infer A; out: infer B } } }
      ? B extends { _zod: { def: { type: 'transform' } } }
        ? StorageShape<A>
        : L extends { _zod: { output: infer Out } }
          ? Out
          : never
      : L extends { _zod: { def: { type: 'transform' } } }
        ? L extends { _zod: { input: infer In } }
          ? In
          : never
        : L extends { _zod: { output: infer Out } }
          ? Out
          : never
