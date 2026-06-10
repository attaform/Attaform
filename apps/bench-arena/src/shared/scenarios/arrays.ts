/**
 * Dynamic-array scenario: one array of N single-field row objects (`rows[i].v`),
 * swept over N. The headline is array behavior at scale: how a library's
 * per-keystroke cost into a row, its mount cost, and (the arrayOp dimension) its
 * reorder cost grow with row count, and how widely a single row edit re-renders
 * (granular libraries re-render one row, whole-form libraries re-render all N).
 * One text field per row keeps the DOM identical across the cohort.
 */
import * as v from 'valibot'
import { z } from 'zod'
import type { ScenarioParams } from '../../adapters/contract'
import { type NativeRule, type ScenarioShape } from './types'

/** Minimum length each row's field must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so every row validates. */
const SEED = 'seed'

/** Row count, defaulted defensively. */
function rowsOf(params: ScenarioParams): number {
  return params.rows ?? 100
}

export function arraysShape(params: ScenarioParams): ScenarioShape {
  const n = rowsOf(params)
  const paths: string[] = []
  const rows: Array<{ v: string }> = []
  for (let i = 0; i < n; i++) {
    paths.push(`rows.${i}.v`)
    rows.push({ v: SEED })
  }
  return {
    paths,
    defaultValues: { rows },
    // The last row: a single-row edit costs the same wherever it lands, and a
    // fixed index keeps path resolution constant across the sweep.
    keystrokeIndex: Math.max(0, n - 1),
    arrayPath: 'rows',
    arrayItemRules: { v: { minLength: MIN_LENGTH } },
  }
}

/** zod v3 schema shared by every zod-capable adapter. */
export function arraysZod3(_params: ScenarioParams): z.ZodTypeAny {
  return z.object({ rows: z.array(z.object({ v: z.string().min(MIN_LENGTH) })) })
}

/** valibot mirror for formisch. */
export function arraysValibot(_params: ScenarioParams): v.GenericSchema {
  return v.object({
    rows: v.array(v.object({ v: v.pipe(v.string(), v.minLength(MIN_LENGTH)) })),
  })
}

/**
 * Native-rule mirror for object leaves. An array scenario has none (its per-item
 * constraint travels on the shape's `arrayItemRules`, which the native-validator
 * adapters turn into a `$each` collection rule), so this is empty.
 */
export function arraysNative(_params: ScenarioParams): Record<string, NativeRule> {
  return {}
}
