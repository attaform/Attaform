#!/usr/bin/env node
/**
 * Guardrail: run the benches and fail if a `new:` implementation
 * regresses below 3× the `old:` one it replaced, for any scenario that
 * pairs the two.
 *
 * KNOW WHAT THIS DOES NOT COVER, because it is most of the suite. Only
 * groups pairing an `old:` bench with a `new:` one are gated, three of
 * fifteen bench files, and the ratio compares each revision against a
 * baseline implementation in the same file rather than against the
 * previous commit. So when both arms slow down together the ratio holds,
 * and a scenario with no pair is not measured at all. A 34% regression in
 * `getAtPath` shipped through exactly that gap: `value-tree-access` has
 * no pair, so nothing looked.
 *
 * The ungated groups are now listed rather than skipped in silence, and
 * `scripts/bench-delta.mjs` covers the other half by measuring this
 * revision against the merge base directly.
 *
 * Runs as part of `pnpm check` via the `check:bench` script in
 * package.json. The bench itself lives at bench/keystroke.bench.ts, where
 * each `describe` group pairs an "old: ..." and a "new: ..." bench. We parse
 * the vitest bench JSON output, walk each group, and assert
 *   hz(new) / hz(old) >= RATIO_FLOOR.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RATIO_FLOOR = 3.0

const tmp = mkdtempSync(join(tmpdir(), 'attaform-bench-'))
const outputPath = join(tmp, 'bench.json')

// Run the bench; let vitest write to our temp JSON file so we don't fight
// with stdout interleaving.
try {
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['vitest', 'bench', '--run', `--outputJson=${outputPath}`],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[check-bench] vitest bench exited non-zero: ${err?.message ?? err}`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(outputPath, 'utf8'))
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[check-bench] Failed to parse bench JSON at ${outputPath}: ${err?.message ?? err}`)
  process.exit(1)
}

const failures = []
const ungated = []

for (const file of report.files ?? []) {
  for (const group of file.groups ?? []) {
    const benchmarks = group.benchmarks ?? []
    const oldBench = benchmarks.find((b) => b.name?.startsWith('old:'))
    const newBench = benchmarks.find((b) => b.name?.startsWith('new:'))
    if (!oldBench || !newBench) {
      // No old/new pair, so there is no ratio to hold. Record it: an
      // unmeasured scenario reported as nothing is how a regression gets
      // to look like a pass.
      ungated.push(group.fullName)
      continue
    }
    const ratio = newBench.hz / oldBench.hz
    const status = ratio >= RATIO_FLOOR ? 'OK' : 'FAIL'
    // eslint-disable-next-line no-console
    console.log(
      `[check-bench] ${status}  ${group.fullName}  ratio=${ratio.toFixed(2)}× ` +
        `(old=${oldBench.hz.toFixed(0)} hz, new=${newBench.hz.toFixed(0)} hz, floor=${RATIO_FLOOR}×)`
    )
    if (ratio < RATIO_FLOOR) {
      failures.push({
        group: group.fullName,
        ratio,
        oldHz: oldBench.hz,
        newHz: newBench.hz,
      })
    }
  }
}

if (failures.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `\n[check-bench] ${failures.length} scenario(s) regressed below ${RATIO_FLOOR}× threshold:`
  )
  for (const f of failures) {
    // eslint-disable-next-line no-console
    console.error(`  - ${f.group}: ${f.ratio.toFixed(2)}×`)
  }
  process.exit(1)
}

if (ungated.length > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `\n[check-bench] ${ungated.length} group(s) carry no old/new pair and are NOT gated here:`
  )
  for (const name of ungated) {
    // eslint-disable-next-line no-console
    console.log(`  - ${name}`)
  }
  // eslint-disable-next-line no-console
  console.log('[check-bench] Their regressions surface through scripts/bench-delta.mjs.')
}

// eslint-disable-next-line no-console
console.log(`\n[check-bench] All ${RATIO_FLOOR}×-gated scenarios within floor.`)
