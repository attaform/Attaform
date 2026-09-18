import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * `docs/comparison/benchmarks.md` is the methodology behind the tables
 * the page renders, and the tables come from the arena. Two ways they
 * drifted apart.
 *
 * Attaform runs two rows, one per Zod adapter, and Regle runs two, one
 * per validation mode. The page explained neither, so a reader met an
 * "Attaform (Zod 4)" row the methodology never mentioned while the
 * same section told them Zod v3 was pinned across the cohort.
 *
 * And the bundle caveat still said "Bundle is total, not first-paint",
 * from before the measurement code-split. Two sections above it, the
 * page already described the current figure correctly, so the page
 * contradicted itself about its own headline number.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ADAPTERS = join(REPO_ROOT, 'apps/bench-arena/src/adapters')
const PAGE = 'docs/comparison/benchmarks.md'

function page(): string {
  return readFileSync(join(REPO_ROOT, PAGE), 'utf8')
}

/** Every adapter's display name, as the arena labels its row. */
function displayNames(): string[] {
  const names: string[] = []
  for (const entry of readdirSync(ADAPTERS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of readdirSync(join(ADAPTERS, entry.name))) {
      if (!file.endsWith('.ts')) continue
      const source = readFileSync(join(ADAPTERS, entry.name, file), 'utf8')
      const found = /displayName: '([^']+)'/.exec(source)
      if (found?.[1] !== undefined) names.push(found[1])
    }
  }
  return names
}

/** "Attaform (Zod 4)" and "Attaform" are one family; "Regle (schema)" and "Regle (rules)" another. */
function family(displayName: string): string {
  return displayName.replace(/ \(.*\)$/, '')
}

describe('the arena cohort vs the page explaining it', () => {
  const names = displayNames()

  it('finds the adapters (the scan is alive)', () => {
    expect(names.length).toBeGreaterThan(5)
    expect(names).toContain('Attaform (Zod 3)')
  })

  it('names every row of a library that contributes more than one', () => {
    const byFamily = new Map<string, string[]>()
    for (const name of names) {
      byFamily.set(family(name), [...(byFamily.get(family(name)) ?? []), name])
    }
    const text = page()
    const unexplained = [...byFamily.values()]
      .filter((group) => group.length > 1)
      .flat()
      .filter((name) => !text.includes(name))
      .sort()
    // A library the page never singles out is fine; the widget labels
    // it. A library that shows up twice needs the page to say why.
    expect(unexplained, `${PAGE} leaves a doubled row unexplained`).toEqual([])
  })

  it('does not promise a fixed runner the sweep never had', () => {
    const results = JSON.parse(
      readFileSync(join(REPO_ROOT, 'apps/bench-arena/results.json'), 'utf8')
    ) as { provenance: { runner?: { cpuModel?: string; shardCount?: number } } }
    const { cpuModel = '', shardCount = 1 } = results.provenance.runner ?? {}

    // The sweep shards across runners and takes whatever hardware the
    // host assigns, so a refresh can move every absolute figure at once
    // with no code behind it: the 2026-09 run moved `massive|mount` by
    // roughly a quarter for all nine libraries. The page said the
    // numbers came "from CI on a fixed runner" while the paragraph
    // above it already promised the slope survives a change of machine,
    // so the page contradicted itself about its own provenance.
    const varies = /^mixed:/.test(cpuModel) || shardCount > 1
    expect(varies, 'the sweep now runs on one machine; this caveat may be retired').toBe(true)
    expect(
      /fixed runner/i.test(page()),
      `${PAGE} promises a fixed runner, but provenance records "${cpuModel}"`
    ).toBe(false)
  })

  it('describes the bundle figure as the split the measurement produces', () => {
    const results = JSON.parse(
      readFileSync(join(REPO_ROOT, 'apps/bench-arena/results.json'), 'utf8')
    ) as { bundle: { asyncGzBytes?: number }[] }
    const deferring = results.bundle.filter((row) => (row.asyncGzBytes ?? 0) > 0).length

    // The build code-splits whether or not anything lands in a deferred
    // chunk, so the page explains the split either way. What it must not
    // do is promise a figure the table is not rendering: `BenchArena.vue`
    // shows "+N deferred" only for a row with a non-zero async chunk.
    // So the assertion must not require that SOME row defers: no row in
    // the cohort currently does, and a page-scope guard has to assert
    // what the page claims rather than what the cohort happens to be.
    expect(page()).toContain('deferred')
    expect(
      /no deferred badge loads in one chunk/.test(page()),
      `${PAGE} must say what a row without a deferred badge means; ` +
        `${deferring} of ${results.bundle.length} rows defer`
    ).toBe(true)
    expect(
      /Bundle is total/.test(page()),
      'the bundle figure is the initial load, not the total'
    ).toBe(false)
  })
})
