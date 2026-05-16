import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Docs-site config regression check.
 *
 * The Vite plugin (`attaform/vite`) carries the `v-register` compile-
 * time template transforms responsible for SSR-correct `:value` /
 * `:selected` / `:checked` attributes on the initial paint. Without
 * them, every demo using v-register against a non-trivial schema
 * default flashes from the slim default (or the first option) to the
 * actual default on client hydration.
 *
 * Nuxt consumers receive the Vite plugin automatically by listing
 * `attaform/nuxt` in `modules` — the module's setup calls
 * `addVitePlugin(attaformVitePlugin(...))` for them. The docs site
 * MUST do the same; we missed it once and the schema-to-inputs
 * country dropdown visibly flickered on hydration.
 *
 * The behavioural side of this contract (transforms produce correct
 * SSR attributes when wired) lives in `test/ssr.test.ts` —
 * specifically the `refined-default-select` case. This test pins the
 * *configuration* side: `apps/site/nuxt.config.ts` imports and uses
 * the attaform Nuxt module.
 *
 * A behavioural test that boots the docs site directly would be
 * preferred, but @nuxt/test-utils' setup gets tangled in the docs
 * site's full prerender + link-checker + content collection chain
 * which is unrelated to this regression. The pair of tests we land
 * with covers the contract end-to-end: "module wires the plugin"
 * (SSR fixture) + "docs site wires the module" (this file).
 */

describe('docs-site config: attaform/nuxt is wired into modules', () => {
  const configPath = fileURLToPath(new URL('../apps/site/nuxt.config.ts', import.meta.url))
  const source = readFileSync(configPath, 'utf8')

  it('imports the attaform Nuxt module from source', () => {
    // Source-relative import: the workspace uses jiti shims in dist,
    // so the source-aliased import is the only way the docs site
    // picks up live changes during dev.
    expect(source).toMatch(/import\s+\w+\s+from\s+['"]\.\.\/\.\.\/src\/nuxt['"]/)
  })

  it('lists the imported module in nuxt.config.modules', () => {
    // Match `modules: [<identifier>, ...]` where <identifier> is the
    // local name the import bound the module to. Allows the name to
    // be renamed without breaking the test, as long as it lives in
    // the modules array.
    const importMatch = source.match(/import\s+(\w+)\s+from\s+['"]\.\.\/\.\.\/src\/nuxt['"]/)
    expect(importMatch).not.toBeNull()
    const moduleName = importMatch![1]
    const modulesArrayMatch = source.match(/modules\s*:\s*\[([^\]]*)\]/)
    expect(modulesArrayMatch).not.toBeNull()
    expect(modulesArrayMatch![1]).toContain(moduleName)
  })
})
