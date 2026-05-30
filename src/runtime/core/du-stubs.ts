import type { AbstractSchema } from '../types/types-api'
import { __DEV__ } from './dev'
import { type Path } from './paths'
import { safeAssign } from './safe-assign'

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
 * same walker. Pollution defense routes every untrusted-key write
 * through `safeAssign`, which uses `Object.defineProperty` for the
 * `__proto__` key (own data property, no chain mutation) and plain
 * bracket-assign for every other key. Legitimate fields literally
 * named `prototype` / `constructor` / `__proto__` round-trip the same
 * way every other key does.
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
      // The disc-only stub routes the discriminator-key write through
      // `safeAssign` so a schema using `z.discriminatedUnion('__proto__', …)`
      // (vanishingly rare, but possible) lands the disc value as an
      // own data property instead of invoking the inherited setter.
      const stub: Record<string, unknown> = {}
      safeAssign(stub, du.discriminatorKey, discValue)
      return stub
    }
  }
  // SSR-walk container. The `safeAssign` per key lands a literal
  // `__proto__` segment as an own data property; every other key
  // takes the plain bracket-assign branch. A hostile payload carrying
  // `__proto__` can't reassign the container's prototype chain.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(rec)) {
    safeAssign(out, k, walkDuStubs(schema, rec[k], [...path, k], warned))
  }
  return out
}
