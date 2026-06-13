/**
 * Discriminated-union scenario: an `event` object that is one of three
 * variants, each tagged by a `kind` discriminant (`click` / `scroll` /
 * `keypress`) and carrying its own text fields. Only the active variant's
 * fields are rendered, so the headline is how a library handles writing into
 * and flipping between branches: a discriminant-aware library resolves the path
 * within the active branch alone, while a plain union walks every option. The
 * default active variant is `click`, so the keystroke and re-render dimensions
 * drive its fields; the variantFlip dimension cycles the discriminant through
 * all three. Every field is a uniform-constraint text input, so the DOM stays
 * identical across the cohort.
 */
import * as v from 'valibot'
import { z } from 'zod'
import { z as z4 } from 'zod-v4'
import type { ScenarioParams } from '../../adapters/contract'
import { type NativeRule, type ScenarioShape } from './types'

/** Minimum length each variant field must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so every variant validates. */
const SEED = 'seed'

/** The object the union occupies; a flip replaces this whole value. */
const UNION_PATH = 'event'

/** The discriminant key within the union object. */
const DISCRIMINANT = 'kind'

/** The default active variant (first rendered, and what keystroke drives). */
const DEFAULT_VARIANT = { tag: 'click', fields: ['x', 'y'] }

/**
 * The variants, each its discriminant value plus its own non-discriminant text
 * fields. The shapes deliberately differ in field count (2 / 1 / 2), so a flip
 * genuinely swaps the rendered field set rather than relabeling a fixed one.
 */
const VARIANTS: ReadonlyArray<{ tag: string; fields: readonly string[] }> = [
  DEFAULT_VARIANT,
  { tag: 'scroll', fields: ['delta'] },
  { tag: 'keypress', fields: ['code', 'meta'] },
]

/** A full valid value for one variant (`{ kind, ...fields: SEED }`). */
function variantValue(tag: string, fields: readonly string[]): Record<string, unknown> {
  const value: Record<string, unknown> = { [DISCRIMINANT]: tag }
  for (const f of fields) value[f] = SEED
  return value
}

export function discriminatedUnionShape(_params: ScenarioParams): ScenarioShape {
  const variants = VARIANTS.map((variant) => ({
    tag: variant.tag,
    fieldPaths: variant.fields.map((f) => `${UNION_PATH}.${f}`),
    value: variantValue(variant.tag, variant.fields),
  }))
  return {
    paths: DEFAULT_VARIANT.fields.map((f) => `${UNION_PATH}.${f}`),
    defaultValues: { [UNION_PATH]: variantValue(DEFAULT_VARIANT.tag, DEFAULT_VARIANT.fields) },
    keystrokeIndex: 0,
    union: {
      unionPath: UNION_PATH,
      discriminantPath: `${UNION_PATH}.${DISCRIMINANT}`,
      variants,
    },
  }
}

/**
 * zod v3 schema shared by every zod-capable adapter. The discriminated union is
 * spelled out literally: zod keys the branch by the `kind` literal, so the
 * options cannot be built from a loop without losing the literal types.
 */
export function discriminatedUnionZod3(_params: ScenarioParams): z.ZodTypeAny {
  return z.object({
    [UNION_PATH]: z.discriminatedUnion(DISCRIMINANT, [
      z.object({
        kind: z.literal('click'),
        x: z.string().min(MIN_LENGTH),
        y: z.string().min(MIN_LENGTH),
      }),
      z.object({ kind: z.literal('scroll'), delta: z.string().min(MIN_LENGTH) }),
      z.object({
        kind: z.literal('keypress'),
        code: z.string().min(MIN_LENGTH),
        meta: z.string().min(MIN_LENGTH),
      }),
    ]),
  })
}

/** zod v4 mirror of {@link discriminatedUnionZod3}, fed to the Attaform (Zod 4) adapter. */
export function discriminatedUnionZod4(_params: ScenarioParams): z4.ZodType {
  return z4.object({
    [UNION_PATH]: z4.discriminatedUnion(DISCRIMINANT, [
      z4.object({
        kind: z4.literal('click'),
        x: z4.string().min(MIN_LENGTH),
        y: z4.string().min(MIN_LENGTH),
      }),
      z4.object({ kind: z4.literal('scroll'), delta: z4.string().min(MIN_LENGTH) }),
      z4.object({
        kind: z4.literal('keypress'),
        code: z4.string().min(MIN_LENGTH),
        meta: z4.string().min(MIN_LENGTH),
      }),
    ]),
  })
}

/** valibot mirror for formisch (`v.variant` is its discriminated union). */
export function discriminatedUnionValibot(_params: ScenarioParams): v.GenericSchema {
  return v.object({
    [UNION_PATH]: v.variant(DISCRIMINANT, [
      v.object({
        kind: v.literal('click'),
        x: v.pipe(v.string(), v.minLength(MIN_LENGTH)),
        y: v.pipe(v.string(), v.minLength(MIN_LENGTH)),
      }),
      v.object({ kind: v.literal('scroll'), delta: v.pipe(v.string(), v.minLength(MIN_LENGTH)) }),
      v.object({
        kind: v.literal('keypress'),
        code: v.pipe(v.string(), v.minLength(MIN_LENGTH)),
        meta: v.pipe(v.string(), v.minLength(MIN_LENGTH)),
      }),
    ]),
  })
}

/**
 * Native-rule mirror for the headless-validation-only libraries (Regle rules
 * mode, Vuelidate), which have no schema and so hand-roll the union. Every
 * variant's field carries the same minimum-length rule across the whole union;
 * a rule whose field is absent under the current variant stays dormant
 * (minimum-length passes an empty/absent optional value), so the active
 * variant's fields validate and the inactive ones never raise a false error.
 */
export function discriminatedUnionNative(_params: ScenarioParams): Record<string, NativeRule> {
  const rules: Record<string, NativeRule> = {}
  for (const variant of VARIANTS) {
    for (const f of variant.fields) rules[`${UNION_PATH}.${f}`] = { minLength: MIN_LENGTH }
  }
  return rules
}
