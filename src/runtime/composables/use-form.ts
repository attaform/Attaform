import type { z } from 'zod-v3'
import { zodAdapter } from '../adapters/zod-v3'
import { InvalidUseFormConfigError } from '../core/errors'
import type {
  AbstractSchema,
  FormKey,
  UseFormReturnType,
  UseFormConfiguration,
  ValidateOnConfig,
} from '../types/types-api'
import type { AcceptableDefaults, GenericForm } from '../types/types-core'
import type { UnwrapZodRoot } from '../adapters/zod-v3/types-zod-adapter'
import type { SupportedRootSchema } from '../adapters/zod-v3/types-root'
import type { StorageShape } from '../adapters/zod-v3/types-storage-shape'
import { useAbstractForm } from './use-abstract-form'

/**
 * Factor the three identical-shape conditionals out of the zod-typed
 * `useForm` signature, so the bundled `.d.ts` carries one alias per
 * shape instead of re-inlining `z.input<UnwrapZodRoot<Schema>> extends
 * GenericForm ? ... : never` four times. That inlining is what produces
 * TS2589 ("Type instantiation is excessively deep") at a consumer call
 * site holding a discriminated union, a refine, or a deep `.register()`
 * chain. The v4 adapter declares the same three aliases, so both lines
 * carry the same per-call depth cost.
 */
type FormOf<Schema extends SupportedRootSchema> =
  z.input<UnwrapZodRoot<Schema>> extends GenericForm ? z.input<UnwrapZodRoot<Schema>> : never
type OutOf<Schema extends SupportedRootSchema> =
  z.output<UnwrapZodRoot<Schema>> extends GenericForm ? z.output<UnwrapZodRoot<Schema>> : never
type ReadOf<Schema extends SupportedRootSchema> =
  StorageShape<UnwrapZodRoot<Schema>> extends GenericForm
    ? StorageShape<UnwrapZodRoot<Schema>>
    : never

/**
 * Create a form bound to a custom `AbstractSchema` adapter.
 *
 * ```ts
 * import { useForm } from 'attaform/zod-v3'
 *
 * const form = useForm({ schema: myAdapter, defaultValues: { name: '' } })
 * ```
 *
 * For a Zod schema, prefer the overload that takes the schema directly:
 * it attaches the adapter for you. For Zod v4, import from
 * `attaform/zod`.
 */
export function useForm<
  Form extends GenericForm,
  GetValueFormType extends GenericForm = Form,
  K extends FormKey = FormKey,
>(
  configuration: Omit<
    UseFormConfiguration<
      Form,
      GetValueFormType,
      AbstractSchema<Form, GetValueFormType>,
      // Inert: `defaultValues` is Omitted below and re-supplied through
      // the `AcceptableDefaults` intersection. `never` keeps the deep
      // `DefaultValuesInput` cascade from re-instantiating here, which is
      // TS2589 margin in the bundled `.d.ts`.
      never,
      K
    >,
    'defaultValues'
  > & {
    // `Form` itself is the reflexive escape arm: a generic wrapper over a
    // custom adapter forwards a `Form`-typed default, so the slot takes
    // `Form` without tripping TS2589 or TS2769 (#422). See
    // `AcceptableDefaults`.
    defaultValues?: AcceptableDefaults<Form, Form>
  }
): UseFormReturnType<Form, GetValueFormType, Form, K>
/**
 * Create a form bound to a Zod v3 schema.
 *
 * ```ts
 * import { useForm } from 'attaform/zod-v3'
 * import { z } from 'zod'
 *
 * const schema = z.object({
 *   email: z.string().email(),
 *   password: z.string().min(8),
 * })
 *
 * const form = useForm({
 *   schema,
 *   defaultValues: { email: '' },
 *   validateOn: 'blur',
 * })
 * ```
 *
 * The returned form carries `register`, `values`, `errors`, `fields`,
 * `setValue`, `handleSubmit`, `meta` and the field-array helpers; see
 * `UseFormReturnType` for the whole surface. For Zod v4, import from
 * `attaform/zod`.
 */
export function useForm<Schema extends SupportedRootSchema, K extends FormKey = FormKey>(
  configuration: Omit<
    UseFormConfiguration<
      FormOf<Schema>,
      OutOf<Schema>,
      AbstractSchema<FormOf<Schema>, OutOf<Schema>>,
      // Inert `DefaultValues` slot; see the overload above.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // The escape arm is the schema's RAW input, `z.input<Schema>`, routed
    // through neither `UnwrapZodRoot` nor a conditional, so it stays
    // identical to a wrapper's forwarded `z.input<S>` and matches
    // reflexively. See the overload above.
    defaultValues?: AcceptableDefaults<FormOf<Schema>, z.input<Schema>>
  } & ValidateOnConfig
): UseFormReturnType<FormOf<Schema>, OutOf<Schema>, ReadOf<Schema>, K>
// The two overloads above are the public contract; this signature only
// gives the body somewhere to land, and it stays untyped deliberately.
// Typing it would restore the overload-vs-impl reconciliation, which
// forces every overload return through `WriteShape`'s primitive-widening
// idempotence, and that in turn blocks fusing `LiftedValueShape` into
// `WriteShape`, whose union-distribution arm breaks the idempotence on
// discriminated unions.
//
// Inside the body, type safety comes from `zodAdapter` and
// `useAbstractForm` inferring off runtime values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useForm(configuration: any): any {
  // Catches `useForm(z.object({...}))` (a raw schema, so `.schema` is
  // undefined), `useForm()` and `useForm({ schema: undefined })`, each
  // before it reaches the adapter and crashes deep with an opaque
  // message.
  if (
    configuration === undefined ||
    configuration === null ||
    (configuration as { schema?: unknown }).schema === undefined
  ) {
    throw new InvalidUseFormConfigError()
  }

  function isZodType(value: unknown): value is z.ZodType {
    return typeof value === 'object' && value !== null && '_def' in value
  }

  const { schema } = configuration
  const abstractSchema = isZodType(schema) ? zodAdapter(schema) : schema

  // Spread, so every opt-in option reaches `useAbstractForm`.
  return useAbstractForm({
    ...configuration,
    schema: abstractSchema,
    defaultValues: configuration.defaultValues,
  })
}
