import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * `docs/scorecard/cii-best-practices-answers.md` is not an internal
 * note. It is the answer key behind a public OpenSSF Best Practices
 * badge, it generates `.bestpractices.json`, and bestpractices.dev
 * pre-fills the submission form from it. An answer that drifts is a
 * public claim that stopped being true.
 *
 * Two had. Criterion 42 said `pnpm check` runs eslint with
 * `--max-warnings 0` and that no warning can land on main; the flag
 * was not in the script, and `no-console` is a warn-severity rule, so
 * a stray `console.log` passed the gate. The script now carries the
 * flag, and this holds it there.
 *
 * Criterion 36 quoted a coverage snapshot that had drifted several
 * points. It now quotes the enforced floor instead, which is the
 * durable number, and this ties it to `vitest.config.ts`.
 *
 * And the generated JSON had drifted from the markdown that generates
 * it by nine criteria, so the form was pre-filling from answers the
 * doc no longer made, a dead evidence URL among them. The page's own
 * submission checklist says regenerating should produce no diff. That
 * is now checked rather than remembered.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ANSWERS = 'docs/scorecard/cii-best-practices-answers.md'

function answers(): string {
  return readFileSync(join(REPO_ROOT, ANSWERS), 'utf8')
}

describe('the badge answer key vs the repo it describes', () => {
  it('the lint gate fails on a warning, as criterion 42 claims', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(answers()).toContain('--max-warnings 0')
    expect(pkg.scripts['lint'], 'criterion 42 promises this flag').toContain('--max-warnings 0')
  })

  it('quotes the coverage floor vitest actually enforces', () => {
    const config = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8')
    const block = /thresholds: \{([\s\S]*?)\}/.exec(config)
    expect(block, 'the coverage thresholds block moved').not.toBeNull()
    const declared = new Map(
      [...(block?.[1] ?? '').matchAll(/(lines|branches|functions|statements): (\d+)/g)].map(
        (match) => [match[1] ?? '', match[2] ?? '']
      )
    )
    expect([...declared.keys()].sort()).toEqual(['branches', 'functions', 'lines', 'statements'])

    const text = answers()
    for (const [metric, percent] of declared) {
      expect(text, `criterion 36 should quote the ${metric} floor`).toContain(
        `${percent}% ${metric}`
      )
    }
  })

  it('carries no hand-maintained count that silently rots', () => {
    // The stale pair: "3,580+ tests as of May 2026" (the suite had
    // grown past 5,200) and "~300+ PRs as of May 2026" (past 600).
    // Both understated the project on a public submission. Evidence
    // that has to be retyped to stay true does not belong here.
    expect(answers()).not.toMatch(/as of \w+ \d{4}/)
  })

  it('the generated JSON is in step with the markdown that generates it', () => {
    // The generator reads and writes relative to cwd, so it runs in a
    // scratch directory holding a copy of its one input. A test must
    // not write into the repo it is checking: a run that is
    // interrupted between the write and the restore would leave the
    // tracked file dirty, and a gate that can create the drift it
    // reports is not a gate.
    const scratch = mkdtempSync(join(tmpdir(), 'attaform-bestpractices-'))
    try {
      mkdirSync(join(scratch, 'docs/scorecard'), { recursive: true })
      copyFileSync(join(REPO_ROOT, ANSWERS), join(scratch, ANSWERS))
      const stdout = execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/build-bestpractices-json.mjs')],
        { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
      expect(stdout).toContain('criteria + project metadata')
      expect(
        readFileSync(join(scratch, '.bestpractices.json'), 'utf8'),
        'run `node scripts/build-bestpractices-json.mjs` and commit the result'
      ).toBe(readFileSync(join(REPO_ROOT, '.bestpractices.json'), 'utf8'))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
