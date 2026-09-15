import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * The bare `zod` specifier means OPPOSITE majors in the two manifests
 * that declare it, and nothing but this test says so.
 *
 *   root                 zod -> v4    zod-v3 -> npm:zod@3   (v4 is the default)
 *   apps/bench-arena     zod -> v3    zod-v4 -> npm:zod@4   (v3 is the cohort pin)
 *
 * bench-arena pins v3 because `docs/comparison/benchmarks.md` promises
 * one validator across the Zod-capable cohort, so a runtime row reflects
 * the library rather than its validator. The v4 alias is the single
 * deliberate exception, feeding the Attaform (Zod 4) row.
 *
 * Dependabot cannot see any of that. It read `zod: ^3.25.76` as a
 * package three majors behind and opened #630 to "fix" it, which would
 * have collapsed the two Attaform rows onto one validator and quietly
 * unpinned the cohort. The failure that PR actually produced was a
 * TypeError in the v3 adapter, nowhere near the fairness claim it broke,
 * so the honest signal has to come from here.
 *
 * If a Zod bump lands you on this test: that is the point. Moving the
 * cohort to v4 is a methodology change, and the page has to move with it.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PAGE = 'docs/comparison/benchmarks.md'
const LOCKFILE = 'pnpm-lock.yaml'

function devDeps(manifest: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8'))
  const { devDependencies } = parsed as { devDependencies?: Record<string, string> }
  return devDependencies ?? {}
}

/** The `apps/bench-arena:` block of the lockfile, where peers carry their resolved zod. */
function benchArenaImporter(): string {
  const lock = readFileSync(join(REPO_ROOT, LOCKFILE), 'utf8')
  const found = /\n {2}apps\/bench-arena:\n(.*?)(?=\n {2}[a-zA-Z]|\npackages:)/s.exec(lock)
  if (found?.[1] === undefined) throw new Error('apps/bench-arena importer not found in lockfile')
  return found[1]
}

/** The major a range or `npm:` alias resolves to, e.g. '^3.25.76' -> 3. */
function majorOf(spec: string): number {
  const found = /(\d+)\./.exec(spec.replace(/^npm:[^@]*@/, ''))
  return found?.[1] === undefined ? Number.NaN : Number(found[1])
}

describe('the arena pins Zod v3 across the cohort', () => {
  it('declares `zod` as v3 and `zod-v4` as the aliased exception', () => {
    const deps = devDeps('apps/bench-arena/package.json')

    expect(
      majorOf(deps['zod'] ?? ''),
      'apps/bench-arena `zod` is the shared cohort validator'
    ).toBe(3)
    expect(deps['zod-v4'], 'the Attaform (Zod 4) row reads through an explicit alias').toMatch(
      /^npm:zod@/
    )
    expect(majorOf(deps['zod-v4'] ?? '')).toBe(4)
  })

  it('is the mirror of the root, where bare `zod` means v4', () => {
    const deps = devDeps('package.json')

    expect(majorOf(deps['zod'] ?? ''), 'root `zod` is the default adapter target').toBe(4)
    expect(deps['zod-v3']).toMatch(/^npm:zod@/)
    expect(majorOf(deps['zod-v3'] ?? '')).toBe(3)
  })

  it('resolves every cohort peer onto that same v3, in the lockfile', () => {
    // The manifest states the intent; the lockfile is what installs.
    // They can part company without either looking wrong on its own:
    // a `pnpm install` run against a briefly-edited manifest floated
    // @formkit/zod, @regle/schemas and @vee-validate/zod onto zod 4
    // while `zod` in the same block still read 3.25.76. The cohort
    // would have validated against a major the pin says it does not
    // use, and every runtime row would have shifted under it.
    const importer = benchArenaImporter()
    const peers = [...importer.matchAll(/\(zod@([\d.]+)\)/g)].map((found) => found[1])

    expect(peers.length, 'the Zod-capable cohort resolves through a zod peer').toBeGreaterThan(0)
    for (const version of peers) {
      expect(majorOf(version ?? ''), `a cohort peer resolved to zod ${version}`).toBe(3)
    }
  })

  it('is the claim the benchmarks page makes to readers', () => {
    const page = readFileSync(join(REPO_ROOT, PAGE), 'utf8')

    // The methodology bullet the pin exists to keep true.
    expect(page).toMatch(/Zod v3 is pinned across the Zod-capable cohort/)
  })
})
