/**
 * Module-level `SchemaIntrospector<ZodV4Node>` instance for the v4
 * adapter. Stateless: every method takes a schema and reads its `def.*`
 * shape through the introspect-module accessors.
 *
 * Hosted in its own file so the per-walker modules (`path-walker.ts`,
 * `slim-primitives.ts`, `default-values.ts`) can import it without
 * routing through `adapter.ts` (which would create an import cycle:
 * `adapter.ts → path-walker.ts → adapter.ts`).
 */
import type { SchemaIntrospector, SharedZodKind } from '../../core/abstract-schema-factory'
import {
  capabilitiesOf,
  getArrayElement,
  getCatchDefault,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
  getEnumValues,
  getIntersectionLeft,
  getIntersectionRight,
  getLiteralValues,
  getNativeEnumValues,
  getObjectShape,
  getMapKeyType,
  getMapValueType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getUnionOptions,
  hasCatchValue,
  isCoercePrimitive,
  isPreprocessNode,
  kindOf,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
  unwrapPipeOut,
  type ZodV4Node,
} from './introspect'

export const V4_INTROSPECTOR: SchemaIntrospector<ZodV4Node> = {
  kindOf: (schema) => kindOf(schema) as SharedZodKind | string,
  getObjectShape,
  getTupleItems,
  getDiscriminatedOptions,
  getDiscriminator,
  getLiteralValues,
  isPreprocessNode,
  isCoercePrimitive,
  capabilitiesOf,

  // Walker accessors (D2 / D3 / D5).
  getArrayElement: (schema) => {
    if (kindOf(schema) !== 'array') return undefined
    return getArrayElement(schema)
  },
  getSetValueType: (schema) => (kindOf(schema) === 'set' ? getSetValueType(schema) : undefined),
  getRecordValueType: (schema) =>
    kindOf(schema) === 'record' ? getRecordValueType(schema) : undefined,
  getMapKeyType: (schema) => (kindOf(schema) === 'map' ? getMapKeyType(schema) : undefined),
  getMapValueType: (schema) => (kindOf(schema) === 'map' ? getMapValueType(schema) : undefined),
  getUnionOptions,
  getIntersectionLeft,
  getIntersectionRight,
  getEnumValues,
  getNativeEnumValues,
  unwrapInner,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapPipeIn,
  unwrapPipeOut,
  unwrapLazy,
  getDefaultValue,
  getCatchDefault,
  hasCatchValue,
}
