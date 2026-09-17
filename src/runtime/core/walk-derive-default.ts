/**
 * The shared default-value walker: it derives the seed value the runtime
 * places at every leaf of a Zod schema tree.
 *
 * Both adapters dispatch through this one body via their
 * `SchemaIntrospector`. The per-version kind sets (v3's `branded` /
 * `effects` / `pipeline` / `native-enum`, v4's `pipe` / `file`) collapse
 * to distinct cases on the SharedZodKind switch.
 *
 * The semantics are pinned by the `default-values`, `get-default-at-path`
 * and `default-values-parity` suites in `test/adapters/zod-v{3,4}/`:
 *
 *  - With `useDefault=true` the walker FIRST peels transparent wrappers
 *    (Optional / Nullable / Readonly / Catch-without-value / Branded /
 *    Effects / Pipeline) looking for an embedded `ZodDefault`, and returns
 *    its value when it finds one. That peel is what makes
 *    `z.string().default('x').optional()` resolve to `'x'` on BOTH majors
 *    rather than stopping at the outer kind. ZodCatch takes precedence: a
 *    catch wrapping a default wins, the peel returning the catch value at
 *    the outer Catch layer.
 *
 *  - A schema-side input normalizer (`z.coerce.X()`, `z.preprocess(fn, _)`)
 *    declares a write boundary the runtime cannot honestly synthesise a
 *    default for. Both early-return `undefined`, so the consumer's
 *    `defaultValues` or a later `setValue` owns what lands in storage.
 *
 *  - Containers recurse into their children; a leaf returns its kind's
 *    canonical empty value (`'' / 0 / 0n / false / new Date(0) / null /
 *    undefined / NaN / first enum or literal value / [] / new Set() /
 *    new Map() / {}`).
 *
 *  - A union or DU seeds from its first option.
 *
 *  - An intersection merges both sides through the shared `mergeDeep`.
 *
 *  - Lazy bumps a counter, and past `maxDepth` returns `undefined`, the
 *    recursive node falling back to consumer-supplied defaultValues.
 *
 *  - Catch returns its fallback under `useDefault=true` and recurses the
 *    inner under `useDefault=false`, where the leaf's empty value wins.
 *
 *  - `void`, `never`, the opaque kinds (`any` / `unknown` / `custom`) and
 *    the three with no canonical empty member (`promise` / `symbol` /
 *    `function`) return `undefined`, leaving the slot genuinely absent
 *    until the consumer writes one.
 */
import type { SchemaIntrospector } from './abstract-schema-factory'
import { mergeDeep } from './merge-deep'
import { safeAssign } from './safe-assign'

/**
 * Sentinel for the chain-peel-default helper, distinct from `undefined`,
 * which IS a legal returned default (`z.string().default(undefined)`).
 */
const NO_EMBEDDED_DEFAULT = Symbol('atta:no-embedded-default')

/**
 * Peel transparent wrappers looking for an embedded `ZodDefault` (or
 * a `ZodCatch` with a fallback value, which takes precedence over a
 * nested default at the same depth). Returns the resolved value or
 * the sentinel `NO_EMBEDDED_DEFAULT` if none found.
 *
 * Applies on both majors. On v4 the `branded` / `effects` / `pipeline`
 * peels silently no-op, their introspector stubs returning undefined.
 *
 * The loop is bounded at 32 iterations as a runaway guard against a
 * pathological wrapper stack, or a self-referential lazy resolved before
 * its inner is constructed.
 *
 * Exported so the v3 fix-up loop in `zod-v3/index.ts` (the
 * `runGetDefaultsV3` validate-then-fix path) can reuse it for the
 * issue-driven default-resolution step.
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
 * Distinct from `peelEmbeddedDefault` in returning a boolean: the caller
 * decides what to do, rather than receiving the value itself.
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
  lazyDepth = 0
): unknown {
  // Pre-check the wrapper chain for an embedded ZodDefault or ZodCatch
  // fallback. Returning it here is what makes
  // `z.string().default('x').optional()` resolve to `'x'` on both majors,
  // rather than stopping at the outer Optional.
  if (useDefault) {
    const peeled = peelEmbeddedDefault(schema, intro)
    if (peeled !== NO_EMBEDDED_DEFAULT) return peeled
  }

  // `z.coerce.X()` flags the wrapped primitive's def with `coerce: true`.
  // The consumer's pre-conversion input shape is unknown, so synthesising
  // the primitive's slim concrete (`''`, `0`) would claim a value they
  // never supplied. Leaving the slot `undefined` gives `defaultValues` or
  // a later `setValue` ownership. A `.default(x)` declared on the coerce
  // primitive was already honored by the chain-peel above.
  if (intro.isCoercePrimitive(schema)) return undefined

  const kind = intro.kindOf(schema)
  switch (kind) {
    case 'object': {
      const shape = intro.getObjectShape(schema)
      // The default container carries `Object.prototype`. This flows
      // straight into `form.values`, so matching the rest of the
      // value-write pipeline keeps the initial tree consistent with what
      // `setAtPath` and `mergeDeep` produce. A schema field name can
      // legitimately be `__proto__` (an architecture firm tracking
      // prototypes, say), and `safeAssign` lands such a key as an own
      // data property.
      const out: Record<string, unknown> = {}
      for (const [key, subSchema] of Object.entries(shape)) {
        safeAssign(out, key, deriveDefaultWalk(subSchema, useDefault, intro, maxDepth, lazyDepth))
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
      return items.map((item) => deriveDefaultWalk(item, useDefault, intro, maxDepth, lazyDepth))
    }
    case 'union': {
      const options = intro.getUnionOptions(schema)
      const first = options[0]
      return first === undefined
        ? undefined
        : deriveDefaultWalk(first, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'discriminated-union': {
      const options = intro.getDiscriminatedOptions(schema)
      const first = options[0]
      return first === undefined
        ? undefined
        : deriveDefaultWalk(first, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'optional':
      return undefined
    case 'nullable':
      return null
    case 'default': {
      // `useDefault=false` suppresses the chain-peel above, so a direct
      // ZodDefault lands here. Recurse the inner for the leaf's bare empty
      // value: an explicit default states the consumer's starting state,
      // not the leaf's type-honest blank.
      if (useDefault) return intro.getDefaultValue(schema)
      const inner = intro.unwrapInner(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'nonoptional':
    case 'success':
    case 'readonly':
    case 'branded': {
      // Readonly is a transparent wrapper on both majors. Branded is
      // v3-only, the `_def.type` carrier.
      const inner = kind === 'branded' ? intro.unwrapBranded(schema) : intro.unwrapInner(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'effects': {
      // v3-only. `ZodEffects` wraps refine / transform / preprocess.
      //
      // For `preprocess` the input side is the user-supplied fn, so the
      // slot has no canonical empty value the adapter can honestly
      // synthesise. Recurse when the inner declares a default (the
      // chain-peel finds it under useDefault=true, and under
      // useDefault=false the recursion reaches the leaf's empty);
      // otherwise return undefined and let `defaultValues` or a later
      // setValue own the slot. For `refinement` and `transform`, recurse
      // the structural source.
      const inner = intro.unwrapEffectsSource(schema)
      if (intro.isPreprocessNode(schema)) {
        if (inner !== undefined && hasDeclaredDefaultInChain(inner, intro)) {
          return deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth)
        }
        return undefined
      }
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'pipeline': {
      // v3-only. The pre-transform default is the input schema's
      // natural default.
      const inner = intro.unwrapPipeIn(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'pipe': {
      // v4-only. Two sub-cases mirroring v3's preprocess branch:
      //
      //   - `z.preprocess(fn, inner)`, where `in` is a ZodTransform. The
      //     input shape is unknown until the consumer writes, so recurse
      //     when the inner carries a declared default and otherwise
      //     return undefined.
      //   - a `.transform(fn)` on output, a generic pipe, or a codec:
      //     the input side IS the source schema, so peel to it.
      const inn = intro.unwrapPipeIn(schema)
      if (inn !== undefined && intro.kindOf(inn) === 'transform') {
        const out = intro.unwrapPipeOut(schema)
        if (out !== undefined && hasDeclaredDefaultInChain(out, intro)) {
          return deriveDefaultWalk(out, useDefault, intro, maxDepth, lazyDepth)
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
        : deriveDefaultWalk(real, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'string':
      return ''
    case 'number':
      return 0
    case 'bigint':
      // z.bigint() strictly rejects numbers, so the default must be a
      // bigint literal. `0` here would fail the schema's own validation
      // during default-values derivation.
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
      // v3-only. A numeric enum is reverse-mapped
      // (`enum E { A }` → `{ A: 0, '0': 'A' }`), so its valid runtime
      // members are the keys whose VALUE's key is not itself a number. A
      // string enum has no reverse mapping, making every key valid. Take
      // the first valid value.
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
      // Bump the lazy counter ONLY here, since structural recursion does
      // not accumulate. Past the cap, return undefined so a recursive node
      // ends in a non-fatal blank; at a recursive boundary the
      // consumer-supplied `defaultValues` is the authority on the seed.
      if (lazyDepth >= maxDepth) return undefined
      let inner: Schema | undefined
      try {
        inner = intro.unwrapLazy(schema)
      } catch {
        return undefined
      }
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth + 1)
    }
    case 'intersection': {
      const left = intro.getIntersectionLeft(schema)
      const right = intro.getIntersectionRight(schema)
      const l =
        left === undefined
          ? undefined
          : deriveDefaultWalk(left, useDefault, intro, maxDepth, lazyDepth)
      const r =
        right === undefined
          ? undefined
          : deriveDefaultWalk(right, useDefault, intro, maxDepth, lazyDepth)
      // `mergeDeep` prefers `right` where both sides carry a plain-record
      // value at a key, and returns `right` wholesale when either side is
      // a leaf. That matches parse-time semantics: an intersection of
      // `{ a }` and `{ b }` must satisfy both, so the merged shape carries
      // both keys' defaults.
      return mergeDeep(l, r)
    }
    case 'catch': {
      // `peelEmbeddedDefault` at the top of the walker already caught
      // `useDefault=true`. Under `useDefault=false` the catch is a
      // default-like wrapper and is skipped, so the inner leaf's bare
      // empty value wins on both majors (aligned in size-teardown P7).
      if (useDefault) return intro.getCatchDefault(schema)
      const inner = intro.unwrapInner(schema)
      return inner === undefined
        ? undefined
        : deriveDefaultWalk(inner, useDefault, intro, maxDepth, lazyDepth)
    }
    case 'file':
      // `z.file()` has no canonical "empty file"; the user picks one
      // through the directive's change handler. `null` is the storage
      // blank the directive canonicalises to on register and on clear, so
      // emitting it here keeps `getEmptyValueAtPath` aligned with what
      // `form.clear(path)` writes.
      return null
    case 'map':
      // The empty Map is as honest a blank as `[]` is for an array or
      // `new Set()` for a set: the container exists, holds nothing, and
      // satisfies `z.map(K, V)` outright.
      return new Map()
    case 'template-literal':
      // A template literal parses strings against a pattern, so the
      // string blank is the right one. `''` need not satisfy that pattern,
      // exactly as `''` does not satisfy `z.string().min(5)`:
      // refinement-level conformance is validation's business, not the
      // blank walker's.
      return ''
    case 'any':
    case 'unknown':
    case 'custom':
    case 'void':
    case 'never':
    case 'promise':
    case 'symbol':
    case 'function':
    case 'transform':
      // Kinds with no honest blank. Two different reasons land here.
      //
      // `any` / `unknown` / `custom` are opaque leaves: the schema
      // states nothing about the value's shape, so there is no blank
      // to derive and the slot stays absent until the consumer writes
      // one. `custom` is the kind `z.instanceof(File)` compiles to on
      // v4, and it lands here rather than on `file`'s `null` because
      // the predicate need not describe a File at all (#542).
      //
      // `promise` / `symbol` / `function` are describable but have no
      // canonical empty member. There is no empty Promise, no empty
      // function, and `Symbol()` mints a fresh value on every call, so
      // seeding one would make the derived blank non-deterministic and
      // break reference stability between two structurally identical
      // schemas. `undefined` leaves the slot genuinely absent until the
      // consumer supplies a value, the truthful answer for all three.
      //
      // `transform` is the input side of a `z.preprocess(fn, inner)`
      // and has no own default: callers walk to `inner` via the
      // surrounding pipe / effects.
      return undefined
    default:
      // Unreachable by construction, not by convention: every kind the
      // introspector can name has a case above, and an unrecognised
      // spelling resolves to `'unknown'`, which has one of its own. Keep
      // it that way rather than reinstating a dev-warn here; a branch that
      // cannot be reached is a better guarantee than a test asserting that
      // it never fires.
      return undefined
  }
}
