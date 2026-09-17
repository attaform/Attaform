import type { z } from 'zod'
import {
  getDiscriminatedOptions,
  getIntersectionLeft,
  getIntersectionRight,
  kindOf,
  unwrapInner,
  unwrapPipe,
} from './introspect'

/**
 * Peel optional, nullable, default, readonly, catch, pipe and
 * intersection wrappers off a schema to reach the innermost
 * discriminated union, or `undefined` when there is none. The
 * default-values walker and the discriminator-aware reshape both read
 * it, so that
 *
 *   z.discriminatedUnion('status', [...]).optional().default({...})
 *   z.discriminatedUnion('kind', [...]).catch({ kind: 'a', ... })
 *   z.intersection(z.discriminatedUnion('kind', [...]), sharedSchema)
 *
 * still reach the DU. Catch is load-bearing here: the fallback exists
 * to fail open to a usable variant, so the runtime must still know
 * which variant the catch-default selects (otherwise it falls back to
 * a plain write and the variant-aware reshape never fires).
 * Intersections with a DU on EXACTLY ONE side resolve to that side;
 * intersections of two distinct DUs are ambiguous and return
 * `undefined` so the runtime falls back to plain writes.
 */
export function unwrapToDiscriminatedUnion(schema: z.ZodType): z.ZodType | undefined {
  let current: z.ZodType = schema
  // Bounded; a well-formed Zod schema tree terminates quickly.
  for (let i = 0; i < 64; i++) {
    const kind = kindOf(current)
    if (kind === 'discriminated-union') return current
    let next: z.ZodType | undefined
    if (
      kind === 'optional' ||
      kind === 'nullable' ||
      kind === 'default' ||
      kind === 'readonly' ||
      kind === 'catch'
    ) {
      next = unwrapInner(current)
    } else if (kind === 'pipe') {
      next = unwrapPipe(current)
    } else if (kind === 'intersection') {
      const left = getIntersectionLeft(current)
      const right = getIntersectionRight(current)
      const leftDU = left !== undefined ? unwrapToDiscriminatedUnion(left) : undefined
      const rightDU = right !== undefined ? unwrapToDiscriminatedUnion(right) : undefined
      if (leftDU !== undefined && rightDU !== undefined) {
        // Ambiguous: both sides resolve to DUs. The reshape can't pick
        // one without arbitrary preference; bail and let the runtime
        // fall through to a plain write.
        return undefined
      }
      return leftDU ?? rightDU
    }
    if (next === undefined) return undefined
    current = next
  }
  return undefined
}

/**
 * A discriminated union's first option, which is the default when no
 * discriminator value is known at default-values construction time.
 */
export function getDiscriminatedUnionFirstOption(schema: z.ZodType): z.ZodObject | undefined {
  const options = getDiscriminatedOptions(schema)
  return options[0]
}
