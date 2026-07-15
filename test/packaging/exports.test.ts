import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Sanity-checks on the built dist/. Skipped when dist doesn't exist yet —
 * this test runs meaningfully after `pnpm prepack` (or during CI release).
 * Scope: verify every package.json exports subpath resolves to an artifact
 * that was actually produced.
 */

const repoRoot = join(__dirname, '..', '..')
const distDir = join(repoRoot, 'dist')

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
  main: string
  types: string
  // An export maps a subpath to either a direct target string
  // (e.g. "./package.json") or a conditions map (condition -> target path).
  exports: Record<string, string | Record<string, string>>
}

/**
 * After running `pnpm dev:prepare`, unbuild (or Nuxt's module-builder on
 * older branches) drops jiti-wrapped stubs into dist/ so the playground
 * can resolve the module without a real build. Those stubs re-export
 * from source via jiti and don't reflect the final published shape.
 * Skip the packaging asserts in that case — `pnpm prepack` (or
 * `pnpm check:size` which runs it) produces the real build.
 *
 * Two stub formats exist in the wild:
 *   - Nuxt module-builder:  `import jiti from '…/jiti.mjs'`
 *   - unbuild --stub:       `import { createJiti } from '…/jiti.mjs'`
 * Match on the shared `jiti` import specifier to cover both.
 */
const isRealBuild =
  existsSync(join(distDir, 'index.mjs')) &&
  !/from\s*['"][^'"]*jiti[^'"]*['"]/.test(readFileSync(join(distDir, 'index.mjs'), 'utf-8'))

/**
 * Walk a dist entry's transitive import graph and return true if any
 * file in the closure imports the bare `zod` specifier. Unbuild's
 * shared-chunk splitter can hoist `from 'zod'` out of an entry into
 * a shared chunk; checking only the entry would miss the dependency.
 */
function closureContainsZodImport(entryPath: string): boolean {
  const seen = new Set<string>()
  const stack: string[] = [entryPath]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    if (!existsSync(current)) continue
    const src = readFileSync(current, 'utf-8')
    if (/from\s*['"]zod['"]/.test(src) || /require\(\s*['"]zod['"]\s*\)/.test(src)) return true
    // Pull every relative import so the walk follows shared chunks.
    for (const match of src.matchAll(/from\s*['"](\.\/[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec !== undefined) stack.push(join(current, '..', spec))
    }
  }
  return false
}

describe.skipIf(!existsSync(distDir) || !isRealBuild)('packaging: package.json exports', () => {
  it('main points at a file that exists', () => {
    expect(existsSync(join(repoRoot, pkg.main))).toBe(true)
  })

  it('types points at a file that exists', () => {
    expect(existsSync(join(repoRoot, pkg.types))).toBe(true)
  })

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    it(`subpath "${subpath}" — every declared artifact exists`, () => {
      // A direct string target (e.g. "./package.json": "./package.json")
      // resolves as-is. Guard it explicitly: `Object.entries` on a string
      // walks its characters, which would check `existsSync('p')` and fail.
      if (typeof entry === 'string') {
        expect(existsSync(join(repoRoot, entry)), `${subpath} -> ${entry}`).toBe(true)
        return
      }
      // Otherwise a conditions map (types / import / require / default),
      // whose values are the target paths.
      for (const [kind, relativePath] of Object.entries(entry)) {
        expect(
          existsSync(join(repoRoot, relativePath)),
          `${subpath}.${kind} -> ${relativePath}`
        ).toBe(true)
      }
    })
  }

  it('all expected entries are present', () => {
    for (const name of [
      'nuxt',
      'index',
      'vite',
      'rollup',
      'esbuild',
      'webpack',
      'rspack',
      'transforms',
      'zod',
      'zod-v3',
      'zod-v4',
    ]) {
      expect(existsSync(join(distDir, `${name}.mjs`)), `${name}.mjs`).toBe(true)
      expect(existsSync(join(distDir, `${name}.d.mts`)), `${name}.d.mts`).toBe(true)
    }
  })

  it('core entry (index.mjs) does not import zod (keeps /zod-v3 opt-in)', () => {
    const src = readFileSync(join(distDir, 'index.mjs'), 'utf-8')
    // Minified bundles may omit whitespace between `from` and the module
    // specifier, so match both forms.
    expect(src).not.toMatch(/from\s*['"]zod['"]/)
    expect(src).not.toMatch(/require\(\s*['"]zod['"]\s*\)/)
  })

  it('zod-v3 entry carries no static `zod` import (consumer-schema-driven)', () => {
    // Post-#383 the v3 adapter rebuilds its slim / stripped schema nodes
    // from the consumer's OWN schema instead of reaching for an ambient
    // `zod`, so `attaform/zod-v3` has no static bare-`zod` import anywhere
    // in its closure: its zod-v3 imports are type-only (erased at build),
    // and it duck-types the schema passed to `useForm`. That keeps the v3
    // bundle decoupled from whichever Zod major the consumer hoists. The
    // only runtime `from 'zod'` lives in zod-v4/strip.ts, reachable from
    // the v4 + unified entries below but not from here. A flip to `true`
    // would mean a v4-only module (e.g. strip.ts) got re-co-located into
    // the v3 closure by the chunk splitter, which is worth a look rather
    // than a silent pass.
    expect(closureContainsZodImport(join(distDir, 'zod-v3.mjs'))).toBe(false)
  })

  it('zod-v4 entry references zod (directly or via a shared chunk)', () => {
    expect(closureContainsZodImport(join(distDir, 'zod-v4.mjs'))).toBe(true)
  })

  it('zod (unified) entry references zod (directly or via a shared chunk)', () => {
    expect(closureContainsZodImport(join(distDir, 'zod.mjs'))).toBe(true)
  })

  it('no dist bundle imports `zod-v3` (the pnpm-alias specifier gets rewritten)', () => {
    // Guard against regressions in the rollup alias plugin (build.config.ts).
    // If the alias silently stopped firing, every zod-v3 entry would re-
    // externalize as `from 'zod-v3'` and consumers would hit resolution
    // failures at install time. We exclude error-message string literals
    // from the check.
    for (const name of [
      'index',
      'nuxt',
      'vite',
      'rollup',
      'esbuild',
      'webpack',
      'rspack',
      'transforms',
      'zod',
      'zod-v3',
      'zod-v4',
    ]) {
      const mjs = readFileSync(join(distDir, `${name}.mjs`), 'utf-8')
      expect(mjs, `${name}.mjs imports zod-v3`).not.toMatch(
        /from\s*['"]zod-v3['"]|require\(\s*['"]zod-v3['"]\s*\)/
      )
    }
  })
})
