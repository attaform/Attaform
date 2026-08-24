/**
 * The shape `form.values.<key>` returns at runtime.
 *
 * Per leaf:
 *
 * 1. Schema-side input normalizers — `z.preprocess(fn, inner)` AND
 *    `z.coerce.X()`. Zod v4 represents these differently
 *    (`ZodPipe<ZodTransform, inner>` for preprocess; a primitive
 *    with `def.coerce === true` for coerce), but they share the
 *    same type-level marker: `_zod.input` is `unknown`. The
 *    normalizer runs at parse time, NOT at the write boundary, so
 *    storage holds the consumer's raw input and the type collapses
 *    to `unknown` to match. Reach the typed value via
 *    `handleSubmit`, `validate`, or `parse` — they re-parse
 *    storage through the wrapper.
 *
 * 2. `inner.transform(fn)` — compiles to `ZodPipe<inner, ZodTransform>`.
 *    Transforms fire at submit / validate, NOT at the write boundary,
 *    so storage holds whatever `inner` stores. Recurse `StorageShape`
 *    on `inner` so a defaulted leaf inside `inner` still reads `T`
 *    (not `T | undefined`).
 *
 *    A bare top-level `ZodTransform` (no `in` schema) reads
 *    `_zod.input` directly — there's no inner to recurse into.
 *
 * 3. Codec / generic pipe — neither side is a transform. Read
 *    `_zod.output`. Codecs aren't write-boundary-synthesized, so the
 *    post-parse view is the only honest storage type.
 *
 * 4. Everything else (defaults, catch, readonly, optional, primitives,
 *    nested objects) — read `_zod.output`. Defaults and catches fire
 *    at parse time, so the post-init view is what storage holds.
 *    Nested objects delegate to Zod's own recursion on `_zod.output`,
 *    which peels nested defaults inside structural containers.
 *
 * Detection order: case 1 wins via the `_zod.input` IsUnknown check
 * before the pipe/transform cascade fires, so wrapped variants like
 * `z.coerce.number().optional()` (input = `unknown | undefined` →
 * collapses to `unknown`) and `z.preprocess(fn, z.object(...))` (input
 * = `unknown`) both land on `unknown` without descending. The IsAny
 * filter keeps `z.any()` from being mistaken for coerce.
 *
 * Implementation note: direct `_zod` property access mirrors Zod's
 * own `$InferObjectOutput` / `$InferObjectInput`, which read
 * `T[k]['_zod']['output']` / `T[k]['_zod']['input']` directly rather
 * than wrapping in the top-level `output<T>` / `input<T>` conditional.
 * Wrapping per key spawns a fresh conditional instantiation for every
 * key; Volar's web-worker checker collapses that per-key walk to
 * `any` once the schema is non-trivial. Property access has no
 * conditional and resolves cleanly under the same budget.
 *
 * Shape access also goes through `_zod.def.shape` rather than
 * `infer Shape from z.ZodObject<Shape>` — the latter collapses to the
 * `$ZodShape` upper bound in the same worker because of
 * `z.ZodObject`'s `out Shape` covariance markers.
 */
export type StorageShape<S> = S extends {
  _zod: { def: { type: 'object'; shape: infer Shape } }
}
  ? { [K in keyof Shape]-?: StorageLeaf<Shape[K]> }
  : StorageLeaf<S>

/**
 * Detects a schema whose `_zod.input` is `unknown` — the marker both
 * `z.preprocess(fn, _)` and `z.coerce.X()` share in Zod v4. Excludes
 * `any` via the canonical `0 extends 1 & T` test so `z.any()` leaves
 * fall through to the cascade below and keep their `any` typing.
 */
type InputIsUnknown<L> = L extends { _zod: { input: infer In } }
  ? 0 extends 1 & In
    ? false
    : unknown extends In
      ? true
      : false
  : false

/**
 * Implementation-detail per-leaf branching for `StorageShape`.
 * Exported so the bundled `.d.ts` carries a single alias body —
 * every leaf of a Zod object schema otherwise re-emits the full
 * pipe / transform / default conditional ladder, which compounds
 * badly with multiple complex schemas in the same scope. Consumers
 * should reach for `StorageShape` instead.
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
