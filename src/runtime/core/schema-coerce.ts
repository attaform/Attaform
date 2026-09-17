/**
 * Schema-driven coercion of user-typed DOM values at the v-register
 * directive layer. When the slim schema declares a numeric or
 * boolean type at a path, the directive coerces incoming string
 * values (`'25'` → `25`, `'true'` → `true`) before the slim-primitive
 * gate sees the write — making the schema authoritative for storage
 * shape and freeing consumers from sprinkling `.number` modifiers
 * across templates.
 *
 * Two rules ship: string→number and string→boolean. `useForm({ coerce:
 * false })` turns them off form-wide, which is the whole of the
 * consumer surface — the rules themselves are library code, so nothing
 * here has to defend against a caller's transform throwing or
 * returning the wrong runtime type.
 *
 * Coercion applies ONLY to user-typed DOM values flowing through
 * the directive's assigner. Programmatic writes (`form.setValue`,
 * `setValueWithInternalPath`) bypass coercion — they're authoritative
 * writes whose strict typing is on the caller. This mirrors the
 * `transforms` pipeline's user-input-only contract.
 */
import type { AbstractSchema, SlimPrimitiveKind } from '../types/types-api'
import { SET_MEMBER_SEGMENT, type Path } from './paths'
import { slimKindOf } from './slim-primitive-gate'

/** Identity function reused by `buildCoerceFn` when coercion is
 *  disabled or the path admits no coercion target. */
export const IDENTITY: (v: unknown) => unknown = (v) => v

/**
 * Resolve the consumer's `coerce` config slot. Only `false` turns
 * coercion off; `true` and `undefined` both run the built-in rules.
 */
export function resolveCoerceEnabled(config: boolean | undefined): boolean {
  return config !== false
}

/**
 * Slim primitive set of one MEMBER of the container at `segments`, or
 * `undefined` when `segments` holds no member-bearing container.
 *
 * An array's members live at real sub-paths, so index 0 answers for
 * all of them. A set's do not: its members are their own keys, so
 * `tags.0` is not a path and asking for one used to hand this layer a
 * resolution the rest of the runtime then treated as a real field
 * (#614). `SET_MEMBER_SEGMENT` asks the same question in a spelling no
 * consumer path can collide with.
 */
function memberSlimTypes(
  schema: AbstractSchema<unknown, unknown>,
  segments: Path,
  accepted: ReadonlySet<SlimPrimitiveKind>
): ReadonlySet<SlimPrimitiveKind> | undefined {
  if (accepted.has('array')) return schema.getSlimPrimitiveTypesAtPath([...segments, 0])
  if (accepted.has('set')) {
    return schema.getSlimPrimitiveTypesAtPath([...segments, SET_MEMBER_SEGMENT])
  }
  return undefined
}

/**
 * Build the per-register coerce closure. The closure captures the
 * resolved `accepted` set, so the per-event hot path doesn't re-walk
 * the schema on every keystroke. Returns `IDENTITY` when coerce is
 * disabled — zero allocation for the common case.
 */
export function buildCoerceFn(
  schema: AbstractSchema<unknown, unknown>,
  segments: Path,
  enabled: boolean
): (value: unknown) => unknown {
  if (!enabled) return IDENTITY
  const accepted = schema.getSlimPrimitiveTypesAtPath(segments)
  const elementAccepted = memberSlimTypes(schema, segments, accepted)
  return (value) => coerceValue(value, accepted, elementAccepted)
}

/**
 * Element-level coerce closure. Returns `undefined` when the path
 * isn't a container (scalar paths use `buildCoerceFn` exclusively).
 *
 * Why this is separate from `buildCoerceFn`: the path-level closure
 * handles the WRITE path correctly — given a container value, it
 * iterates and coerces each element internally. But the directive's
 * READ-side comparisons (`setChecked` array/Set branches,
 * `setSelected` multi-select) compare a SCALAR DOM-side value (the
 * option's `value` attribute) against the post-coerce container
 * elements. The path-level closure can't help here because it would
 * see a scalar and look up the path's accept set (`{ array }`),
 * which has no scalar coercion target. The element-level closure
 * skips ahead to the element-type accept set.
 */
export function buildElementCoerceFn(
  schema: AbstractSchema<unknown, unknown>,
  segments: Path,
  enabled: boolean
): ((value: unknown) => unknown) | undefined {
  if (!enabled) return undefined
  const accepted = schema.getSlimPrimitiveTypesAtPath(segments)
  const elementAccepted = memberSlimTypes(schema, segments, accepted)
  if (elementAccepted === undefined) return undefined
  return (value) => coerceScalar(value, elementAccepted)
}

/**
 * Pick the unambiguous coercion target for an accept set. Returns
 * the target kind only when it's the SOLE coercible kind — if the
 * path admits both `string` and `number`, the schema explicitly
 * accepts either, so silent retyping is wrong (passthrough).
 */
function pickScalarTarget(accepted: ReadonlySet<SlimPrimitiveKind>): SlimPrimitiveKind | null {
  if (accepted.has('string')) return null
  if (accepted.has('number')) return 'number'
  if (accepted.has('boolean')) return 'boolean'
  return null
}

/**
 * string → number. Trim first so whitespace-only inputs don't slip
 * past the empty-string guard via `Number('  ') === 0`. The
 * blank-paths machinery owns the empty-input shape; coercion only
 * fires when there's a non-blank token to consider. A token that
 * isn't a finite number passes through untouched for the slim gate
 * to rule on.
 */
function toNumber(source: string): unknown {
  const trimmed = source.trim()
  if (trimmed === '') return source
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : source
}

/**
 * string → boolean. Case-insensitive + whitespace-tolerant, aligning
 * with the aria-style boolean-token convention (`aria-checked`
 * accepts "true"/"True"/"TRUE"). DOM `value=` attributes preserve
 * whatever case the dev wrote, and `value="True"` is common enough
 * that strict-lowercase-only would be a footgun.
 */
function toBoolean(source: string): unknown {
  const normalized = source.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return source
}

function coerceScalar(value: unknown, accepted: ReadonlySet<SlimPrimitiveKind>): unknown {
  if (accepted.size === 0) return value
  const sourceKind = slimKindOf(value)
  if (accepted.has(sourceKind)) return value
  // Both rules read a string; nothing else has a coercion source.
  if (sourceKind !== 'string') return value
  const target = pickScalarTarget(accepted)
  if (target === 'number') return toNumber(value as string)
  if (target === 'boolean') return toBoolean(value as string)
  return value
}

function coerceArrayMembers(
  arr: readonly unknown[],
  elementAccepted: ReadonlySet<SlimPrimitiveKind>
): readonly unknown[] {
  let changed = false
  const out: unknown[] = []
  for (const el of arr) {
    const next = coerceScalar(el, elementAccepted)
    if (next !== el) changed = true
    out.push(next)
  }
  return changed ? out : arr
}

function coerceSetMembers(
  set: ReadonlySet<unknown>,
  elementAccepted: ReadonlySet<SlimPrimitiveKind>
): ReadonlySet<unknown> {
  let changed = false
  const out: unknown[] = []
  for (const el of set) {
    const next = coerceScalar(el, elementAccepted)
    if (next !== el) changed = true
    out.push(next)
  }
  return changed ? new Set(out) : set
}

function coerceValue(
  value: unknown,
  accepted: ReadonlySet<SlimPrimitiveKind>,
  elementAccepted: ReadonlySet<SlimPrimitiveKind> | undefined
): unknown {
  if (Array.isArray(value)) {
    if (!accepted.has('array') || elementAccepted === undefined) return value
    return coerceArrayMembers(value, elementAccepted)
  }
  if (value instanceof Set) {
    if (!accepted.has('set') || elementAccepted === undefined) return value
    return coerceSetMembers(value, elementAccepted)
  }
  return coerceScalar(value, accepted)
}
