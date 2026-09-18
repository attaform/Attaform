/**
 * The unified `useForm` behind the `attaform/zod` entry. At runtime it
 * dispatches on schema shape: a Zod v4 schema, with a truthy `def.type`,
 * goes to the v4 adapter, and a Zod v3 schema or any other
 * `AbstractSchema` goes to the v3 wrapper, which already takes both
 * through its own shape branch.
 *
 * At the type level, TWO overloads (v4 first, v3 second) plus an untyped
 * impl. Each overload matches its direct adapter's signature exactly, so
 * a v4 call site pays the same per-call depth cost as importing
 * `attaform/zod-v4`, and overload resolution commits on argument shape
 * at a concrete call site, so there is no dispatch tax.
 *
 * For the equivalent of `typeof useForm<X>`, reach for the
 * `UseFormReturn<X>` and `UseFormConfig<X>` helpers in
 * `types/types-api.ts`: instantiation expressions on an overloaded
 * function follow brittle resolution rules, and the helpers give a
 * deterministic projection.
 *
 * This module is the FALLBACK path. Under Vite, the `attaform/vite`
 * plugin's `resolveId` hook rewrites `attaform/zod` to `attaform/zod-v3`
 * or `attaform/zod-v4` at build time, so this dispatch never runs and
 * the bundle ships one adapter. Another bundler, or unbundled ESM, hits
 * the dispatch and pays a modest size cost for a single hello-world
 * import. Importing `attaform/zod-v3` or `attaform/zod-v4` directly
 * guarantees the lean bundle anywhere: those subpaths are never
 * rewritten and never load the other adapter.
 */
import { InvalidUseFormConfigError } from '../../core/errors'
import { isZodV4SchemaShape } from '../../core/zod-shape'
import type { ZodV4Internals } from './types-zod-major'
import { useForm as useFormV3 } from '../../composables/use-form'
import { useForm as useFormV4 } from '../zod-v4'
import type {
  AbstractSchema,
  FormKey,
  ValidateOnConfig,
  UseFormReturnType,
  UseFormConfiguration,
} from '../../types/types-api'
import type { AcceptableDefaults } from '../../types/types-core'
import type { SupportedRootSchema as SupportedRootSchemaV4 } from '../zod-v4/types-root'
import type { SupportedRootSchema as SupportedRootSchemaV3 } from '../zod-v3/types-root'
import type {
  V3FormOf,
  V3OutOf,
  V3ReadOf,
  V3SchemaInput,
  V4FormOf,
  V4OutOf,
  V4ReadOf,
  V4SchemaInput,
} from './types-projections'

/**
 * Create a form bound to a Zod v4 schema.
 *
 * ```ts
 * import { useForm } from 'attaform/zod'
 * import { z } from 'zod'
 *
 * const schema = z.object({
 *   username: z.string().min(2, 'At least 2 characters'),
 *   password: z.string().min(8, 'At least 8 characters'),
 * })
 *
 * const form = useForm({ schema })
 * ```
 *
 * The constraint intersects `ZodV4Internals`, the v4-only `_zod` brand,
 * so a v3 schema cannot bind this overload even where `z` resolves to v3
 * in a single-major install; it falls through to the v3 overload below.
 * See `types-zod-major.ts`.
 */
export function useForm<
  Schema extends SupportedRootSchemaV4 & ZodV4Internals,
  K extends FormKey = FormKey,
>(
  configuration: Omit<
    UseFormConfiguration<
      V4FormOf<Schema>,
      V4OutOf<Schema>,
      AbstractSchema<V4FormOf<Schema>, V4OutOf<Schema>>,
      // Inert: `defaultValues` is Omitted below and re-supplied through
      // the `AcceptableDefaults` intersection. `never` keeps the deep
      // `DefaultValuesInput` cascade from re-instantiating here, which
      // across BOTH overloads at one concrete call site is what tips the
      // bundled `.d.ts` into TS2589.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // The slot adds the schema's own input, `V4SchemaInput<Schema>`, as a
    // reflexive escape arm, so a generic form wrapper forwarding
    // `defaultValues` does not trip TS2589 or TS2769 (#422). It is
    // redundant at a concrete call site, a schema's input being a subset
    // of its `DefaultValuesInput`, so concrete checking is unchanged, and
    // the return type never references the slot, so field inference
    // survives the wrapper. See `AcceptableDefaults`.
    defaultValues?: AcceptableDefaults<V4FormOf<Schema>, V4SchemaInput<Schema>>
  } & ValidateOnConfig
): UseFormReturnType<V4FormOf<Schema>, V4OutOf<Schema>, V4ReadOf<Schema>, K>
/**
 * Create a form bound to a Zod v3 schema.
 *
 * ```ts
 * import { useForm } from 'attaform/zod'
 * import { z } from 'zod-v3'
 *
 * const schema = z.object({
 *   username: z.string().min(2, 'At least 2 characters'),
 *   password: z.string().min(8, 'At least 8 characters'),
 * })
 *
 * const form = useForm({ schema })
 * ```
 *
 * A v4 schema binds the overload above and never reaches this one.
 */
export function useForm<Schema extends SupportedRootSchemaV3, K extends FormKey = FormKey>(
  configuration: Omit<
    UseFormConfiguration<
      V3FormOf<Schema>,
      V3OutOf<Schema>,
      AbstractSchema<V3FormOf<Schema>, V3OutOf<Schema>>,
      // Inert `DefaultValues` slot; see the v4 overload above.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // See the v4 overload above for the escape-arm rationale (#422).
    defaultValues?: AcceptableDefaults<V3FormOf<Schema>, V3SchemaInput<Schema>>
  } & ValidateOnConfig
): UseFormReturnType<V3FormOf<Schema>, V3OutOf<Schema>, V3ReadOf<Schema>, K>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useForm(configuration: any): any {
  if (
    configuration === undefined ||
    configuration === null ||
    (configuration as { schema?: unknown }).schema === undefined
  ) {
    throw new InvalidUseFormConfigError()
  }
  const { schema } = configuration as { schema: unknown }
  if (isZodV4SchemaShape(schema)) {
    return useFormV4(configuration as Parameters<typeof useFormV4>[0])
  }
  return useFormV3(configuration as Parameters<typeof useFormV3>[0])
}
