/**
 * Flat scenario: F sibling string leaves at depth 1. The headline shape, swept
 * over F to expose how each library's per-keystroke cost and render scope scale
 * with field count.
 *
 * Every leaf carries the SAME light constraint (a minimum length), so the
 * validation work is uniform across fields and the DOM is identical (all text
 * inputs). A flat baseline deliberately avoids mixed types: per-field type
 * coercion differs library to library and would smuggle an unfair asymmetry
 * into the simplest comparison. Genuine mixed types live in the massive
 * scenario, where the realism is the point and coercion is handled evenly.
 */
import * as v from 'valibot'
import { z } from 'zod'
import type { ScenarioParams } from '../../adapters/contract'
import { fieldCount, type NativeRule, type ScenarioShape } from './types'

/** Minimum length every flat leaf must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so the baseline tree validates. */
const SEED = 'seed'

export function flatShape(params: ScenarioParams): ScenarioShape {
  const F = fieldCount(params)
  const paths: string[] = []
  const defaultValues: Record<string, unknown> = {}
  for (let i = 0; i < F; i++) {
    paths.push(`f${i}`)
    defaultValues[`f${i}`] = SEED
  }
  return {
    paths,
    defaultValues,
    // The last field: for a flat object a single-scalar write costs the same
    // wherever it lands, and a fixed index keeps path resolution constant.
    keystrokeIndex: Math.max(0, F - 1),
  }
}

/** zod v3 schema shared by Attaform, vee-validate, TanStack, FormKit, Regle (schema). */
export function flatZod3(params: ScenarioParams): z.ZodTypeAny {
  const F = fieldCount(params)
  const shape: Record<string, z.ZodTypeAny> = {}
  for (let i = 0; i < F; i++) shape[`f${i}`] = z.string().min(MIN_LENGTH)
  return z.object(shape)
}

/** valibot mirror for formisch. */
export function flatValibot(params: ScenarioParams): v.GenericSchema {
  const F = fieldCount(params)
  const entries: Record<string, v.GenericSchema> = {}
  for (let i = 0; i < F; i++) entries[`f${i}`] = v.pipe(v.string(), v.minLength(MIN_LENGTH))
  return v.object(entries)
}

/** Native-rule mirror for Regle (rules mode) and Vuelidate. */
export function flatNative(params: ScenarioParams): Record<string, NativeRule> {
  const F = fieldCount(params)
  const rules: Record<string, NativeRule> = {}
  for (let i = 0; i < F; i++) rules[`f${i}`] = { minLength: MIN_LENGTH }
  return rules
}
