/**
 * Zod v4 adapter entry point. Re-exports the adapter + the useForm
 * wrapper that threads zod-v4-specific schema types through
 * useAbstractForm.
 */
import type { z } from 'zod'
import { useAbstractForm } from '../../composables/use-abstract-form'
import { InvalidUseFormConfigError } from '../../core/errors'
import type {
  AbstractSchema,
  FormKey,
  ValidateOnConfig,
  UseFormReturnType,
  UseFormConfiguration,
  SchemaFactoryOptions,
} from '../../types/types-api'
import type { AcceptableDefaults, FlatPath, GenericForm, NestedType } from '../../types/types-core'
import { zodV4Adapter } from './adapter'
import type { StorageShape } from './types-storage-shape'
import type { SupportedRootSchema } from './types-root'

export { zodV4Adapter as zodAdapter } from './adapter'
export { assertZodVersion, kindOf } from './introspect'
export type { ZodKind } from './introspect'
export type { StorageLeaf, StorageShape } from './types-storage-shape'

/**
 * What `setValue` and `defaultValues` accept at `Path`: the schema's
 * `z.input<Schema>` shape there. It matches what `form.values.X` returns
 * at runtime, storage holding the honest input view until transforms
 * run.
 *
 * ```ts
 * const schema = z.object({
 *   flag: z.string().transform((v) => v.length > 10),
 * })
 * type FlagWriteIn = PathInput<typeof schema, 'flag'> // string
 * ```
 */
export type PathInput<Schema extends z.ZodType, Path extends string> =
  z.input<Schema> extends GenericForm
    ? Path extends FlatPath<z.input<Schema>>
      ? NestedType<z.input<Schema>, Path>
      : never
    : never

/**
 * What `Path` holds after the full parse pipeline: the schema's
 * `z.output<Schema>` shape there. It matches `form.parse()`'s `data` and
 * the value `handleSubmit`'s callback receives.
 *
 * ```ts
 * const schema = z.object({
 *   flag: z.string().transform((v) => v.length > 10),
 * })
 * type FlagParsedOut = PathOutput<typeof schema, 'flag'> // boolean
 * ```
 */
export type PathOutput<Schema extends z.ZodType, Path extends string> =
  z.output<Schema> extends GenericForm
    ? Path extends FlatPath<z.output<Schema>>
      ? NestedType<z.output<Schema>, Path>
      : never
    : never

/**
 * Factor the three identical-shape conditionals out of `useForm`'s public
 * signature, so the bundled `.d.ts` carries one alias per shape instead
 * of re-inlining `z.input<Schema> extends GenericForm ? z.input<Schema>
 * : never` four times. That inlining is what produces TS2589 ("Type
 * instantiation is excessively deep") at a consumer call site holding a
 * discriminated union, a transform pipe, or a deep `.register()` chain.
 * Each alias computes once per `Schema` instantiation, and downstream
 * generics ride it rather than re-evaluating the conditional.
 */
type FormOf<Schema extends SupportedRootSchema> =
  z.input<Schema> extends GenericForm ? z.input<Schema> : never
type OutOf<Schema extends SupportedRootSchema> =
  z.output<Schema> extends GenericForm ? z.output<Schema> : never
type ReadOf<Schema extends SupportedRootSchema> =
  StorageShape<Schema> extends GenericForm ? StorageShape<Schema> : never

/**
 * Create a form bound to a Zod v4 schema.
 *
 * ```ts
 * import { useForm } from 'attaform/zod'
 * import { z } from 'zod'
 *
 * const schema = z.object({
 *   email: z.email(),
 *   password: z.string().min(8),
 * })
 *
 * const form = useForm({ schema, defaultValues: { email: '' } })
 * ```
 *
 * The returned form carries `register`, `values`, `errors`, `fields`,
 * `setValue`, `handleSubmit`, `meta` and the field-array helpers; see
 * `UseFormReturnType` for the whole surface. For Zod v3, import from
 * `attaform/zod-v3`.
 */
export function useForm<Schema extends SupportedRootSchema, K extends FormKey = FormKey>(
  configuration: Omit<
    UseFormConfiguration<
      FormOf<Schema>,
      OutOf<Schema>,
      AbstractSchema<FormOf<Schema>, OutOf<Schema>>,
      // Inert: `defaultValues` is Omitted below and re-supplied through
      // the `AcceptableDefaults` intersection. `never` keeps the deep
      // `DefaultValuesInput` cascade from re-instantiating here, which is
      // TS2589 margin in the bundled `.d.ts`.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // The slot adds the schema's RAW input, `z.input<Schema>`, as a
    // reflexive escape arm, so a generic form wrapper forwarding
    // `defaultValues` does not trip TS2589 or TS2769 (#422). Raw, not the
    // `FormOf` conditional, which would stop matching a forwarded value
    // under a generic. Redundant at a concrete call site; see
    // `AcceptableDefaults`.
    defaultValues?: AcceptableDefaults<FormOf<Schema>, z.input<Schema>>
  } & ValidateOnConfig
): UseFormReturnType<FormOf<Schema>, OutOf<Schema>, ReadOf<Schema>, K> {
  // Catches `useForm(z.object({...}))` (a raw schema, so `.schema` is
  // undefined), `useForm()` and `useForm({ schema: undefined })`, each
  // before it reaches the adapter and crashes deep with an opaque
  // message. A JS caller or an `as any` caller can defy the static
  // signature, and the `unknown` cast is what keeps these runtime checks
  // live under tsc.
  const candidate = configuration as unknown
  if (
    candidate === undefined ||
    candidate === null ||
    (candidate as { schema?: unknown }).schema === undefined
  ) {
    throw new InvalidUseFormConfigError()
  }
  // Three generic slots, three views:
  //  - `Form` (z.input) is the WRITE view, what `setValue`, `register`
  //    and `defaultValues` accept. Loose for honest-input wrappers,
  //    since preprocess accepts `unknown` at the write boundary.
  //  - `Out` (z.output) is the PARSED view, what `handleSubmit` and
  //    `form.parse()` yield, refinements having fired and transforms
  //    having run.
  //  - `Read` (StorageShape) is the READ view, what `form.values`,
  //    `form.fields`, register's read side and `toRef` expose. Per key
  //    it is z.output for a write-boundary wrapper, so a defaulted leaf
  //    types as `T` rather than `T | undefined`, and z.input for a
  //    transform, storage holding the pre-transform input.
  type Form = z.input<Schema> extends GenericForm ? z.input<Schema> : never
  type Out = z.output<Schema> extends GenericForm ? z.output<Schema> : never
  type Read = StorageShape<Schema> extends GenericForm ? StorageShape<Schema> : never
  // `zodV4Adapter` returns a factory `(formKey, options) =>
  // AbstractSchema`, and `UseFormConfiguration.schema` accepts `Schema |
  // ((key, options) => Schema)`, so the factory is a first-class input.
  // The cast below stays narrow deliberately: casting through `unknown as
  // AbstractSchema` would convert a function to an object type and hide
  // the mismatch, where preserving the factory shape at the boundary is
  // what threads per-form `maxRecursionDepth` through.
  const adapter: (key: FormKey, options: SchemaFactoryOptions) => AbstractSchema<Form, Out> =
    zodV4Adapter(configuration.schema) as (
      key: FormKey,
      options: SchemaFactoryOptions
    ) => AbstractSchema<Form, Out>
  // The discriminated `ValidateOnConfig` does not narrow cleanly through
  // `Omit` plus spread: TS picks the wrong variant after the structural
  // rebuild. The runtime input IS the right shape, the public `useForm`
  // signature having enforced the discriminant on `configuration`
  // already, so the cast side-steps a purely structural disagreement.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return useAbstractForm<Form, Out, Read, K>({
    ...configuration,
    schema: adapter,
  } as Parameters<typeof useAbstractForm<Form, Out, Read, K>>[0])
}
