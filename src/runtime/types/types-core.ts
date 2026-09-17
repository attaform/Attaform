import type { Unset } from '../core/unset'

/**
 * The minimum shape any form value satisfies, a plain record. Use it as
 * a constraint for composables that work generically across forms, such
 * as a custom hook taking any form's `useForm` return.
 */
export type GenericForm = Record<string, unknown>

/** `true` when `T` is an object or array. */
export type IsObjectOrArray<T> = T extends GenericForm
  ? true
  : T extends Array<unknown>
    ? true
    : false

/**
 * Shared recursion body backing `PartialFlatPath` and
 * `RegisterFlatPath`. One walk over `Form`, with `Mode` deciding
 * whether container paths are emitted alongside their reachable leaves.
 *
 * - `'partial'`: emit every container path (object containers,
 *   nested-object array roots, array-of-object element containers).
 *   Used by `setValue`, `form.values.<path>`, and every read-side API
 *   that can address a container.
 * - `'register'`: skip container paths, since `v-register` binds onto a
 *   leaf-backing native element. Primitive arrays still admit the
 *   array-root path under both modes, because multi-select and
 *   grouped-checkbox bindings register onto the array itself.
 */
export type FlatPathBuilder<
  Form,
  Mode extends 'partial' | 'register',
  Key extends keyof Form = keyof Form,
> =
  IsObjectOrArray<Form> extends true
    ? Key extends string
      ? Form[Key] extends infer Value
        ? Value extends Array<infer ArrayItem>
          ? IsObjectOrArray<ArrayItem> extends true
            ? Mode extends 'partial'
              ? | `${Key}`
                | `${Key}.${number}`
                | `${Key}.${number}.${FlatPathBuilder<ArrayItem, Mode>}`
              : `${Key}.${number}.${FlatPathBuilder<ArrayItem, Mode>}`
            : `${Key}` | `${Key}.${number}`
          : Value extends GenericForm
            ? Mode extends 'partial'
              ? `${Key}` | `${Key}.${FlatPathBuilder<Value, Mode>}`
              : `${Key}.${FlatPathBuilder<Value, Mode>}`
            : `${Key}`
        : never
      : Key extends number
        ? | `${Key}`
          | (Form[Key] extends GenericForm
              ? `${Key}.${FlatPathBuilder<Form[Key], Mode>}`
              : Form[Key] extends Array<infer ArrayItem>
                ? IsObjectOrArray<ArrayItem> extends true
                  ? Mode extends 'partial'
                    ? `${Key}.${number}` | `${Key}.${number}.${FlatPathBuilder<ArrayItem, Mode>}`
                    : `${Key}.${number}.${FlatPathBuilder<ArrayItem, Mode>}`
                  : `${Key}.${number}`
                : never)
        : never
    : never

/**
 * Backs `FlatPath` in its default partial-path mode. Reach for
 * `FlatPath`; this alias is not part of the stable surface.
 *
 * It is exported so `rollup-plugin-dts` keeps it as a named alias in
 * the bundled `.d.ts` rather than inlining the full template-literal
 * recursion at every reference site. Inlined, it compounds into TS2589
 * territory once several complex forms share a scope.
 *
 * The `Form extends unknown` wrapper distributes over a top-level
 * union so each member contributes its OWN `keyof`. That is what makes
 * a `z.discriminatedUnion` root expose every variant's keys as
 * addressable paths, rather than the intersection that naked
 * `keyof (A | B)` collapses to. Interior unions already distribute
 * inside `FlatPathBuilder` at its `infer Value` step.
 */
export type PartialFlatPath<Form> = Form extends unknown ? FlatPathBuilder<Form, 'partial'> : never

// Two TypeScript behaviours shape what FlatPath can offer:
//
// 1. `something.${string}` | `something.${string}.deeper` collapses to
// `something.${string}`, because `${string}.deeper` is a subtype of string. Records in a schema
// therefore suggest fewer paths. Nothing warns; prefer static keys where practical.
//
// 2. Trailing decimals are valid JS numbers (`42.`), so `something.${number}` admits
// 'something.42.' and `something.${number}.deeper` admits 'something.42..deeper'. useForm strips
// trailing decimals when processing paths at runtime.
/**
 * Union of dotted-string paths reachable inside `Form`. For
 * `{ user: { email: string }, items: string[] }`:
 *
 *   `'user' | 'user.email' | 'items' | 'items.0' | 'items.1' | ...`
 *
 * Every path-addressed API (`setValue(path, value)`, `register(path)`,
 * `toRef(path)`) takes one, so paths autocomplete and typos are
 * compile errors.
 */
export type FlatPath<Form> = PartialFlatPath<Form>

/**
 * Convert a tuple of path segments to its dotted-string equivalent.
 *
 *   `JoinSegments<['cargo', 'items', 0, 'sku']>` is `'cargo.items.0.sku'`
 *
 * Depth is bounded by the tuple length, typically 3 or 4, so the cost
 * does not scale with `FlatPath<Form>`. Template literal types
 * distribute over unions, so a segment union propagates into the joined
 * path: `JoinSegments<['pickup' | 'delivery', 'line1']>` is
 * `'pickup.line1' | 'delivery.line1'`. That is what makes tuple-form
 * path APIs work inside a `v-for` over a prefix variable, since the
 * joined result is checked against the existing `FlatPath<Form>` /
 * `RegisterFlatPath<Form>` unions instead of a separate enumeration.
 */
export type JoinSegments<
  S extends ReadonlyArray<string | number>,
  Acc extends string = '',
> = S extends readonly [
  infer Head extends string | number,
  ...infer Rest extends ReadonlyArray<string | number>,
]
  ? Acc extends ''
    ? JoinSegments<Rest, `${Head}`>
    : JoinSegments<Rest, `${Acc}.${Head}`>
  : Acc

/**
 * The advice half of a segment-array rejection, used when `S` never
 * inferred a tuple at all.
 *
 * A caller passing a plain `string` lands here: inference falls back to
 * the constraint, and `JoinSegments` of a non-tuple array is `''`.
 * Naming a path would be a lie, so the message names the remedies
 * instead. This is the shape behind #568, where a row component
 * received its path prefix as an untyped `string` prop and every
 * concatenation widened to `string`.
 */
type PlainStringAdvice =
  'attaform: a plain string cannot be checked against the schema. Pass a literal path, type the dynamic prefix, or use the segment-array form.'

/**
 * Why a segment array was rejected, as a type the compiler prints.
 *
 * Every segment-array overload brands its parameter
 * `S & (<joined path is valid> ? unknown : <this>)`. The brand must
 * stay a string literal: `S & never` is `never`, which makes TypeScript
 * report the parameter as `never` and say nothing about what was wrong,
 * while a string literal intersects without collapsing, so the sentence
 * survives into the diagnostic and the argument keeps its inferred
 * tuple type:
 *
 * ```
 * Argument of type '["boxes", 3, "nope"]' is not assignable to parameter
 * of type 'readonly ["boxes", 3, "nope"] &
 *   "attaform: 'boxes.3.nope' is not a path in this form's schema"'.
 * ```
 *
 * Nothing can satisfy the brand, so a wrong path stays a compile error;
 * only the message changes.
 */
export type SegmentPathRejection<Joined extends string> = [Joined] extends ['']
  ? PlainStringAdvice
  : `attaform: '${Joined}' is not a path in this form's schema`

/**
 * `SegmentPathRejection` for `register`, whose accepted set is
 * `RegisterFlatPath` rather than `FlatPath`.
 *
 * Worth its own sentence: a container path is in the schema and still
 * not registrable, so "not a path in this form's schema" would be false
 * exactly where it is most likely to be read.
 */
export type SegmentRegisterRejection<Joined extends string> = [Joined] extends ['']
  ? PlainStringAdvice
  : `attaform: '${Joined}' is not a registrable path. v-register binds a leaf input, so container paths are excluded.`

/**
 * `true` when `T` is a union, `false` for a single type. Gates
 * non-homomorphic mapped-type forms so a single object type keeps its
 * homomorphic `[K in keyof T]` lookup, preserving literal keys instead
 * of widening to an index signature.
 */
export type IsUnion<T, U = T> = T extends T ? ([U] extends [T] ? false : true) : never

/**
 * Union of all keys across all members of `T`. For a single object type
 * this equals `keyof T`; for `A | B` it produces `keyof A | keyof B`,
 * where naked `keyof (A | B)` would intersect to common keys only.
 *
 * Paired with `ValueOfUnion` to merge variant key sets in the chained
 * metadata proxies (`form.fields`, `form.errors`), so per-variant
 * leaves stay addressable through one shape whichever discriminant is
 * active.
 */
export type KeyofUnion<T> = T extends unknown ? keyof T : never

/**
 * Value at key `K` across union members of `T`. Members holding `K`
 * contribute `T[K]`; members lacking it contribute `undefined`.
 *
 * That mirrors the metadata proxies at runtime: chained access works at
 * every union member, and the leaf carries `T | undefined` because the
 * key is absent in some variants, where the runtime returns a stable
 * stub.
 */
export type ValueOfUnion<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : undefined
  : never

/**
 * Value at key `K` across union members of `T`, dropping members that
 * LACK `K` entirely: they contribute `never`, not `undefined`. The
 * counterpart to `ValueOfUnion`, which injects a synthetic `undefined`
 * for absent-variant keys so chained reads stay safe.
 *
 * `form.fields` uses it at discriminated-union keys so a variant-only
 * field types as node-optional `FieldState<X> | undefined`, the node
 * being absent when its variant is not active, rather than
 * value-optional `FieldState<X | undefined>`, which would falsely
 * promise a readable node. A genuine `undefined` from an OPTIONAL
 * declaration survives; only the synthetic one is stripped.
 */
export type PresentValueOfUnion<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never

/**
 * Apply the discriminated-union key merge to a shape carrying values
 * rather than metadata leaves. Single object types map homomorphically;
 * unions of objects merge keys via `KeyofUnion` / `ValueOfUnion` so
 * per-variant fields are reachable through one chained-access shape.
 *
 * `ValuesSurface` uses it to make an oversized-only
 * `form.values.cargo.permitNumber` typecheck whichever variant is
 * active, matching the runtime, where plain JS access on a missing key
 * returns `undefined` rather than throwing.
 *
 * Date / Map / Set / RegExp / function leaves stay opaque, since a
 * value read of those should preserve the platform shape.
 */
export type LiftedValueShape<T> = [T] extends [
  string | number | boolean | bigint | symbol | null | undefined,
]
  ? T
  : [T] extends [
        Date | RegExp | Map<unknown, unknown> | Set<unknown> | ((...args: never) => unknown),
      ]
    ? T
    : [T] extends [ReadonlyArray<unknown>]
      ? T
      : [T] extends [object]
        ? [IsUnion<T>] extends [true]
          ? { [K in KeyofUnion<T>]: LiftedValueShape<ValueOfUnion<T, K>> }
          : { [K in keyof T]: LiftedValueShape<T[K]> }
        : T

/**
 * Recursive `Partial`: every property at every depth is optional, so a
 * partial override at any nesting level is valid.
 */
export type DeepPartial<T> = T extends Primitive
  ? T
  : T extends Array<infer ArrayItem>
    ? DeepPartial<ArrayItem>[]
    : T extends object
      ? {
          [Key in keyof T]?: DeepPartial<T[Key]>
        }
      : T

/**
 * Shared descent body backing `NestedType` and `NestedReadType`. Both
 * walk segment by segment, distributing over union members via
 * `KeyofUnion` / `ValueOfUnion`, and diverge only at the leaf:
 *
 * - `TaintArrayCrossings extends false` (`NestedType`): leaves are
 *   returned untouched, which is what the strict write-side APIs need
 *   (`setValue`'s value parameter, `form.fields.<path>`).
 * - `TaintArrayCrossings extends true` (`NestedReadType`): leaves widen
 *   with `| undefined` once any segment in the walk was an array index,
 *   reflecting an out-of-bounds read at runtime.
 *
 * `_Tainted` carries the array crossing under taint mode and stays
 * `false` through every arm under strict mode. Both strip nullishness
 * at the root.
 *
 * Reach for `NestedType` or `NestedReadType`; this is not part of the
 * stable surface.
 */
export type NestedTypeBuilder<
  RootValue,
  FlattenedPath extends string,
  TaintArrayCrossings extends boolean,
  _Tainted extends boolean = false,
  _RootValue = NonNullable<RootValue>,
> =
  IsObjectOrArray<_RootValue> extends false
    ? never
    : FlattenedPath extends `${infer Key}.${infer Rest}`
      ? Key extends `${number}`
        ? Key extends KeyofUnion<_RootValue>
          ? NestedTypeBuilder<
              ValueOfUnion<_RootValue, Key>,
              Rest,
              TaintArrayCrossings,
              TaintArrayCrossings extends true ? true : _Tainted
            >
          : Key extends `${infer NumericKey extends number}`
            ? NumericKey extends KeyofUnion<_RootValue>
              ? NestedTypeBuilder<
                  ValueOfUnion<_RootValue, NumericKey>,
                  Rest,
                  TaintArrayCrossings,
                  TaintArrayCrossings extends true ? true : _Tainted
                >
              : never
            : never
        : Key extends KeyofUnion<_RootValue>
          ? NestedTypeBuilder<ValueOfUnion<_RootValue, Key>, Rest, TaintArrayCrossings, _Tainted>
          : never
      : FlattenedPath extends `${number}`
        ? FlattenedPath extends KeyofUnion<_RootValue>
          ? TaintArrayCrossings extends true
            ? ValueOfUnion<_RootValue, FlattenedPath> | undefined
            : ValueOfUnion<_RootValue, FlattenedPath>
          : FlattenedPath extends `${infer NumericKey extends number}`
            ? NumericKey extends KeyofUnion<_RootValue>
              ? TaintArrayCrossings extends true
                ? ValueOfUnion<_RootValue, NumericKey> | undefined
                : ValueOfUnion<_RootValue, NumericKey>
              : never
            : never
        : FlattenedPath extends KeyofUnion<_RootValue>
          ? _Tainted extends true
            ? ValueOfUnion<_RootValue, FlattenedPath> | undefined
            : ValueOfUnion<_RootValue, FlattenedPath>
          : never

/**
 * Resolve the type at a dotted-string path inside `RootValue`, for the
 * strict write-side APIs:
 *
 *   `NestedType<{ user: { email: string } }, 'user.email'>` is `string`
 *
 * On a discriminated-union descent it uses `KeyofUnion` /
 * `ValueOfUnion`, so a per-variant key resolves to `T | undefined`
 * rather than `never`. That keeps `NestedType` in lockstep with
 * `FlatPath`: every path `FlatPath` says is reachable resolves to a
 * useful value type, instead of collapsing to the intersection of all
 * variants' keys.
 *
 * TypeScript caps conditional-type recursion near 50 levels, so paths
 * deeper than that resolve to `never`. Real schemas do not reach it.
 */
export type NestedType<RootValue, FlattenedPath extends string> = NestedTypeBuilder<
  RootValue,
  FlattenedPath,
  false
>

/**
 * Primitive-leaf marker used by `DeepPartial` and the sibling
 * structural walkers. Reach for `DeepPartial`; this is not part of the
 * stable surface, and is exported only so the bundled `.d.ts`
 * references one alias instead of re-emitting the union at every
 * recursion branch of every walker.
 */
export type Primitive = string | number | boolean | symbol | bigint | null | undefined

/**
 * Distinguish a tuple from a regular array, for write-side helpers that
 * must preserve tuple positions instead of widening to
 * `Array<element>`.
 *
 *   `IsTuple<[string, number]>` is `true`
 *   `IsTuple<string[]>` is `false`
 */
export type IsTuple<T extends readonly unknown[]> = number extends T['length'] ? false : true

/**
 * Path-resolved type for the read-side APIs (`form.values.<path>`,
 * `form.toRef(path)`, `register(path).innerRef`). Like `NestedType`,
 * except that once the walk crosses an array index the result is tagged
 * `| undefined`, honouring the out-of-bounds read the runtime allows.
 * Discriminated-union descents follow the same rule as `NestedType`.
 */
export type NestedReadType<RootValue, FlattenedPath extends string> = NestedTypeBuilder<
  RootValue,
  FlattenedPath,
  true
>

/**
 * The array a path actually addresses, nullish stripped, or `never`
 * when the path does not address an array. Shared by `ArrayPath`
 * (membership) and `ArrayItem` (element type) so the filter and the
 * extractor cannot disagree about what counts as one.
 *
 * The strip is load-bearing. `Form` is the schema's INPUT shape, so
 * `z.array(row).default([])` resolves to `row[] | undefined`, and
 * `NestedType` tags a discriminated union's per-variant keys the same
 * way on purpose. A bare `extends readonly unknown[]` predicate reads
 * that tag as "not an array", which is how every optional, defaulted,
 * nullable and DU-variant array fell out of the field-array helpers
 * while the runtime went on accepting all of them (#541).
 *
 * `extends infer Leaf` binds the stripped leaf once so the guards below
 * do not re-instantiate `NestedType`, and the tuple wraps suppress
 * distribution so a union leaf is judged whole: `A[] | B[]` is an
 * array, `A[] | string` is not.
 *
 * Reach for `ArrayPath` / `ArrayItem`; this alias exists so
 * `rollup-plugin-dts` keeps one named reference in the bundled `.d.ts`.
 */
export type ArrayLeafOf<Form, P extends string> =
  Exclude<NestedType<Form, P>, undefined | null> extends infer Leaf
    ? [Leaf] extends [never]
      ? never
      : [Leaf] extends [readonly unknown[]]
        ? Leaf
        : never
    : never

/**
 * `FlatPath<Form>` narrowed to the paths whose leaf is an array, so the
 * typed field-array helpers (append, remove, swap) accept only paths
 * that address one: `append('email', ...)` on a `{ email: string }` is
 * a compile error. Optionality is not a disqualifier; see `ArrayLeafOf`
 * for what counts as an array here.
 *
 * `P extends string` re-triggers distribution over the `FlatPath<Form>`
 * union so the conditional evaluates per member. Without it the branch
 * reduces against the union as a whole and collapses to `never` as soon
 * as one member fails the predicate.
 */
export type ArrayPath<Form, P extends FlatPath<Form> = FlatPath<Form>> = P extends string
  ? [ArrayLeafOf<Form, P>] extends [never]
    ? never
    : P
  : never

/**
 * Element type of the array addressed by `Path`. Callers constrain
 * `Path extends ArrayPath<Form>`, so this is always well-defined. It
 * rides on `ArrayLeafOf`, the same alias `ArrayPath` admits the path
 * with, so an accepted path never hands its helper a `never` value
 * slot.
 */
export type ArrayItem<Form, Path extends ArrayPath<Form>> =
  ArrayLeafOf<Form, Path> extends ReadonlyArray<infer Item> ? Item : never

/**
 * The record a path actually addresses, nullish stripped, or `never`
 * when the path does not address one. Shared by `RecordPath`
 * (membership) and `RecordValue` (value type).
 *
 * `string extends keyof Leaf` is the index-signature probe: it holds
 * for `Record<string, V>`, whose `keyof` is `string`, and fails for a
 * fixed object, whose `keyof` is a literal key union. The leading array
 * guard keeps arrays, which also satisfy the object check, out of the
 * record set.
 *
 * Nullish is stripped first for the reason `ArrayLeafOf` gives, with an
 * extra bite here: `keyof (Record<string, V> | undefined)` is `never`,
 * so on a `.default({})` or `.optional()` record the probe could not
 * fire at all and `form.record(path)` rejected the path (#541).
 *
 * Reach for `RecordPath` / `RecordValue`; exported for the same `.d.ts`
 * reason as `ArrayLeafOf`.
 */
export type RecordLeafOf<Form, P extends string> =
  Exclude<NestedType<Form, P>, undefined | null> extends infer Leaf
    ? [Leaf] extends [never]
      ? never
      : [Leaf] extends [readonly unknown[]]
        ? never
        : [Leaf] extends [Record<string, unknown>]
          ? string extends keyof Leaf
            ? Leaf
            : never
          : never
    : never

/**
 * Companion to `ArrayPath`: `FlatPath<Form>` narrowed to the paths
 * whose leaf is a record, meaning an object with an open string-keyed
 * index signature such as `z.record(z.string(), V)`. A fixed-shape
 * `z.object({ ... })` is excluded, since its keys are statically known
 * and it has no `string` index signature.
 */
export type RecordPath<Form, P extends FlatPath<Form> = FlatPath<Form>> = P extends string
  ? [RecordLeafOf<Form, P>] extends [never]
    ? never
    : P
  : never

/**
 * Value type of the record addressed by `Path`, the `V` in a
 * `Record<string, V>`. Callers constrain `Path extends
 * RecordPath<Form>`, so the leaf is always an open string-keyed record.
 * It rides on `RecordLeafOf`, the same alias `RecordPath` admits the
 * path with, so the two cannot disagree.
 */
export type RecordValue<Form, Path extends RecordPath<Form>> =
  RecordLeafOf<Form, Path> extends Record<string, infer Value> ? Value : never

/**
 * Widens primitive-literal leaves to their primitive supertype, to
 * match the runtime's slim-primitive write contract.
 *
 *   WriteShape<{ color: 'red' | 'green' }>
 *     // { color: string }
 *   WriteShape<{ count: 42 }>
 *     // { count: number }
 *
 * The runtime write gate accepts any value whose primitive type matches
 * the schema's slim primitive set at that path. Refinement-level
 * constraints (enum membership, literal equality, format checks, length
 * and range bounds, regex, custom predicates) are not enforced at write
 * time; they surface through field-level validation. So
 * `setValue('color', 'magenta')` and `defaultValues: { color: 'teal' }`
 * are not type errors despite being out-of-enum at the validation
 * layer.
 *
 * Tuple positions keep their literal types through the homomorphic
 * mapped form, so `[string, number]` stays a 2-tuple of widened
 * primitives instead of collapsing to `Array<string | number>`, and
 * tuple detection runs before the array branch so positionally-typed
 * literals survive. Date / RegExp / Map / Set / function instances pass
 * through unchanged, since the runtime accepts them as their own slim
 * kinds.
 *
 * This stays STRICT, with no `| Unset` widening, because it types the
 * prev-value argument of `setValue(path, prev => ...)`, which always
 * receives a real value, plus read-side types and internals like
 * `FieldStateMap<T>`. The consumer-facing write-value type is
 * `DefaultValuesShape<T>`, which adds `| Unset` at every recursable
 * position.
 */
export type WriteShape<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends bigint
          ? bigint
          : T extends symbol
            ? symbol
            : T
  : T extends Date | RegExp | Map<unknown, unknown> | Set<unknown> | ((...args: never) => unknown)
    ? T
    : T extends readonly [unknown, ...unknown[]]
      ? { -readonly [K in keyof T]: WriteShape<T[K]> }
      : T extends ReadonlyArray<infer U>
        ? IsTuple<T> extends true
          ? { -readonly [K in keyof T]: WriteShape<T[K]> }
          : Array<WriteShape<U>>
        : T extends object
          ? { [K in keyof T]: WriteShape<T[K]> }
          : T

/**
 * Walk `T` and add `| Unset` at every primitive leaf except symbol,
 * null and undefined, at every opaque leaf (`Date`, `RegExp`, `Map`,
 * `Set`, functions), and at every container position. The recursion
 * topology mirrors `WriteShape<T>`, which is what lets
 * `DefaultValuesShape<T>` be a one-line composition.
 *
 * Symbol / null / undefined leaves pass through untouched, so the
 * runtime sentinel does not pollute leaf semantics it has no business
 * carrying. Container positions widen so a single `unset` at any level
 * recursively marks every descendant primitive blank.
 *
 * Reach for `DefaultValuesShape`; this is not part of the stable
 * surface.
 */
export type AugmentWithUnset<T> = T extends string | number | boolean | bigint
  ? T | Unset
  : T extends symbol | null | undefined
    ? T
    : T extends Date | RegExp | Map<unknown, unknown> | Set<unknown> | ((...args: never) => unknown)
      ? T | Unset
      : T extends readonly [unknown, ...unknown[]]
        ? { -readonly [K in keyof T]: AugmentWithUnset<T[K]> } | Unset
        : T extends ReadonlyArray<infer U>
          ? IsTuple<T> extends true
            ? { -readonly [K in keyof T]: AugmentWithUnset<T[K]> } | Unset
            : Array<AugmentWithUnset<U>> | Unset
          : T extends object
            ? { [K in keyof T]: AugmentWithUnset<T[K]> } | Unset
            : T

/**
 * `WriteShape<T>` plus `Unset`, the brand-typed sentinel that marks a
 * leaf as starting displayed-empty in `defaultValues`, `setValue` and
 * `reset`.
 *
 * `Unset` is admitted at every position: primitive leaves, opaque
 * leaves (`Date`, `RegExp`, `Map`, `Set`, functions), and containers
 * (objects, arrays, tuples, records, discriminated unions, optional and
 * nullable wrappers). A container `unset` recursively marks every
 * primitive descendant blank, so `defaultValues: { profile: unset }`
 * and `setValue('cargo', unset)` typecheck cleanly.
 *
 *   DefaultValuesShape<{ income: number; name: string; age: 21 }>
 *     // { income: number | Unset; name: string | Unset; age: number | Unset } | Unset
 */
export type DefaultValuesShape<T> = AugmentWithUnset<WriteShape<T>>

/**
 * The type accepted at `defaultValues` and at `reset()`'s parameter:
 * `DeepPartial` and `DefaultValuesShape` fused into a single walk, so
 * every level is optional and every position, primitive leaf, opaque
 * leaf or container, admits `| Unset`.
 *
 * The fusion is deliberate and should not be re-split into
 * `DeepPartial<DefaultValuesShape<F>>`. Both passes have identical
 * topology (object to mapped, tuple to positional, array to recurse,
 * primitive to terminal), and walking twice exhausts the depth budget
 * at call sites wiring several complex forms into one scope. One walk
 * also keeps opaque leaves (`Date`, `Map`, `Set`, `RegExp`, functions)
 * intact when their containing property is optional, where
 * `DeepPartial`'s pass would structurally destructure them.
 *
 * ```ts
 * type T = DefaultValuesInput<{
 *   email: string
 *   joinedAt: Date
 *   profile: { name: string; age: number }
 * }>
 * // → {
 * //   email?: string | Unset
 * //   joinedAt?: Date | Unset
 * //   profile?: { name?: string | Unset; age?: number | Unset } | Unset
 * // } | Unset
 * ```
 */
export type DefaultValuesInput<T> = T extends string
  ? string | Unset
  : T extends number
    ? number | Unset
    : T extends boolean
      ? boolean | Unset
      : T extends bigint
        ? bigint | Unset
        : T extends symbol
          ? symbol
          : T extends null | undefined
            ? T
            : T extends
                  | Date
                  | RegExp
                  | Map<unknown, unknown>
                  | Set<unknown>
                  | ((...args: never) => unknown)
              ? T | Unset
              : T extends readonly [unknown, ...unknown[]]
                ? { -readonly [K in keyof T]?: DefaultValuesInput<T[K]> } | Unset
                : T extends ReadonlyArray<infer U>
                  ? IsTuple<T> extends true
                    ? { -readonly [K in keyof T]?: DefaultValuesInput<T[K]> } | Unset
                    : Array<DefaultValuesInput<U>> | Unset
                  : T extends object
                    ? { [K in keyof T]?: DefaultValuesInput<T[K]> } | Unset
                    : T

/**
 * The type accepted at a `useForm` overload's `defaultValues` slot.
 * `Form` is the schema's input projection; `SchemaInput` is the
 * schema's own `z.input<Schema>`. A value is one of:
 *
 *  - `DefaultValuesInput<Form>`, the partial, `Unset`-widened
 *    in-progress shape. `defaultValues` deliberately accepts a form
 *    mid-completion: a leaf may be blank or hold a not-yet-valid value,
 *    so a `z.email()` field accepts any `string`. Sharp, fully
 *    validated types are produced only at `handleSubmit`.
 *  - `SchemaInput`, the schema's full input shape.
 *  - a sync or async factory returning either.
 *
 * The `SchemaInput` arm is redundant at a concrete call site, since a
 * schema's input is always assignable to its own `DefaultValuesInput`,
 * and it does not weaken per-field checking (`number` is still rejected
 * where `string` is expected). It earns its place in the generic
 * form-wrapper case (#422): when the schema is a free type parameter
 * `S`, a forwarded `z.input<S>` is REFLEXIVELY assignable to that arm,
 * a relation TypeScript can decide even under a generic, whereas
 * `DefaultValuesInput<Form>` alone stays a deferred conditional cascade
 * that is not provably assignable and trips TS2589 / TS2769. No runtime
 * effect; the slot only governs what the type checker accepts.
 *
 * `DefaultValuesInput<Form>` is computed ONCE, as the `DVI` argument to
 * `AcceptableDefaultsOf`, rather than inlined in each arm, which would
 * re-instantiate the deep cascade three times per overload and, across
 * the unified entry's two overloads, tip the bundled `.d.ts` into
 * TS2589. The arms stay a DIRECT union rather than a conditional over
 * the cascade, so the `SchemaInput` arm remains reflexively matchable
 * under a generic.
 */
export type AcceptableDefaults<Form, SchemaInput> = AcceptableDefaultsOf<
  DefaultValuesInput<Form>,
  SchemaInput
>
type AcceptableDefaultsOf<DVI, SchemaInput> =
  DVI | SchemaInput | (() => DVI | SchemaInput) | (() => Promise<DVI | SchemaInput>)
