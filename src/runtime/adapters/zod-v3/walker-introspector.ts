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
  capabilitiesOf,
  getArrayElement,
  getCatchDefault,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
  getIntersectionLeft,
  getIntersectionRight,
  getLiteralValues,
  getMapKeyType,
  getMapValueType,
  getNativeEnumValues,
  getObjectShape,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getUnionOptions,
  hasCatchValue,
  isCoercePrimitive,
  isPreprocessNode,
  kindOf,
  scanCapabilities,
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
  capabilitiesOf,

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

/**
 * The introspector a v3 sub-schema is built with. `getSchemasAtPath`
 * builds a sub-schema per candidate on every query, and the runtime asks
 * it one question once, `needsAsyncValidation`. Its capability walk
 * therefore skips the per-node memo: a `WeakMap` insert costs more than
 * walking the few nodes under a path.
 */
export const V3_SUB_SCHEMA_INTROSPECTOR: SchemaIntrospector<z.ZodTypeAny> = {
  ...V3_INTROSPECTOR,
  capabilitiesOf: scanCapabilities,
}
