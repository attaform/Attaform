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
 * v3 and v4 dispatch through one `deriveDefaultWalk` body, each
 * supplying its own `SchemaIntrospector`. `core/walk-derive-default.ts`
 * holds the per-kind rules, including the
 * `peelEmbeddedDefault` chain-walk that closes the v3↔v4 parity gap
 * on `Optional(Default('x'))` / `Nullable(Default('x'))` / etc.
 *
 * With `useDefault` false, `.default(x)` wrappers are skipped and the
 * walker produces the underlying leaf's empty value, which is what a
 * caller wanting a blank initial state rather than the schema's declared
 * defaults asks for.
 *
 * `maxRecursionDepth` caps descent through `z.lazy()`: the counter
 * bumps only when the walker crosses a lazy boundary.
 */
export function deriveDefault(
  schema: z.ZodType,
  useDefault: boolean,
  maxRecursionDepth: number
): unknown {
  return deriveDefaultWalk(schema, useDefault, V4_INTROSPECTOR, maxRecursionDepth)
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
 * Produce a form's starting value.
 *
 * Walk the schema to derive blank defaults, merge constraints, then run
 * the shared DU-aware structural fix walk (sign-off 7,
 * `core/walk-fix-structural.ts`) over the merged tree. No schema is
 * rebuilt and nothing parses, so user refinements and transforms
 * never fire during construction, constraint keys the schema doesn't
 * declare are preserved (except foreign-variant keys at DU values,
 * which the walk removes for the variant-memory machinery), and async
 * refines and transforms need no special casing: refinement enforcement
 * stays with the adapter's construction parse and the post-mount async
 * pass.
 */
export function getDefaultValuesFromZodSchema<Form>(
  opts: GetDefaultValuesOptions
): DefaultValuesResult<Form> {
  const { schema, useDefaultSchemaValues, constraints, maxRecursionDepth } = opts
  const initial = deriveDefault(schema, useDefaultSchemaValues, maxRecursionDepth)
  // The walk repairs what the CONSTRAINTS broke: a constraint supplying
  // a primitive where the schema declares an object, a DU value
  // carrying keys from a variant it is not. With no constraints there
  // is nothing to have broken, and the derivation is already a fixed
  // point of the walk, so this skips 20 to 24 percent of the work on a
  // wide form in what is the common case (most forms pass no
  // `defaultValues` at all).
  //
  // That the derivation IS a fixed point is an invariant, not a
  // theorem, so it is pinned across a corpus of schema shapes in
  // `test/adapters/structural-walk-is-constraint-repair.test.ts`. If
  // that suite ever fails, this branch is the thing to remove.
  if (constraints === undefined) return { data: initial as Form, success: true }
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
