import type { AbstractSchema } from '../types/types-api'
import { __DEV__ } from './dev'
import { type Path } from './paths'

/**
 * Walk an `initialData` / restored payload and collapse any object whose
 * position carries a discriminated union but whose `discriminator` value
 * isn't a known variant literal into a stub holding only the
 * discriminator key. Drops any first-variant fields that snuck in past
 * the parser to keep the form value structurally consistent with the
 * schema's view of "no variant selected yet."
 *
 * The walker is intentionally pure — every dependency (schema, data,
 * base path, warning-set policy) is a parameter, not a closure capture
 * — so `createFormStore` can call it both at construction (for the
 * authored defaults) and inside `reshapeUnionAtPath` (for runtime
 * variant transitions) without sharing state across calls.
 *
 * SSR hydration payloads (third-party storage JSON) flow through the
 * same walker. Pollution defense is structural: every intermediate
 * container is allocated via `Object.create(null)` so the `out[k] =
 * …` write is a plain own-property assignment regardless of `k`.
 * Legitimate fields literally named `prototype` / `constructor` /
 * `__proto__` round-trip the same way every other key does.
 *
 * `warn: true` opts in to a `__DEV__`-only one-shot per
 * `(dotted-path, disc-value)` console warning when a non-blank
 * discriminator value falls back to a stub — typo-style bugs where the
 * consumer wrote `kind: 'BAD'` and got a stub by accident. The blank
 * literals `''` / `0` / `0n` / `false` / `null` are the intentional
 * "no variant selected" signal from `expandUnsetAt` and never warn.
 */
export function applyDuStubs(
  schema: AbstractSchema<unknown, unknown>,
  data: unknown,
  options: { warn?: boolean; basePath?: Path } = {}
): unknown {
  const warned = options.warn === true ? new Set<string>() : undefined
  return walkDuStubs(schema, data, options.basePath ?? [], warned)
}

function walkDuStubs(
  schema: AbstractSchema<unknown, unknown>,
  value: unknown,
  path: Path,
  warned: Set<string> | undefined
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    typeof value === 'function'
  ) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => walkDuStubs(schema, item, [...path, i], warned))
  }
  const rec = value as Record<string, unknown>
  const du = schema.getUnionDiscriminatorAtPath(path)
  if (du !== undefined) {
    const discValue = rec[du.discriminatorKey]
    if (discValue !== undefined && !du.isVariantSelected(discValue)) {
      // Kind-blank stub (`''` / `0` / `0n` / `false` / `null`) is the
      // intentional "no variant selected yet" signal from
      // `expandUnsetAt` — don't warn. The warn is for typo-style bugs
      // where the user wrote `kind: 'BAD'` and got a stub by accident.
      const isKindBlank =
        discValue === '' ||
        discValue === 0 ||
        discValue === 0n ||
        discValue === false ||
        discValue === null
      if (!isKindBlank && warned !== undefined && __DEV__) {
        const dotted = path.map((s) => String(s)).join('.') || '(root)'
        const key = `${dotted}::${String(discValue)}`
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(
            `[attaform] defaultValues at '${dotted}' carries discriminator ` +
              `'${du.discriminatorKey}=${JSON.stringify(discValue)}' which isn't a known variant. ` +
              `Form mounts in a stub holding only the discriminator key. Validation will surface the mismatch.`
          )
        }
      }
      // The disc-only stub also uses a prototype-less container so a
      // schema whose discriminator key happens to be `__proto__` /
      // `constructor` / `prototype` (vanishingly rare, but possible
      // via `z.discriminatedUnion('prototype', …)`) lands the disc
      // value as an ordinary own-property pair.
      const stub: Record<string, unknown> = Object.create(null)
      stub[du.discriminatorKey] = discValue
      return stub
    }
  }
  // Prototype-less SSR-walk container. Pairs with the `setAtPath` and
  // persistence merges already proto-less, so an SSR payload carrying
  // a legitimate `__proto__` / `constructor` / `prototype` own
  // property (or a hostile one) lands as a plain own-property pair
  // with no path to `Object.prototype`.
  const out: Record<string, unknown> = Object.create(null)
  for (const k of Object.keys(rec)) {
    out[k] = walkDuStubs(schema, rec[k], [...path, k], warned)
  }
  return out
}
