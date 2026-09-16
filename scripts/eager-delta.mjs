#!/usr/bin/env node
/**
 * Per-PR eager attribution. Measures the eager closure for HEAD and for
 * the merge base, and writes a delta table to `$GITHUB_STEP_SUMMARY`.
 *
 * This exists because of a governance finding, not a byte one: between
 * two release tags the eager closure grew 33,004 -> 34,511 (+4.6%) in 22
 * days of ordinary bug-fix guard code, about 2 kB gz a month, which is
 * larger than the whole mechanical tier of the program that then had to
 * win it back. Nothing was wrong with any individual PR. The problem was
 * that no PR had a number attached, so the cost was only ever visible in
 * aggregate, long after the decisions that caused it.
 *
 * Non-gating on purpose. `check-eager-size.mjs` is the gate; this is the
 * attribution. A PR that genuinely needs bytes should be able to spend
 * them, in the open, with the figure in the summary.
 *
 * Both revisions are measured with THIS checkout's harness, via
 * `ATTAFORM_EAGER_SRC_ROOT` pointed at a worktree of the base. Measuring
 * each revision with its own copy of the script would fold a harness edit
 * into the delta and attribute it to the source.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env, exit } from 'node:process'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const BASE_REF = env.EAGER_BASE_REF || 'origin/main'

/** Measure with the current harness against an arbitrary source tree. */
async function measureAt(srcRoot) {
  const prior = env.ATTAFORM_EAGER_SRC_ROOT
  env.ATTAFORM_EAGER_SRC_ROOT = srcRoot
  try {
    // Fresh module instance per root: SRC_ROOT is read at module scope.
    const mod = await import(`./check-eager-size.mjs?root=${encodeURIComponent(srcRoot)}`)
    return await mod.measureEager()
  } finally {
    if (prior === undefined) delete env.ATTAFORM_EAGER_SRC_ROOT
    else env.ATTAFORM_EAGER_SRC_ROOT = prior
  }
}

const ROOT = join(import.meta.dirname, '..')

let base
try {
  base = git('merge-base', BASE_REF, 'HEAD')
} catch {
  console.log(`eager-delta: no merge base against ${BASE_REF}; skipping.`)
  exit(0)
}

const head = await measureAt(ROOT)

let baseResult
const worktree = mkdtempSync(join(tmpdir(), 'attaform-eager-base-'))
try {
  git('worktree', 'add', '--detach', worktree, base)
  baseResult = await measureAt(worktree)
} catch (error) {
  console.log(`eager-delta: could not measure the base (${base.slice(0, 8)}): ${error.message}`)
  exit(0)
} finally {
  try {
    git('worktree', 'remove', '--force', worktree)
  } catch {
    rmSync(worktree, { recursive: true, force: true })
  }
}

const delta = head.eagerGz - baseResult.eagerGz
const pct = ((delta / baseResult.eagerGz) * 100).toFixed(2)
const sign = delta > 0 ? '+' : ''
const verdict = delta > 0 ? '🔺 grew' : delta < 0 ? '🟢 shrank' : '⚪ unchanged'

const table = [
  `### Eager bundle attribution`,
  '',
  `Base \`${base.slice(0, 8)}\` → this PR. The eager closure is what every`,
  `consumer pays on first paint, before any lazy feature runs.`,
  '',
  '| | base | PR | delta |',
  '| --- | ---: | ---: | ---: |',
  `| eager gz | ${baseResult.eagerGz} B | ${head.eagerGz} B | **${sign}${delta} B (${sign}${pct}%)** |`,
  `| async gz | ${baseResult.asyncGz} B | ${head.asyncGz} B | ${head.asyncGz - baseResult.asyncGz} B |`,
  '',
  `**${verdict}.**`,
  '',
].join('\n')

console.log(table)
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`)
