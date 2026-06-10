import type { ScenarioId, ScenarioParams } from '../../adapters/contract'
import type * as v from 'valibot'
import type { z } from 'zod'
import { arraysNative, arraysShape, arraysValibot, arraysZod3 } from './arrays'
import {
  discriminatedUnionNative,
  discriminatedUnionShape,
  discriminatedUnionValibot,
  discriminatedUnionZod3,
} from './discriminated-union'
import { flatNative, flatShape, flatValibot, flatZod3 } from './flat'
import { gridNative, gridShape, gridValibot, gridZod3 } from './grid'
import { nestedNative, nestedShape, nestedValibot, nestedZod3 } from './nested'
import type { NativeRule, ScenarioShape } from './types'

export { leafSeed, nestRules } from './types'
export type { NativeRule, ScenarioShape } from './types'

/**
 * Per-scenario builders, dispatched once here so every adapter stays
 * scenario-agnostic: an adapter asks for the shape plus whichever validator
 * flavor it feeds, never knowing which scenario it is driving. New scenarios
 * extend these switches (Phase 3); the adapters do not change.
 */

function notYet(scenario: ScenarioId, kind: string): never {
  throw new Error(`bench: ${kind} for scenario "${scenario}" is not implemented yet`)
}

export function shapeFor(scenario: ScenarioId, params: ScenarioParams): ScenarioShape {
  switch (scenario) {
    case 'flat':
      return flatShape(params)
    case 'nested':
      return nestedShape(params)
    case 'arrays':
      return arraysShape(params)
    case 'grid':
      return gridShape(params)
    case 'discriminated-union':
      return discriminatedUnionShape(params)
    default:
      return notYet(scenario, 'shape')
  }
}

/** zod v3 schema shared by every zod-capable adapter (the common denominator). */
export function zodSchemaFor(scenario: ScenarioId, params: ScenarioParams): z.ZodTypeAny {
  switch (scenario) {
    case 'flat':
      return flatZod3(params)
    case 'nested':
      return nestedZod3(params)
    case 'arrays':
      return arraysZod3(params)
    case 'grid':
      return gridZod3(params)
    case 'discriminated-union':
      return discriminatedUnionZod3(params)
    default:
      return notYet(scenario, 'zod schema')
  }
}

/** valibot schema for formisch. */
export function valibotSchemaFor(scenario: ScenarioId, params: ScenarioParams): v.GenericSchema {
  switch (scenario) {
    case 'flat':
      return flatValibot(params)
    case 'nested':
      return nestedValibot(params)
    case 'arrays':
      return arraysValibot(params)
    case 'grid':
      return gridValibot(params)
    case 'discriminated-union':
      return discriminatedUnionValibot(params)
    default:
      return notYet(scenario, 'valibot schema')
  }
}

/** Native-rule mirror for Regle (rules mode) and Vuelidate. */
export function nativeRulesFor(
  scenario: ScenarioId,
  params: ScenarioParams
): Record<string, NativeRule> {
  switch (scenario) {
    case 'flat':
      return flatNative(params)
    case 'nested':
      return nestedNative(params)
    case 'arrays':
      return arraysNative(params)
    case 'grid':
      return gridNative(params)
    case 'discriminated-union':
      return discriminatedUnionNative(params)
    default:
      return notYet(scenario, 'native rules')
  }
}
