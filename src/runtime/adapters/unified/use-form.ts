/**
 * Unified `useForm` for the `attaform/zod` entry. Runtime-dispatches
 * on schema shape: a Zod v4 schema (`def.type` truthy) routes to the
 * v4 adapter; a Zod v3 schema (or any other `AbstractSchema`) routes
 * to the v3 wrapper, which already accepts both Zod v3 input and
 * `AbstractSchema` directly via its built-in shape branch.
 *
 * Type-level dispatch happens via TWO typed overloads — v4 first, v3
 * second — plus an untyped impl. Each overload mirrors the matching
 * direct adapter's signature exactly, so a v4-schema call site pays
 * the same per-call depth cost as importing from `attaform/zod-v4`
 * directly. Overload resolution at concrete call sites commits to one
 * overload immediately on argument shape — no type-level dispatch tax.
 *
 * Tests and other call sites that need the equivalent of
 * `typeof useForm<X>` should reach for the `UseFormReturn<X>` /
 * `UseFormConfig<X>` helpers in `types-api.ts` — instantiation
 * expressions on overloaded functions follow brittle resolution rules,
 * and the helper types give a deterministic projection.
 *
 * This module is the FALLBACK path. Vite consumers see the
 * `attaform/vite` plugin's `resolveId` hook rewrite `attaform/zod`
 * imports to either `attaform/zod-v3` or `attaform/zod-v4` at build
 * time — in that case this dispatch never runs and the consumer
 * bundle ships only the matching adapter. Other bundlers (and
 * non-bundled ESM consumption) hit this dispatch instead, paying a
 * modest size cost for the convenience of a single hello-world import.
 *
 * Power users who want a guaranteed lean bundle on non-Vite tooling
 * can import directly from `attaform/zod-v3` or `attaform/zod-v4` —
 * those subpaths are never rewritten and never load the other
 * adapter.
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
 * const form = useForm({
 *   schema: z.object({
 *     username: z.string().min(2, 'At least 2 characters'),
 *     password: z.string().min(8, 'At least 8 characters'),
 *   }),
 * })
 * ```
 *
 * The constraint intersects `ZodV4Internals` (the v4-only `_zod`
 * brand) so a v3 schema can't bind this overload even when `z`
 * resolves to v3 in a single-major consumer install; v3 schemas fall
 * through to the v3 overload below. See `types-zod-major.ts`.
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
      // `defaultValues` is Omitted below and re-supplied via the
      // `AcceptableDefaults` intersection, so this `DefaultValues` slot is
      // inert. `never` keeps it from re-instantiating the deep
      // `DefaultValuesInput` cascade here — that redundant instantiation,
      // across both overloads at a concrete call site, tips the bundled
      // `.d.ts` into TS2589.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // #422: the `AcceptableDefaults` slot adds the schema's own input
    // (`V4SchemaInput<Schema>`) as a reflexive escape arm so a generic form
    // wrapper forwarding `defaultValues` does not trip TS2589 / TS2769.
    // The arm is redundant at concrete call sites (a schema's input is a
    // subset of its `DefaultValuesInput`), so concrete checking is
    // unchanged. The return type never references the slot, so field
    // inference is preserved through the wrapper. See `AcceptableDefaults`.
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
 * const form = useForm({
 *   schema: z.object({
 *     username: z.string().min(2, 'At least 2 characters'),
 *     password: z.string().min(8, 'At least 8 characters'),
 *   }),
 * })
 * ```
 *
 * v3 schemas match this overload; v4 schemas hit the v4 overload
 * above first and never reach here.
 */
export function useForm<Schema extends SupportedRootSchemaV3, K extends FormKey = FormKey>(
  configuration: Omit<
    UseFormConfiguration<
      V3FormOf<Schema>,
      V3OutOf<Schema>,
      AbstractSchema<V3FormOf<Schema>, V3OutOf<Schema>>,
      // Inert `DefaultValues` slot — see the v4 overload above.
      never,
      K
    >,
    'schema' | 'validateOn' | 'debounceMs' | 'defaultValues'
  > & {
    schema: Schema
    // #422 — see the v4 overload above for the escape-arm rationale.
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
