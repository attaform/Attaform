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
  getArrayElement,
  getCatchDefault,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
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

export const V3_INTROSPECTOR: SchemaIntrospector<z.ZodTypeAny> = {
  kindOf: (schema) => kindOf(schema) as SharedZodKind | string,
  getObjectShape: (schema) => getObjectShape(schema),
  getTupleItems: (schema) => getTupleItems(schema),
  getDiscriminatedOptions: (schema) => getDiscriminatedOptions(schema) as readonly z.ZodTypeAny[],
  getDiscriminator: (schema) => getDiscriminator(schema),
  getLiteralValues: (schema) => getLiteralValues(schema),
  isPreprocessNode: (schema) => isPreprocessNode(schema),
  isCoercePrimitive: (schema) => isCoercePrimitive(schema),
  containsAsyncRefine: (schema) => containsAsyncRefine(schema),
  containsAsyncTransform: (schema) => containsAsyncTransform(schema),
  hasContainerOrRootRefine: (schema) => hasContainerOrRootRefine(schema),

  // Walker accessors (D2 / D3 / D5).
  getArrayElement: (schema) => getArrayElement(schema),
  getSetValueType: (schema) => getSetValueType(schema),
  getRecordKeyType: (schema) => getRecordKeyType(schema),
  getRecordValueType: (schema) => getRecordValueType(schema),
  getUnionOptions: (schema) => getUnionOptions(schema),
  getIntersectionLeft: (schema) => getIntersectionLeft(schema),
  getIntersectionRight: (schema) => getIntersectionRight(schema),
  getEnumValues: (schema) => {
    if (!isZodSchemaType(schema, 'ZodEnum')) return []
    return (schema as z.ZodEnum<[string, ...string[]]>).options
  },
  getNativeEnumValues: (schema) => getNativeEnumValues(schema),
  unwrapInner: (schema) => unwrapInner(schema),
  unwrapBranded: (schema) => unwrapBranded(schema),
  unwrapEffectsSource: (schema) => unwrapEffectsSource(schema),
  unwrapPipeIn: (schema) => unwrapPipeIn(schema),
  unwrapPipeOut: (schema) => unwrapPipeOut(schema),
  unwrapLazy: (schema) => unwrapLazy(schema),
  getLazyGetter: (schema) => getLazyGetter(schema),
  getDefaultValue: (schema) => getDefaultValue(schema),
  getCatchDefault: (schema) => getCatchDefault(schema),
  hasCatchValue: (schema) => hasCatchValue(schema),
}
