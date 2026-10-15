import type { CreateFormStoreOptions } from '../../src/runtime/core/create-form-store'
import type { AbstractSchema } from '../../src/runtime/types/types-api'
import type { GenericForm } from '../../src/runtime/types/types-core'

/**
 * The schema half of a store's construction options, built the way
 * `useForm` builds it: the schema, and its defaults derived once for the
 * construction to share. Spread it into a direct `createFormStore` call.
 */
export function schemaOptions<F extends GenericForm, G extends GenericForm = F>(
  schema: AbstractSchema<F, G>
): Pick<CreateFormStoreOptions<F, G>, 'schema' | 'schemaDefaults'> {
  return { schema, schemaDefaults: schema.getDefaultValues({ useDefaultSchemaValues: true }) }
}
