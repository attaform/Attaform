import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Docs-site config regression check: the `attaform/*` subpath
 * aliases that route consumer imports to `src/*.ts` (instead of
 * the published `dist/*.mjs` jiti shims) MUST be configured on
 * BOTH the Vite side (browser) AND the Nitro side (SSR).
 *
 * Background — the dist/jiti staleness story:
 *
 *   `unbuild --stub` ships `dist/*.mjs` as jiti shims whose body
 *   is `await jiti.import('/app/src/<entry>.ts')`. The shim runs
 *   ONCE per process at module init; jiti caches the resolved
 *   exports binding. Edits to `src/` AFTER startup never reach
 *   the cached binding, so any consumer that resolves through
 *   `dist/` is frozen at the snapshot taken at boot.
 *
 *   The browser side avoids this via `vite.resolve.alias`:
 *   `attaform/zod` → `src/zod.ts` directly, HMR sees every edit.
 *   Without a matching `nitro.alias`, the SSR side falls through
 *   to Node resolution → `dist/zod.mjs` → frozen jiti binding.
 *   Page-server-renders ship stale form state into hydration; the
 *   client picks up the stale state even though its own
 *   client-side `src/` is fresh.
 *
 *   The symptom was observed when `count: unset` against
 *   `z.number().default(10)` SSR'd as `count: 10` (the schema's
 *   declared default) instead of `count: 0` (the slim/empty
 *   primitive). The fix in `src/runtime/core/` was correct; the
 *   demo at `/docs/schemas/defaults` still showed the bug because
 *   Nitro had frozen the OLD behavior before the fix landed.
 *
 * This test pins the source-string contract: every alias entry
 * that exists on the Vite side ALSO exists on the Nitro side.
 * Removing or shrinking either set drops us back into the dist/
 * jiti staleness window. A behavioural test (boot Nitro, render
 * a demo, check the hydrated state matches the latest `src/`)
 * would be preferred — but @nuxt/test-utils' setup tangles with
 * the docs site's full prerender + content collection chain,
 * which is unrelated to this regression. The source-string check
 * is the standing diagnostic: a contributor removing one side
 * fails this test before they ship the silent-staleness drift.
 */

describe('docs-site config: source-alias symmetry between Vite and Nitro', () => {
  const configPath = fileURLToPath(new URL('../apps/site/nuxt.config.ts', import.meta.url))
  const source = readFileSync(configPath, 'utf8')

  const subpaths = [
    'src/index.ts',
    'src/zod.ts',
    'src/zod-v3.ts',
    'src/zod-v4.ts',
    'src/abstract.ts',
    'src/vite.ts',
    'src/transforms.ts',
  ] as const

  it('Vite alias block references every attaform subpath as src/*.ts', () => {
    for (const subpath of subpaths) {
      // Vite aliases use the regex array form: `replacement: resolve(monorepoRoot, 'src/foo.ts')`.
      expect(source).toContain(`'${subpath}'`)
    }
  })

  it('Nitro alias block exists and uses the same subpaths', () => {
    // The Nitro alias block must exist and reference each source path.
    // We assert that both halves of the config contain each `src/*.ts`
    // string by counting occurrences — every entry should appear at
    // least twice (once for Vite, once for Nitro).
    for (const subpath of subpaths) {
      const occurrences = source.split(`'${subpath}'`).length - 1
      expect(
        occurrences,
        `${subpath} should appear in both Vite and Nitro alias blocks`
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('Nitro alias block names attaform subpath keys', () => {
    // Source-string regression: the Nitro `alias:` block contains the
    // attaform subpath keys. Catches a contributor refactoring the
    // Nitro alias into a different shape (e.g. dropping `attaform/zod`)
    // that loses dev-time SSR freshness.
    const attaformKeys = [
      'attaform',
      "'attaform/zod'",
      "'attaform/zod-v3'",
      "'attaform/zod-v4'",
      "'attaform/abstract'",
      "'attaform/vite'",
      "'attaform/transforms'",
    ] as const
    for (const key of attaformKeys) {
      expect(source).toContain(key)
    }
  })
})
