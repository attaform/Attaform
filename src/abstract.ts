/**
 * `attaform/abstract`, the schema-agnostic escape hatch.
 *
 * `useAbstractForm` works against any object implementing
 * `AbstractSchema`: a custom adapter, a non-Zod validation library, or
 * a hand-rolled shape. The Zod entries wrap their schemas with the
 * matching adapter automatically, so reach for this one only when
 * integrating a schema library Attaform ships no adapter for.
 *
 *   import { useAbstractForm } from 'attaform/abstract'
 *
 *   const form = useAbstractForm({
 *     schema: myCustomAdapter,
 *     defaultValues: { name: '' },
 *   })
 *
 * The return is the same reactive form the Zod entries produce; see
 * `UseFormReturnType` for the full surface.
 */

export * from './runtime/_shared-exports'

// Under its real name only. There is deliberately no
// `useAbstractForm as useForm` alias: a same-named wrong-variant export
// fails deep at the first schema call instead of red-squiggling at the
// import site, which is the footgun this entry exists to remove.
export { useAbstractForm } from './runtime/composables/use-abstract-form'

export type { AbstractSchema } from './runtime/types/types-api'
export type { FieldMetaPayload } from './runtime/core/field-meta'
