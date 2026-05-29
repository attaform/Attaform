import { z } from 'zod-v3'

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
  unwrapEffectsSource,
  unwrapInner,
  unwrapLazy,
  unwrapPipeIn,
} from './introspect'
import { isZodSchemaType } from './helpers'

/**
 * v3 analogue of v4's `strip.ts stripAsyncChecks` (`zod-v4/strip.ts:212`).
 * Walks the schema tree once, rebuilding containers + wrappers and
 * dropping every `ZodEffects` it encounters (refinement, transform, or
 * preprocess). Container-level constraints (`.min(n)` / `.max(n)` /
 * `.length(n)` / `.strict()` / `.passthrough()` / `.catchall(...)`) are
 * re-applied via the per-kind `carry*` helpers below so a rebuilt
 * `z.array(z.string()).min(1)` still rejects `[]`.
 *
 * Why drop sync refines too: v3 wraps `.refine(asyncFn, …)` predicates
 * inside a sync closure (see `introspect.ts isAsyncEffect`), so the
 * adapter cannot statically distinguish sync from async refinements.
 * The strip pass is the construction-time fallback for the case where
 * the original `safeParse` threw "Async refinement encountered during
 * synchronous parse" — at that moment all we know is *some* refine is
 * async, but not which. Dropping every `ZodEffects` is the safest
 * recovery: we lose sync refine seeding in mixed forms, but container
 * and leaf checks still surface.
 *
 * Adapter-divergence note (Phase 12 part 2 / ADAPT-D4 deferred):
 * this stays per-adapter rather than dedup-ing into a shared core
 * walker. v3's "drop every ZodEffects" policy is irreducibly
 * different from v4's "filter by isAsyncCheck per check site" — v4
 * knows which checks are async (`check.def.fn.constructor.name`)
 * and rebuilds the leaf with sync checks intact; v3 has no such
 * accessor and has to drop the wrapper wholesale. A unified walker
 * would need to either parameterise five separate behavior knobs
 * (yielding a walker bigger than the two it replaces) or special-
 * case v3's effects-dropping at the call site (defeating the dedup).
 * The cross-reference on v4's `strip.ts:stripAsyncChecks` records the
 * same rationale.
 *
 * Cycle-safe via a per-pass `WeakSet` so a pathological
 * `z.lazy(() => self)` schema terminates.
 *
 * Used by `getDefaultValues` strict mode in `index.ts`; the
 * post-mount async pass picks up the verdicts this strip path can't
 * surface (full sync + async refines via `safeParseAsync`).
 */
export function stripAsyncChecks(schema: z.ZodTypeAny): z.ZodTypeAny {
  const seen = new WeakSet<object>()

  function recurse(s: z.ZodTypeAny): z.ZodTypeAny {
    const candidate = s as unknown
    if (typeof candidate !== 'object' || candidate === null) return s
    if (seen.has(candidate)) return s
    seen.add(candidate)

    // ZodEffects: drop the wrapper. The source schema returned by
    // `unwrapEffectsSource` is the pre-refine / pre-transform shape;
    // recurse into it so nested effects deeper in the tree also drop.
    if (isZodSchemaType(s, 'ZodEffects')) {
      const inner = unwrapEffectsSource(s)
      return inner === undefined ? s : recurse(inner)
    }

    // Transparent wrappers: recurse the inner and rewrap.
    if (isZodSchemaType(s, 'ZodOptional')) {
      const inner = unwrapInner(s)
      return inner === undefined ? s : z.optional(recurse(inner))
    }
    if (isZodSchemaType(s, 'ZodNullable')) {
      const inner = unwrapInner(s)
      return inner === undefined ? s : z.nullable(recurse(inner))
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
      return z.lazy(() => stripped)
    }
    if (isZodSchemaType(s, 'ZodPipeline')) {
      // Pipelines carry transforms whose output shape is load-bearing
      // for the downstream schema's input. The Path-A fallback only
      // runs after the original parse already threw, so leaving pipes
      // in place would re-throw on retry; recurse the input side
      // alone so the parse can proceed against the structural shape.
      // Matches v4's conservative pipe handling in `stripAsyncChecks`
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
      return carryObjectChecks(z.object(next), s)
    }
    if (isZodSchemaType(s, 'ZodArray')) {
      const element = getArrayElement(s)
      if (element === undefined) return s
      return carryArrayChecks(z.array(recurse(element)), s)
    }
    if (isZodSchemaType(s, 'ZodSet')) {
      const valueType = getSetValueType(s)
      if (valueType === undefined) return s
      return carrySetChecks(z.set(recurse(valueType)), s)
    }
    if (isZodSchemaType(s, 'ZodTuple')) {
      const items = getTupleItems(s).map(recurse)
      // z.tuple requires [T, ...T[]] but the runtime accepts an array.
      const rebuilt = z.tuple(items as [z.ZodTypeAny, ...z.ZodTypeAny[]])
      return rebuilt
    }
    if (isZodSchemaType(s, 'ZodRecord')) {
      const keyType = getRecordKeyType(s)
      const valueType = getRecordValueType(s)
      if (valueType === undefined) return s
      const next = recurse(valueType)
      return keyType === undefined
        ? z.record(next as z.ZodTypeAny)
        : z.record(keyType as z.ZodString, next as z.ZodTypeAny)
    }
    if (isZodSchemaType(s, 'ZodUnion')) {
      const options = getUnionOptions(s).map(recurse)
      return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
    }
    if (isZodSchemaType(s, 'ZodDiscriminatedUnion')) {
      const discKey = getDiscriminator(s)
      const options = getDiscriminatedOptions(s).map(
        (o) => recurse(o) as z.ZodObject<z.ZodRawShape>
      )
      if (discKey === undefined || options.length === 0) return s
      return z.discriminatedUnion(
        discKey,
        options as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]]
      )
    }
    if (isZodSchemaType(s, 'ZodIntersection')) {
      const left = getIntersectionLeft(s)
      const right = getIntersectionRight(s)
      if (left === undefined || right === undefined) return s
      return z.intersection(recurse(left), recurse(right))
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
