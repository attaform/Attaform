#!/usr/bin/env node
/**
 * Run the benchmark suite and report which scenarios carry a ratio floor
 * and which do not.
 *
 * THE FLOOR ITSELF NO LONGER LIVES HERE. Under vitest 4 this script owned
 * the 3x gate: it re-parsed the bench JSON, paired arms by an `old:` /
 * `new:` naming convention and compared their `hz`. vitest 5 asserts
 * benchmark results directly, so the floor moved into the bench files via
 * `bench/lib/ratio-floor.ts` and the runner enforces it. A broken floor
 * now fails `pnpm bench` as well as this script, and it fails at the arm
 * that broke rather than in a table printed afterwards.
 *
 * What is left is the half that nothing else does: the census. Only
 * groups pairing an `old:` bench with a `new:` one are gated, three of
 * fifteen bench files, and the ratio compares each revision against a
 * baseline implementation in the same file rather than against the
 * previous commit. So when both arms slow down together the ratio holds,
 * and a scenario with no pair is not measured at all. A 34% regression in
 * `getAtPath` shipped through exactly that gap: `value-tree-access` has
 * no pair, so nothing looked. Listing the ungated groups by name is what
 * stops an unmeasured scenario reading as a clean one.
 *
 * `scripts/bench-delta.mjs` covers that other half by measuring this
 * revision against the merge base directly.
 *
 * The `old:` / `new:` prefixes this script reads are written by
 * `benchAgainstBaseline`, never by hand, so a pair reported as gated is
 * one the assertion actually ran against.
 *
 * Runs as part of `pnpm check` via the `check:bench` script in
 * package.json.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'attaform-bench-'))
const outputPath = join(tmp, 'bench.json')

// vitest 5 dropped `--outputJson`; the JSON reporter plus `--outputFile`
// replaces it. Let vitest write to our temp file so we don't fight with
// stdout interleaving.
try {
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['vitest', 'bench', '--run', '--reporter=json', `--outputFile=${outputPath}`],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
} catch (err) {
  // A failing `toBeFasterThan` lands here: vitest reports the scenario and
  // the ratio it missed by, then exits non-zero.
  console.error(`[check-bench] vitest bench exited non-zero: ${err?.message ?? err}`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(outputPath, 'utf8'))
} catch (err) {
  console.error(`[check-bench] Failed to parse bench JSON at ${outputPath}: ${err?.message ?? err}`)
  process.exit(1)
}

/**
 * vitest 5's benchmark results hang off the test that registered them:
 * one `benchmarks[]` entry per test, whose `name` is the test's full
 * name, and one `tasks[]` entry per `bench()` call under it. There is no
 * `hz` field any more; ops/sec is `throughput.mean` and the millisecond
 * figure is `latency.mean`.
 */
const gated = []
const ungated = []

for (const file of report.testResults ?? []) {
  for (const assertion of file.assertionResults ?? []) {
    for (const group of assertion.benchmarks ?? []) {
      const tasks = group.tasks ?? []
      const oldTask = tasks.find((t) => t.name?.startsWith('old:'))
      const newTask = tasks.find((t) => t.name?.startsWith('new:'))
      if (oldTask === undefined || newTask === undefined) {
        ungated.push(group.name)
        continue
      }
      gated.push({
        group: group.name,
        ratio: newTask.throughput.mean / oldTask.throughput.mean,
        oldHz: oldTask.throughput.mean,
        newHz: newTask.throughput.mean,
      })
    }
  }
}

for (const { group, ratio, oldHz, newHz } of gated) {
  console.log(
    `[check-bench] FLOOR HELD  ${group}  ratio=${ratio.toFixed(2)}x ` +
      `(old=${oldHz.toFixed(0)} hz, new=${newHz.toFixed(0)} hz)`
  )
}

if (ungated.length > 0) {
  console.log(`\n[check-bench] ${ungated.length} group(s) carry no old/new pair and are NOT gated:`)
  for (const name of ungated) {
    console.log(`  - ${name}`)
  }
  console.log('[check-bench] Their regressions surface through scripts/bench-delta.mjs.')
}

if (gated.length === 0) {
  console.error(
    '\n[check-bench] NO gated scenario ran. Every floor assertion has gone missing, ' +
      'or the bench run collected nothing.'
  )
  process.exit(1)
}

console.log(`\n[check-bench] ${gated.length} floor-gated scenario(s) ran, all within floor.`)
