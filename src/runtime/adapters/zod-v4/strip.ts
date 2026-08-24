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
} from './introspect'

/**
 * Re-apply the sync checks from `original` to `rebuilt`. Container
 * constructors (`z.object`, `z.array`, `z.tuple`, `z.record`,
 * `z.union`) don't accept checks in their factory signature, so
 * rebuilding a container would silently drop `.min(1)` / `.max(3)` /
 * etc. Async checks are filtered out — that is the whole point of the
 * rebuild.
 *
 * `.check(...)` accepts raw check instances, which is exactly what
 * the internal `def.checks` array holds.
 */
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

/**
 * Walk the schema tree and rebuild each node with async refinement
 * checks removed. Sync `.refine` / `.superRefine` / built-in checks
 * (`min`, `max`, `email`, etc.) are preserved; wrappers (`.optional()`,
 * `.nullable()`, `.default(v)`, `.readonly()`, `.catch(v)`) are
 * preserved structurally and recursed into.
 *
 * Used by the construction-time default-values flow: a schema
 * containing an async refine cannot go through `safeParse` (Zod
 * throws "Encountered Promise during synchronous parse"), so both the
 * validate-then-fix pass and the strict-mode seed pass parse against
 * this rebuilt twin instead. Every sync-refinement violation the
 * original parse would have collected still surfaces.
 *
 * Pipes are returned unchanged: they carry transforms whose output
 * shape is load-bearing for the inner schema's input, so rebuilding
 * them blindly would change parse results. An async refine INSIDE a
 * pipe therefore still poisons the sync parse — the callers' defensive
 * try/catch owns that case (same observable behavior as before this
 * walker existed).
 *
 * Adapter-divergence note (Phase 12 part 2 / ADAPT-D4 deferred):
 * this stays per-adapter rather than dedup-ing into a shared core
 * walker. The structural skeleton is parallel to v3's
 * `zod-v3/strip-async.ts:stripAsyncChecks`, but the per-check filter
 * is irreducibly asymmetric: v4 knows the user fn directly
 * (`check.def.fn.constructor.name`) so sync refines survive the
 * rebuild; v3 cannot statically distinguish sync from async
 * `.refine(fn)` and drops every `ZodEffects` it encounters.
 */
export function stripAsyncChecks(schema: z.ZodType): z.ZodType {
  // Cycle-detection set scoped to one strip pass — pathological
  // `z.lazy(() => self)` schemas would otherwise infinite-recurse.
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

      // Pipes pass through (see the docblock); the rest are leaves
      // whose checks the strip walker deliberately leaves in place —
      // an async check on one of these still poisons the sync parse
      // and the callers' defensive catch owns that case.
      case 'pipe':
      case 'boolean':
      case 'date':
      case 'enum':
      case 'literal':
      case 'null':
      case 'undefined':
      case 'any':
      case 'unknown':
      case 'nan':
      case 'void':
      case 'never':
      case 'promise':
      case 'custom':
      case 'template-literal':
      case 'transform':
      case 'file':
      case 'map':
      case 'symbol':
      case 'function':
        return s
    }
  }

  return recurse(schema)
}
