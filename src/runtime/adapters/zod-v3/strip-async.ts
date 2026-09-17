// Type-only: this pass constructs zero nodes through the ambient `z`.
// Every container / wrapper rebuild goes through `rebuild-schema.ts`,
// which reconstructs from the consumer's own (correct-version) node,
// keeping the pass immune to a second, mismatched zod in the tree.
import type { z } from 'zod-v3'

import {
  getArrayElement,
  getCatchDefault,
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
  unwrapBranded,
  getEffect,
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
} from './introspect'
import { isZodSchemaType } from './helpers'
import {
  rebuildArray,
  rebuildDiscriminatedUnion,
  rebuildIntersection,
  rebuildEffects,
  rebuildLazy,
  rebuildObject,
  rebuildRecord,
  rebuildSet,
  rebuildTuple,
  rebuildUnion,
  rebuildWrapperInner,
} from './rebuild-schema'

/**
 * Rebuild the tree keeping every `ZodEffects` in place, but wrapping
 * each refinement so a promise it returns gets a rejection handler
 * attached before anyone can drop it.
 *
 * This exists because a sync parse of a schema holding an async
 * refinement leaks an unhandled rejection, and the leak is Zod's to
 * create but Attaform's to trigger. Zod v3 cannot mark an async
 * refinement statically, so it finds one by RUNNING it:
 * `executeRefinement` calls the predicate, sees a Promise come back,
 * and throws "Async refinement encountered during synchronous parse".
 * It discards that promise on the way out. When the consumer's
 * predicate rejects, through a failed `await` or a thrown error, nothing
 * is holding the promise and the host app gets an unhandled rejection
 * from a parse it never asked for.
 *
 * The wrapper changes nothing about the verdict. It calls the original
 * refinement, attaches a no-op `catch` if the result is thenable, and
 * returns that same result, so Zod still sees a Promise, still throws
 * its sync-detect error, and the strip recovery still runs. A sync
 * refinement passes through untouched.
 *
 * Attaching `catch` does not hide the failure from the consumer: it
 * marks THIS promise handled, and any handler they attach to their own
 * promise still fires. The same failure is reported properly through
 * the async validation pass.
 */
export function wrapAsyncSafeRefinements(schema: z.ZodTypeAny): z.ZodTypeAny {
  return walkEffects(schema)
}

/** A refinement's return value, when it happens to be thenable. */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function walkEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
  const seen = new WeakSet<object>()

  function recurse(s: z.ZodTypeAny): z.ZodTypeAny {
    const candidate = s as unknown
    if (typeof candidate !== 'object' || candidate === null) return s
    if (seen.has(candidate)) return s
    seen.add(candidate)

    if (isZodSchemaType(s, 'ZodEffects')) {
      const inner = unwrapEffectsSource(s)
      if (inner === undefined) return s
      // Keep the wrapper, recurse the source, and make the refinement's
      // returned promise observable. A transform or preprocess step is
      // left exactly as it is, neither returning a promise Zod then
      // discards. Making that promise observable is the ONLY reason this
      // module rebuilds a tree at all.
      const effect = getEffect(s)
      const rebuiltInner = recurse(inner)
      const original = effect?.['refinement']
      if (effect === undefined || typeof original !== 'function') {
        return rebuildEffects(s, rebuiltInner, effect)
      }
      const refine = original as (value: unknown, ctx: unknown) => unknown
      const safeEffect = {
        ...effect,
        refinement: (value: unknown, ctx: unknown): unknown => {
          const result = refine(value, ctx)
          if (isThenable(result)) {
            // Marks THIS promise handled so Zod dropping it cannot
            // surface as an unhandled rejection. The consumer's own
            // handlers, and the async validation pass, are unaffected.
            void result.catch(() => undefined)
          }
          return result
        },
      }
      return rebuildEffects(s, rebuiltInner, safeEffect)
    }

    // Transparent wrappers: recurse the inner and rewrap.
    if (isZodSchemaType(s, 'ZodOptional')) {
      const inner = unwrapInner(s)
      return inner === undefined ? s : rebuildWrapperInner(s, recurse(inner))
    }
    if (isZodSchemaType(s, 'ZodNullable')) {
      const inner = unwrapInner(s)
      return inner === undefined ? s : rebuildWrapperInner(s, recurse(inner))
    }
    if (isZodSchemaType(s, 'ZodDefault')) {
      const inner = unwrapInner(s)
      if (inner === undefined) return s
      const def = getDefaultValue(s)
      return (recurse(inner) as z.ZodTypeAny).default(def as never) as z.ZodTypeAny
    }
    if (isZodSchemaType(s, 'ZodCatch')) {
      const inner = unwrapInner(s)
      if (inner === undefined) return s
      const fallback = getCatchDefault(s)
      return (recurse(inner) as z.ZodTypeAny).catch(fallback as never) as z.ZodTypeAny
    }
    if (isZodSchemaType(s, 'ZodReadonly')) {
      const inner = unwrapInner(s)
      return inner === undefined ? s : ((recurse(inner) as z.ZodTypeAny).readonly() as z.ZodTypeAny)
    }
    if (isZodSchemaType(s, 'ZodBranded')) {
      const inner = unwrapBranded(s)
      return inner === undefined ? s : recurse(inner)
    }
    if (isZodSchemaType(s, 'ZodLazy')) {
      const inner = unwrapLazy(s)
      if (inner === undefined) return s
      const stripped = recurse(inner)
      return rebuildLazy(s, stripped)
    }
    if (isZodSchemaType(s, 'ZodPipeline')) {
      // Pipelines carry transforms whose output shape is load-bearing
      // for the downstream schema's input. The Path-A fallback only
      // runs after the original parse already threw, so leaving pipes
      // in place would re-throw on retry; recurse the input side
      // alone so the parse can proceed against the structural shape.
      // Matches the v4 adapter's conservative pipe handling
      // (`strip.ts:304-313`).
      const inSide = unwrapPipeIn(s)
      return inSide === undefined ? s : recurse(inSide)
    }

    // Containers: recurse children + carry the container-level checks.
    if (isZodSchemaType(s, 'ZodObject')) {
      const shape = getObjectShape(s)
      const next: z.ZodRawShape = {}
      for (const [k, v] of Object.entries(shape)) {
        next[k] = recurse(v)
      }
      return carryObjectChecks(rebuildObject(s, next), s)
    }
    if (isZodSchemaType(s, 'ZodArray')) {
      const element = getArrayElement(s)
      if (element === undefined) return s
      return carryArrayChecks(rebuildArray(s, recurse(element)), s)
    }
    if (isZodSchemaType(s, 'ZodSet')) {
      const valueType = getSetValueType(s)
      if (valueType === undefined) return s
      return carrySetChecks(rebuildSet(s, recurse(valueType)), s)
    }
    if (isZodSchemaType(s, 'ZodTuple')) {
      const items = getTupleItems(s).map(recurse)
      return rebuildTuple(s, items)
    }
    if (isZodSchemaType(s, 'ZodRecord')) {
      const keyType = getRecordKeyType(s)
      const valueType = getRecordValueType(s)
      if (valueType === undefined) return s
      const next = recurse(valueType)
      return keyType === undefined ? rebuildRecord(s, next) : rebuildRecord(s, next, keyType)
    }
    if (isZodSchemaType(s, 'ZodUnion')) {
      const options = getUnionOptions(s).map(recurse)
      return rebuildUnion(s, options)
    }
    if (isZodSchemaType(s, 'ZodDiscriminatedUnion')) {
      const discKey = getDiscriminator(s)
      const options = getDiscriminatedOptions(s).map(
        (o) => recurse(o) as z.ZodObject<z.ZodRawShape>
      )
      if (discKey === undefined || options.length === 0) return s
      return rebuildDiscriminatedUnion(s, options)
    }
    if (isZodSchemaType(s, 'ZodIntersection')) {
      const left = getIntersectionLeft(s)
      const right = getIntersectionRight(s)
      if (left === undefined || right === undefined) return s
      return rebuildIntersection(s, recurse(left), recurse(right))
    }

    // Leaves: pass through unchanged. ZodEffects is the only carrier
    // of async behaviour in v3; rebuilding leaves would drop their
    // declared `_def.checks` (`.min(3)` / `.email()` / etc.) with no
    // upside.
    return s
  }

  return recurse(schema)
}

interface ZodArrayLengthSlot {
  value: number
  message?: string
}

function readArrayLength(
  schema: z.ZodTypeAny,
  key: 'minLength' | 'maxLength' | 'exactLength'
): ZodArrayLengthSlot | undefined {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def
  const slot = def?.[key]
  if (slot === null || slot === undefined) return undefined
  return slot as ZodArrayLengthSlot
}

function readSetSize(
  schema: z.ZodTypeAny,
  key: 'minSize' | 'maxSize'
): ZodArrayLengthSlot | undefined {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def
  const slot = def?.[key]
  if (slot === null || slot === undefined) return undefined
  return slot as ZodArrayLengthSlot
}

function readObjectUnknownKeys(
  schema: z.ZodTypeAny
): 'strict' | 'passthrough' | 'strip' | undefined {
  const def = (schema as unknown as { _def?: { unknownKeys?: unknown } })._def
  const v = def?.unknownKeys
  if (v === 'strict' || v === 'passthrough' || v === 'strip') return v
  return undefined
}

function readObjectCatchall(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = (schema as unknown as { _def?: { catchall?: unknown } })._def
  const ca = def?.catchall
  if (ca === undefined || ca === null) return undefined
  // v3 stores a `ZodNever` placeholder when no catchall was set; the
  // rebuild can skip in that case (`.catchall(z.never())` is the
  // default shape and applying it explicitly is a no-op).
  if (
    typeof ca === 'object' &&
    (ca as { _def?: { typeName?: string } })._def?.typeName === 'ZodNever'
  ) {
    return undefined
  }
  return ca as z.ZodTypeAny
}

/**
 * Re-apply `.min(n)` / `.max(n)` / `.length(n)` from `original` to
 * `rebuilt`. v3 stores these as standalone `_def.minLength /
 * .maxLength / .exactLength` slots (not on `_def.checks`), so they
 * silently drop when the array is rebuilt via `z.array(inner)`.
 * Mirrors v4's `carryChecks` (`strip.ts:52`).
 */
function carryArrayChecks(
  rebuilt: z.ZodArray<z.ZodTypeAny>,
  original: z.ZodTypeAny
): z.ZodArray<z.ZodTypeAny> {
  let next = rebuilt
  const min = readArrayLength(original, 'minLength')
  if (min !== undefined) next = next.min(min.value, min.message)
  const max = readArrayLength(original, 'maxLength')
  if (max !== undefined) next = next.max(max.value, max.message)
  const exact = readArrayLength(original, 'exactLength')
  if (exact !== undefined) next = next.length(exact.value, exact.message)
  return next
}

function carrySetChecks(
  rebuilt: z.ZodSet<z.ZodTypeAny>,
  original: z.ZodTypeAny
): z.ZodSet<z.ZodTypeAny> {
  let next = rebuilt
  const min = readSetSize(original, 'minSize')
  if (min !== undefined) next = next.min(min.value, min.message)
  const max = readSetSize(original, 'maxSize')
  if (max !== undefined) next = next.max(max.value, max.message)
  return next
}

function carryObjectChecks(
  rebuilt: z.ZodObject<z.ZodRawShape>,
  original: z.ZodTypeAny
): z.ZodObject<z.ZodRawShape> {
  let next = rebuilt
  const unknownKeys = readObjectUnknownKeys(original)
  if (unknownKeys === 'strict') next = next.strict()
  else if (unknownKeys === 'passthrough') next = next.passthrough()
  const catchall = readObjectCatchall(original)
  if (catchall !== undefined) next = next.catchall(catchall)
  return next
}
