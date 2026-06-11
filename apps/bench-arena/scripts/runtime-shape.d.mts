/**
 * Types for the pure runtime-shape helpers. The implementation is plain `.mjs`
 * (the orchestrator runs it through `node` with no transpile step); this sibling
 * declaration lets the gating vitest under `test/` import it with real types.
 */

export type CellStatus = 'measured' | 'did-not-finish'

export interface TimedSummary {
  median: number
  p95: number
  iqr: number
  count: number
  trimmed: number
}

export interface TimedCell {
  kind: 'timed'
  adapter: string
  scenario: string
  params: string
  dim: string
  status?: CellStatus
  summary?: TimedSummary
  unit?: string
  supported?: boolean
  calibrationMs?: number
  budgetMs?: number
}

export interface MemorySeries {
  retained: number[]
  churn: number[]
  leak: number[]
}

export interface MemoryCell {
  kind: 'memory'
  adapter: string
  scenario: string
  params: string
  cycles: number
  retained: number
  churn: number
  leak: number
  series: MemorySeries
}

export type Cell = TimedCell | MemoryCell

export interface MemoryFacet {
  median: number
  p95: number
  count: number
}

export interface RuntimeRow {
  lib: string
  supported: boolean
  status?: CellStatus
  budgetMs?: number
  median?: number
  p95?: number
  iqr?: number
  count?: number
  trimmed?: number
  unit?: string
  ratio?: number | null
  slope?: number | null
  retained?: MemoryFacet
  churn?: MemoryFacet
  leak?: MemoryFacet
  series?: MemorySeries
}

export interface DimBlock {
  unit: string
  byParam: Record<string, RuntimeRow[]>
}

export type Runtime = Record<string, Record<string, DimBlock>>

export const SCENARIO_ORDER: string[]
export const DIM_ORDER: string[]
export const BASELINE: string

export function statusOf(cell: Cell): CellStatus
export function isDnf(cell: Cell): boolean
export function cellValue(cell: Cell): number
export function rowOf(cell: Cell): RuntimeRow
export function buildRuntime(cells: Cell[], libOrder: Map<string, number>): Runtime
