// P7 rep sketch: default-values.ts after sign-off 7 — the slim-schema
// rebuild is gone; the validate-then-fix loop parses against the
// ORIGINAL schema (or its stripAsyncChecks twin when async refines are
// present) and classifies issues value-directed via slim-primitive
// kinds, exactly as today, fixing only structural/primitive issues.
import type { z } from 'zod'
import { getAtPath, setAtPath } from 'CORE/path-walker'
import { slimKindOf } from 'CORE/slim-primitive-gate'
import { mergeDeep } from 'CORE/merge-deep'
import { deriveDefaultWalk } from 'CORE/walk-derive-default'
import { getDiscriminatedUnionFirstOption, unwrapToDiscriminatedUnion } from 'V4/discriminator'
import { slimPrimitivesOf } from 'V4/slim-primitives'
import {
  containsAsyncRefine,
  containsAsyncTransform,
  getDiscriminatedOptions,
  getUnionOptions,
  isCoercePrimitive,
  kindOf,
  unwrapPipeIn,
} from 'V4/introspect'
import { getNestedZodSchemasAtPath } from 'V4/path-walker'
import { stripAsyncChecks } from 'V4/strip'
import { V4_INTROSPECTOR } from 'V4/walker-introspector'

export function deriveDefault(
  schema: z.ZodType,
  useDefault: boolean,
  maxRecursionDepth: number
): unknown {
  return deriveDefaultWalk(schema, useDefault, V4_INTROSPECTOR, maxRecursionDepth, {
    unsupportedKindFallback: () => undefined,
    catchOnUseDefaultFalse: 'recurseInner',
  })
}

export type GetDefaultValuesOptions = {
  schema: z.ZodType
  useDefaultSchemaValues: boolean
  constraints: unknown
  maxRecursionDepth: number
}

export type DefaultValuesResult<Form> = {
  data: Form
  success: boolean
}

export function getDefaultValuesFromZodSchema<Form>(
  opts: GetDefaultValuesOptions
): DefaultValuesResult<Form> {
  const { schema, useDefaultSchemaValues, constraints, maxRecursionDepth } = opts
  const initial = deriveDefault(schema, useDefaultSchemaValues, maxRecursionDepth)
  const merged = mergeDeep(initial, constraints) as unknown

  // Async transforms make the input side async-only — no sync parse is
  // possible; the post-mount async pass owns the verdicts.
  if (containsAsyncTransform(schema)) {
    return { data: merged as Form, success: true }
  }
  const target = containsAsyncRefine(schema) ? stripAsyncChecks(schema) : schema

  let firstParse: z.ZodSafeParseResult<unknown>
  try {
    firstParse = target.safeParse(merged) as z.ZodSafeParseResult<unknown>
  } catch {
    return { data: merged as Form, success: false }
  }
  if (firstParse.success) {
    return { data: merged as Form, success: true }
  }

  let fixedData = merged as Record<string, unknown>
  for (const issue of firstParse.error.issues) {
    const pathSegments = issue.path.map((seg) => (typeof seg === 'number' ? seg : String(seg))) as (
      | string
      | number
    )[]
    const candidates = getNestedZodSchemasAtPath(schema, pathSegments, maxRecursionDepth)
    const candidate = candidates[0]
    if (candidate === undefined) continue

    // Schema-side input normalizers accept raw writes verbatim; an
    // `undefined` there is intentional under the no-write-mutation
    // contract.
    if (isCoercePrimitive(candidate)) continue
    if (kindOf(candidate) === 'pipe') {
      const pipeIn = unwrapPipeIn(candidate)
      if (pipeIn !== undefined && kindOf(pipeIn) === 'transform') continue
    }

    // Refinement-vs-primitive classification: if the offending value's
    // slim kind is in the candidate's accept set, the issue is
    // refinement-level — pass through unchanged.
    const valueAtPath = getAtPath(merged, pathSegments)
    const slimKinds = slimPrimitivesOf(candidate, maxRecursionDepth)
    if (slimKinds.size > 0 && slimKinds.has(slimKindOf(valueAtPath))) continue

    const fixValue = defaultFromIssue(issue, candidate, useDefaultSchemaValues, maxRecursionDepth)
    if (fixValue === SKIP) continue
    fixedData = (
      pathSegments.length === 0 ? fixValue : setAtPath(fixedData, pathSegments, fixValue)
    ) as Record<string, unknown>
  }

  let secondSuccess = false
  try {
    secondSuccess = (target.safeParse(fixedData) as z.ZodSafeParseResult<unknown>).success
  } catch {
    secondSuccess = false
  }
  return { data: fixedData as unknown as Form, success: secondSuccess }
}

const SKIP = Symbol('atta:skip-fix')

function defaultFromIssue(
  issue: z.core.$ZodIssue,
  candidate: z.ZodType,
  useDefaultSchemaValues: boolean,
  maxRecursionDepth: number
): unknown {
  if (issue.code === 'invalid_type') {
    const du = unwrapToDiscriminatedUnion(candidate)
    if (du !== undefined) {
      const first = getDiscriminatedUnionFirstOption(du)
      if (first !== undefined)
        return deriveDefault(first, useDefaultSchemaValues, maxRecursionDepth)
    }
    return deriveDefault(candidate, useDefaultSchemaValues, maxRecursionDepth)
  }
  if (issue.code === 'invalid_value') {
    const values = (issue as unknown as { values?: readonly unknown[] }).values
    if (values !== undefined && values.length > 0) return values[0]
    return deriveDefault(candidate, useDefaultSchemaValues, maxRecursionDepth)
  }
  return deriveDefault(candidate, useDefaultSchemaValues, maxRecursionDepth)
}

export { getDiscriminatedOptions, getUnionOptions }
