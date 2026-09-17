#!/usr/bin/env node
/**
 * Per-PR benchmark attribution: run the hot-path suites against this
 * revision and against the merge base, interleaved, and report the
 * per-scenario delta.
 *
 * This exists because `check-bench` cannot see most of what it is
 * guarding. It gates only groups that pair an `old:` bench against a
 * `new:` one, 3 of 15 bench files. A 34% regression in `getAtPath`
 * shipped through that gap: the suite that measures path reads has no
 * such pair, so the gate never looked, and the suites that do have pairs
 * compare each revision
 * against a baseline implementation living in the same file rather than
 * against the previous commit, so both arms move together and the ratio
 * holds.
 *
 * Interleaving is the point. Benchmarks on a laptop or a shared runner
 * drift with thermal load by more than the regressions worth catching,
 * so a number from one process compared against a number from another
 * is not evidence. Alternating revisions within one run and taking
 * medians makes the comparison survive the drift.
 *
 * One round is not enough, and the script says so rather than letting a
 * reader find out. Validating it against a known-good branch, a single
 * round reported five proxy-read scenarios 8-11% slower that three
 * rounds placed between -1% and +5%. So the default is three, and any
 * scenario whose own repeat runs disagree by as much as the delta
 * itself is marked `noisy` instead of being reported as a finding.
 *
 * Three rounds is still not always enough, and the cheapest way to
 * tell is to ask what the flagged scenario actually runs before
 * theorising about why it moved. Several `old:` arms are baseline
 * implementations written inline in the bench file and import nothing
 * from `src/`, so they execute byte-identical code on both sides by
 * construction. They are a free control: when one of those is reported
 * slower, the number being read is this harness's own noise floor, and
 * every other row at that magnitude should be read the same way.
 * Observed on a build-time-only change, where three rounds called two
 * scenarios slower beyond noise and seven rounds called nothing slower.
 *
 * The inverse also holds, from the other direction: several scenarios
 * moving together in one direction is a finding even when each is
 * individually marked `noisy`. Six proxy-read scenarios doing that
 * caught a real cache deletion during the efficiency program.
 *
 * Non-gating, like `eager-delta.mjs`. It makes the number visible on
 * the PR; a human decides whether a regression is bought or accidental.
 *
 * Usage:
 *   node scripts/bench-delta.mjs                 # vs origin/main
 *   BENCH_BASE_REF=v0.29.0 node scripts/bench-delta.mjs
 *   BENCH_ROUNDS=3 node scripts/bench-delta.mjs
 *   BENCH_SUITES='bench/keystroke.bench.ts' node scripts/bench-delta.mjs
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env, exit } from 'node:process'

const ROOT = join(import.meta.dirname, '..')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

/**
 * The suites that cover the paths a form pays on every keystroke: the
 * write funnel, the value reads under it, the array helpers, the error
 * rollup, and the reset rebuild.
 */
const DEFAULT_SUITES = [
  'bench/keystroke.bench.ts',
  'bench/value-tree-access.bench.ts',
  'bench/field-arrays.bench.ts',
  'bench/errors-materialization.bench.ts',
  'bench/reset.bench.ts',
]

const SUITES = (env.BENCH_SUITES ?? DEFAULT_SUITES.join(' ')).split(/\s+/).filter(Boolean)
const ROUNDS = Number(env.BENCH_ROUNDS ?? 3)
const BASE_REF = env.BENCH_BASE_REF ?? 'origin/main'
/** Below this, a delta is drift rather than a finding. */
const REPORT_THRESHOLD_PCT = 5

if (git('status', '--porcelain', '--', 'src').length > 0) {
  console.error('[bench-delta] `src/` has uncommitted changes; commit or stash them first.')
  console.error('[bench-delta] This script swaps `src/` in place and would lose them.')
  exit(1)
}

let base
try {
  base = git('merge-base', BASE_REF, 'HEAD')
} catch {
  console.log(`[bench-delta] no merge base against ${BASE_REF}; skipping.`)
  exit(0)
}
if (base === git('rev-parse', 'HEAD')) {
  console.log('[bench-delta] HEAD is the merge base; nothing to compare.')
  exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'attaform-bench-delta-'))
const headSrc = join(scratch, 'head')
const baseSrc = join(scratch, 'base')
cpSync(join(ROOT, 'src'), headSrc, { recursive: true })
execFileSync('sh', ['-c', `git archive ${base} src | tar -x -C ${JSON.stringify(scratch)}`], {
  cwd: ROOT,
})
cpSync(join(scratch, 'src'), baseSrc, { recursive: true })
rmSync(join(scratch, 'src'), { recursive: true, force: true })

/** Put `from` in place of `src/`, replacing it wholesale. */
function useSource(from) {
  rmSync(join(ROOT, 'src'), { recursive: true, force: true })
  cpSync(from, join(ROOT, 'src'), { recursive: true })
}

// Restore on every exit path, including a signal: a half-swapped `src/`
// is the one genuinely bad outcome here.
let restored = false
function restore() {
  if (restored) return
  restored = true
  try {
    useSource(headSrc)
  } catch (error) {
    console.error(`[bench-delta] COULD NOT RESTORE src/: ${error.message}`)
    console.error(`[bench-delta] recover with: git checkout -- src && git clean -fd src`)
  }
  rmSync(scratch, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (restore(), exit(130)))
process.on('exit', restore)

/** One bench run over `SUITES`, as scenario name -> ops/sec. */
function measure() {
  const out = join(scratch, `bench-${Math.random().toString(36).slice(2)}.json`)
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['vitest', 'bench', '--run', `--outputJson=${out}`, ...SUITES],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
  )
  const report = JSON.parse(readFileSync(out, 'utf8'))
  const rows = new Map()
  for (const file of report.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const bench of group.benchmarks ?? []) {
        if (typeof bench.name === 'string' && typeof bench.hz === 'number') {
          rows.set(`${group.fullName} > ${bench.name}`, bench.hz)
        }
      }
    }
  }
  return rows
}

const samples = new Map()
const record = (side, rows) => {
  for (const [name, hz] of rows) {
    const entry = samples.get(name) ?? { head: [], base: [] }
    entry[side].push(hz)
    samples.set(name, entry)
  }
}

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`[bench-delta] round ${round}/${ROUNDS}: HEAD`)
  useSource(headSrc)
  record('head', measure())
  console.log(`[bench-delta] round ${round}/${ROUNDS}: base ${base.slice(0, 8)}`)
  useSource(baseSrc)
  record('base', measure())
}
restore()

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** How far a side's own repeat runs spread, as a percentage of its median. */
const spreadPct = (values) => {
  if (values.length < 2) return Infinity
  const mid = median(values)
  if (mid <= 0) return Infinity
  return (100 * (Math.max(...values) - Math.min(...values))) / mid
}

const results = []
for (const [name, { head, base: baseRuns }] of samples) {
  if (head.length === 0 || baseRuns.length === 0) continue
  const b = median(baseRuns)
  const h = median(head)
  if (b <= 0) continue
  const pct = (100 * (h - b)) / b
  // A delta smaller than the run-to-run spread on either side is not
  // distinguishable from drift, however large it looks.
  const noise = Math.max(spreadPct(baseRuns), spreadPct(head))
  results.push({ name, base: b, head: h, pct, noisy: noise >= Math.abs(pct) })
}
results.sort((a, b) => a.pct - b.pct)

const moved = results.filter((r) => Math.abs(r.pct) >= REPORT_THRESHOLD_PCT)
const slower = moved.filter((r) => r.pct < 0 && !r.noisy)
const fmt = (n) => Math.round(n).toLocaleString('en-US')
const lines = [
  '### Benchmark attribution',
  '',
  `Base \`${base.slice(0, 8)}\` → this PR. ${ROUNDS} interleaved round(s), medians.`,
  `${results.length} scenarios; ${moved.length} moved by ${REPORT_THRESHOLD_PCT}% or more.`,
  '',
  // The numbers are hz, so a bigger one is better and a `+` is good news.
  // Spelling that out per row rather than leaving a bare `+94%` next to a
  // scenario name, which reads like damage at a glance.
  '`hz` is operations per second: **higher is better**, so `+` is faster.',
  '',
]
if (moved.length === 0) {
  lines.push(`**No scenario moved by ${REPORT_THRESHOLD_PCT}% or more.**`, '')
} else {
  lines.push('| scenario | base | PR | change | |', '| --- | ---: | ---: | ---: | --- |')
  for (const r of moved) {
    const direction = r.pct > 0 ? 'faster' : 'slower'
    const note = r.noisy ? "noisy (within this scenario's own run-to-run spread)" : ''
    lines.push(
      `| ${r.name} | ${fmt(r.base)} hz | ${fmt(r.head)} hz | **${Math.abs(r.pct).toFixed(1)}% ${direction}** | ${note} |`
    )
  }
  lines.push(
    '',
    slower.length > 0
      ? `**${slower.length} slower beyond noise.** Worth an explanation in the PR body.`
      : "**Nothing slower beyond this run's noise floor.**",
    ''
  )
}
const table = lines.join('\n')
console.log(table)
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`)
