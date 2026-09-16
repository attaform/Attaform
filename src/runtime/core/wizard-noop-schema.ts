import type {
  AbstractSchema,
  MaybePromise,
  SchemaDefaultsResult,
  SchemaParseResult,
  SlimPrimitiveKind,
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
 *  - Every noop schema is structurally interchangeable with every
 *    other, so a same-key collision between a string slot and a real
 *    form raises the standard schema-mismatch warning from
 *    `useAbstractForm`.
 */

const EMPTY_SLIM_KINDS: ReadonlySet<SlimPrimitiveKind> = new Set()

/**
 * The noop schema. Every affordance slot in every wizard in the app
 * shares one instance: a schema that declares nothing has nothing to
 * distinguish it, and the owning store stamps its own key onto the
 * envelopes on the way out.
 */
const EMPTY_VALUE: Record<string, never> = {}
const NOOP_SUCCESS: SchemaParseResult<Record<string, never>> = {
  success: true,
  data: EMPTY_VALUE,
  errors: undefined,
}
const NOOP_DEFAULTS: SchemaDefaultsResult<Record<string, never>> = NOOP_SUCCESS

let NOOP_SCHEMA: AbstractSchema<Record<string, never>, Record<string, never>> | undefined

export function buildNoopWizardSchema(): AbstractSchema<
  Record<string, never>,
  Record<string, never>
> {
  NOOP_SCHEMA ??= {
    getDefaultValues: () => NOOP_DEFAULTS,
    getDefaultAtPath: () => undefined,
    getEmptyValueAtPath: () => undefined,
    isPreprocessOrCoerceLeaf: () => false,
    isOpaqueLeafAtPath: () => false,
    arrayShapeAtPath: () => null,
    isFixedObjectAtPath: (path) => path.length === 0,
    // The noop schema declares no shape at all, so nothing under it is
    // addressable, root included.
    entryKeyKindAtPath: () => undefined,
    getSchemasAtPath: () => [],
    validateAtPath: (): MaybePromise<SchemaParseResult<Record<string, never>>> => NOOP_SUCCESS,
    getSlimPrimitiveTypesAtPath: () => new Set(EMPTY_SLIM_KINDS),
    isLeafAtPath: () => false,
    isRequiredAtPath: () => false,
    getUnionDiscriminatorAtPath: () => undefined,
    hasDiscriminatedUnions: () => false,
  }
  return NOOP_SCHEMA
}
