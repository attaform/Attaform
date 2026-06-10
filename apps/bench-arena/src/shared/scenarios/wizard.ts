/**
 * Wizard scenario: a linear multi-step flow whose fields are partitioned into
 * ordered steps, one step shown at a time. The headline is how a library
 * advances a gated step: validate the leaving step, then reveal the next. A
 * library with a wizard primitive (Attaform's useWizard) makes each step its
 * own form, so gating an advance validates only that step; a library without
 * one hand-composes the flow off a step signal and validates the step the way
 * its engine allows. Every field is a uniform-constraint text input, so the DOM
 * stays identical across the cohort, and the steps are uniform (same field
 * count each), so a transition cost reflects navigation and gating rather than a
 * lopsided step.
 *
 * Branching across steps (a discriminator selecting later steps) is deliberately
 * out of scope here: the discriminated-union scenario already measures branch
 * resolution, and a linear flow isolates the step-transition cost without a
 * per-library branching shape to express differently. The genuinely comparable
 * operations are the gated forward advance (stepTransition) and the cross-step
 * aggregate validation (the validate dimension over every step).
 */
import * as v from 'valibot'
import { z } from 'zod'
import type { ScenarioParams } from '../../adapters/contract'
import { type NativeRule, type ScenarioShape } from './types'

/** Minimum length each field must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so every step validates. */
const SEED = 'seed'

/** Steps when the param omits a count; the default multi-step flow. */
const DEFAULT_STEPS = 4

/** Text fields per step; uniform so a transition cost is step-independent. */
const FIELDS_PER_STEP = 3

/** Step count for the scenario, from the `steps` param (label `S4`). */
function stepCount(params: ScenarioParams): number {
  return Math.max(2, params.steps ?? DEFAULT_STEPS)
}

/** The object key for step `i` (`step0`); each step occupies its own object. */
function stepKey(i: number): string {
  return `step${i}`
}

/** The field name for position `j` within a step (`f0`). */
function fieldName(j: number): string {
  return `f${j}`
}

export function wizardShape(params: ScenarioParams): ScenarioShape {
  const steps = stepCount(params)
  const stepKeys = Array.from({ length: steps }, (_unused, i) => stepKey(i))
  const stepPaths = stepKeys.map((key) =>
    Array.from({ length: FIELDS_PER_STEP }, (_unused, j) => `${key}.${fieldName(j)}`)
  )
  const defaultValues: Record<string, unknown> = {}
  for (const key of stepKeys) {
    const obj: Record<string, unknown> = {}
    for (let j = 0; j < FIELDS_PER_STEP; j++) obj[fieldName(j)] = SEED
    defaultValues[key] = obj
  }
  return {
    paths: stepPaths.flat(),
    defaultValues,
    keystrokeIndex: 0,
    wizard: { stepKeys, steps: stepPaths },
  }
}

/**
 * zod v3 schema shared by every zod-capable adapter: an object of per-step
 * objects (`{ step0: { f0, f1, f2 }, ... }`). A single-form library validates
 * the whole object; an adapter that builds a form per step (useWizard) reads
 * each step's sub-object off the root shape by key.
 */
export function wizardZod3(params: ScenarioParams): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (let i = 0; i < stepCount(params); i++) {
    const fields: Record<string, z.ZodTypeAny> = {}
    for (let j = 0; j < FIELDS_PER_STEP; j++) fields[fieldName(j)] = z.string().min(MIN_LENGTH)
    shape[stepKey(i)] = z.object(fields)
  }
  return z.object(shape)
}

/** valibot mirror for formisch. */
export function wizardValibot(params: ScenarioParams): v.GenericSchema {
  const entries: Record<string, v.GenericSchema> = {}
  for (let i = 0; i < stepCount(params); i++) {
    const fields: Record<string, v.GenericSchema> = {}
    for (let j = 0; j < FIELDS_PER_STEP; j++) {
      fields[fieldName(j)] = v.pipe(v.string(), v.minLength(MIN_LENGTH))
    }
    entries[stepKey(i)] = v.object(fields)
  }
  return v.object(entries)
}

/**
 * Native-rule mirror for the headless-validation-only libraries (Regle rules
 * mode, Vuelidate), one minimum-length rule per leaf keyed by dotted path.
 */
export function wizardNative(params: ScenarioParams): Record<string, NativeRule> {
  const rules: Record<string, NativeRule> = {}
  for (let i = 0; i < stepCount(params); i++) {
    for (let j = 0; j < FIELDS_PER_STEP; j++) {
      rules[`${stepKey(i)}.${fieldName(j)}`] = { minLength: MIN_LENGTH }
    }
  }
  return rules
}
