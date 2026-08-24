---
title: Types reference
description: Every public type Attaform exports, grouped by purpose. Inference flows from useForm; consumers rarely need to reach for these directly, but they're documented for advanced wiring.
metaRows:
  - label: Category
    value: Reference
  - label: Doctrine
    value: inference-first; types exposed but rarely needed
  - label: Source
    value: src/runtime/types/types-api.ts + types-core.ts
    kind: code
---

# Types reference

> Every public type Attaform exports, grouped by purpose. Inference handles the common cases; these are for advanced wiring (custom adapters, deeply nested generic helpers, type-safe consumer libraries).

::docs-meta-table
::

This page is reference material, alphabetical-ish by purpose. Most consumers never reach for these directly; the [Inference-first DX](/docs/schemas/contract) doctrine means `useForm` + a schema gives you autocomplete on every reactive surface without naming the types.

## Form configuration

| Type                                | Source                  | Purpose                                                                                    |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `UseFormConfiguration<Form>`        | runtime/types/types-api | The options bag passed to `useForm`.                                                       |
| `UseFormReturnType<Form, GetValue>` | runtime/types/types-api | The whole reactive return: values, fields, errors, meta, methods.                          |
| `AttaformPluginOptions`             | runtime/core/plugin     | Options for `createAttaform({ defaults, devtools })`.                                      |
| `AttaformDefaults`                  | runtime/types/types-api | The fields settable via `createAttaform({ defaults })`.                                    |
| `HistoryPlugin`                     | runtime/types/types-api | What `historyPlugin()` from `attaform/history` returns; passed via `useForm({ history })`. |
| `OnInvalidSubmitPolicy`             | runtime/types/types-api | `'none'` \| `'focus-first-error'` \| `'scroll-to-first-error'` \| `'both'`.                |
| `ValidateOn` / `ValidateOnConfig`   | runtime/types/types-api | `validateOn` field and its discriminated config.                                           |
| `DisplayState` / `GetDisplayState`  | runtime/types/types-api | The display-state verdict (`idle` \| `pending` \| `error` \| `success`) and its resolver.  |

## Reactive surfaces

| Type                            | Source                  | Purpose                                                   |
| ------------------------------- | ----------------------- | --------------------------------------------------------- |
| `FieldState<Value>`             | runtime/types/types-api | The 31-property per-leaf reactive bundle.                 |
| `FieldStateMap<Form>` / `Entry` | runtime/types/types-api | The proxy shape exposing `form.fields`.                   |
| `FormMeta<Form>`                | runtime/types/types-api | Form-level aggregates over every field's state.           |
| `FormErrorsSurface<Form>`       | runtime/types/types-api | The proxy shape exposing `form.errors`.                   |
| `FormErrorRecord`               | runtime/types/types-api | The per-path error array shape.                           |
| `ErrorsProxyShape<Form>`        | runtime/types/types-api | Type-level view of the errors proxy for advanced helpers. |
| `WriteMeta`                     | runtime/types/types-api | Metadata attached to a mutation (source, batch flags).    |

## Validation

| Type                                                  | Source                  | Purpose                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationError`                                     | runtime/types/types-api | The error shape (`{ path, message, code, data? }`). Form identity lives on the response envelope, not per entry.                                                       |
| `ErrorInput`                                          | runtime/types/types-api | What `form.setErrors` accepts: an `Error` or `{ message?, path?, code?, data? }`. Foreign fields are stripped during normalization, so `ValidationError` is a subtype. |
| `Json`                                                | runtime/types/types-api | JSON-serialisable value; the type of the optional `data` payload.                                                                                                      |
| `ValidationResponse<Form>`                            | runtime/types/types-api | Discriminated success-or-failure validation result with parsed data.                                                                                                   |
| `ValidationResponseWithoutValue<Form>`                | runtime/types/types-api | Same shape minus the `data` payload (the settled half of `validate()`'s status).                                                                                       |
| `ParseOptions`                                        | runtime/types/types-api | Options bag for `form.parse`; `commit: true` writes the verdict to the error store and cancels in-flight field runs.                                                   |
| `ReactiveValidationStatus<Form>`                      | runtime/types/types-api | Discriminated pending-vs-settled reactive validation status.                                                                                                           |
| `PendingValidationStatus` / `SettledValidationStatus` | runtime/types/types-api | The two branches of `ReactiveValidationStatus`.                                                                                                                        |
| `HandleSubmit` / `OnSubmit` / `OnError`               | runtime/types/types-api | The `handleSubmit` callback signatures.                                                                                                                                |
| `SubmitHandler<Form>`                                 | runtime/types/types-api | Generic handler type for typed user submit functions.                                                                                                                  |

## Schema contract

| Type                             | Source                  | Purpose                                                          |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `AbstractSchema<Form, GetValue>` | runtime/types/types-api | The 12-method + 2-optional contract custom adapters implement.   |
| `DefaultValuesResponse<Form>`    | runtime/types/types-api | What `getDefaultValues` returns.                                 |
| `SlimPrimitiveKind`              | runtime/types/types-api | `'string'` \| `'number'` \| … (typeof-style kinds).              |
| `SlimRuntimeOf<T>`               | runtime/types/types-api | Type-level helper to compute the slim primitive set for a type.  |
| `FieldMetaPayload`               | runtime/types/types-api | Schema-attached metadata: label, description, placeholder, meta. |

## Path types

| Type                           | Source                   | Purpose                                                  |
| ------------------------------ | ------------------------ | -------------------------------------------------------- |
| `FlatPath<Form>`               | runtime/types/types-core | Every reachable dotted path through the form.            |
| `PartialFlatPath<Form>`        | runtime/types/types-core | Same but allowing partial-prefix paths.                  |
| `ArrayPath<Form>`              | runtime/types/types-core | Every reachable path whose value is an array.            |
| `JoinSegments<Segments>`       | runtime/types/types-core | Type-level join of a segment tuple into a dotted string. |
| `Path` / `PathKey` / `Segment` | runtime/core/paths       | Canonicalized runtime path representation.               |

## Shape helpers

| Type                                                              | Source                   | Purpose                                                          |
| ----------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `GenericForm`                                                     | runtime/types/types-core | The most-permissive form shape; used in generics that constrain. |
| `DeepPartial<T>`                                                  | runtime/types/types-core | Every leaf made optional, recursively.                           |
| `DefaultValuesInput<Schema>` / `DefaultValuesShape<Form>`         | runtime/types/types-core | The `defaultValues` argument shape vs. the resolved tree.        |
| `WriteShape<Schema>`                                              | runtime/types/types-core | The shape `setValue` accepts (`z.input`-equivalent).             |
| `NestedReadType<T, P>` / `NestedType<T, P>`                       | runtime/types/types-core | Walk a type to the value at a path.                              |
| `LiftedValueShape<T>`                                             | runtime/types/types-core | Helper for variant-memory and discriminated-union plumbing.      |
| `ArrayItem<T>`                                                    | runtime/types/types-core | Element type of an array.                                        |
| `IsTuple<T>` / `IsUnion<T>` / `KeyofUnion<T>` / `ValueOfUnion<T>` | runtime/types/types-core | Type-level predicates and unions over generic values.            |
| `Primitive`                                                       | runtime/types/types-core | The base primitive set.                                          |

## Binding

| Type                                              | Source                           | Purpose                                                          |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `RegisterDirective`                               | runtime/types/types-api          | The `v-register` directive type.                                 |
| `RegisterValue` / `RegisterOptions`               | runtime/types/types-api          | The value the directive accepts; the per-register options shape. |
| `RegisterFlatPath<Form>`                          | runtime/types/types-api          | Paths bindable through `register`.                               |
| `RegisterTextModifier` / `RegisterSelectModifier` | runtime/types/types-api          | The `.lazy` / `.trim` / `.number` modifier types.                |
| `RegisterTransform<V>`                            | runtime/types/types-api          | Custom DOM ↔ value transform shape.                              |
| `CustomDirectiveRegisterAssignerFn`               | runtime/types/types-api          | The `assignKey` custom-assigner signature.                       |
| `UseRegisterReturn<V>`                            | runtime/composables/use-register | What `useRegister<V>()` returns.                                 |

## Set / mutate

| Type                     | Source                  | Purpose                                                      |
| ------------------------ | ----------------------- | ------------------------------------------------------------ |
| `SetValuePayload<Form>`  | runtime/types/types-api | Whole-form merge payload shape.                              |
| `SetValueCallback<Form>` | runtime/types/types-api | The `(prev) => next` callback signature.                     |
| `MetaTrackerValue`       | runtime/types/types-api | Internal "I'm mutating" flag exposed for advanced consumers. |
| `Unset`                  | runtime/core/unset      | The `unset` sentinel's brand type.                           |

## SSR payload

| Type                      | Source                 | Purpose                         |
| ------------------------- | ---------------------- | ------------------------------- |
| `SerializedAttaformState` | runtime/core/serialize | The SSR payload shape.          |
| `SerializedFormData`      | runtime/core/registry  | Single form's serialized state. |

## Wizard

| Type                                         | Source                     | Purpose                                                 |
| -------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| `UseWizardReturnType<Forms>`                 | runtime/types/types-wizard | The whole wizard return: current, statuses, navigation. |
| `WizardOptions<Forms>`                       | runtime/types/types-wizard | The options bag.                                        |
| `AnyForm` / `FormKeyOf<F>` / `KeysOf<Forms>` | runtime/types/types-wizard | Helpers for typing forms passed to `useWizard`.         |
| `WizardNavOptions`                           | runtime/types/types-wizard | Options forwarded to `next` / `back` / `goTo`.          |

## DevTools

| Type                     | Source                       | Purpose                                               |
| ------------------------ | ---------------------------- | ----------------------------------------------------- |
| `AttaformDevtoolsBridge` | runtime/core/devtools-shared | The window-bridge contract the Nuxt overlay consumes. |

## Coercion

| Type                                                    | Source                  | Purpose                            |
| ------------------------------------------------------- | ----------------------- | ---------------------------------- |
| `CoercionEntry` / `CoercionRegistry` / `CoercionResult` | runtime/types/types-api | The schema-driven coercion shapes. |

## Internal-only (not for direct consumption)

These types ride on internal helpers and are exported for advanced custom-adapter authors. The [Inference-first DX](/docs/schemas/contract) doctrine means everyday consumers never need them:

- `StorageLeaf` / `StorageShape`: the slim-write-shape internal representations the runtime walks.
- `PartialFlatPath<Form>`: used by the path-prefix matchers inside the runtime.
- `LiftedValueShape<T>`: variant-memory plumbing.

Treat them as appendix items: stable enough to reference, but the public-facing surfaces (`UseFormReturnType`, `FieldState`, `ValidationError`) are what consumer code should depend on.

## Where to next

- [The schema contract](/docs/schemas/contract): the high-level model these types implement.
- [`AbstractSchema`](/docs/schemas/abstract-schema): when you need the contract for a non-Zod schema library.
- [Entry-point reference](/docs/reference/entry-points): which subpath each type ships from.
