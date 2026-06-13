/**
 * Deeply-nested scenario: a single object chain `l0.l1.....l{D-1}.leaf`, D
 * wrapper objects deep, swept over D. One leaf, so the headline is not render
 * scope but path resolution and deep reactivity: how a library's per-keystroke
 * cost and mount cost grow as the edited value sinks deeper into the tree
 * (Attaform's depth story). The single uniform constraint (minimum length) and
 * the single text input keep the DOM identical across the cohort.
 */
import * as v from 'valibot'
import { z } from 'zod'
import { z as z4 } from 'zod-v4'
import type { ScenarioParams } from '../../adapters/contract'
import { type NativeRule, type ScenarioShape } from './types'

/** Minimum length the deep leaf must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so the chain validates. */
const SEED = 'seed'

/** Wrapper-object depth, defaulted defensively. */
function depthOf(params: ScenarioParams): number {
  return params.depth ?? 8
}

/** The wrapper segments `[l0, ..., l{D-1}]` above the `leaf`. */
function wrappers(depth: number): string[] {
  const out: string[] = []
  for (let d = 0; d < depth; d++) out.push(`l${d}`)
  return out
}

export function nestedShape(params: ScenarioParams): ScenarioShape {
  const segs = wrappers(depthOf(params))
  let tree: Record<string, unknown> = { leaf: SEED }
  for (const seg of [...segs].reverse()) tree = { [seg]: tree }
  return {
    paths: [[...segs, 'leaf'].join('.')],
    defaultValues: tree,
    keystrokeIndex: 0,
  }
}

/** zod v3 schema shared by every zod-capable adapter. */
export function nestedZod3(params: ScenarioParams): z.ZodTypeAny {
  let schema: z.ZodTypeAny = z.object({ leaf: z.string().min(MIN_LENGTH) })
  for (const seg of [...wrappers(depthOf(params))].reverse()) {
    schema = z.object({ [seg]: schema })
  }
  return schema
}

/** zod v4 mirror of {@link nestedZod3}, fed to the Attaform (Zod 4) adapter. */
export function nestedZod4(params: ScenarioParams): z4.ZodType {
  let schema: z4.ZodType = z4.object({ leaf: z4.string().min(MIN_LENGTH) })
  for (const seg of [...wrappers(depthOf(params))].reverse()) {
    schema = z4.object({ [seg]: schema })
  }
  return schema
}

/** valibot mirror for formisch. */
export function nestedValibot(params: ScenarioParams): v.GenericSchema {
  let schema: v.GenericSchema = v.object({ leaf: v.pipe(v.string(), v.minLength(MIN_LENGTH)) })
  for (const seg of [...wrappers(depthOf(params))].reverse()) {
    schema = v.object({ [seg]: schema })
  }
  return schema
}

/** Native-rule mirror (flat dotted leaf path) for Regle (rules) and Vuelidate. */
export function nestedNative(params: ScenarioParams): Record<string, NativeRule> {
  const path = [...wrappers(depthOf(params)), 'leaf'].join('.')
  return { [path]: { minLength: MIN_LENGTH } }
}
