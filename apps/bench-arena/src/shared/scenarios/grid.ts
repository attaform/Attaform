/**
 * Grid scenario: an array of N row objects, each with M text columns
 * (`rows.{i}.c{j}`), the line-items editor every invoice, order, or timesheet
 * form is. Swept over rows (N) and columns (M). It folds an array's length
 * reactivity together with a row's object nesting, so the headline is
 * edit-one-cell render scope: typing into a single cell should wake only that
 * cell, not its row siblings and not the other rows. A granular library
 * re-renders one cell; a whole-form library re-renders the whole grid. The
 * grid reuses the array machinery (one `arrayPath` with M `arrayItemFields`),
 * so every adapter renders it through the same reactive row path it uses for
 * the single-column array. One text input per cell keeps the DOM identical
 * across the cohort.
 */
import * as v from 'valibot'
import { z } from 'zod'
import type { ScenarioParams } from '../../adapters/contract'
import { type NativeRule, type ScenarioShape } from './types'

/** Minimum length each cell must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so every cell validates. */
const SEED = 'seed'

/** Row count, defaulted defensively. */
function rowsOf(params: ScenarioParams): number {
  return params.rows ?? 20
}

/** Column count, defaulted defensively. */
function colsOf(params: ScenarioParams): number {
  return params.cols ?? 8
}

/** The M column field names `[c0, ..., c{M-1}]`. */
function columns(cols: number): string[] {
  const out: string[] = []
  for (let c = 0; c < cols; c++) out.push(`c${c}`)
  return out
}

/**
 * Each cell seeds to a DISTINCT valid value (`seed-{row}-{col}`). Distinct
 * content keeps an edited cell's new value distinguishable from its neighbors'
 * and makes a row reorder meaningful (a swap changes what each moved row
 * displays). Identical cells would mask the cost the render-scope and reorder
 * dimensions are measuring.
 */
function seedFor(row: number, col: number): string {
  return `${SEED}-${row}-${col}`
}

export function gridShape(params: ScenarioParams): ScenarioShape {
  const n = rowsOf(params)
  const fields = columns(colsOf(params))
  const paths: string[] = []
  const rows: Array<Record<string, string>> = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, string> = {}
    fields.forEach((field, c) => {
      paths.push(`rows.${i}.${field}`)
      row[field] = seedFor(i, c)
    })
    rows.push(row)
  }
  const itemRules: Record<string, NativeRule> = {}
  for (const field of fields) itemRules[field] = { minLength: MIN_LENGTH }
  return {
    paths,
    defaultValues: { rows },
    // The last cell of the last row: a single-cell edit costs the same wherever
    // it lands, and a fixed cell keeps path resolution constant across the sweep.
    keystrokeIndex: Math.max(0, paths.length - 1),
    arrayPath: 'rows',
    arrayItemRules: itemRules,
    arrayItemFields: fields,
    newRow: () => {
      const row: Record<string, string> = {}
      for (const field of fields) row[field] = SEED
      return row
    },
  }
}

/** zod v3 schema shared by every zod-capable adapter. */
export function gridZod3(params: ScenarioParams): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of columns(colsOf(params))) shape[field] = z.string().min(MIN_LENGTH)
  return z.object({ rows: z.array(z.object(shape)) })
}

/** valibot mirror for formisch. */
export function gridValibot(params: ScenarioParams): v.GenericSchema {
  const entries: Record<string, v.GenericSchema> = {}
  for (const field of columns(colsOf(params))) {
    entries[field] = v.pipe(v.string(), v.minLength(MIN_LENGTH))
  }
  return v.object({ rows: v.array(v.object(entries)) })
}

/**
 * Native-rule mirror for object leaves. A grid scenario has none (its per-cell
 * constraint travels on the shape's `arrayItemRules`, which the native-validator
 * adapters turn into a `$each` collection rule), so this is empty.
 */
export function gridNative(_params: ScenarioParams): Record<string, NativeRule> {
  return {}
}
