/**
 * Version-faithful, prototype-preserving reconstruction of Zod v3
 * schema nodes.
 *
 * The adapter slims and strips schemas by rebuilding container and
 * wrapper nodes around already-processed children. Building those
 * replacements through the ambient `z.object()` / `z.array()` / ...
 * constructors is a latent version-skew hazard: the published bundle
 * rewrites `import 'zod-v3'` back to `import 'zod'` (see
 * `build.config.ts`), so the resolved `z` is whichever Zod the
 * consumer's dependency tree hoists. When that is a mismatched second
 * major (a hoisted Zod v4 beside the Zod v3 a schema was authored
 * with), the freshly built nodes carry the wrong internal shape, the
 * v3 slim walk reads an empty accept-set, and every write is silently
 * rejected.
 *
 * These helpers sidestep the resolved version entirely. Each derives
 * the replacement from the ORIGINAL node the consumer handed in:
 * `Object.create(Object.getPrototypeOf(original))` keeps the node on
 * its authoring Zod's prototype (so `instanceof`, `_parse`, and every
 * getter stay that version's), and only the changed `_def` children
 * are patched. No ambient constructor is ever called, so a second Zod
 * in the tree cannot poison the rebuild.
 *
 * Shallow by design: the children passed in are already processed, so
 * unlike `cloneSchemaDeep` there is no recursive descent here. The
 * field names written below are the same ones `introspect.ts` reads.
 */
import type { z } from 'zod-v3'
import { getDiscriminatedOptions, getDiscriminatedOptionsMap } from './introspect'

// The internal `_def` carrier. Reads go through `introspect.ts`; the
// writes below are the one sanctioned place outside it that mirrors
// the same field names back onto a node.
interface DefCarrier {
  _def: Record<string, unknown>
}

/**
 * Shallow, prototype-preserving rebuild. Returns a new node on
 * `original`'s prototype whose `_def` is `original._def` with
 * `defPatch` merged over it. `original._def` is never mutated — the
 * spread allocates a fresh object.
 *
 * No own properties are copied. The Zod constructor binds `parse` /
 * `safeParse` / `default` / `catch` / ... as own properties bound to
 * the instance that built them, so copying them would bind the
 * rebuilt node's methods to `original`. Leaving them off lets every
 * method resolve through the prototype with a dynamic `this`, which
 * is exactly what reads the patched `_def`.
 */
function rebuildWithDef<T extends z.ZodTypeAny>(original: T, defPatch: Record<string, unknown>): T {
  const node = Object.create(Object.getPrototypeOf(original)) as T & DefCarrier
  node._def = { ...(original as unknown as DefCarrier)._def, ...defPatch }
  return node
}

/**
 * Rebuild a `ZodObject` around a new shape. The shape is stored as the
 * `_def.shape` thunk Zod expects (lazy, for self-referential schemas).
 *
 * `ZodObject` memoises `{ shape, keys }` on an own `_cached` slot its
 * constructor seeds to `null`. `Object.create` skips the constructor,
 * so seed it here; without it `_getCached` returns the `undefined`
 * sentinel and the first parse throws on `cached.shape`.
 */
export function rebuildObject(
  original: z.ZodTypeAny,
  shape: z.ZodRawShape
): z.ZodObject<z.ZodRawShape> {
  // `unknownKeys` resets to the fresh-constructor default ('strip') so
  // the slim rebuild matches the old `z.object(shape)` exactly: a
  // `.strict()` root must not start rejecting unknown keys on the
  // lenient slim parse. The strip-async pass re-applies the real
  // unknown-keys / catchall policy via `carryObjectChecks`, which reads
  // them from the ORIGINAL, so that path is unchanged.
  const node = rebuildWithDef(original, { shape: () => shape, unknownKeys: 'strip' })
  ;(node as unknown as { _cached: unknown })._cached = null
  return node as unknown as z.ZodObject<z.ZodRawShape>
}

/**
 * Rebuild a `ZodArray` around a new element schema (`_def.type`). The
 * standalone `.min` / `.max` / `.length` slots reset to null (the
 * fresh-constructor default): the slim path lenient-parses empty seed
 * arrays and must not keep a length floor. `carryArrayChecks` restores
 * the real bounds from the original on the strip-async path.
 */
export function rebuildArray(
  original: z.ZodTypeAny,
  element: z.ZodTypeAny
): z.ZodArray<z.ZodTypeAny> {
  return rebuildWithDef(original, {
    type: element,
    minLength: null,
    maxLength: null,
    exactLength: null,
  }) as unknown as z.ZodArray<z.ZodTypeAny>
}

/** Rebuild a `ZodSet` around a new value schema (`_def.valueType`); reset the size bounds like a fresh `z.set`. */
export function rebuildSet(
  original: z.ZodTypeAny,
  valueType: z.ZodTypeAny
): z.ZodSet<z.ZodTypeAny> {
  return rebuildWithDef(original, {
    valueType,
    minSize: null,
    maxSize: null,
  }) as unknown as z.ZodSet<z.ZodTypeAny>
}

/**
 * Rebuild a `ZodRecord` around a new value schema, optionally a new
 * key schema. When `keyType` is omitted the original's key carries
 * through the spread (Zod's one-arg `z.record` defaults it to a
 * string key, which the original already encodes).
 */
export function rebuildRecord(
  original: z.ZodTypeAny,
  valueType: z.ZodTypeAny,
  keyType?: z.ZodTypeAny
): z.ZodRecord<z.ZodTypeAny, z.ZodTypeAny> {
  const patch: Record<string, unknown> = { valueType }
  if (keyType !== undefined) patch['keyType'] = keyType
  return rebuildWithDef(original, patch) as unknown as z.ZodRecord<z.ZodTypeAny, z.ZodTypeAny>
}

/** Rebuild a `ZodTuple` around new items (`_def.items`); reset the variadic `_def.rest` like a fresh `z.tuple`. */
export function rebuildTuple(
  original: z.ZodTypeAny,
  items: readonly z.ZodTypeAny[]
): z.ZodTuple<[z.ZodTypeAny, ...z.ZodTypeAny[]]> {
  return rebuildWithDef(original, { items, rest: null }) as unknown as z.ZodTuple<
    [z.ZodTypeAny, ...z.ZodTypeAny[]]
  >
}

/** Rebuild a `ZodUnion` around new options (`_def.options`). */
export function rebuildUnion(
  original: z.ZodTypeAny,
  options: readonly z.ZodTypeAny[]
): z.ZodUnion<[z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]> {
  return rebuildWithDef(original, { options }) as unknown as z.ZodUnion<
    [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
  >
}

/** Rebuild a `ZodIntersection` around new sides (`_def.left` / `_def.right`). */
export function rebuildIntersection(
  original: z.ZodTypeAny,
  left: z.ZodTypeAny,
  right: z.ZodTypeAny
): z.ZodIntersection<z.ZodTypeAny, z.ZodTypeAny> {
  return rebuildWithDef(original, { left, right }) as unknown as z.ZodIntersection<
    z.ZodTypeAny,
    z.ZodTypeAny
  >
}

/**
 * Rebuild a transparent wrapper (`ZodOptional` / `ZodNullable`) around
 * a new inner schema (`_def.innerType`). The wrapper kind is taken
 * from `original`'s prototype, so one helper serves both.
 */
export function rebuildWrapperInner<T extends z.ZodTypeAny>(original: T, inner: z.ZodTypeAny): T {
  return rebuildWithDef(original, { innerType: inner })
}

/** Rebuild a `ZodLazy` whose getter resolves to an already-processed target (`_def.getter`). */
export function rebuildLazy(original: z.ZodTypeAny, target: z.ZodTypeAny): z.ZodLazy<z.ZodTypeAny> {
  return rebuildWithDef(original, { getter: () => target }) as unknown as z.ZodLazy<z.ZodTypeAny>
}

/**
 * Clear a primitive leaf's refinement checks (`_def.checks`) while
 * preserving everything else on the def. Notably `_def.coerce` carries
 * through: a coercing slim leaf is strictly more permissive on the
 * lenient slim pass, and the write gate short-circuits coerce leaves
 * before they reach this shape, so keeping the flag is both safe and
 * more faithful than dropping it (which a fresh `z.string()` would).
 */
export function stripLeafChecks<T extends z.ZodTypeAny>(original: T): T {
  return rebuildWithDef(original, { checks: [] })
}

/**
 * Rebuild a `ZodDiscriminatedUnion` around new options. Both
 * `_def.options` and `_def.optionsMap` (what the DU's `_parse` reads to
 * route a value to its branch) are swapped. Rebuilding the map is
 * load-bearing: a swap-options-only rebuild would leave the original
 * map pointing at the unslimmed options, and every empty-default write
 * would route to a branch that still carries its refinements and be
 * rejected.
 *
 * The new map reuses the original's: zod already built it at
 * construction (with its full discriminator extraction over literal /
 * enum / native-enum / optional / nullable / default / catch / ...),
 * so we walk it and remap each value to the matching NEW option. The
 * new options are produced in the original options' order at every call
 * site, so an original option's index selects its replacement. This
 * keeps zod's discriminator logic as the single source of truth rather
 * than re-deriving it here.
 */
export function rebuildDiscriminatedUnion(
  original: z.ZodTypeAny,
  options: readonly z.AnyZodObject[]
): z.ZodTypeAny {
  const originalOptions = getDiscriminatedOptions(original)
  const originalMap = getDiscriminatedOptionsMap(original)
  const optionsMap = new Map<unknown, z.AnyZodObject>()
  if (originalMap !== undefined) {
    for (const [value, originalOption] of originalMap) {
      const index = originalOptions.indexOf(originalOption)
      const replacement = index >= 0 ? options[index] : undefined
      if (replacement !== undefined) optionsMap.set(value, replacement)
    }
  }
  return rebuildWithDef(original, { options, optionsMap })
}
