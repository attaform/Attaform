/**
 * Module-level `SchemaIntrospector<z.ZodType>` instance for the v4
 * adapter. The instance is stateless — every method receives a schema
 * and reads its `def.*` shape via the introspect-module accessors.
 *
 * Hosted in its own file so the per-walker modules (`path-walker.ts`,
 * `slim-primitives.ts`, `default-values.ts`) can import it without
 * routing through `adapter.ts` (which would create an import cycle:
 * `adapter.ts → path-walker.ts → adapter.ts`).
 */
import type { z } from 'zod'
import type { SchemaIntrospector, SharedZodKind } from '../../core/abstract-schema-factory'
import {
  containsAsyncRefine,
  containsAsyncTransform,
  getArrayElement,
  getCatchDefault,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
  getEnumValues,
  getIntersectionLeft,
  getIntersectionRight,
  getLazyGetter,
  getLiteralValues,
  getNativeEnumValues,
  getObjectShape,
  getRecordKeyType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getUnionOptions,
  hasCatchValue,
  hasContainerOrRootRefine,
  isCoercePrimitive,
  isPreprocessNode,
  kindOf,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
  unwrapPipeOut,
} from './introspect'

export const V4_INTROSPECTOR: SchemaIntrospector<z.ZodType> = {
  kindOf: (schema) => kindOf(schema) as SharedZodKind | string,
  getObjectShape: (schema) => getObjectShape(schema as z.ZodObject),
  getTupleItems,
  getDiscriminatedOptions: (schema) => getDiscriminatedOptions(schema) as readonly z.ZodType[],
  getDiscriminator,
  getLiteralValues,
  isPreprocessNode,
  isCoercePrimitive,
  containsAsyncRefine,
  containsAsyncTransform,
  hasContainerOrRootRefine,

  // Walker accessors (D2 / D3 / D5).
  getArrayElement: (schema) => {
    if (kindOf(schema) !== 'array') return undefined
    return getArrayElement(schema as z.ZodArray)
  },
  getSetValueType: (schema) => (kindOf(schema) === 'set' ? getSetValueType(schema) : undefined),
  getRecordKeyType: (schema) =>
    kindOf(schema) === 'record' ? getRecordKeyType(schema) : undefined,
  getRecordValueType: (schema) =>
    kindOf(schema) === 'record' ? getRecordValueType(schema) : undefined,
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
  getLazyGetter,
  getDefaultValue,
  getCatchDefault,
  hasCatchValue,
}
