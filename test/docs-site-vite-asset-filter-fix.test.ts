import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Docs-site config regression check: keep Vite's
 * `vite:asset-import-meta-url` plugin filter from blowing V8's regex
 * stack on megabyte-class prebundled deps.
 *
 * Background. Vite 7.3.3 ships the built-in plugin
 * `vite:asset-import-meta-url` with the transform filter
 *
 *     code: /new\s+URL.+import\.meta\.url/s
 *
 * (source: `vite/dist/node/chunks/config.js:27704`). The `.+`
 * between `new\s+URL` and `import\.meta\.url`, combined with the `s`
 * (dotAll) flag, makes V8's regex engine catastrophic-backtrack on
 * dense minified content. Trip-wire: `@vue/repl/monaco-editor`'s
 * 7.2 MB prebundle overflows `pattern.test`, throwing
 * `Maximum call stack size exceeded` from
 * `EnvironmentPluginContainer.transform`. Visible as `Internal server
 * error` + a 404 on the prebundle URL on the first `/play/<slug>`
 * load — the Monaco editor never mounts.
 *
 * Captured via filter-trace instrumentation as
 * `[filter-trace] THREW plugin=vite:asset-import-meta-url`.
 *
 * The fix: `apps/site/nuxt.config.ts` declares a small `enforce:
 * 'post'` Vite plugin whose `configResolved` hook locates
 * `vite:asset-import-meta-url` in the resolved plugins array and
 * replaces its `transform.filter.code` with the literal string
 * `'import.meta.url'`. Vite's `patternToCodeFilter` switches to
 * `String.prototype.includes` (linear, no backtracking). The
 * handler's own precise matcher (`assetImportMetaUrlRE` in Vite's
 * source) still gates the actual rewrite, so behavior is preserved
 * for legitimate `new URL(..., import.meta.url)` rewriting.
 *
 * This test pins the wiring at the source-string layer (mirrors the
 * other `docs-site-*` tests). A behavioural reproduction would need
 * a full headless browser run — overkill for the regression we're
 * guarding here.
 */

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('docs-site vite:asset-import-meta-url filter fix', () => {
  const nuxtConfig = read('../apps/site/nuxt.config.ts')

  it('declares the configResolved patch plugin', () => {
    expect(nuxtConfig).toMatch(/name:\s*['"]attaform:fix-vite-asset-import-meta-url-filter['"]/)
  })

  it('registers the plugin in vite.plugins', () => {
    expect(nuxtConfig).toMatch(/plugins:\s*\[[^\]]*fixViteAssetImportMetaUrlFilter/)
  })

  it('runs in the `post` enforce phase', () => {
    // The plugin we are mutating (vite:asset-import-meta-url) is a
    // built-in Vite plugin, registered after user-supplied plugins
    // unless we declare ourselves as `post`. Without `enforce: 'post'`,
    // our configResolved fires before vite:asset-import-meta-url is
    // in the resolved plugins array and the `.find(...)` returns
    // undefined.
    expect(nuxtConfig).toMatch(
      /name:\s*['"]attaform:fix-vite-asset-import-meta-url-filter['"][\s\S]{0,200}enforce:\s*['"]post['"]/
    )
  })

  it('targets the exact upstream plugin name', () => {
    // The plugin name is the contract: it MUST match the literal Vite
    // built-in name. Vite has no stable public alias, so a typo means
    // the override silently no-ops and the overflow returns the next
    // time someone bumps a megabyte dep into the optimizer chain.
    expect(nuxtConfig).toContain("'vite:asset-import-meta-url'")
  })

  it('replaces filter.code with a string (not a regex)', () => {
    // The whole point of the patch is to swap a backtracking regex
    // for a linear-time substring check. Vite's `patternToCodeFilter`
    // dispatches on `pattern instanceof RegExp`: regex → `.test()`
    // (catastrophic on dense input), string → `.includes()` (linear).
    // Pinning the assignment shape guards against an accidental
    // refactor to a regex that "looks safer" but reintroduces the
    // catastrophic-backtracking risk.
    expect(nuxtConfig).toMatch(/target\.transform\.filter\.code\s*=\s*['"]import\.meta\.url['"]/)
  })

  it('gates the assignment on the filter object existing', () => {
    // If Vite upgrades and `vite:asset-import-meta-url`'s shape
    // changes (e.g. filter moves elsewhere or is removed), the
    // assignment must no-op cleanly instead of throwing during
    // configResolved. A throw here would crash the dev server boot.
    expect(nuxtConfig).toMatch(/target\.transform\.filter\s*==\s*null/)
  })
})
