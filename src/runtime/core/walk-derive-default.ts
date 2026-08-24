/**
 * Shared default-value walker — derives the initial seed value the
 * runtime places at every leaf of a Zod schema tree.
 *
 * Both v3 and v4 adapters dispatch through this body via their
 * `SchemaIntrospector` instance plus a small `DeriveDefaultContext`
 * carrying per-adapter knobs (`unsupportedKindFallback`, `formKey`).
 * The per-version kind sets — v3's `branded` / `effects` / `pipeline`
 * / `native-enum`, v4's `pipe` / `file` — collapse to distinct cases
 * on the SharedZodKind switch.
 *
 * Semantics (preserved verbatim from the prior per-adapter
 * implementations — characterised by the `default-values`,
 * `get-default-at-path`, and `default-values-parity` test suites in
 * `test/adapters/zod-v{3,4}/`):
 *
 *  - When `useDefault=true`, the walker FIRST peels transparent
 *    wrappers (Optional / Nullable / Readonly / Catch-without-value /
 *    Branded / Effects / Pipeline) looking for an embedded
 *    `ZodDefault` — and returns its value if found. This mirrors v3's
 *    prior `unwrapDefault` chain-peel and CLOSES a v3↔v4 parity gap:
 *    on v4, `z.string().default('x').optional()` previously returned
 *    `undefined` because the outer-kind switch hit `case 'optional'`
 *    first; under the unified walker it returns `'x'`. ZodCatch
 *    precedence is preserved: catch wraps default → catch wins (the
 *    chain-peel returns the catch value at the outer Catch layer).
 *
 *  - Schema-side input normalizers (`z.coerce.X()`,
 *    `z.preprocess(fn, _)`) declare a write boundary the runtime
 *    cannot honestly synthesise a default for. Both early-return
 *    `undefined` so the consumer's `defaultValues` or a later
 *    `setValue` owns what lands in storage.
 *
 *  - Containers recurse into children; leaves return their kind's
 *    canonical empty value (`'' / 0 / 0n / false / new Date(0) /
 *    null / undefined / NaN / first enum or literal value /
 *    [] / new Set() / {}`).
 *
 *  - Unions / DUs use the first option as the seed.
 *
 *  - Intersections merge both sides via the shared `mergeDeep`.
 *
 *  - Lazy bumps a counter; past `maxDepth` returns `undefined` (the
 *    recursive node falls back to consumer-supplied defaultValues).
 *
 *  - Catch with `useDefault=true` returns the catch fallback; with
 *    `useDefault=false` recurses the inner so the leaf's empty value
 *    wins.
 *
 *  - `void` / `any` / `unknown` / `never` / opaque kinds return
 *    `undefined`.
 */
import type { SchemaIntrospector } from './abstract-schema-factory'
import { mergeDeep } from './merge-deep'
import { safeAssign } from './safe-assign'

export interface DeriveDefaultContext<Schema> {
  /**
   * Fallback for a kind the walker doesn't have a case for. Returning
   * `undefined` is the safe default; v3 wires a `console.warn` here
   * for visibility into custom-adapter consumers, v4 returns
   * `undefined` silently (its kind set is exhaustive against
   * `SchemaIntrospector.kindOf`).
   */
  unsupportedKindFallback(schema: Schema, kind: string): unknown
}

/**
 * Sentinel for the chain-peel-default helper. Distinct from
 * `undefined`, which IS a legal returned default value (e.g.
 * `z.string().default(undefined)`).
 */
export const NO_EMBEDDED_DEFAULT = Symbol('atta:no-embedded-default')

/**
 * Peel transparent wrappers looking for an embedded `ZodDefault` (or
 * a `ZodCatch` with a fallback value, which takes precedence over a
 * nested default at the same depth). Returns the resolved value or
 * the sentinel `NO_EMBEDDED_DEFAULT` if none found.
 *
 * Mirrors v3's prior `unwrapDefault` loop and now applies on v4 too.
 * v4's kind set means `branded` / `effects` / `pipeline` peels
 * silently no-op (the introspector stubs return undefined).
 *
 * Bounded loop (32 iterations) matches the prior cap and acts as a
 * runaway guard for pathological wrapper stacks / self-referential
 * lazy loops resolved before their inner is constructed.
 *
 * Exported so the v3 strict-mode fix-up loop in `zod-v3/index.ts`
 * (the `runStrictGetDefaultsV3` validate-then-fix path) can reuse
 * it for the issue-driven default-resolution step.
 */
export function peelEmbeddedDefault<Schema>(
  schema: Schema,
  intro: SchemaIntrospector<Schema>
): unknown {
  let current: Schema | undefined = schema
  for (let i = 0; i < 32; i++) {
    if (current === undefined) return NO_EMBEDDED_DEFAULT
    const k = intro.kindOf(current)
    if (k === 'default') return intro.getDefaultValue(current)
    if (k === 'catch') {
      if (intro.hasCatchValue(current)) return intro.getCatchDefault(current)
      current = intro.unwrapInner(current)
      continue
    }
    if (k === 'optional' || k === 'nullable' || k === 'readonly') {
      current = intro.unwrapInner(current)
      continue
    }
    if (k === 'branded') {
      current = intro.unwrapBranded(current)
      continue
    }
    if (k === 'effects') {
      current = intro.unwrapEffectsSource(current)
      continue
    }
    if (k === 'pipeline') {
      current = intro.unwrapPipeIn(current)
      continue
    }
    return NO_EMBEDDED_DEFAULT
  }
  return NO_EMBEDDED_DEFAULT
}

/**
 * Walk transparent wrappers looking for a `ZodDefault` in the chain.
 * Used by the preprocess branch to decide whether the inner has a
 * consumer-declared default the adapter should honor (recurse the
 * inner) or whether the slot is fully consumer-owned (`undefined`).
 *
 * Distinct from `peelEmbeddedDefault` in that the result is a
 * boolean — the caller decides what to do with it, not the value
 * itself.
 */
function hasDeclaredDefaultInChain<Schema>(
  schema: Schema,
  intro: SchemaIntrospector<Schema>
): boolean {
  let current: Schema | undefined = schema
  for (let i = 0; i < 32; i++) {
    if (current === undefined) return false
    const k = intro.kindOf(current)
    if (k === 'default') return true
    if (k === 'optional' || k === 'nullable' || k === 'readonly' || k === 'catch') {
      current = intro.unwrapInner(current)
      continue
    }
    return false
  }
  return false
}

export function deriveDefaultWalk<Schema>(
  schema: Schema,
  useDefault: boolean,
  intro: SchemaIntrospector<Schema>,
  maxDepth: number,
  ctx: DeriveDefaultContext<Schema>,
  lazyDepth = 0
): unknown {
  // Pre-check the wrapper chain for an embedded ZodDefault / ZodCatch
  // fallback. Returning it here is what makes
  // `z.string().default('x').optional()` resolve to 'x' rather than
  // undefined. Closes the v3↔v4 parity gap (v4 previously stopped at
  // the outer Optional and returned undefined).
  if (useDefault) {
    const peeled = peelEmbeddedDefault(schema, intro)
    if (peeled !== NO_EMBEDDED_DEFAULT) return peeled
  }

  // `z.coerce.X()` flags the wrapped primitive's def with `coerce:
  // true`; the consumer's pre-conversion input shape is unknown so
  // synthesising the primitive's slim concrete (`''` / `0` / etc.)
  // would claim a value the consumer never supplied. Leave the slot
  // `undefined` so `defaultValues` or a later `setValue` owns what
  // lands in storage. A consumer-declared `.default(x)` on the coerce
  // primitive was already honored by the chain-peel above.
  if (intro.isCoercePrimitive(schema)) return undefined

  const kind = intro.kindOf(schema)
  switch (kind) {
    case 'object': {
      const shape = intro.getObjectShape(schema)
      // Default container carries `Object.prototype`. The default
      // flows directly into `form.values`; matching the rest of the
      // value-write pipeline keeps the initial tree consistent with
      // what `setAtPath` and `mergeDeep` produce. Schema field names
      // can legitimately include `__proto__` (an architecture firm
      // tracking prototypes; a Zod schema with `z.object({ __proto__: … })`);
      // `safeAssign` lands such a key as an own data property.
      const out: Record<string, unknown> = {}
      for (const [key, subSchema] of Object.entries(shape)) {
        safeAssign(
          out,
          key,
          deriveDefaultWalk(subSchema, useDefault, intro, maxDepth, ctx, lazyDepth)
        )
      }
      return out
    }
    case 'array':
      return []
    case 'set':
      return new Set()
    case 'record':
      return {}
    case 'tuple': {
      const items = intro.getTupleItems(schema)
      return items.map((item) =>
        deriveDefaultWalk(item, useDefault, intro, maxDepth, ctx, lazyDepth)
      )
    }
    case 'union': {
      const options = intro.getUnionOptions(schema)
      const first = options[0]
      return first === undefined
        ? undefined
        : deriveDefaultWalk(first, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'discriminated-union': {
      const options = intro.getDiscriminatedOptions(schema)
      const first = options[0]
      return first === undefined
        ? undefined
        : deriveDefaultWalk(first, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'optional':
      return undefined
    case 'nullable':
      return null
    case 'default': {
      // `useDefault=false` path: the chain-peel above is suppressed,
      // so a direct ZodDefault still lands here — recurse the inner
      // to produce the leaf's bare empty value (the explicit default
      // is the consumer's "starting state" intent, not the leaf's
      // type-honest blank).
      if (useDefault) return intro.getDefaultValue(schema)
      const inner = intro.unwrapInner(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'readonly':
    case 'branded': {
      // Readonly: v3 + v4 transparent wrapper.
      // Branded: v3-only — `_def.type` carrier.
      const inner = kind === 'branded' ? intro.unwrapBranded(schema) : intro.unwrapInner(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'effects': {
      // v3-only. `ZodEffects` wraps refine / transform / preprocess.
      // For `preprocess`: the input side is the user-supplied fn, so
      // the slot has no canonical empty value the adapter can honestly
      // synthesise. If the inner declares a default, recurse (the
      // chain-peel finds it for useDefault=true; under useDefault=false
      // we recurse to the leaf's empty). Otherwise return undefined so
      // `defaultValues` or a later setValue owns the slot.
      // For `refinement` / `transform`: recurse the structural source.
      const inner = intro.unwrapEffectsSource(schema)
      if (intro.isPreprocessNode(schema)) {
        if (inner !== undefined && hasDeclaredDefaultInChain(inner, intro)) {
          return deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth)
        }
        return undefined
      }
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'pipeline': {
      // v3-only. The pre-transform default is the input schema's
      // natural default.
      const inner = intro.unwrapPipeIn(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'pipe': {
      // v4-only. Two sub-cases mirroring v3's preprocess branch:
      //
      //   - `z.preprocess(fn, inner)` — `in` is a ZodTransform. The
      //     input shape is unknown until the consumer writes. If the
      //     inner carries a declared default, recurse; otherwise
      //     return undefined.
      //   - `.transform(fn)` (transform on output) / generic / codec
      //     pipes — the input side IS the source schema; peel to it.
      const inn = intro.unwrapPipeIn(schema)
      if (inn !== undefined && intro.kindOf(inn) === 'transform') {
        const out = intro.unwrapPipeOut(schema)
        if (out !== undefined && hasDeclaredDefaultInChain(out, intro)) {
          return deriveDefaultWalk(out, useDefault, intro, maxDepth, ctx, lazyDepth)
        }
        return undefined
      }
      const out = intro.unwrapPipeOut(schema)
      const real =
        inn !== undefined && intro.kindOf(inn) !== 'transform'
          ? inn
          : out !== undefined && intro.kindOf(out) !== 'transform'
            ? out
            : (inn ?? out)
      return real === undefined
        ? undefined
        : deriveDefaultWalk(real, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'string':
      return ''
    case 'number':
      return 0
    case 'bigint':
      // z.bigint() strictly rejects numbers; the default must be a
      // bigint literal. Using `0` here would fail the schema's own
      // validation during default-values derivation.
      return 0n
    case 'boolean':
      return false
    case 'date':
      return new Date(0)
    case 'null':
      return null
    case 'undefined':
      return undefined
    case 'enum': {
      const values = intro.getEnumValues(schema)
      return values[0]
    }
    case 'native-enum': {
      // v3-only. Numeric enums get reverse-mapped
      // (`enum E { A }` → `{ A: 0, '0': 'A' }`); the valid runtime
      // members are the keys whose VALUE'S key isn't itself a number.
      // String enums have no reverse mapping, so every key is valid.
      // Pick the first valid value.
      const values = intro.getNativeEnumValues(schema)
      if (values === undefined) return undefined
      const validKeys = Object.keys(values).filter(
        (k) => typeof values[values[k] as string] !== 'number'
      )
      if (validKeys.length === 0) return undefined
      const first = validKeys[0]
      return first === undefined ? undefined : values[first]
    }
    case 'literal': {
      const values = intro.getLiteralValues(schema)
      return values[0]
    }
    case 'nan':
      return NaN
    case 'lazy': {
      // Bump the lazy counter ONLY here — structural recursion doesn't
      // accumulate. Past the cap, return undefined so a recursive node
      // ends in a non-fatal blank; `defaultValues` (consumer-supplied)
      // is the authority for what the seed should be at the recursive
      // boundary anyway.
      if (lazyDepth >= maxDepth) return undefined
      let inner: Schema | undefined
      try {
        inner = intro.unwrapLazy(schema)
      } catch {
        return undefined
      }
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth + 1)
    }
    case 'intersection': {
      const left = intro.getIntersectionLeft(schema)
      const right = intro.getIntersectionRight(schema)
      const l =
        left === undefined
          ? undefined
          : deriveDefaultWalk(left, useDefault, intro, maxDepth, ctx, lazyDepth)
      const r =
        right === undefined
          ? undefined
          : deriveDefaultWalk(right, useDefault, intro, maxDepth, ctx, lazyDepth)
      // `mergeDeep` prefers `right` where both sides carry a plain-
      // record value at a key, and returns `right` wholesale when
      // either side is a leaf. Matches parse-time semantics: an
      // intersection of `{ a }` and `{ b }` must satisfy both, so the
      // merged shape carries both keys' defaults.
      return mergeDeep(l, r)
    }
    case 'catch': {
      // `useDefault=true` was already caught by `peelEmbeddedDefault`
      // at the top of the walker; on `useDefault=false` the catch is a
      // default-like wrapper that gets skipped — the inner leaf's bare
      // empty value wins (both majors, aligned in size-teardown P7).
      if (useDefault) return intro.getCatchDefault(schema)
      const inner = intro.unwrapInner(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, ctx, lazyDepth)
    }
    case 'file':
      // `z.file()` has no canonical "empty file" — the user picks one
      // through the directive's change handler. `null` is the storage
      // blank value the directive canonicalises to on register / clear;
      // emitting `null` here keeps `getEmptyValueAtPath` aligned with
      // what `form.clear(path)` writes.
      return null
    case 'any':
    case 'unknown':
    case 'void':
    case 'never':
    case 'promise':
    case 'custom':
    case 'template-literal':
    case 'transform':
    case 'map':
    case 'symbol':
    case 'function':
      // `promise` / `custom` / `template-literal` / `map` / `symbol` /
      // `function` are rejected by `assertSupportedKinds` at adapter
      // construction, so these branches are unreachable through the
      // public surface. `transform` is the input side of a
      // `z.preprocess(fn, inner)` and has no own default — callers
      // walk to `inner` via the surrounding pipe / effects. Kept for
      // exhaustive switch safety.
      return undefined
    default:
      return ctx.unsupportedKindFallback(schema, kind)
  }
}
