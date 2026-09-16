/**
 * Module-level `SchemaIntrospector<z.ZodTypeAny>` instance for the v3
 * adapter. Mirrors the v4 instance at
 * `src/runtime/adapters/zod-v4/walker-introspector.ts` against v3's
 * introspect-module accessors. Hosted in its own file so the
 * per-walker modules can import the const without routing through
 * `index.ts` (which would create an import cycle).
 */
import type { z } from 'zod-v3'
import type { SchemaIntrospector, SharedZodKind } from '../../core/abstract-schema-factory'
import { isZodSchemaType } from './helpers'
import {
  containsAsyncRefine,
  containsAsyncTransform,
  containsDiscriminatedUnion,
  getArrayElement,
  getCatchDefault,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
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

export const V3_INTROSPECTOR: SchemaIntrospector<z.ZodTypeAny> = {
  kindOf: (schema) => kindOf(schema) as SharedZodKind | string,
  getObjectShape,
  getTupleItems,
  getDiscriminatedOptions: (schema) => getDiscriminatedOptions(schema) as readonly z.ZodTypeAny[],
  getDiscriminator,
  getLiteralValues,
  isPreprocessNode,
  isCoercePrimitive,
  containsAsyncRefine,
  containsAsyncTransform,
  containsDiscriminatedUnion,
  hasContainerOrRootRefine,

  // Walker accessors (D2 / D3 / D5).
  getArrayElement,
  getSetValueType,
  getRecordValueType,
  getMapKeyType: (schema) => (kindOf(schema) === 'map' ? getMapKeyType(schema) : undefined),
  getMapValueType: (schema) => (kindOf(schema) === 'map' ? getMapValueType(schema) : undefined),
  getUnionOptions,
  getIntersectionLeft,
  getIntersectionRight,
  getEnumValues: (schema) => {
    if (!isZodSchemaType(schema, 'ZodEnum')) return []
    return (schema as z.ZodEnum<[string, ...string[]]>).options
  },
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
