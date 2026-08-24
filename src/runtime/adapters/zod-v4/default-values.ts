import type { z } from 'zod'
import { mergeDeep } from '../../core/merge-deep'
import { deriveDefaultWalk } from '../../core/walk-derive-default'
import { fixStructuralDefaults } from '../../core/walk-fix-structural'
import { unwrapToDiscriminatedUnion } from './discriminator'
import { slimPrimitivesOf } from './slim-primitives'
import { getDiscriminatedOptions, getUnionOptions } from './introspect'
import { V4_INTROSPECTOR } from './walker-introspector'

/**
 * Derive a default value for any Zod v4 schema.
 *
 * Thin wrapper around the shared `deriveDefaultWalk` core walker —
 * v3 and v4 dispatch through the same body via their respective
 * `SchemaIntrospector` instance. See `core/walk-derive-default.ts`
 * for the per-kind dispatch rules, including the
 * `peelEmbeddedDefault` chain-walk that closes the v3↔v4 parity gap
 * on `Optional(Default('x'))` / `Nullable(Default('x'))` / etc.
 *
 * When `useDefault` is false, `.default(x)` wrappers are skipped so
 * the walker produces the underlying leaf's empty value instead —
 * useful when the caller wants a "blank" initial state rather than
 * the schema's declared defaults.
 *
 * `maxRecursionDepth` caps descent through `z.lazy()`: the counter
 * bumps only when the walker crosses a lazy boundary.
 */
export function deriveDefault(
  schema: z.ZodType,
  useDefault: boolean,
  maxRecursionDepth: number
): unknown {
  return deriveDefaultWalk(schema, useDefault, V4_INTROSPECTOR, maxRecursionDepth, {
    // v4 has an exhaustive switch against `SchemaIntrospector.kindOf`;
    // unknown kinds genuinely shouldn't appear, so return undefined.
    unsupportedKindFallback: () => undefined,
    // v4 historically recurses into the inner on `useDefault=false`
    // so a `.catch(v)` slot returns the leaf empty rather than the
    // fallback. Pinned by `test/adapters/zod-v4/unsupported-kinds.test.ts`
    // (`z.catch falls through to inner leaf default when useDefault=false`).
    catchOnUseDefaultFalse: 'recurseInner',
  })
}

export type GetDefaultValuesOptions = {
  // `z.ZodType`, not `z.ZodObject`: the derivation walk is generic over
  // the root kind (object, record, discriminated-union), and the
  // algorithm bottoms out at `deriveDefault` which handles each.
  schema: z.ZodType
  useDefaultSchemaValues: boolean
  constraints: unknown
  maxRecursionDepth: number
}

export type DefaultValuesResult<Form> = {
  data: Form
  success: boolean
}

/**
 * getDefaultValuesFromZodSchema — produces a form's starting value.
 *
 * Walk the schema to derive blank defaults, merge constraints, then
 * run the shared DU-aware structural fix walk (sign-off 7,
 * `core/walk-fix-structural.ts`) over the merged tree. No schema is
 * rebuilt and nothing parses, so user refinements and transforms
 * never fire during construction, constraint keys the schema doesn't
 * declare are preserved (except foreign-variant keys at DU values,
 * which the walk removes for the variant-memory machinery), and
 * async refines / transforms need no special casing — refinement
 * enforcement stays with the adapter's strict-mode pass and the
 * post-mount async pass.
 */
export function getDefaultValuesFromZodSchema<Form>(
  opts: GetDefaultValuesOptions
): DefaultValuesResult<Form> {
  const { schema, useDefaultSchemaValues, constraints, maxRecursionDepth } = opts
  const initial = deriveDefault(schema, useDefaultSchemaValues, maxRecursionDepth)
  const merged = mergeDeep(initial, constraints)

  return fixStructuralDefaults<Form, z.ZodType>(
    schema,
    merged,
    useDefaultSchemaValues,
    maxRecursionDepth,
    {
      intro: V4_INTROSPECTOR,
      slimPrimitivesOf: (s) => slimPrimitivesOf(s, maxRecursionDepth),
      deriveDefault: (s, useDefault) => deriveDefault(s, useDefault, maxRecursionDepth),
      unwrapToDiscriminatedUnion,
    }
  )
}

/**
 * Exported for callers who want the discriminated-union option set for
 * path resolution (used by the adapter's getSchemasAtPath).
 */
export { getDiscriminatedOptions, getUnionOptions }
