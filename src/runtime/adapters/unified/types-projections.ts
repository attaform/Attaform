/**
 * Per-major projection helpers shared by the unified `attaform/zod`
 * entry. Each maps an arbitrary Zod v4 OR v3 object schema to the
 * `GenericForm`-shaped input / output / storage-read projections the
 * form types are parameterised over. The constraint on each alias scopes
 * `S` to one Zod major, so the projection is a direct read with no
 * dispatch in the type body.
 *
 * They live here rather than in `types-unified.ts` or `use-form.ts` so
 * the two entry points share one definition. Internal: the overloaded
 * `useForm` already infers fully at a call site, so consumer code never
 * reaches for them.
 */
import type { z } from 'zod'
import type { z as zV3 } from 'zod-v3'
import type { StorageShape as StorageShapeV4 } from '../zod-v4/types-storage-shape'
import type { StorageShape as StorageShapeV3 } from '../zod-v3/types-storage-shape'
import type { UnwrapZodRoot } from '../zod-v3/types-zod-adapter'
import type { SupportedRootSchema as SupportedRootSchemaV4 } from '../zod-v4/types-root'
import type { SupportedRootSchema as SupportedRootSchemaV3 } from '../zod-v3/types-root'
import type { GenericForm } from '../../types/types-core'

/**
 * The schema's own input type exactly as a consumer would write it,
 * `z.input<S>`, routed through neither `GenericForm` nor
 * `UnwrapZodRoot`. It is the reflexive escape arm `AcceptableDefaults`
 * adds to the `defaultValues` slot, so a generic form wrapper forwarding
 * `z.input<S>` type-checks under a free `S` (#422).
 *
 * It MUST stay syntactically identical to what the wrapper forwards:
 * wrapping it in a conditional makes it a deferred conditional, which
 * stops matching the forwarded value under a generic. A wrong-major
 * schema cannot bind the slot anyway, being rejected at the overload's
 * `schema` constraint, so the raw input never widens it.
 */
export type V4SchemaInput<S extends SupportedRootSchemaV4> = z.input<S>
export type V3SchemaInput<S extends SupportedRootSchemaV3> = zV3.input<S>

export type V4FormOf<S extends SupportedRootSchemaV4> =
  z.input<S> extends GenericForm ? z.input<S> : never
export type V4OutOf<S extends SupportedRootSchemaV4> =
  z.output<S> extends GenericForm ? z.output<S> : never
export type V4ReadOf<S extends SupportedRootSchemaV4> =
  StorageShapeV4<S> extends GenericForm ? StorageShapeV4<S> : never

export type V3FormOf<S extends SupportedRootSchemaV3> =
  zV3.input<UnwrapZodRoot<S>> extends GenericForm ? zV3.input<UnwrapZodRoot<S>> : never
export type V3OutOf<S extends SupportedRootSchemaV3> =
  zV3.output<UnwrapZodRoot<S>> extends GenericForm ? zV3.output<UnwrapZodRoot<S>> : never
export type V3ReadOf<S extends SupportedRootSchemaV3> =
  StorageShapeV3<UnwrapZodRoot<S>> extends GenericForm ? StorageShapeV3<UnwrapZodRoot<S>> : never
