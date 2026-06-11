/**
 * The pure shape of the runtime block: how a harvested cell becomes a results
 * row, and how rows gain their ratio (versus the baseline) and slope (versus the
 * smallest param). Side-effect-free and dependency-free (no fs / os / spec run),
 * so the gating vitest can import and exercise the DNF math directly without
 * triggering the orchestrator's `await main()`.
 *
 * A timed cell carries a status discriminant mirroring the Scorecard precedent:
 * 'measured' is a normal result, 'did-not-finish' is a cell that could not
 * produce a stable median inside its per-cell budget (a single mount of thousands
 * of fields, or a full-form validate at the largest sizes on the heaviest
 * libraries). A DNF row carries a budgetMs and no median/ratio/slope; the math
 * here keeps a DNF cell from poisoning its neighbours' ratios and slopes.
 */

// Stable output ordering, so the committed results.json diffs minimally run to
// run. Scenarios and dimensions emit in these orders; params sort by size and
// rows by the cohort order the registry defines (read from the meta payload).
export const SCENARIO_ORDER = [
  'flat',
  'nested',
  'arrays',
  'grid',
  'discriminated-union',
  'massive',
  'wizard',
]
export const DIM_ORDER = [
  'keystroke',
  'mount',
  'validate',
  'rerender',
  'arrayAdd',
  'arrayReorder',
  'variantFlip',
  'stepTransition',
  'memory',
]

export const BASELINE = 'attaform'

/** Round a ratio/slope to two decimals; medians keep their measured precision. */
function round2(value) {
  return Number(value.toFixed(2))
}

/** A param label's relative size: the product of its numeric codes (F50 -> 50,
 *  N100M8 -> 800), so the smallest param (the slope baseline) sorts first. */
function paramSize(label) {
  const nums = label.match(/\d+/g)
  if (!nums) return 0
  return nums.reduce((acc, n) => acc * Number(n), 1)
}

/** 95th percentile of a small sample (the memory cycles); coarse but adequate. */
function p95(samples) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))
  return sorted[index] ?? 0
}

/** A timed cell's status: a missing discriminant reads as a normal measurement,
 *  so a results.json written before the DNF field existed still reads cleanly. */
export function statusOf(cell) {
  return cell.status ?? 'measured'
}

/** Whether a cell ran out its per-cell budget without a stable median. Only timed
 *  cells DNF; a memory cell carries no status and is always measured. */
export function isDnf(cell) {
  return statusOf(cell) === 'did-not-finish'
}

/** A cell's comparison dimension. Timed cells name their own; a memory cell carries
 *  no `dim` field, so its dimension is implicitly 'memory'. */
export function dimOf(cell) {
  return cell.kind === 'memory' ? 'memory' : cell.dim
}

/** The value a cell's ratio and slope are computed on: keystroke/mount/etc. use
 *  the timed median; memory uses retained heap (its headline, churn is noisier).
 *  Never called on a DNF cell (which has no summary); callers gate on isDnf. */
export function cellValue(cell) {
  return cell.kind === 'memory' ? cell.retained : cell.summary.median
}

/** Build one results-row from a harvested cell (timed dims and memory differ). A
 *  DNF cell yields a status-only row: a budget but no median/p95/unit, so the
 *  renderer shows "did not finish" rather than a fabricated number. */
export function rowOf(cell) {
  if (cell.kind === 'memory') {
    return {
      lib: cell.adapter,
      retained: { median: cell.retained, p95: p95(cell.series.retained), count: cell.cycles },
      churn: { median: cell.churn, p95: p95(cell.series.churn), count: cell.cycles },
      leak: { median: cell.leak, p95: p95(cell.series.leak), count: cell.cycles },
      series: cell.series,
      supported: true,
    }
  }
  if (isDnf(cell)) {
    return {
      lib: cell.adapter,
      status: 'did-not-finish',
      budgetMs: cell.budgetMs,
      supported: true,
    }
  }
  return {
    lib: cell.adapter,
    median: cell.summary.median,
    p95: cell.summary.p95,
    iqr: cell.summary.iqr,
    count: cell.summary.count,
    trimmed: cell.summary.trimmed,
    unit: cell.unit,
    supported: cell.supported,
    status: 'measured',
  }
}

/**
 * Assemble the runtime block: scenario -> dim -> { unit, byParam }, with ratio
 * (versus the baseline at the same param) and slope (versus the same library at
 * the scenario's smallest param) computed per row. Emitted in stable order.
 *
 * A DNF cell never contributes a number: its own ratio and slope are null, and it
 * is excluded as a baseline (so a DNF baseline nulls every ratio at that param),
 * as a slope base (a DNF smallest nulls that library's slopes), and from the
 * column unit inference (it has no unit). A measured cell beside a DNF cell still
 * computes normally.
 */
export function buildRuntime(cells, libOrder) {
  // Index cells by scenario|dim|param|lib for the ratio/slope lookups.
  const index = new Map()
  const key = (s, d, p, lib) => `${s}|${d}|${p}|${lib}`
  const grouped = {}
  for (const cell of cells) {
    const dim = dimOf(cell)
    index.set(key(cell.scenario, dim, cell.params, cell.adapter), cell)
    ;((grouped[cell.scenario] ??= {})[dim] ??= new Set()).add(cell.params)
  }

  const runtime = {}
  for (const scenario of SCENARIO_ORDER) {
    if (!grouped[scenario]) continue
    runtime[scenario] = {}
    for (const dim of DIM_ORDER) {
      const paramSet = grouped[scenario][dim]
      if (!paramSet) continue
      const params = [...paramSet].sort((a, b) => paramSize(a) - paramSize(b))
      const smallest = params[0]
      const byParam = {}
      let unit = dim === 'memory' ? 'bytes' : null
      for (const param of params) {
        const baseCell = index.get(key(scenario, dim, param, BASELINE))
        const baseValue = baseCell && !isDnf(baseCell) ? cellValue(baseCell) : 0
        const built = []
        for (const m of libOrder.keys()) {
          const cell = index.get(key(scenario, dim, param, m))
          if (!cell) continue
          const row = rowOf(cell)
          if (isDnf(cell)) {
            // A cell that did not finish contributes no comparable number; null
            // its ratio and slope so it drops out of every derived statistic.
            row.ratio = null
            row.slope = null
            built.push(row)
            continue
          }
          const value = cellValue(cell)
          row.ratio = baseValue > 0 ? round2(value / baseValue) : null
          const smallestCell = index.get(key(scenario, dim, smallest, m))
          if (!smallestCell) {
            row.slope = 1
          } else if (isDnf(smallestCell)) {
            // The smaller param could not be measured, so the growth factor is
            // unknown rather than 1.
            row.slope = null
          } else {
            const smallestValue = cellValue(smallestCell)
            row.slope = smallestValue > 0 ? round2(value / smallestValue) : 1
          }
          built.push(row)
          if (unit === null && cell.kind === 'timed') {
            // rerender mixes units (FormKit reports the dom-mutation proxy); the
            // canonical column unit is renders, and each row keeps its own unit.
            unit = dim === 'rerender' ? 'renders' : cell.unit
          }
        }
        byParam[param] = built
      }
      runtime[scenario][dim] = { unit: unit ?? 'ms', byParam }
    }
  }
  return runtime
}

/**
 * The single-machine-per-dimension fairness invariant for a sharded sweep. Each
 * shard runs on one machine, so a (scenario, dim) column whose cells came from more
 * than one shard was measured across more than one CPU: its library ratios (a lib
 * versus the baseline at a param) and its slopes (a lib across params) would then
 * compare timings taken on different hardware. Given the shard partials, each
 * carrying the runner it measured on and the cells it produced, return every column
 * measured across more than one CPU model, so the merge can refuse to publish a
 * cohort whose comparisons cross machines. An empty array is a clean cohort.
 *
 * GitHub-hosted runners are a heterogeneous fleet: one monthly sweep can draw two
 * CPU generations at once. So the rule is enforced here rather than assumed from
 * the shard map, which is free to be re-sliced as long as no (scenario, dim) is
 * split across shards.
 */
export function crossMachineColumns(partials) {
  const modelsByColumn = new Map()
  for (const partial of partials) {
    const model = partial.runner?.cpuModel ?? 'unknown'
    for (const cell of partial.cells ?? []) {
      const column = `${cell.scenario} / ${dimOf(cell)}`
      let models = modelsByColumn.get(column)
      if (!models) {
        models = new Set()
        modelsByColumn.set(column, models)
      }
      models.add(model)
    }
  }
  return [...modelsByColumn.entries()]
    .filter(([, models]) => models.size > 1)
    .map(([column, models]) => ({ column, models: [...models].sort() }))
    .sort((a, b) => a.column.localeCompare(b.column))
}
