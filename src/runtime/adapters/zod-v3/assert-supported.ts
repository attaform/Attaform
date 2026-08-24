import type { z } from 'zod-v3'
import { __DEV__ } from '../../core/dev'
import { UnsupportedSchemaError } from './errors'
import { isZodSchemaType } from './helpers'
import {
  getArrayElement,
  getDiscriminatedOptions,
  getIntersectionLeft,
  getIntersectionRight,
  getLazyGetter,
  getObjectShape,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getTypeName,
  getUnionOptions,
  unwrapBranded,
  unwrapEffectsSource,
  unwrapInner,
  unwrapPipeIn,
} from './introspect'

/**
 * Kinds the v3 adapter does not implement. `z.promise(...)`,
 * `z.function(...)`, `z.map(...)`, and `z.symbol()` can't be
 * represented as form values (Promise/function-valued fields have no
 * meaningful initial state; Maps have no obvious form representation;
 * symbols aren't JSON-serialisable so persistence and SSR round-trip
 * would silently drop them). The adapter rejects them at construction
 * so the failure surfaces at `useForm(...)` rather than as a mystery
 * `null` at render time. Mirrors v4's `UNSUPPORTED` set with the
 * v3-only additions (`function` / `map` / `symbol`); v4's
 * `template-literal` / `custom` aren't kinds in zod-v3.
 */
const UNSUPPORTED_TYPE_NAMES = new Set(['ZodPromise', 'ZodFunction', 'ZodMap', 'ZodSymbol'])

function labelPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.')
}

/**
 * Walk the schema tree and fail fast on unsupported kinds. Detects
 * recursive `z.lazy(...)` by tracking the *getter function identity*
 * of each lazy on the descent stack — a repeated getter means the
 * factory resolves back into itself (directly or through a detour).
 *
 * This runs once, at adapter construction time, so the cost is paid
 * at app startup rather than per keystroke. Mirrors v4's
 * `assertSupportedKinds`; the dispatch goes through `isZodSchemaType`
 * (typeName comparison) plus the introspect accessors for the
 * structural reads.
 */
export function assertSupportedKinds(
  schema: z.ZodTypeAny,
  path: readonly string[] = [],
  lazyGetters: readonly (() => unknown)[] = []
): void {
  const typeName = getTypeName(schema)
  if (typeName !== undefined && UNSUPPORTED_TYPE_NAMES.has(typeName)) {
    throw new UnsupportedSchemaError(
      __DEV__
        ? `[attaform/zod-v3] unsupported kind '${typeName}' at '${labelPath(path)}'`
        : `[attaform] AF02 attaform.dev/e/AF02 '${typeName}' at '${labelPath(path)}'`
    )
  }

  if (isZodSchemaType(schema, 'ZodObject')) {
    for (const [key, sub] of Object.entries(getObjectShape(schema))) {
      assertSupportedKinds(sub, [...path, key], lazyGetters)
    }
    return
  }

  if (isZodSchemaType(schema, 'ZodArray')) {
    const inner = getArrayElement(schema)
    if (inner) assertSupportedKinds(inner, [...path, '*'], lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodSet')) {
    const inner = getSetValueType(schema)
    if (inner) assertSupportedKinds(inner, [...path, '*'], lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodRecord')) {
    const inner = getRecordValueType(schema)
    if (inner) assertSupportedKinds(inner, [...path, '*'], lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodTuple')) {
    const items = getTupleItems(schema)
    items.forEach((item, i) => assertSupportedKinds(item, [...path, String(i)], lazyGetters))
    return
  }

  if (isZodSchemaType(schema, 'ZodUnion')) {
    const options = getUnionOptions(schema)
    options.forEach((opt, i) => assertSupportedKinds(opt, [...path, `|${i}`], lazyGetters))
    return
  }

  if (isZodSchemaType(schema, 'ZodDiscriminatedUnion')) {
    const options = getDiscriminatedOptions(schema)
    options.forEach((opt, i) => assertSupportedKinds(opt, [...path, `|${i}`], lazyGetters))
    return
  }

  if (isZodSchemaType(schema, 'ZodIntersection')) {
    const left = getIntersectionLeft(schema)
    if (left) assertSupportedKinds(left, [...path, 'left'], lazyGetters)
    const right = getIntersectionRight(schema)
    if (right) assertSupportedKinds(right, [...path, 'right'], lazyGetters)
    return
  }

  if (
    isZodSchemaType(schema, 'ZodOptional') ||
    isZodSchemaType(schema, 'ZodNullable') ||
    isZodSchemaType(schema, 'ZodDefault') ||
    isZodSchemaType(schema, 'ZodReadonly') ||
    isZodSchemaType(schema, 'ZodCatch')
  ) {
    const inner = unwrapInner(schema)
    if (inner) assertSupportedKinds(inner, path, lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodBranded')) {
    const inner = unwrapBranded(schema)
    if (inner) assertSupportedKinds(inner, path, lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodEffects')) {
    const inner = unwrapEffectsSource(schema)
    if (inner) assertSupportedKinds(inner, path, lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodPipeline')) {
    const inner = unwrapPipeIn(schema)
    if (inner) assertSupportedKinds(inner, path, lazyGetters)
    return
  }

  if (isZodSchemaType(schema, 'ZodLazy')) {
    const getter = getLazyGetter(schema)
    // Recursive z.lazy() is supported. Stop descending on the second
    // encounter (the shape walk only needs each unique getter once);
    // downstream walks cap their descent via `maxRecursionDepth`.
    if (getter !== undefined && lazyGetters.includes(getter)) return
    const inner = getter?.()
    if (inner !== undefined) {
      assertSupportedKinds(
        inner as z.ZodTypeAny,
        path,
        getter === undefined ? lazyGetters : [...lazyGetters, getter]
      )
    }
    return
  }

  // Leaves: nothing to descend into. Includes ZodString, ZodNumber,
  // ZodBigInt, ZodBoolean, ZodDate, ZodNull, ZodUndefined, ZodAny,
  // ZodUnknown, ZodNever, ZodVoid, ZodLiteral, ZodEnum, ZodNativeEnum,
  // ZodNaN. Plus the unsupported leaves (already rejected above).
}
