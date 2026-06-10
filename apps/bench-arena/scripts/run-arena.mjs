#!/usr/bin/env node
/**
 * The benchmark orchestrator: it produces the provenance-stamped results.json
 * the documentation renders.
 *
 * Rather than re-drive the cohort (which would duplicate the spec's cell matrix
 * and its CDP memory loop, two copies that could silently drift), it RUNS the
 * Playwright spec and harvests each cell's measurement from a per-test
 * attachment. So the published numbers and the gate that asserts they are
 * well-formed come from the exact same green run: they cannot diverge. The spec
 * config already builds the production preview and exposes gc, so this script
 * only orchestrates, aggregates, and writes.
 *
 * Steps: run the spec (abort if it is red) -> harvest the cell + meta
 * attachments -> measure bundles -> look up each library's OpenSSF Scorecard
 * (best-effort) -> compute ratios and slopes -> stamp provenance -> write
 * results.json.
 *
 * Run `pnpm prepack` at the repo root first so the Attaform rows measure the
 * real published dist. The committed results.json must always come from CI; a
 * local run (or a --grep smoke run, which writes results.smoke.json) is for
 * development only and stamps its provenance source as "local".
 *
 * CLI:
 *   node scripts/run-arena.mjs                 full run -> results.json
 *   node scripts/run-arena.mjs --grep <pat>    partial smoke run -> results.smoke.json
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { argv, env, exit, version as nodeVersion } from 'node:process'
import { fileURLToPath } from 'node:url'
import { readInstalledRepoSlug, readInstalledVersions } from './installed-version.mjs'
import { measureBundles } from './measure-bundles.mjs'
import { fetchScorecards, scorecardViewerUrl } from './scorecards.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCHEMA_VERSION = 1
const BASELINE = 'attaform'

// Stable output ordering, so the committed results.json diffs minimally run to
// run. Scenarios and dimensions emit in these orders; params sort by size and
// rows by the cohort order the registry defines (read from the meta payload).
const SCENARIO_ORDER = [
  'flat',
  'nested',
  'arrays',
  'grid',
  'discriminated-union',
  'massive',
  'wizard',
]
const DIM_ORDER = [
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

// Packages whose resolved (lockfile-pinned) versions stamp the provenance block.
const LIB_VERSION_PKGS = [
  'attaform',
  'vee-validate',
  '@tanstack/vue-form',
  '@formisch/vue',
  '@regle/core',
  '@formkit/vue',
  '@vuelidate/core',
  'zod',
  'valibot',
]

// Adapter id -> the npm package whose `repository` field locates its source, so
// the Scorecard slug is derived from the lockfile-pinned package rather than
// hardcoded (it self-corrects when a project moves orgs). Regle's two adapters
// share one repository.
const LIB_REPO_PKG = {
  attaform: 'attaform',
  'vee-validate': 'vee-validate',
  tanstack: '@tanstack/vue-form',
  formisch: '@formisch/vue',
  'regle-schema': '@regle/core',
  'regle-rules': '@regle/core',
  formkit: '@formkit/vue',
  vuelidate: '@vuelidate/core',
}

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

/** The value a cell's ratio and slope are computed on: keystroke/mount/etc. use
 *  the timed median; memory uses retained heap (its headline, churn is noisier). */
function cellValue(cell) {
  return cell.kind === 'memory' ? cell.retained : cell.summary.median
}

function parseArgs() {
  const grepIndex = argv.indexOf('--grep')
  const grep = grepIndex >= 0 ? (argv[grepIndex + 1] ?? null) : null
  return { grep }
}

/** Run the Playwright spec (live `list` output) and tee a JSON report to disk. */
function runSpec(grep) {
  const reportPath = join(PKG_ROOT, 'test-results', 'arena-report.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  const args = ['exec', 'playwright', 'test', '--reporter=list,json']
  if (grep) args.push('--grep', grep)
  const result = spawnSync('pnpm', args, {
    cwd: PKG_ROOT,
    stdio: 'inherit',
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
  })
  return { status: result.status ?? 1, reportPath }
}

/** Depth-first walk of the report's nested suites, yielding every spec. */
function* walkSpecs(suite) {
  for (const child of suite.suites ?? []) yield* walkSpecs(child)
  for (const spec of suite.specs ?? []) yield spec
}

/** Decode the cell + meta attachments the spec emitted (inline base64 JSON). */
function harvest(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const cells = []
  let meta = null
  for (const top of report.suites ?? []) {
    for (const spec of walkSpecs(top)) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          for (const att of result.attachments ?? []) {
            if (typeof att.body !== 'string') continue
            const payload = JSON.parse(Buffer.from(att.body, 'base64').toString('utf8'))
            if (att.name === 'cell') cells.push(payload)
            else if (att.name === 'meta') meta = payload
          }
        }
      }
    }
  }
  return { cells, meta }
}

/**
 * Capability matrix + display metadata, straight from the built adapters' meta,
 * plus each library's repository and (best-effort) OpenSSF Scorecard. A library
 * with no published Scorecard carries scorecard: null; the docs render that as
 * "not published" and link the repository instead.
 */
function capabilitiesOf(meta, scorecardInfo) {
  return (meta ?? []).map((m) => {
    const row = {
      lib: m.id,
      displayName: m.displayName,
      layer: m.layer,
      schemaLib: m.schemaLib,
      ownsInputs: m.ownsInputs,
    }
    for (const scenario of SCENARIO_ORDER)
      row[scenario] = m.capabilities?.[scenario] ?? 'unsupported'
    const info = scorecardInfo?.[m.id]
    row.repo = info?.repo ?? null
    row.repoUrl = info?.repoUrl ?? null
    row.scorecardUrl = info?.viewerUrl ?? null
    row.scorecard = info?.scorecard ?? null
    return row
  })
}

/**
 * Per-adapter repository + OpenSSF Scorecard info. Derives each library's repo
 * slug from its installed package, resolves the published scores in one
 * best-effort batch, and returns adapter id -> { repo, repoUrl, viewerUrl,
 * scorecard }. Never throws: a failed lookup leaves scorecard null.
 */
async function buildScorecardInfo(meta) {
  const slugById = {}
  for (const m of meta ?? []) {
    const pkg = LIB_REPO_PKG[m.id]
    slugById[m.id] = pkg ? readInstalledRepoSlug(pkg) : null
  }
  const scores = await fetchScorecards(Object.values(slugById))
  const info = {}
  for (const [id, slug] of Object.entries(slugById)) {
    info[id] = {
      repo: slug,
      repoUrl: slug ? `https://${slug}` : null,
      viewerUrl: slug ? scorecardViewerUrl(slug) : null,
      scorecard: slug ? (scores[slug] ?? null) : null,
    }
  }
  return info
}

/**
 * The cohort display order for stable row sorting: the registry order from meta
 * first, then any adapter seen only in the cells (so a --grep smoke run with no
 * meta attachment still orders its rows).
 */
function libOrderOf(meta, cells) {
  const order = new Map()
  ;(meta ?? []).forEach((m) => order.set(m.id, order.size))
  for (const cell of cells) if (!order.has(cell.adapter)) order.set(cell.adapter, order.size)
  return order
}

/** Build one results-row from a harvested cell (timed dims and memory differ). */
function rowOf(cell) {
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
  return {
    lib: cell.adapter,
    median: cell.summary.median,
    p95: cell.summary.p95,
    iqr: cell.summary.iqr,
    count: cell.summary.count,
    trimmed: cell.summary.trimmed,
    unit: cell.unit,
    supported: cell.supported,
  }
}

/**
 * Assemble the runtime block: scenario -> dim -> { unit, byParam }, with ratio
 * (versus the baseline at the same param) and slope (versus the same library at
 * the scenario's smallest param) computed per row. Emitted in stable order.
 */
function buildRuntime(cells, libOrder) {
  // Index cells by scenario|dim|param|lib for the ratio/slope lookups.
  const index = new Map()
  const key = (s, d, p, lib) => `${s}|${d}|${p}|${lib}`
  const grouped = {}
  for (const cell of cells) {
    const dim = cell.kind === 'memory' ? 'memory' : cell.dim
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
        const baseValue = baseCell ? cellValue(baseCell) : 0
        const built = []
        for (const m of libOrder.keys()) {
          const cell = index.get(key(scenario, dim, param, m))
          if (!cell) continue
          const row = rowOf(cell)
          const value = cellValue(cell)
          row.ratio = baseValue > 0 ? round2(value / baseValue) : null
          const smallestCell = index.get(key(scenario, dim, smallest, m))
          const smallestValue = smallestCell ? cellValue(smallestCell) : 0
          row.slope = smallestValue > 0 ? round2(value / smallestValue) : 1
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

async function main() {
  const { grep } = parseArgs()
  const smoke = grep !== null

  const { status, reportPath } = runSpec(grep)
  if (status !== 0) {
    console.error(`\n[run-arena] the spec run failed (exit ${status}); not writing results.`)
    exit(status)
  }

  const { cells, meta } = harvest(reportPath)
  if (cells.length === 0) {
    console.error('[run-arena] no cell measurements were harvested from the report.')
    exit(1)
  }
  if (!meta && !smoke) {
    console.error('[run-arena] the cohort meta attachment was missing from a full run.')
    exit(1)
  }

  const libOrder = libOrderOf(meta, cells)
  const scorecardInfo = await buildScorecardInfo(meta)
  const cpus = os.cpus()
  const runId = env.GITHUB_RUN_ID
  const ciRunUrl =
    runId && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : null

  const results = {
    schemaVersion: SCHEMA_VERSION,
    provenance: {
      source: runId ? 'ci' : 'local',
      commit: env.GITHUB_SHA ?? null,
      ciRunId: runId ?? null,
      ciRunUrl,
      runner: {
        os: os.platform(),
        arch: os.arch(),
        cpuModel: cpus[0]?.model ?? 'unknown',
        cpuCount: cpus.length,
      },
      node: nodeVersion,
      timestamp: new Date().toISOString(),
      libVersions: readInstalledVersions(LIB_VERSION_PKGS),
    },
    baseline: BASELINE,
    capabilities: capabilitiesOf(meta, scorecardInfo),
    bundle: await measureBundles(),
    runtime: buildRuntime(cells, libOrder),
  }

  const outPath = join(PKG_ROOT, smoke ? 'results.smoke.json' : 'results.json')
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(
    `\n[run-arena] wrote ${outPath} ` +
      `(${cells.length} cells, ${results.bundle.length} bundle rows, source=${results.provenance.source})`
  )
}

await main()
