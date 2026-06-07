import type { AbstractSchema, FormKey, SchemaFactoryOptions } from '../types/types-api'
import type { GenericForm } from '../types/types-core'

/**
 * Accept schema as either a direct value or a factory function
 * `(key, options) => schema`. The factory form is documented but
 * rarely used — it exists for schemas that want to embed the formKey
 * or the resolved per-form options (e.g. `maxRecursionDepth`) into
 * their adapter instance.
 */
export function getComputedSchema<F extends GenericForm, GetValueFormType>(
  formKey: FormKey,
  schemaOrCallback:
    | AbstractSchema<F, GetValueFormType>
    | ((formKey: FormKey, options: SchemaFactoryOptions) => AbstractSchema<F, GetValueFormType>),
  options: SchemaFactoryOptions
): AbstractSchema<F, GetValueFormType> {
  if (typeof schemaOrCallback === 'function') return schemaOrCallback(formKey, options)
  return schemaOrCallback
}
