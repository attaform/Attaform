---
title: AbstractSchema
description: The schema-agnostic contract the core consumes, 14 required methods plus 4 optional hooks covering defaults, shape, and validation. Implement it to wire any schema library into Attaform.
metaRows:
  - label: Category
    value: Reference
  - label: Contract
    value: AbstractSchema<Form, GetValue>
    kind: code
  - label: Required methods
    value: 15
  - label: Optional hooks
    value: 4 (metadata, async, container-refine, unions)
---

# AbstractSchema

> Attaform is schema-agnostic at the core. Wire any schema library (Valibot, ArkType, Effect-Schema, a hand-rolled validator) into the runtime by implementing the `AbstractSchema` contract.

::docs-meta-table
::

This page is the contract reference. The Zod adapters under `attaform/zod` and `attaform/zod-v3` are reference implementations; read their source when you need a concrete example of any of the methods below.

## The contract

```ts
type AbstractSchema<Form, GetValueFormType = Form> = {
  // Defaults
  getDefaultValues(config): SchemaDefaultsResult<Form>
  getDefaultAtPath(path: Path): unknown
  getEmptyValueAtPath(path: Path): unknown

  // Shape introspection
  arrayShapeAtPath(path: Path): number | null
  isLeafAtPath(path: Path): boolean
  isOpaqueLeafAtPath(path: Path): boolean
  isPreprocessOrCoerceLeaf(path: Path): boolean
  isRequiredAtPath(path: Path): boolean
  isFixedObjectAtPath(path: Path): boolean
  entryKeyKindAtPath(path: Path): 'string' | 'number' | undefined
  getSchemasAtPath(path: Path): AbstractSchema<unknown, GetValueFormType>[]
  getSlimPrimitiveTypesAtPath(path: Path): Set<SlimPrimitiveKind>
  getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined

  // Validation
  validateAtPath(
    data: unknown,
    path: Path | undefined,
    options?: ValidateOptions
  ): MaybePromise<SchemaParseResult<Form>>

  // Optional hooks
  getFieldMetaAtPath?(path: Path): ResolvedFieldMeta
  needsAsyncValidation?(): boolean
  hasContainerOrRootRefine?(): boolean
  hasDiscriminatedUnions?(): boolean
}
```

Fourteen required methods. Four optional hooks. The runtime fills in sensible fallbacks for the optional hooks, so omit them when your library doesn't model the feature.

## Defaults

### `getDefaultValues(config): SchemaDefaultsResult<Form>`

Returns `{ data, errors, success }`. Called at form creation and on `reset()`. The `config` argument carries `useDefaultSchemaValues` and `constraints`.

### `getDefaultAtPath(path: Path): unknown`

Returns the schema-prescribed default at a structured path. The runtime calls this on every `setValue` to fill structural gaps:

- Empty path → whole-form default.
- Object property → property's default.
- Array index → element default.
- Tuple position → position's default.
- Optional / nullable around a structural inner → inner default.
- Optional / nullable around a primitive → `undefined` / `null` (preserve the wrapper's semantic).
- `.default(x)` wrapper → `x`.

Return `undefined` for paths that don't exist in the schema. Must NOT throw; the runtime skips filling on `undefined`.

### `getEmptyValueAtPath(path: Path): unknown`

The "clear this field" value, and the reason `form.clear(path)` differs from `form.reset()`: this one **ignores** declared defaults. A `.default(x)` / `.prefault(x)` / `.catch(x)` wrapper resolves to the inner schema's empty rather than to `x`.

- Primitive leaf → the type's falsy concrete (`''`, `0`, `false`, `0n`, epoch).
- Array / set / record → empty.
- Object → recursive: every property gets its own empty.
- `.optional()` → `undefined`; `.nullable()` → `null` (each wrapper's own marker).
- Discriminated union → the first variant's recursive empty.
- A path the schema doesn't declare → `undefined`, which callers read as "don't write" and leave storage alone.

## Shape introspection

### `arrayShapeAtPath(path: Path): number | null`

- `number`: tuple's fixed length. The runtime pads array writes to this length with per-position defaults.
- `null`: not a tuple. Covers unbounded arrays (the runtime follows the consumer's length and reuses one element default) and paths that don't resolve to an array at all.

The answer is definitive: the runtime consults it on every structural write that descends into an array branch and never second-guesses it, so returning `null` for a real tuple silently loses the per-position padding.

### `isLeafAtPath(path: Path): boolean`

`true` for primitive paths, `false` for object / array / map / set containers. Drives the proxy's descend-vs-terminate decision; reserved leaf-prop names (`dirty`, `errors`, `valid`, `label`, …) inject only at the FieldState terminal.

### `isOpaqueLeafAtPath(path: Path): boolean`

`true` when the schema declares a value at `path` without describing its shape, the way Zod's `any` / `unknown` / `custom` do. The write gate then accepts the value whole rather than walking into it to check sub-paths the schema never declared, which is what lets a consumer store a `File`, a `Map`, or any class instance at a leaf. Return `false` throughout if every leaf in your library has a known shape.

### `isPreprocessOrCoerceLeaf(path: Path): boolean`

`true` where a schema-side normalizer sits between the consumer's write and the parse: Zod's `z.preprocess(fn, inner)` and `z.coerce.X()`. The slim-primitive write gate then accepts the raw value verbatim and stops walking children, so storage holds the user's input and the normalizer fires inside `safeParse` instead. That is the mechanism behind [How values are stored](/docs/schemas/storage-shape).

The semantic is path-prefix, not leaf-only: return `true` if **any** ancestor of `path` resolves to such a wrapper, so descendants under a preprocess-wrapped container short-circuit the gate too. Return `false` throughout if your library has no such construct.

### `isRequiredAtPath(path: Path): boolean`

`true` when the leaf is required (no `.optional()` / `.nullable()` / `.default()` / `.catch()` wrapper around it). Used by the blank validation augmentation to raise `'No value supplied'` for unfilled required fields.

### `isFixedObjectAtPath(path: Path): boolean`

`true` only for a closed object with declared keys. Open containers (records, unions) return `false`, and the proxy then falls back to the keys the data currently holds, so a genuinely-absent key (an out-of-bounds index, a missing record key, an inactive variant's key) reads `undefined` rather than resolving a phantom node.

The empty path (the form root) is always a fixed object. Peel transparent wrappers before deciding, so `z.object({...}).optional()` still reports `true`. A path you don't declare reports `false`.

### `entryKeyKindAtPath(path: Path): 'string' | 'number' | undefined`

How the container at `path` spells its own entry keys: `'number'` for a sequence, `'string'` for an object or a record, and for a map whatever its declared key type accepts. `undefined` for a leaf, for an undeclared path, and for any container whose entries a path segment cannot name.

The write walkers consult it when a write has to **create** an entry, which is where a map needs the ruling: a path segment alone cannot say whether `scores.42` means the string `'42'` or the number `42`, and picking wrong fails the map's own parse. An entry the map already holds needs no ruling, since its existing key wins. A map keyed by something no segment can spell reports `undefined` and stays one whole value.

### `getSchemasAtPath(path: Path): AbstractSchema[]`

List of candidate sub-schemas at `path`. Multiple results are expected for discriminated-union branches. `path` is a canonical `Segment[]`. Return `[]` if your library doesn't model union-style multi-candidates.

### `getSlimPrimitiveTypesAtPath(path: Path): Set<SlimPrimitiveKind>`

Set of primitive `typeof`-style kinds the path's leaf accepts at write time (`'string'`, `'number'`, `'boolean'`, `'bigint'`, …). Drives the slim-primitive write gate. Return a permissive fallback (`new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'date', 'undefined', 'null'])`) for paths the schema doesn't declare; over-rejecting writes breaks dynamic / SSR rehydration.

### `getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined`

For discriminated-union containers, return `{ discriminatorKey, getVariantDefault }`. Used by the variant-reshape pipeline so a discriminator-key write swaps the active branch without leaking old keys. Return `undefined` if your library doesn't model DUs.

## Validation

### `validateAtPath(data, path?, options?): MaybePromise<SchemaParseResult>`

Returns `MaybePromise<SchemaParseResult>`. `path` is a `Segment[]` or `undefined` (whole-form validation). Honor `options.sync` when the schema is sync-capable; the runtime uses it to batch error writes inside DU variant reshape.

An `AbstractSchema` never names a form. One instance is shared by every form built on the same schema, and the owning store stamps its own `formKey` onto the verdict on the way out, which is why nothing you return here carries one.

Must NOT throw. Return `{ success: false, errors }` for validation failures.

## Optional hooks

### `getFieldMetaAtPath(path: Path): ResolvedFieldMeta` _(optional)_

Resolves schema-attached metadata (label, description, placeholder, full payload). Drives `form.fields(p).label` / `.description` / `.placeholder` / `.meta`. Omit if your library doesn't model metadata yet, and consumers see humanized fallbacks.

### `needsAsyncValidation(): boolean` _(optional)_

Return `true` if `validateAtPath` may need a Promise to surface every error this schema can produce. The runtime uses this to decide whether to schedule a one-shot construction-time async pass.

### `hasContainerOrRootRefine(): boolean` _(optional)_

`true` when the schema holds a refinement above leaf level: a cross-field equality, a sum constraint, anything whose verdict a leaf write could move. The runtime uses it to decide whether a leaf write needs a whole-form pass or can validate the leaf alone, so it buys a scoped validation instead of a full one.

Omitting it is treated as `() => true`, the conservative whole-form answer, which is why it is optional. Bias toward `true` when in doubt: a false `true` costs a little work, and a false `false` lets an ancestor verdict go stale, which is a wrong answer rather than a slow one.

### `hasDiscriminatedUnions(): boolean` _(optional)_

`true` when the schema tree holds at least one discriminated union at any depth, arrays, tuples, records, and lazy schemas included. The store reads it once at construction: `false` lets every write skip the cross-variant ancestor guard and the variant-reshape dispatch entirely.

Omitting it is treated as "contains unions", so the conservative per-write probes stay on. Never return `false` for a schema that does hold one, which would disable variant reshape for the whole form.

## A minimal Valibot-ish adapter

Assume your library exposes:

- `schema.defaultValues()` returning the schema's typed defaults.
- `schema.parse(data)` returning `{ success: true, data }` or `{ success: false, issues: { path: string[]; message: string }[] }`.

```ts
import type {
  AbstractSchema,
  GenericForm,
  SchemaDefaultsResult,
  SlimPrimitiveKind,
  ValidationError,
} from 'attaform/abstract'

const PERMISSIVE: ReadonlySet<SlimPrimitiveKind> = new Set<SlimPrimitiveKind>([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'date',
  'undefined',
  'null',
])

export function myLibAdapter<F extends GenericForm>(schema: MyLibSchema<F>): AbstractSchema<F, F> {
  return {
    getDefaultValues({ constraints }): SchemaDefaultsResult<F> {
      const defaults = schema.defaultValues()
      const merged = mergeDeepPartial(defaults, constraints)
      return { data: merged, errors: undefined, success: true }
    },

    getDefaultAtPath(path) {
      return walkSchemaToDefault(schema, path)
    },

    arrayShapeAtPath(path) {
      return walkSchemaToArrayShape(schema, path)
    },

    isLeafAtPath(path) {
      const kinds = walkSchemaToSlimPrimitives(schema, path)
      if (kinds === undefined) return false
      return ![...kinds].some((k) => k === 'object' || k === 'array' || k === 'map' || k === 'set')
    },

    isRequiredAtPath(path) {
      const leaf = walkSchemaToLeaf(schema, path)
      return leaf?.isRequired ?? false
    },

    getEmptyValueAtPath(path) {
      // The "clear this field" value. Whatever your library treats as
      // the leaf's blank state; `undefined` is always safe.
      return walkSchemaToDefault(schema, path)
    },

    isFixedObjectAtPath(path) {
      // True only for closed, declared-key object shapes. Open
      // containers (records, unions) return false so the runtime
      // falls back to live keys.
      const kinds = walkSchemaToSlimPrimitives(schema, path)
      return kinds !== undefined && kinds.has('object')
    },

    entryKeyKindAtPath(path) {
      // How the container here spells its own entry keys, for a write
      // that has to create one: `'number'` for a sequence, `'string'`
      // for a keyed container. `undefined` for a leaf, for a path you
      // don't declare, and for any container whose entries a path
      // segment cannot name.
      const kinds = walkSchemaToSlimPrimitives(schema, path)
      if (kinds === undefined) return undefined
      if (kinds.has('array')) return 'number'
      return kinds.has('object') ? 'string' : undefined
    },

    isPreprocessOrCoerceLeaf() {
      // True where a schema-side input normalizer (a coercing or
      // preprocessing node) should accept raw writes verbatim. Return
      // false if your library has no such construct.
      return false
    },

    isOpaqueLeafAtPath() {
      // True where the schema declares a value without describing its
      // shape (Zod's `any` / `unknown` / `custom`). The write gate then
      // accepts the value whole instead of walking into it looking for
      // sub-paths the schema never declared. Return false if every leaf
      // in your library has a known shape.
      return false
    },

    getSchemasAtPath() {
      return []
    },

    getSlimPrimitiveTypesAtPath(path) {
      return walkSchemaToSlimPrimitives(schema, path) ?? PERMISSIVE
    },

    getUnionDiscriminatorAtPath() {
      return undefined
    },

    validateAtPath(data, path) {
      const result = path !== undefined ? schema.parseAtPath(data, path) : schema.parse(data)

      if (result.success) {
        return { success: true, data: result.data, errors: undefined }
      }

      const errors: ValidationError[] = result.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: `my-lib:${issue.code ?? 'unknown'}`,
      }))

      return { success: false, errors, data: undefined }
    },
  }
}
```

Wire your adapter through `useAbstractForm`:

```ts
import { useAbstractForm } from 'attaform/abstract'
import { myLibAdapter } from './my-adapter'

const form = useAbstractForm({ schema: myLibAdapter(mySchema) })
```

## Zod-v3 vs. Zod-v4: an introspection asymmetry

Worth knowing if you're studying the reference implementations: the v4 adapter exports `kindOf`, `ZodKind`, and `assertZodVersion` for runtime introspection of Zod nodes; the v3 adapter exports `isZodSchemaType` but not the broader set. Both adapters implement the full `AbstractSchema` contract; the difference is in the consumer-facing diagnostic helpers above the contract surface. If you're forking a Zod adapter as a starting point, the v4 source is the richer reference; the v3 source is the leaner one.

## Where to next

- [The schema contract](/docs/schemas/contract): the high-level mental model `AbstractSchema` implements.
- [Types reference](/docs/reference/types): every type the contract references.
- [Entry-point reference](/docs/reference/entry-points): which subpath ships `AbstractSchema` (`attaform/abstract`).
