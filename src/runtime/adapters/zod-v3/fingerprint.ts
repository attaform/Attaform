import type { z } from 'zod-v3'
import { canonicalStringify } from '../../core/canonical-stringify'

/**
 * Compute a structural fingerprint for a Zod v3 schema.
 *
 * Same contract as the v4 counterpart — deterministic across
 * reference-distinct but structurally-equal schemas, key-order-
 * insensitive for `z.object` shapes, membership-order-insensitive
 * for `z.union` options, idempotent across calls. See
 * `src/runtime/adapters/zod-v4/fingerprint.ts` for the full
 * rationale and the list of compromises (function-valued
 * refinements / transforms / non-deterministic default factories
 * collapse to opaque `fn:*` sentinels).
 *
 * Caching is per-call, not module-global: cycles mean a cached
 * mid-traversal result from one call is invalid for another
 * (the `<cyclic>` sentinel's meaning depends on the starting
 * node). A WeakSet guards against cycles introduced by `z.lazy`.
 */

type V3Schema = z.ZodTypeAny

interface V3Def {
  readonly typeName?: string
  readonly shape?: () => Record<string, V3Schema>
  readonly type?: V3Schema
  readonly keyType?: V3Schema
  readonly valueType?: V3Schema
  readonly items?: readonly V3Schema[]
  readonly options?: readonly V3Schema[]
  readonly discriminator?: string
  // ZodEnum stores its admitted values as an array; ZodNativeEnum
  // stores them as the enum OBJECT (`{Red: 'red', '0': 'Red'}` for a
  // numeric enum). The fingerprint walker handles the two shapes in
  // separate branches.
  readonly values?: readonly unknown[] | Record<string, unknown>
  readonly value?: unknown
  readonly innerType?: V3Schema
  readonly defaultValue?: () => unknown
  readonly checks?: readonly unknown[]
  readonly schema?: V3Schema
  readonly effect?: { readonly type?: string }
  readonly getter?: () => V3Schema
  readonly left?: V3Schema
  readonly right?: V3Schema
  readonly catchValue?: () => unknown
  // ZodPipeline stores its input + output sides on `in` / `out`
  // respectively — NOT on `schema`. The pre-fix walker read `schema`
  // (always `undefined`) and emitted `ZodPipeline(?)` for every
  // pipeline.
  readonly in?: V3Schema
  readonly out?: V3Schema
}

const cyclicSentinel = '<cyclic>'

export function fingerprintZodSchema(schema: V3Schema): string {
  const cache = new WeakMap<object, string>()
  const inProgress = new WeakSet<object>()
  return visit(schema, cache, inProgress)
}

function visit(
  schema: V3Schema,
  cache: WeakMap<object, string>,
  inProgress: WeakSet<object>
): string {
  const key = schema as unknown as object
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  if (inProgress.has(key)) return cyclicSentinel
  inProgress.add(key)
  try {
    const computed = computeFingerprint(schema, cache, inProgress)
    cache.set(key, computed)
    return computed
  } finally {
    inProgress.delete(key)
  }
}

function getDef(schema: V3Schema): V3Def {
  return (schema as unknown as { _def: V3Def })._def
}

function computeFingerprint(
  schema: V3Schema,
  cache: WeakMap<object, string>,
  inProgress: WeakSet<object>
): string {
  const def = getDef(schema)
  const kind = def.typeName ?? 'ZodUnknown'
  const recurse = (child: V3Schema): string => visit(child, cache, inProgress)

  switch (kind) {
    case 'ZodString':
    case 'ZodNumber':
    case 'ZodBigInt':
    case 'ZodDate':
      return `${kind}${formatChecks(def.checks)}`

    case 'ZodBoolean':
    case 'ZodNull':
    case 'ZodUndefined':
    case 'ZodAny':
    case 'ZodUnknown':
    case 'ZodNaN':
    case 'ZodVoid':
    case 'ZodNever':
      return kind

    case 'ZodLiteral':
      return `ZodLiteral:${canonicalStringify(def.value)}`

    case 'ZodEnum': {
      // ZodEnum stores its admitted values as an array on `_def.values`.
      // Sort + canonicalStringify for a deterministic fingerprint.
      const values = Array.isArray(def.values) ? def.values : []
      const sorted = [...values].sort((a, b) => {
        const as = String(a)
        const bs = String(b)
        return as < bs ? -1 : as > bs ? 1 : 0
      })
      return `ZodEnum:${canonicalStringify(sorted)}`
    }

    case 'ZodNativeEnum': {
      // ZodNativeEnum stores the enum OBJECT on `_def.values` (e.g.
      // `{Red: 'red'}` for a string enum or `{A: 0, '0': 'A'}` for a
      // numeric enum). The pre-fix walker shared the ZodEnum branch
      // which did `[...values]` — that throws `TypeError: not
      // iterable` on the object. Use `Object.values` to extract the
      // admitted runtime members; numeric enums include their
      // reverse-mapped string keys, which is fine for fingerprint
      // determinism (both forms are valid Zod inputs).
      const values =
        def.values && typeof def.values === 'object' && !Array.isArray(def.values)
          ? Object.values(def.values)
          : []
      const sorted = [...values].sort((a, b) => {
        const as = String(a)
        const bs = String(b)
        return as < bs ? -1 : as > bs ? 1 : 0
      })
      return `ZodNativeEnum:${canonicalStringify(sorted)}`
    }

    case 'ZodObject': {
      const shape = readShapeSafely(def)
      const sortedEntries = Object.entries(shape)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${recurse(v)}`)
      // Object-level `formatChecks` matches v4's `object{…}${formatChecks(schema)}`
      // (`fingerprint.ts:148`). ZodObject rarely carries `_def.checks`
      // in v3 — the call is structurally for parity rather than
      // expected-to-fire — but consumers who reach through a custom
      // ZodObject builder that stores extra constraints get them
      // surfaced symmetrically.
      return `ZodObject{${sortedEntries.join(',')}}${formatChecks(def.checks)}`
    }

    case 'ZodArray':
      return `ZodArray[${def.type === undefined ? '?' : recurse(def.type)}]${formatChecks(def.checks)}`

    case 'ZodTuple': {
      const items = def.items ?? []
      return `ZodTuple[${items.map(recurse).join(',')}]`
    }

    case 'ZodRecord': {
      const keyPart = def.keyType === undefined ? '?' : recurse(def.keyType)
      const valuePart = def.valueType === undefined ? '?' : recurse(def.valueType)
      return `ZodRecord<${keyPart},${valuePart}>`
    }

    case 'ZodUnion': {
      const options = (def.options ?? []).map(recurse).sort()
      return `ZodUnion(${options.join('|')})`
    }

    case 'ZodDiscriminatedUnion': {
      const disc = def.discriminator ?? '?'
      const options = (def.options ?? []).map(recurse).sort()
      return `ZodDiscriminatedUnion[${JSON.stringify(disc)}](${options.join('|')})`
    }

    case 'ZodOptional': {
      const inner = def.innerType
      return inner === undefined ? 'ZodOptional(?)' : `ZodOptional(${recurse(inner)})`
    }

    case 'ZodNullable': {
      const inner = def.innerType
      return inner === undefined ? 'ZodNullable(?)' : `ZodNullable(${recurse(inner)})`
    }

    case 'ZodDefault': {
      const inner = def.innerType
      // v3 stores defaults as a factory: `defaultValue: () => X`.
      // Call it twice and compare with Object.is — non-deterministic
      // factories (`() => new Date()`) return distinct objects each
      // call, so we collapse to `fn:*` to stay idempotent. Pure
      // factories that return the same primitive / cached reference
      // serialise normally.
      return `ZodDefault[${defaultFactoryRepr(def.defaultValue)}](${
        inner === undefined ? '?' : recurse(inner)
      })`
    }

    case 'ZodReadonly': {
      const inner = def.innerType
      return inner === undefined ? 'ZodReadonly(?)' : `ZodReadonly(${recurse(inner)})`
    }

    case 'ZodEffects': {
      // `.refine` / `.transform` / `.preprocess` — the effect function
      // isn't stably hashable. We can distinguish effect kinds (refine
      // vs transform) via `def.effect.type` and fold that into the
      // fingerprint, but the function body collapses to an opaque
      // sentinel.
      const effectType = def.effect?.type ?? 'effect'
      const inner = def.schema
      return `ZodEffects:${effectType}:fn:*(${inner === undefined ? '?' : recurse(inner)})`
    }

    case 'ZodPipeline': {
      // Internally `z.pipe(a, b)` — `.in` and `.out` live on the def
      // (NOT `.schema`). The pre-fix walker read `def.schema`
      // (undefined for a pipeline) so every pipeline collapsed to
      // `ZodPipeline(?)`. Read the input side first (mirrors v4's
      // `unwrapPipe` which returns `in ?? out`); the output side is
      // a derived shape rather than a consumer-authored schema.
      const inner = def.in ?? def.out
      return inner === undefined ? 'ZodPipeline(?)' : `ZodPipeline(${recurse(inner)})`
    }

    case 'ZodCatch': {
      const inner = def.innerType ?? def.schema
      const catchRepr = defaultFactoryRepr(def.catchValue)
      return `ZodCatch[${catchRepr}](${inner === undefined ? '?' : recurse(inner)})`
    }

    case 'ZodLazy': {
      const resolve = def.getter
      if (typeof resolve !== 'function') return 'ZodLazy(?)'
      try {
        const inner = resolve()
        return `ZodLazy(${recurse(inner)})`
      } catch {
        return 'ZodLazy(?)'
      }
    }

    case 'ZodIntersection': {
      const leftPart = def.left === undefined ? '?' : recurse(def.left)
      const rightPart = def.right === undefined ? '?' : recurse(def.right)
      const parts = [leftPart, rightPart].sort()
      return `ZodIntersection(${parts.join('&')})`
    }

    case 'ZodSet': {
      // ZodSet stores its element type on `_def.valueType` (same slot
      // ZodRecord uses for its value type). The pre-fix walker fell
      // through to the opaque default branch, so `z.set(z.string())`
      // and `z.set(z.number())` collapsed to the same `ZodSet:*`.
      // Mirrors v4's `set<element>${formatChecks(schema)}`.
      const inner = def.valueType
      return inner === undefined
        ? 'ZodSet(?)'
        : `ZodSet<${recurse(inner)}>${formatChecks(def.checks)}`
    }

    case 'ZodBranded': {
      // ZodBranded stores its inner on `_def.type` (the v3 quirk; v4's
      // brand is type-only). The pre-fix walker fell through to the
      // opaque default branch and lost the inner's shape entirely, so
      // `z.string().brand<'A'>()` and `z.number().brand<'B'>()`
      // collapsed to the same `ZodBranded:*`. Brand annotations are
      // type-level only at runtime, so emit just the inner's
      // fingerprint with a transparent wrapper.
      const inner = def.type
      return inner === undefined ? 'ZodBranded(?)' : `ZodBranded(${recurse(inner)})`
    }

    // Structural opacity — schemas whose runtime behaviour isn't
    // introspectable via `_def` fall here. Still distinguishable
    // from other kinds by the returned string.
    case 'ZodPromise':
    case 'ZodFunction':
    case 'ZodMap':
    case 'ZodSymbol':
    default:
      return `${kind}:*`
  }
}

function readShapeSafely(def: V3Def): Record<string, V3Schema> {
  if (typeof def.shape !== 'function') return {}
  try {
    return def.shape()
  } catch {
    return {}
  }
}

/**
 * Render a v3 default / catch factory. Called twice; if the two
 * results differ (by `Object.is`), the factory is non-deterministic
 * and we collapse to `fn:*` to preserve idempotence. Same fix as
 * v4's `defaultValueRepr` — factories like `() => new Date()` would
 * otherwise make the fingerprint time-dependent.
 */
function defaultFactoryRepr(factory: (() => unknown) | undefined): string {
  if (typeof factory !== 'function') return 'none'
  let first: unknown
  let second: unknown
  try {
    first = factory()
    second = factory()
  } catch {
    return 'fn:*'
  }
  if (!Object.is(first, second)) return 'fn:*'
  if (typeof first === 'function') return 'fn:*'
  return canonicalStringify(first)
}

function formatChecks(checks: readonly unknown[] | undefined): string {
  if (!Array.isArray(checks) || checks.length === 0) return ''
  const parts = checks.map((c) => canonicalStringify(c)).sort()
  return `[${parts.join(';')}]`
}
