/**
 * Bundled-types guard for the `attaform/abstract` entry — the
 * schema-agnostic escape hatch — through the published artifact the way
 * a custom-adapter consumer sees it.
 *
 * Pins against the bundled `dist/abstract.d.mts`:
 *   - `useAbstractForm` is exported under its real name. The
 *     `useAbstractForm as useForm` alias was removed in the schema-entry
 *     re-partition, so there is no `useForm` on this entry to import.
 *   - `AbstractSchema<Form, GetValueFormType>` is exported and generic
 *     over the form shape a custom adapter validates.
 *   - The returned form carries the shared reactive surface
 *     (`values` / `register` / `handleSubmit`), so an emit that dropped
 *     the core surface off the abstract entry fails here.
 */
import { useAbstractForm } from '../../../dist/abstract'
import type { AbstractSchema } from '../../../dist/abstract'

type Fields = { name: string }

// `AbstractSchema` is exported and parameterised over the form shape.
declare const schema: AbstractSchema<Fields, Fields>

// `useAbstractForm` accepts it under its real name and returns the
// reactive form surface.
const form = useAbstractForm({ schema, key: 'abstract-fixture' })
void form.values
void form.register
void form.handleSubmit
