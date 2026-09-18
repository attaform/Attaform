/**
 * Type-level helpers for the unified `attaform/zod` entry. These give
 * tests and other type-query call sites a deterministic projection
 * over an arbitrary v4 OR v3 schema, sidestepping the brittle
 * instantiation-expression resolution rules TypeScript applies to
 * overloaded functions (`typeof useForm<X>` can pick the wrong
 * overload or the impl signature, depending on whether the type
 * argument is a concrete schema, a generic, or a constraint).
 *
 * The helpers dispatch ONCE per use site through a binary conditional,
 * so nothing stacks and nothing amplifies across the return type.
 * Equivalent to `ReturnType<typeof useForm<S>>`, but cache-stable across
 * call patterns.
 *
 * They are test- and internal-facing. Consumer code has no reason to
 * reach for them: the overloaded `useForm` already infers fully at the
 * call site.
 */
import type { z } from 'zod'
import type { z as zV3 } from 'zod-v3'
import type { ZodV4Internals } from './types-zod-major'
import type {
  AbstractSchema,
  FormKey,
  UseFormConfiguration,
  UseFormReturnType,
  ValidateOnConfig,
} from '../../types/types-api'
import type { DefaultValuesInput } from '../../types/types-core'
import type { SupportedRootSchema as SupportedRootSchemaV4 } from '../zod-v4/types-root'
import type { SupportedRootSchema as SupportedRootSchemaV3 } from '../zod-v3/types-root'
import type { V3FormOf, V3OutOf, V3ReadOf, V4FormOf, V4OutOf, V4ReadOf } from './types-projections'

/**
 * Direct V4 projection, with no major dispatch. Use it when the schema's
 * Zod major is statically known, the usual case for a V4 generic helper
 * like `function setup<S extends z.ZodObject>(s: S)`. TS simplifies it
 * cleanly under a generic constraint because no conditional
 * is present.
 */
export type UseFormReturnV4<
  Schema extends z.ZodObject,
  K extends FormKey = FormKey,
> = UseFormReturnType<V4FormOf<Schema>, V4OutOf<Schema>, V4ReadOf<Schema>, K>

/**
 * Direct V4 configuration projection. Mirrors `UseFormReturnV4`.
 */
export type UseFormConfigV4<Schema extends z.ZodObject, K extends FormKey = FormKey> = Omit<
  UseFormConfiguration<
    V4FormOf<Schema>,
    V4OutOf<Schema>,
    AbstractSchema<V4FormOf<Schema>, V4OutOf<Schema>>,
    DefaultValuesInput<V4FormOf<Schema>>,
    K
  >,
  'schema' | 'validateOn' | 'debounceMs'
> & { schema: Schema } & ValidateOnConfig

/**
 * Direct V3 projection, with no major dispatch. Use it when the schema's
 * Zod major is statically known.
 */
export type UseFormReturnV3<
  Schema extends zV3.ZodObject<zV3.ZodRawShape>,
  K extends FormKey = FormKey,
> = UseFormReturnType<V3FormOf<Schema>, V3OutOf<Schema>, V3ReadOf<Schema>, K>

/**
 * Direct V3 configuration projection. Mirrors `UseFormReturnV3`.
 */
export type UseFormConfigV3<
  Schema extends zV3.ZodObject<zV3.ZodRawShape>,
  K extends FormKey = FormKey,
> = Omit<
  UseFormConfiguration<
    V3FormOf<Schema>,
    V3OutOf<Schema>,
    AbstractSchema<V3FormOf<Schema>, V3OutOf<Schema>>,
    DefaultValuesInput<V3FormOf<Schema>>,
    K
  >,
  'schema' | 'validateOn' | 'debounceMs'
> & { schema: Schema } & ValidateOnConfig

/**
 * The return shape of `useForm` for a given Zod schema. Dispatches
 * once on the schema's major version and projects to the matching
 * adapter's `Form` / `Out` / `Read` slots. The dispatch matches the
 * full `SupportedRootSchema` per major, so an object, record, or
 * discriminated-union root all resolve here exactly as the runtime
 * `useForm` overloads accept them.
 *
 * Replaces `ReturnType<typeof useForm<Schema, K>>` in test code holding
 * concrete schemas. In a generic helper, `<S extends z.ZodObject>`, reach
 * for `UseFormReturnV4<S>` instead: TS does not simplify a conditional
 * under a generic constraint, so this helper's dispatch stays deferred
 * and return-type compatibility cannot be proven.
 */
export type UseFormReturn<
  Schema,
  K extends FormKey = FormKey,
> = Schema extends SupportedRootSchemaV4 & ZodV4Internals
  ? UseFormReturnType<V4FormOf<Schema>, V4OutOf<Schema>, V4ReadOf<Schema>, K>
  : Schema extends SupportedRootSchemaV3
    ? UseFormReturnType<V3FormOf<Schema>, V3OutOf<Schema>, V3ReadOf<Schema>, K>
    : never

/**
 * The configuration parameter shape of `useForm` for a given Zod
 * schema. Same dispatch as `UseFormReturn`; it replaces
 * `Parameters<typeof useForm<Schema, K>>[0]` in test code.
 */
export type UseFormConfig<
  Schema,
  K extends FormKey = FormKey,
> = Schema extends SupportedRootSchemaV4 & ZodV4Internals
  ? Omit<
      UseFormConfiguration<
        V4FormOf<Schema>,
        V4OutOf<Schema>,
        AbstractSchema<V4FormOf<Schema>, V4OutOf<Schema>>,
        DefaultValuesInput<V4FormOf<Schema>>,
        K
      >,
      'schema' | 'validateOn' | 'debounceMs'
    > & { schema: Schema } & ValidateOnConfig
  : Schema extends SupportedRootSchemaV3
    ? Omit<
        UseFormConfiguration<
          V3FormOf<Schema>,
          V3OutOf<Schema>,
          AbstractSchema<V3FormOf<Schema>, V3OutOf<Schema>>,
          DefaultValuesInput<V3FormOf<Schema>>,
          K
        >,
        'schema' | 'validateOn' | 'debounceMs'
      > & { schema: Schema } & ValidateOnConfig
    : never
