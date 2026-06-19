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
 * `FormOf` / `OutOf` / `ReadOf` factor the three identical-shape
 * conditionals out of the zod-typed `useForm` signature. The bundled
 * `.d.ts` then carries one alias per shape rather than re-inlining
 * `z.input<UnwrapZodObject<Schema>> extends GenericForm ? … : never`
 * four times — the pattern that produces TS2589 ("Type instantiation
 * is excessively deep") on consumer call sites with complex schemas
 * (discriminated unions, refines, deep `.register()` chains). Mirrors
 * the v4 adapter's own `FormOf`/`OutOf`/`ReadOf` aliases verbatim so
 * v3 and v4 carry the same per-call depth cost.
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
 * const form = useForm({ schema: myAdapter, defaultValues: { … } })
 * ```
 *
 * For Zod schemas, prefer the overload that accepts a `ZodObject`
 * directly — it wraps the adapter automatically. For Zod v4, import
 * from `attaform/zod` instead.
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
      // `defaultValues` is Omitted below and re-supplied via the
      // `AcceptableDefaults` intersection, so this `DefaultValues` slot is
      // inert. `never` avoids re-instantiating the deep `DefaultValuesInput`
      // cascade here (a TS2589 margin in the bundled `.d.ts`).
      never,
      K
    >,
    'defaultValues'
  > & {
    // #422: `Form` itself is the reflexive escape arm — a generic wrapper
    // over a custom adapter forwards a `Form`-typed default, so the slot
    // accepts `Form` without tripping TS2589 / TS2769. See `AcceptableDefaults`.
    defaultValues?: AcceptableDefaults<Form, Form>
  }
): UseFormReturnType<Form, GetValueFormType, Form, K>
/**
 * Create a form bound to a Zod v3 `ZodObject` schema.
 *
 * ```ts
 * import { useForm } from 'attaform/zod-v3'
 * import { z } from 'zod'
 *
 * const form = useForm({
 *   schema: z.object({
 *     email: z.string().email(),
 *     password: z.string().min(8),
 *   }),
 *   defaultValues: { email: '' },
 *   validateOn: 'blur',
 * })
 * ```
 *
 * Returns a form API exposing `register`, `values`, `errors`,
 * `fields`, `setValue`, `handleSubmit`, `meta`, field-array
 * helpers, and more. See `UseFormReturnType` for the full
 * surface.
 *
 * For Zod v4, import from `attaform/zod` instead.
 */
export function useForm<Schema extends SupportedRootSchema, K extends FormKey = FormKey>(
  configuration: Omit<
    UseFormConfiguration<
      FormOf<Schema>,
      OutOf<Schema>,
      AbstractSchema<FormOf<Schema>, OutOf<Schema>>,
      // Inert `DefaultValues` slot — see the abstract-schema overload above.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // #422 — see the abstract-schema overload above for the escape-arm
    // rationale. The arm is the schema's raw input (`z.input<Schema>`, NOT
    // routed through `UnwrapZodRoot` or a conditional, so it stays identical
    // to a wrapper's forwarded `z.input<S>` and matches reflexively).
    defaultValues?: AcceptableDefaults<FormOf<Schema>, z.input<Schema>>
  } & ValidateOnConfig
): UseFormReturnType<FormOf<Schema>, OutOf<Schema>, ReadOf<Schema>, K>
// Untyped impl signature. The two overloads above are the public typed
// contract; this signature exists only so the body has somewhere to
// land. Keeping it untyped severs the overload-vs-impl reconciliation
// that would otherwise force every overload return to round-trip
// through `WriteShape`'s primitive-widening idempotence — a constraint
// that blocks fusing `LiftedValueShape` into `WriteShape` because the
// union-distribution arm breaks that idempotence on discriminated
// unions.
//
// Type safety inside the body comes from the inner helpers
// (`zodAdapter`, `useAbstractForm`) inferring from runtime values; the
// public surface that consumers see comes from the overloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useForm(configuration: any): any {
  // Foot-gun guard: catches `useForm(z.object({...}))` (raw schema as
  // the first arg — its `.schema` field is undefined), `useForm()` (no
  // args), and `useForm({ schema: undefined })` before they reach the
  // adapter and crash deep with an opaque message.
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

  // Spread the full configuration so opt-in options (`onInvalidSubmit`,
  // `validateOn`, `debounceMs`, `persist`, `history`, `key`, `strict`)
  // reach useAbstractForm. Writing `strict: configuration.strict ?? true`
  // here would short-circuit the registry's app-level defaults
  // (`createAttaform({ defaults: { strict: false } })`). The
  // library-level fallback to `true` lives downstream in
  // `createFormStore`, where it can apply *after* the registry merge.
  return useAbstractForm({
    ...configuration,
    schema: abstractSchema,
    defaultValues: configuration.defaultValues,
  })
}
