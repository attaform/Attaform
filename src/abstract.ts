/**
 * `attaform/abstract` — the schema-agnostic escape hatch.
 *
 * `useAbstractForm` works against any object implementing
 * `AbstractSchema`: a custom adapter, a non-Zod validation library, or
 * a hand-rolled shape. The Zod entries (`attaform`, `attaform/zod`,
 * `attaform/zod-v3`, `attaform/zod-v4`) wrap their schemas with the
 * matching adapter automatically; reach for this entry only when you're
 * integrating a schema library Attaform doesn't ship an adapter for.
 *
 *   import { useAbstractForm } from 'attaform/abstract'
 *
 *   const form = useAbstractForm({
 *     schema: myCustomAdapter,
 *     defaultValues: { name: '' },
 *   })
 *
 * The return shape is the same reactive form the Zod entries produce;
 * see `UseFormReturnType` for the full surface.
 */

// Schema-agnostic core — the same surface every entry ships.
export * from './runtime/_shared-exports'

// The abstract form under its real name only. There is deliberately no
// `useAbstractForm as useForm` alias: a same-named wrong-variant export
// fails deep at the first schema call instead of red-squiggling at the
// import site, which is the footgun this entry exists to remove.
export { useAbstractForm } from './runtime/composables/use-abstract-form'

// The multi-schema-lib contract a custom adapter implements, plus the
// augmentable field-metadata interface (surfaces on every `FieldState`).
export type { AbstractSchema } from './runtime/types/types-api'
export type { FieldMetaPayload } from './runtime/core/field-meta'
