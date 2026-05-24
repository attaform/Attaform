import type {
  AbstractSchema,
  DefaultValuesResponse,
  FormKey,
  MaybePromise,
  SlimPrimitiveKind,
  ValidationResponse,
} from '../types/types-api'

/**
 * Minimal `AbstractSchema` implementation backing the wizard's noop
 * forms. String slots in `useWizard({ steps })` desugar to a form built
 * with this schema, so affordance positions (intro, terms, review,
 * congratulations) participate in the same registry, status, and
 * submission machinery as schema-backed forms.
 *
 * Contract:
 *  - `validateAtPath` always settles as `success: true` with data `{}`.
 *  - No paths resolve in the schema: every introspection method returns
 *    a permissive empty answer so the form runtime never tries to walk
 *    fields that do not exist.
 *  - The fingerprint is constant — every noop form structurally agrees
 *    with every other noop form, so a same-key collision between a
 *    string slot and a real form raises the standard fingerprint
 *    mismatch warning from `useAbstractForm`.
 */

const NOOP_FINGERPRINT = 'attaform:wizard-noop'

const EMPTY_SLIM_KINDS: ReadonlySet<SlimPrimitiveKind> = new Set()

/**
 * Build the noop schema for a given form key. The key only enters the
 * resolved `ValidationResponse.formKey` field so error envelopes stay
 * symmetric with adapter-backed schemas; structurally every noop schema
 * is interchangeable.
 */
export function buildNoopWizardSchema(
  formKey: FormKey
): AbstractSchema<Record<string, never>, Record<string, never>> {
  const emptyValue: Record<string, never> = {}
  const success: ValidationResponse<Record<string, never>> = {
    success: true,
    data: emptyValue,
    errors: undefined,
    formKey,
  }
  const defaultsResponse: DefaultValuesResponse<Record<string, never>> = {
    success: true,
    data: emptyValue,
    errors: undefined,
    formKey,
  }
  return {
    fingerprint: () => NOOP_FINGERPRINT,
    getDefaultValues: () => defaultsResponse,
    getDefaultAtPath: () => undefined,
    getEmptyValueAtPath: () => undefined,
    isPreprocessOrCoerceLeaf: () => false,
    arrayShapeAtPath: () => undefined,
    getSchemasAtPath: () => [],
    validateAtPath: (): MaybePromise<ValidationResponse<Record<string, never>>> => success,
    getSlimPrimitiveTypesAtPath: () => new Set(EMPTY_SLIM_KINDS),
    isLeafAtPath: () => false,
    isRequiredAtPath: () => false,
    getUnionDiscriminatorAtPath: () => undefined,
  }
}
