/**
 * Massive scenario: one form mixing all three structural shapes at scale, swept
 * over the total leaf count L (~2,000 to ~5,000 inputs). A real enterprise form
 * is not a thousand flat fields; it is sections of flat fields, a deep object or
 * two, and repeating line-item rows, all in one form. Massive composes exactly
 * that: a flat block, one deeply nested block, and one array of rows, sharing a
 * single schema and validated in one pass.
 *
 * The headline is the ceiling: mount, one keystroke, and full-form validation at
 * a field count where the cost of doing work proportional to the whole form (a
 * keystroke that re-parses every leaf) diverges sharply from work proportional
 * to the one field that changed. The keystroke targets a flat leaf so the number
 * isolates that whole-form overhead at scale; deep-path cost is the nested
 * scenario's job, and array behavior is the arrays and grid scenarios'.
 *
 * Every leaf is a text input carrying the same minimum-length constraint, so the
 * DOM and the validation work are uniform across the cohort. The array section
 * reuses the array machinery (`arrayPath` / `arrayItemFields` / `arrayItemRules`),
 * so the native-validator adapters build their collection rule exactly as they do
 * for the arrays scenario; the flat and nested leaves travel on `objectPaths`,
 * which each adapter renders alongside the rows. Massive runs no array mutation,
 * so the rows are static (no reorder or add dimension here).
 */
import * as v from 'valibot'
import { z } from 'zod'
import type { ScenarioParams } from '../../adapters/contract'
import { type NativeRule, type ScenarioShape } from './types'

/** Minimum length every leaf must satisfy; the uniform constraint. */
const MIN_LENGTH = 2

/** A valid seed value (length >= MIN_LENGTH) so the whole tree validates. */
const SEED = 'seed'

/** Fields per array row (an invoice-line-item width). */
const COLS = 4

/** Wrapper-object depth above the nested-leaf cluster (the deep block). */
const NEST_DEPTH = 8

/** Share of the leaf budget given to the flat block and the array block; the
 *  remainder is the nested block. */
const FLAT_FRACTION = 0.3
const ARRAY_FRACTION = 0.4

/** Total leaf count, defaulted defensively. */
function leavesOf(params: ScenarioParams): number {
  return params.leaves ?? 2000
}

/** The wrapper segments `[l0, ..., l{NEST_DEPTH-1}]` above the nested leaves. */
function wrappers(): string[] {
  const out: string[] = []
  for (let d = 0; d < NEST_DEPTH; d++) out.push(`l${d}`)
  return out
}

/**
 * Resolve the leaf budget L into the three blocks. The counts are a
 * deterministic function of L, so a label (`L5000`) always produces the same
 * structure: an array of `rows` x `COLS` cells, `flatCount` flat leaves, and
 * `nestedCount` leaves clustered at the bottom of the wrapper chain.
 */
interface MassiveLayout {
  readonly flatCount: number
  readonly rows: number
  readonly cols: number
  readonly arrayLeaves: number
  readonly nestedCount: number
}

function layout(params: ScenarioParams): MassiveLayout {
  const L = leavesOf(params)
  const cols = COLS
  const rows = Math.max(1, Math.floor((L * ARRAY_FRACTION) / cols))
  const arrayLeaves = rows * cols
  const flatCount = Math.floor(L * FLAT_FRACTION)
  const nestedCount = Math.max(0, L - flatCount - arrayLeaves)
  return { flatCount, rows, cols, arrayLeaves, nestedCount }
}

/** The dotted prefix above the nested leaves (`deep.l0.l1.....l{NEST_DEPTH-1}`). */
function nestPrefix(): string {
  return ['deep', ...wrappers()].join('.')
}

export function massiveShape(params: ScenarioParams): ScenarioShape {
  const { flatCount, rows, cols, arrayLeaves, nestedCount } = layout(params)

  // The rendered input order: every array cell first (row-major, the existing
  // array-branch index formula), then the flat leaves, then the nested leaves.
  // The object leaves carry indices continuing past the array cells, so the flat
  // and nested blocks render at `arrayLeaves + their position in objectPaths`.
  const paths: string[] = []
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < cols; c++) paths.push(`rows.${i}.c${c}`)
  }
  const objectPaths: string[] = []
  for (let i = 0; i < flatCount; i++) objectPaths.push(`s${i}`)
  const prefix = nestPrefix()
  for (let i = 0; i < nestedCount; i++) objectPaths.push(`${prefix}.n${i}`)
  paths.push(...objectPaths)

  // The seed tree: flat leaves, the nested cluster wrapped to depth, and the row
  // array. Cloned per mount by the adapters that own a mutable array.
  const defaultValues: Record<string, unknown> = {}
  for (let i = 0; i < flatCount; i++) defaultValues[`s${i}`] = SEED
  let nested: Record<string, unknown> = {}
  for (let i = 0; i < nestedCount; i++) nested[`n${i}`] = SEED
  for (const seg of [...wrappers()].reverse()) nested = { [seg]: nested }
  defaultValues['deep'] = nested
  defaultValues['rows'] = Array.from({ length: rows }, () => newRow(cols))

  const arrayItemFields: string[] = []
  const arrayItemRules: Record<string, NativeRule> = {}
  for (let c = 0; c < cols; c++) {
    arrayItemFields.push(`c${c}`)
    arrayItemRules[`c${c}`] = { minLength: MIN_LENGTH }
  }

  return {
    paths,
    defaultValues,
    // The last flat leaf: a shallow scalar write whose cost is the library's
    // per-keystroke overhead at this scale, undiluted by deep-path resolution.
    keystrokeIndex: arrayLeaves + Math.max(0, flatCount - 1),
    arrayPath: 'rows',
    arrayItemRules,
    arrayItemFields,
    newRow: () => newRow(cols),
    objectPaths,
  }
}

/** A fresh all-seed row of `cols` fields. */
function newRow(cols: number): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (let c = 0; c < cols; c++) row[`c${c}`] = SEED
  return row
}

/** zod v3 schema shared by every zod-capable adapter. */
export function massiveZod3(params: ScenarioParams): z.ZodTypeAny {
  const { flatCount, cols, nestedCount } = layout(params)
  const shape: Record<string, z.ZodTypeAny> = {}
  for (let i = 0; i < flatCount; i++) shape[`s${i}`] = z.string().min(MIN_LENGTH)
  const bottom: Record<string, z.ZodTypeAny> = {}
  for (let i = 0; i < nestedCount; i++) bottom[`n${i}`] = z.string().min(MIN_LENGTH)
  let nested: z.ZodTypeAny = z.object(bottom)
  for (const seg of [...wrappers()].reverse()) nested = z.object({ [seg]: nested })
  shape['deep'] = nested
  const row: Record<string, z.ZodTypeAny> = {}
  for (let c = 0; c < cols; c++) row[`c${c}`] = z.string().min(MIN_LENGTH)
  shape['rows'] = z.array(z.object(row))
  return z.object(shape)
}

/** valibot mirror for formisch. */
export function massiveValibot(params: ScenarioParams): v.GenericSchema {
  const { flatCount, cols, nestedCount } = layout(params)
  const entries: Record<string, v.GenericSchema> = {}
  for (let i = 0; i < flatCount; i++) entries[`s${i}`] = v.pipe(v.string(), v.minLength(MIN_LENGTH))
  const bottom: Record<string, v.GenericSchema> = {}
  for (let i = 0; i < nestedCount; i++)
    bottom[`n${i}`] = v.pipe(v.string(), v.minLength(MIN_LENGTH))
  let nested: v.GenericSchema = v.object(bottom)
  for (const seg of [...wrappers()].reverse()) nested = v.object({ [seg]: nested })
  entries['deep'] = nested
  const row: Record<string, v.GenericSchema> = {}
  for (let c = 0; c < cols; c++) row[`c${c}`] = v.pipe(v.string(), v.minLength(MIN_LENGTH))
  entries['rows'] = v.array(v.object(row))
  return v.object(entries)
}

/**
 * Native-rule mirror for the object leaves (flat + nested), keyed by dotted path
 * for `nestRules` to de-flatten. The array section's per-row rules travel on the
 * shape's `arrayItemRules`, which the native-validator adapters turn into a
 * collection rule, so the rows are absent here.
 */
export function massiveNative(params: ScenarioParams): Record<string, NativeRule> {
  const { flatCount, nestedCount } = layout(params)
  const rules: Record<string, NativeRule> = {}
  for (let i = 0; i < flatCount; i++) rules[`s${i}`] = { minLength: MIN_LENGTH }
  const prefix = nestPrefix()
  for (let i = 0; i < nestedCount; i++) rules[`${prefix}.n${i}`] = { minLength: MIN_LENGTH }
  return rules
}
