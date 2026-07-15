---
title: AbstractSchema
description: The schema-agnostic contract the core consumes, 12 required methods plus 2 optional hooks covering identity, defaults, shape, and validation. Implement it to wire any schema library into Attaform.
metaRows:
  - label: Category
    value: Reference
  - label: Contract
    value: AbstractSchema<Form, GetValue>
    kind: code
  - label: Required methods
    value: 12
  - label: Optional hooks
    value: 2 (getFieldMetaAtPath, needsAsyncValidation)
---

# AbstractSchema

> Attaform is schema-agnostic at the core. Wire any schema library (Valibot, ArkType, Effect-Schema, a hand-rolled validator) into the runtime by implementing the `AbstractSchema` contract.

::docs-meta-table
::

This page is the contract reference. The Zod adapters under `attaform/zod` and `attaform/zod-v3` are reference implementations; read their source when you need a concrete example of any of the methods below.

## The contract

```ts
type AbstractSchema<Form, GetValueFormType = Form> = {
  // Identity
  fingerprint(): string

  // Defaults
  getDefaultValues(config): DefaultValuesResponse<Form>
  getDefaultAtPath(path: Path): unknown

  // Shape introspection
  arrayShapeAtPath(path: Path): number | null | undefined
  isLeafAtPath(path: Path): boolean
  isRequiredAtPath(path: Path): boolean
  getSchemasAtPath(path: Path): AbstractSchema<unknown, GetValueFormType>[]
  getSlimPrimitiveTypesAtPath(path: Path): Set<SlimPrimitiveKind>
  getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined

  // Validation
  validateAtPath(
    data: unknown,
    path: Path | undefined,
    options?: ValidateOptions
  ): MaybePromise<ValidationResponse<Form>>

  // Optional hooks
  getFieldMetaAtPath?(path: Path): ResolvedFieldMeta
  needsAsyncValidation?(): boolean
}
```

Twelve required methods. Two optional hooks. The runtime fills in sensible fallbacks for the optional hooks, so omit them when your library doesn't model the feature.

## Identity

### `fingerprint()`

Structural signature of the schema. Two schemas with the same shape return the same string; different shapes return different strings. Used to:

- Catch shared-key mismatches in dev (two `useForm({ key: 'x' })` calls with different schemas warn).
- Key persisted drafts so schema changes auto-invalidate stale drafts.

Must NOT throw. If it does, Attaform catches the exception, logs it via `console.error` in dev, and skips the shared-key mismatch check for that call. An opaque stable string (`'custom-adapter:v1'`) is a valid fallback; opaque fingerprints disable schema-change auto-invalidation for persisted drafts (the key never changes), so prefer a real structural hash if your library exposes the metadata.

## Defaults

### `getDefaultValues(config): DefaultValuesResponse<Form>`

Returns `{ data, errors, success, formKey }`. Called at form creation and on `reset()`. The `config` argument carries `useDefaultSchemaValues`, `constraints`, and `strict` flags.

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

## Shape introspection

### `arrayShapeAtPath(path: Path): number | null | undefined`

- `number`: tuple's fixed length.
- `null`: unbounded array.
- `undefined`: non-array path.

The runtime caches the answer to skip per-write probe loops on array writes.

### `isLeafAtPath(path: Path): boolean`

`true` for primitive paths, `false` for object / array / map / set containers. Drives the proxy's descend-vs-terminate decision; reserved leaf-prop names (`dirty`, `errors`, `valid`, `label`, …) inject only at the FieldState terminal.

### `isRequiredAtPath(path: Path): boolean`

`true` when the leaf is required (no `.optional()` / `.nullable()` / `.default()` / `.catch()` wrapper around it). Used by the blank validation augmentation to raise `'No value supplied'` for unfilled required fields.

### `getSchemasAtPath(path: Path): AbstractSchema[]`

List of candidate sub-schemas at `path`. Multiple results are expected for discriminated-union branches. `path` is a canonical `Segment[]`. Return `[]` if your library doesn't model union-style multi-candidates.

### `getSlimPrimitiveTypesAtPath(path: Path): Set<SlimPrimitiveKind>`

Set of primitive `typeof`-style kinds the path's leaf accepts at write time (`'string'`, `'number'`, `'boolean'`, `'bigint'`, …). Drives the slim-primitive write gate. Return a permissive fallback (`new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'date', 'undefined', 'null'])`) for paths the schema doesn't declare; over-rejecting writes breaks dynamic / SSR rehydration.

### `getUnionDiscriminatorAtPath(path: Path): UnionDiscriminatorContext | undefined`

For discriminated-union containers, return `{ discriminatorKey, getVariantDefault }`. Used by the variant-reshape pipeline so a discriminator-key write swaps the active branch without leaking old keys. Return `undefined` if your library doesn't model DUs.

## Validation

### `validateAtPath(data, path?, options?): MaybePromise<ValidationResponse>`

Returns `MaybePromise<ValidationResponse>`. `path` is a `Segment[]` or `undefined` (whole-form validation). Honor `options.sync` when the schema is sync-capable; the runtime uses it to batch error writes inside DU variant reshape.

Must NOT throw. Return `{ success: false, errors }` for validation failures.

## Optional hooks

### `getFieldMetaAtPath(path: Path): ResolvedFieldMeta` _(optional)_

Resolves schema-attached metadata (label, description, placeholder, full payload). Drives `form.fields(p).label` / `.description` / `.placeholder` / `.meta`. Omit if your library doesn't model metadata yet, and consumers see humanized fallbacks.

### `needsAsyncValidation(): boolean` _(optional)_

Return `true` if `validateAtPath` may need a Promise to surface every error this schema can produce. The runtime uses this to decide whether to schedule a one-shot construction-time async pass.

## A minimal Valibot-ish adapter

Assume your library exposes:

- `schema.defaultValues()` returning the schema's typed defaults.
- `schema.parse(data)` returning `{ success: true, data }` or `{ success: false, issues: { path: string[]; message: string }[] }`.

```ts
import type {
  AbstractSchema,
  DefaultValuesResponse,
  GenericForm,
  SlimPrimitiveKind,
  ValidationError,
  ValidationResponse,
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
    fingerprint() {
      return schema.signature?.() ?? 'my-lib:v1'
    },

    getDefaultValues({ constraints }): DefaultValuesResponse<F> {
      const defaults = schema.defaultValues()
      const merged = mergeDeepPartial(defaults, constraints)
      return { data: merged, errors: undefined, success: true, formKey: '' }
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
        return { success: true, data: result.data, errors: [], formKey: '' }
      }

      const errors: ValidationError[] = result.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: `my-lib:${issue.code ?? 'unknown'}`,
        formKey: '',
      }))

      return { success: false, errors, data: undefined, formKey: '' }
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
