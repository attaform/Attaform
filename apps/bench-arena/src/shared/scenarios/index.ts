import type { ScenarioId, ScenarioParams } from '../../adapters/contract'
import type * as v from 'valibot'
import type { z } from 'zod'
import type { z as z4 } from 'zod-v4'
import { arraysNative, arraysShape, arraysValibot, arraysZod3, arraysZod4 } from './arrays'
import {
  discriminatedUnionNative,
  discriminatedUnionShape,
  discriminatedUnionValibot,
  discriminatedUnionZod3,
  discriminatedUnionZod4,
} from './discriminated-union'
import { flatNative, flatShape, flatValibot, flatZod3, flatZod4 } from './flat'
import { gridNative, gridShape, gridValibot, gridZod3, gridZod4 } from './grid'
import { massiveNative, massiveShape, massiveValibot, massiveZod3, massiveZod4 } from './massive'
import { nestedNative, nestedShape, nestedValibot, nestedZod3, nestedZod4 } from './nested'
import type { NativeRule, ScenarioShape } from './types'
import { wizardNative, wizardShape, wizardValibot, wizardZod3, wizardZod4 } from './wizard'

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
    case 'massive':
      return massiveShape(params)
    case 'wizard':
      return wizardShape(params)
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
    case 'massive':
      return massiveZod3(params)
    case 'wizard':
      return wizardZod3(params)
    default:
      return notYet(scenario, 'zod schema')
  }
}

/** zod v4 schema, fed only to the Attaform (Zod 4) adapter (same shapes as v3). */
export function zodV4SchemaFor(scenario: ScenarioId, params: ScenarioParams): z4.ZodType {
  switch (scenario) {
    case 'flat':
      return flatZod4(params)
    case 'nested':
      return nestedZod4(params)
    case 'arrays':
      return arraysZod4(params)
    case 'grid':
      return gridZod4(params)
    case 'discriminated-union':
      return discriminatedUnionZod4(params)
    case 'massive':
      return massiveZod4(params)
    case 'wizard':
      return wizardZod4(params)
    default:
      return notYet(scenario, 'zod v4 schema')
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
    case 'massive':
      return massiveValibot(params)
    case 'wizard':
      return wizardValibot(params)
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
    case 'massive':
      return massiveNative(params)
    case 'wizard':
      return wizardNative(params)
    default:
      return notYet(scenario, 'native rules')
  }
}
