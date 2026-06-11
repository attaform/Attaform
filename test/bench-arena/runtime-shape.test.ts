/**
 * Gating guard for the bench-arena runtime shape, specifically the did-not-finish
 * math. The monthly refresh workflow is non-gating (a red sweep just skips the
 * results PR), so the property that a DNF cell never poisons its neighbours'
 * ratios and slopes is pinned here, in the gating unit suite, instead.
 *
 * A DNF cell carries a budget and no median. The rules under test: its own ratio
 * and slope are null; a DNF baseline nulls every ratio at that param; a DNF
 * smallest-param nulls that library's slope at larger params; the column unit is
 * read from a measured cell; and a measured cell beside a DNF cell is unaffected.
 */
import { describe, expect, it } from 'vitest'
import {
  buildRuntime,
  cellValue,
  isDnf,
  rowOf,
  statusOf,
} from '../../apps/bench-arena/scripts/runtime-shape.mjs'
import type {
  Cell,
  DimBlock,
  Runtime,
  RuntimeRow,
} from '../../apps/bench-arena/scripts/runtime-shape.mjs'

function timed(
  adapter: string,
  scenario: string,
  params: string,
  dim: string,
  median: number
): Cell {
  return {
    kind: 'timed',
    adapter,
    scenario,
    params,
    dim,
    status: 'measured',
    summary: { median, p95: median, iqr: 0, count: 30, trimmed: 2 },
    unit: 'ms',
    supported: true,
    calibrationMs: 1,
  }
}

function dnf(
  adapter: string,
  scenario: string,
  params: string,
  dim: string,
  budgetMs = 320_000
): Cell {
  return { kind: 'timed', adapter, scenario, params, dim, status: 'did-not-finish', budgetMs }
}

function memory(adapter: string, scenario: string, params: string, retained: number): Cell {
  return {
    kind: 'memory',
    adapter,
    scenario,
    params,
    cycles: 5,
    retained,
    churn: 0,
    leak: 0,
    series: { retained: [retained], churn: [0], leak: [0] },
  }
}

function block(rt: Runtime, scenario: string, dim: string): DimBlock {
  const s = rt[scenario]
  if (!s) throw new Error(`no scenario ${scenario}`)
  const d = s[dim]
  if (!d) throw new Error(`no dim ${scenario}/${dim}`)
  return d
}

function rowsAt(rt: Runtime, scenario: string, dim: string, param: string): RuntimeRow[] {
  const rows = block(rt, scenario, dim).byParam[param]
  if (!rows) throw new Error(`no rows at ${scenario}/${dim}/${param}`)
  return rows
}

function rowFor(rows: RuntimeRow[], lib: string): RuntimeRow {
  const row = rows.find((r) => r.lib === lib)
  if (!row) throw new Error(`no row for ${lib}`)
  return row
}

// Three slices, each isolating one DNF rule. The cohort order is fixed so the
// baseline (attaform) is first; rows are looked up by lib, not position.
const libOrder = new Map<string, number>([
  ['attaform', 0],
  ['vee-validate', 1],
  ['tanstack', 2],
  ['formkit', 3],
])

const cells: Cell[] = [
  // massive.validate: a heavy library DNFs at the larger param; the baseline and
  // its own smaller param both measured, so ratio/slope around it must hold.
  timed('attaform', 'massive', 'L2000', 'validate', 10),
  timed('attaform', 'massive', 'L5000', 'validate', 30),
  timed('tanstack', 'massive', 'L2000', 'validate', 20),
  dnf('tanstack', 'massive', 'L5000', 'validate'),
  // flat.keystroke: the baseline itself DNFs, so every ratio at that param nulls.
  dnf('attaform', 'flat', 'F10', 'keystroke'),
  timed('vee-validate', 'flat', 'F10', 'keystroke', 5),
  // nested.validate: a library DNFs at the SMALLEST param, so its slope at the
  // larger param is unknown even though its ratio there still computes.
  timed('attaform', 'nested', 'D4', 'validate', 10),
  timed('attaform', 'nested', 'D8', 'validate', 20),
  dnf('formkit', 'nested', 'D4', 'validate'),
  timed('formkit', 'nested', 'D8', 'validate', 50),
]

describe('runtime-shape DNF discrimination', () => {
  it('statusOf defaults a status-less cell to measured', () => {
    expect(statusOf(timed('attaform', 'flat', 'F10', 'keystroke', 1))).toBe('measured')
    expect(statusOf(dnf('formkit', 'massive', 'L5000', 'validate'))).toBe('did-not-finish')
    expect(statusOf(memory('attaform', 'flat', 'F10', 1))).toBe('measured')
  })

  it('isDnf is true only for a did-not-finish cell', () => {
    expect(isDnf(dnf('formkit', 'massive', 'L5000', 'validate'))).toBe(true)
    expect(isDnf(timed('attaform', 'flat', 'F10', 'keystroke', 1))).toBe(false)
    expect(isDnf(memory('attaform', 'flat', 'F10', 1))).toBe(false)
  })

  it('cellValue reads median for timed and retained for memory', () => {
    expect(cellValue(timed('attaform', 'flat', 'F10', 'keystroke', 7))).toBe(7)
    expect(cellValue(memory('attaform', 'flat', 'F10', 4096))).toBe(4096)
  })
})

describe('rowOf', () => {
  it('a DNF cell yields a status-only row with a budget and no median', () => {
    const row = rowOf(dnf('tanstack', 'massive', 'L5000', 'validate', 320_000))
    expect(row.status).toBe('did-not-finish')
    expect(row.budgetMs).toBe(320_000)
    expect(row.supported).toBe(true)
    expect(row.median).toBeUndefined()
    expect('unit' in row).toBe(false)
  })

  it('a measured timed cell yields a full row stamped measured', () => {
    const row = rowOf(timed('attaform', 'flat', 'F10', 'keystroke', 12))
    expect(row.status).toBe('measured')
    expect(row.median).toBe(12)
    expect(row.unit).toBe('ms')
    expect(row.supported).toBe(true)
  })
})

describe('buildRuntime ratio and slope with DNF cells', () => {
  const rt = buildRuntime(cells, libOrder)

  it('a DNF cell gets null ratio and slope and never a median', () => {
    const tanstack = rowFor(rowsAt(rt, 'massive', 'validate', 'L5000'), 'tanstack')
    expect(tanstack.status).toBe('did-not-finish')
    expect(tanstack.ratio).toBeNull()
    expect(tanstack.slope).toBeNull()
    expect(tanstack.median).toBeUndefined()
    expect(tanstack.budgetMs).toBe(320_000)
  })

  it('a measured cell beside a DNF cell still computes its ratio and slope', () => {
    const attaform = rowFor(rowsAt(rt, 'massive', 'validate', 'L5000'), 'attaform')
    expect(attaform.ratio).toBe(1) // baseline versus itself
    expect(attaform.slope).toBe(3) // 30 at L5000 over 10 at L2000
    const tanstackSmall = rowFor(rowsAt(rt, 'massive', 'validate', 'L2000'), 'tanstack')
    expect(tanstackSmall.ratio).toBe(2) // 20 over the baseline 10
    expect(tanstackSmall.slope).toBe(1) // its own smallest param
  })

  it('the column unit is read from a measured cell, never the DNF row', () => {
    expect(block(rt, 'massive', 'validate').unit).toBe('ms')
  })

  it('a DNF baseline nulls every ratio at that param', () => {
    const rows = rowsAt(rt, 'flat', 'keystroke', 'F10')
    const attaform = rowFor(rows, 'attaform')
    expect(attaform.status).toBe('did-not-finish')
    expect(attaform.ratio).toBeNull()
    const vee = rowFor(rows, 'vee-validate')
    expect(vee.median).toBe(5) // it measured fine
    expect(vee.ratio).toBeNull() // but the baseline did not, so there is no ratio
    expect(vee.slope).toBe(1) // its own smallest param
  })

  it('a DNF smallest param nulls that library slope at larger params', () => {
    const formkitSmall = rowFor(rowsAt(rt, 'nested', 'validate', 'D4'), 'formkit')
    expect(formkitSmall.status).toBe('did-not-finish')
    const formkitLarge = rowFor(rowsAt(rt, 'nested', 'validate', 'D8'), 'formkit')
    expect(formkitLarge.ratio).toBe(2.5) // 50 over the baseline 20, still computable
    expect(formkitLarge.slope).toBeNull() // but the D4 base did not finish
  })
})
