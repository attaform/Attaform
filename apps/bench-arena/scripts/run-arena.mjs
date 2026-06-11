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
 *   node scripts/run-arena.mjs                   full run -> results.json
 *   node scripts/run-arena.mjs --grep <pat>      partial smoke run -> results.smoke.json
 *   node scripts/run-arena.mjs --scorecards-only refresh only the supply-chain scores in
 *                                                results.json, in place, with no browser run
 *
 * Sharded across runners (the monthly workflow), the same orchestrator runs in
 * two extra modes so the long sweep splits over separate CPU-isolated machines:
 *   node scripts/run-arena.mjs --grep <pat> --emit-cells <path>
 *                                                shard mode: run one grep slice and write its
 *                                                harvested cells (no scorecards/bundles/runtime)
 *   node scripts/run-arena.mjs --assemble <dir>  merge mode: fold every shard partial in <dir>,
 *                                                run the global tail once -> results.json
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { argv, env, exit, version as nodeVersion } from 'node:process'
import { fileURLToPath } from 'node:url'
import { readInstalledRepoSlug, readInstalledVersions } from './installed-version.mjs'
import { measureBundles } from './measure-bundles.mjs'
import { BASELINE, buildRuntime, isDnf, SCENARIO_ORDER } from './runtime-shape.mjs'
import { fetchScorecards, scorecardViewerUrl } from './scorecards.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCHEMA_VERSION = 1

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

function parseArgs() {
  const flagValue = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  return {
    grep: flagValue('--grep'),
    scorecardsOnly: argv.includes('--scorecards-only'),
    emitCells: flagValue('--emit-cells'),
    assemble: flagValue('--assemble'),
  }
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

/** The repository + Scorecard fields, stamped onto a capability row in one
 *  canonical key order so the full-run and the --scorecards-only paths emit an
 *  identical shape. scorecardStatus is the discriminant the docs render on:
 *  'published' carries a score, 'not-published' is an opted-out project, and
 *  'unavailable' is a lookup that did not complete (a gap on our side). */
function stampScorecard(row, info) {
  row.repo = info?.repo ?? null
  row.repoUrl = info?.repoUrl ?? null
  row.scorecardUrl = info?.viewerUrl ?? null
  row.scorecardStatus = info?.status ?? 'unavailable'
  row.scorecard = info?.scorecard ?? null
  return row
}

/**
 * Capability matrix + display metadata, straight from the built adapters' meta,
 * plus each library's repository and (best-effort) OpenSSF Scorecard.
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
    return stampScorecard(row, scorecardInfo?.[m.id])
  })
}

/**
 * Per-adapter repository + OpenSSF Scorecard info for a list of adapter ids.
 * Derives each library's repo slug from its installed package, resolves the
 * Scorecards in one best-effort batch, and returns adapter id -> { repo,
 * repoUrl, viewerUrl, status, scorecard }. status is 'published' |
 * 'not-published' | 'unavailable'; scorecard carries { score, date } only when
 * published. Never throws: a slug that cannot be derived, or a lookup that does
 * not complete, both resolve to status 'unavailable'.
 */
async function buildScorecardInfo(ids) {
  const slugById = {}
  for (const id of ids) {
    const pkg = LIB_REPO_PKG[id]
    slugById[id] = pkg ? readInstalledRepoSlug(pkg) : null
  }
  const results = await fetchScorecards(Object.values(slugById))
  const info = {}
  for (const [id, slug] of Object.entries(slugById)) {
    const result = slug ? results[slug] : null
    info[id] = {
      repo: slug,
      repoUrl: slug ? `https://${slug}` : null,
      viewerUrl: slug ? scorecardViewerUrl(slug) : null,
      status: result?.status ?? 'unavailable',
      scorecard: result?.status === 'published' ? { score: result.score, date: result.date } : null,
    }
  }
  return info
}

/**
 * Refresh only the supply-chain (Scorecard) fields of the committed
 * results.json, in place, without re-running the browser sweep. Supply-chain
 * scores move on a different cadence than runtime performance, so this keeps the
 * verified runtime numbers untouched and re-polls just the cohort's Scorecards:
 * it picks up a newly published score, or refreshes an existing snapshot.
 *
 * Safety valve: if every lookup comes back 'unavailable' (the network is down,
 * not the projects), it writes nothing and exits non-zero, so a flaky
 * connection can never overwrite good committed scores with blanks.
 */
async function refreshScorecards() {
  const outPath = join(PKG_ROOT, 'results.json')
  const results = JSON.parse(readFileSync(outPath, 'utf8'))
  const ids = results.capabilities.map((c) => c.lib)
  const info = await buildScorecardInfo(ids)
  const conclusive = Object.values(info).filter(
    (i) => i.status === 'published' || i.status === 'not-published'
  )
  if (conclusive.length === 0) {
    console.error(
      '[run-arena] every Scorecard lookup was unavailable (the network looks down); ' +
        'leaving the committed scores untouched.'
    )
    exit(1)
  }
  const scorecardKeys = ['repo', 'repoUrl', 'scorecardUrl', 'scorecardStatus', 'scorecard']
  results.capabilities = results.capabilities.map((c) => {
    const row = {}
    for (const [k, v] of Object.entries(c)) if (!scorecardKeys.includes(k)) row[k] = v
    return stampScorecard(row, info[c.lib])
  })
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`)
  const published = conclusive.filter((i) => i.status === 'published').length
  console.log(
    `[run-arena] refreshed Scorecards in ${outPath} ` +
      `(${published} published, ${conclusive.length - published} not published, ` +
      `${ids.length - conclusive.length} unavailable)`
  )
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

/**
 * This machine's hardware identity for the provenance block. A shard partial
 * stamps its own, so the merge can fold the cohort of runners that measured.
 */
function runnerIdentity() {
  const cpus = os.cpus()
  return {
    os: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
  }
}

/**
 * Fold the shard runners into one provenance runner block. A homogeneous matrix
 * (every shard is ubuntu-latest) reports a single representative identity; were
 * GitHub's fleet to hand out different CPUs, cpuModel summarizes them as
 * "mixed: ..." rather than silently picking one. shardCount records how many
 * runners the sweep was split across (1 for a single-process run), additive so
 * the renderer and PR body keep reading runner.cpuModel unchanged.
 */
function aggregateRunners(runners) {
  const first = runners[0] ?? runnerIdentity()
  const models = [...new Set(runners.map((r) => r.cpuModel))]
  return {
    os: first.os,
    arch: first.arch,
    cpuModel: models.length <= 1 ? (models[0] ?? first.cpuModel) : `mixed: ${models.join(' + ')}`,
    cpuCount: first.cpuCount,
    shardCount: runners.length,
  }
}

/**
 * The global tail shared by the single-process run and the sharded merge: order
 * the cohort, resolve Scorecards, measure bundles, stamp provenance (with the
 * given runner block, this machine for a local run or the folded shard cohort
 * for a merge), build the runtime block, and write results to outPath.
 */
async function assembleResults(cells, meta, runner, outPath) {
  const libOrder = libOrderOf(meta, cells)
  const scorecardInfo = await buildScorecardInfo((meta ?? []).map((m) => m.id))
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
      runner,
      node: nodeVersion,
      timestamp: new Date().toISOString(),
      libVersions: readInstalledVersions(LIB_VERSION_PKGS),
    },
    baseline: BASELINE,
    capabilities: capabilitiesOf(meta, scorecardInfo),
    bundle: await measureBundles(),
    runtime: buildRuntime(cells, libOrder),
  }

  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`)
  const dnfCount = cells.filter(isDnf).length
  const shardNote = runner.shardCount > 1 ? `, ${runner.shardCount} shards` : ''
  console.log(
    `\n[run-arena] wrote ${outPath} ` +
      `(${cells.length} cells${dnfCount ? `, ${dnfCount} did-not-finish` : ''}, ` +
      `${results.bundle.length} bundle rows, source=${results.provenance.source}${shardNote})`
  )
}

/**
 * Shard mode: run one grep slice of the spec and write its harvested cells (plus
 * the cohort meta, when the slice included the metadata test) to a partial. The
 * merge step concatenates the partials and runs the global tail once. Aborts
 * without writing if the slice is red, the same contract as a full run, so a red
 * shard contributes nothing rather than a half-measured partial.
 */
function emitCells(grep, outPath) {
  const { status, reportPath } = runSpec(grep)
  if (status !== 0) {
    console.error(`\n[run-arena] the shard slice failed (exit ${status}); not writing cells.`)
    exit(status)
  }
  const { cells, meta } = harvest(reportPath)
  if (cells.length === 0) {
    console.error('[run-arena] no cell measurements were harvested from the shard slice.')
    exit(1)
  }
  const partial = {
    schemaVersion: SCHEMA_VERSION,
    cells,
    meta: meta ?? null,
    runner: runnerIdentity(),
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(partial, null, 2)}\n`)
  console.log(
    `[run-arena] wrote ${outPath} (${cells.length} cells, meta ${meta ? 'present' : 'absent'})`
  )
}

/**
 * Merge mode: read every cells-*.json partial the shards uploaded, concatenate
 * their cells, take the cohort meta from the first partial that carried it (the
 * shard whose slice ran the metadata test), fold the runner identities, and run
 * the global tail once. Mirrors the full-run guards: no partials, no cells, or no
 * meta each abort without writing, so an incomplete sweep publishes nothing
 * rather than a thin results.json.
 */
async function assemble(dir) {
  const partials = readdirSync(dir)
    .filter((f) => /^cells-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  if (partials.length === 0) {
    console.error(`[run-arena] no cells-*.json shard partials found in ${dir}.`)
    exit(1)
  }
  const cells = partials.flatMap((p) => p.cells ?? [])
  if (cells.length === 0) {
    console.error('[run-arena] the shard partials carried no cell measurements.')
    exit(1)
  }
  const meta = partials.find((p) => p.meta)?.meta ?? null
  if (!meta) {
    console.error('[run-arena] no shard partial carried the cohort meta attachment.')
    exit(1)
  }
  const runner = aggregateRunners(partials.map((p) => p.runner).filter(Boolean))
  await assembleResults(cells, meta, runner, join(PKG_ROOT, 'results.json'))
}

async function main() {
  const { grep, scorecardsOnly, emitCells: emitCellsPath, assemble: assembleDir } = parseArgs()
  if (scorecardsOnly) {
    await refreshScorecards()
    return
  }
  if (assembleDir !== null) {
    await assemble(resolve(PKG_ROOT, assembleDir))
    return
  }
  if (emitCellsPath !== null) {
    emitCells(grep, resolve(PKG_ROOT, emitCellsPath))
    return
  }
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

  const outPath = join(PKG_ROOT, smoke ? 'results.smoke.json' : 'results.json')
  await assembleResults(cells, meta, { ...runnerIdentity(), shardCount: 1 }, outPath)
}

await main()
