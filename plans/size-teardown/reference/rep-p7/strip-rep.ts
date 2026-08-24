// P7 rep sketch: strip.ts after sign-off 7 — getSlimSchema and
// stripRefinements DELETED; only stripAsyncChecks (kept per the
// declined sign-off) and its carryChecks helper survive.
import { z } from 'zod'
import {
  getArrayElement,
  getCatchDefault,
  getChecks,
  getDefaultValue,
  getDiscriminatedOptions,
  getDiscriminator,
  getIntersectionLeft,
  getIntersectionRight,
  getObjectShape,
  getRecordKeyType,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getUnionOptions,
  hasChecks,
  isAsyncCheck,
  kindOf,
  unwrapInner,
  unwrapLazy,
} from 'V4/introspect'

function carrySyncChecks<Rebuilt extends z.ZodType>(
  rebuilt: Rebuilt,
  original: z.ZodType
): Rebuilt {
  if (!hasChecks(original)) return rebuilt
  const checks = getChecks(original).filter((c) => !isAsyncCheck(c))
  if (checks.length === 0) return rebuilt
  return (rebuilt as z.ZodType<unknown>).check(
    ...(checks as Parameters<z.ZodType<unknown>['check']>)
  ) as Rebuilt
}

export function stripAsyncChecks(schema: z.ZodType): z.ZodType {
  const seen = new WeakSet<object>()

  function recurse(s: z.ZodType): z.ZodType {
    if (seen.has(s)) return s
    seen.add(s)

    const kind = kindOf(s)
    switch (kind) {
      case 'string':
        return hasChecks(s) ? carrySyncChecks(z.string(), s) : s
      case 'number':
        return hasChecks(s) ? carrySyncChecks(z.number(), s) : s
      case 'bigint':
        return hasChecks(s) ? carrySyncChecks(z.bigint(), s) : s

      case 'array': {
        const element = getArrayElement(s as z.ZodArray)
        return carrySyncChecks(z.array(recurse(element)), s)
      }
      case 'set': {
        return carrySyncChecks(z.set(recurse(getSetValueType(s))), s)
      }
      case 'tuple': {
        const items = getTupleItems(s).map(recurse)
        const rebuilt = z.tuple(
          items as unknown as [z.ZodType, ...z.ZodType[]]
        ) as unknown as z.ZodType
        return carrySyncChecks(rebuilt, s)
      }
      case 'object': {
        const shape = getObjectShape(s as z.ZodObject)
        const next: Record<string, z.ZodType> = {}
        for (const [k, v] of Object.entries(shape)) {
          next[k] = recurse(v as z.ZodType)
        }
        return carrySyncChecks(z.object(next), s)
      }
      case 'record': {
        const keyType = getRecordKeyType(s)
        const valueType = recurse(getRecordValueType(s))
        return carrySyncChecks(
          z.record(keyType as z.ZodType<string | number | symbol>, valueType),
          s
        )
      }
      case 'union': {
        const options = getUnionOptions(s).map(recurse)
        return carrySyncChecks(
          z.union(options as unknown as readonly [z.ZodType, z.ZodType, ...z.ZodType[]]),
          s
        )
      }
      case 'discriminated-union': {
        const options = getDiscriminatedOptions(s).map((opt) => recurse(opt) as z.ZodObject)
        const discriminator = getDiscriminator(s)
        if (discriminator === undefined) return s
        return z.discriminatedUnion(
          discriminator,
          options as unknown as readonly [z.ZodObject, ...z.ZodObject[]]
        )
      }

      case 'optional': {
        const inner = unwrapInner(s)
        return inner === undefined ? s : (recurse(inner) as z.ZodType).optional()
      }
      case 'nullable': {
        const inner = unwrapInner(s)
        return inner === undefined ? s : (recurse(inner) as z.ZodType).nullable()
      }
      case 'default': {
        const inner = unwrapInner(s)
        if (inner === undefined) return s
        return (recurse(inner) as z.ZodType).default(getDefaultValue(s) as never)
      }
      case 'readonly': {
        const inner = unwrapInner(s)
        return inner === undefined ? s : (recurse(inner) as z.ZodType).readonly()
      }
      case 'lazy': {
        const inner = unwrapLazy(s)
        if (inner === undefined) return s
        const stripped = recurse(inner)
        return z.lazy(() => stripped)
      }
      case 'intersection': {
        const left = getIntersectionLeft(s)
        const right = getIntersectionRight(s)
        if (left === undefined || right === undefined) return s
        return z.intersection(recurse(left), recurse(right))
      }
      case 'catch': {
        const inner = unwrapInner(s)
        if (inner === undefined) return s
        return (recurse(inner) as z.ZodType).catch(getCatchDefault(s) as never)
      }

      default:
        // Pipes carry transforms whose output shape is load-bearing;
        // every remaining kind is a leaf without strippable checks.
        return s
    }
  }

  return recurse(schema)
}
