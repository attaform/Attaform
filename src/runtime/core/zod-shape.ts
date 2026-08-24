/**
 * Shape detector for Zod v4 schemas. Used by the unified `attaform/zod`
 * entry's runtime dispatch (`runtime/adapters/unified/use-form.ts`) to
 * route to the v4 adapter; anything that fails the check routes to v3.
 * Mirrors the discrimination already used by the v4 introspection
 * helper (`adapters/zod-v4/introspect.ts`'s `assertZodVersion`, which
 * reads `def.type`).
 *
 * Why `def.type` and not `_def`:
 * - Zod v4 retained `_def` for backward compat — reading `_def` alone
 *   misclassifies v4 schemas as v3.
 * - Zod v4's stable shape is `def.type: string` (lowercase tag like
 *   `'object'`); Zod v3's is `_def.typeName: string` (capitalised tag
 *   like `'ZodObject'`). The check is structural so consumers who
 *   alias the Zod major to a non-standard import path still work.
 */

interface ZodV4Shape {
  def: { type: unknown }
}

/**
 * Returns true when `value` looks like a Zod v4 schema (has
 * `def.type: string`). Used by the unified entry's runtime-dispatch
 * to route to the v4 adapter.
 */
export function isZodV4SchemaShape(value: unknown): value is ZodV4Shape {
  if (typeof value !== 'object' || value === null) return false
  const def = (value as { def?: unknown }).def
  if (typeof def !== 'object' || def === null) return false
  return typeof (def as { type?: unknown }).type === 'string'
}
