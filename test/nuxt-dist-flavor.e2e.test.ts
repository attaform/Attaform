import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

/**
 * End-to-end proof that the dev/prod dual dist keeps ONE module graph in
 * a Nuxt dev boot (size-teardown P1a). The fixture resolves attaform
 * through the real exports map (committed node_modules symlink, no
 * source aliases): `attaform/nuxt` loads the built module, which
 * registers the runtime plugin by literal path into dist/dev, while the
 * app's own `attaform/zod-v4` import resolves the `development`
 * condition. If those two routes loaded different module graphs, there
 * would be two registries and `useForm` would throw `Registry not found`
 * during SSR — so the rendered marker IS the single-registry assertion.
 *
 * Also covers the P2 v-register delivery end to end: the fixture's
 * template binds `v-register`, the module's Vite plugin rewrites the
 * compiled output to an `attaform/directive` import (resolved through
 * the same real exports map), and the SSR-compiled render emits the
 * field's value through the directive's getSSRProps.
 *
 * Runs only against a real build (skipped while dist/ holds
 * `unbuild --stub` shims); `pnpm check` exercises it after `check:size`
 * produces the real bundle.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const distIndex = join(repoRoot, 'dist', 'index.mjs')
const isRealBuild =
  existsSync(distIndex) &&
  !/from\s*['"][^'"]*jiti[^'"]*['"]/.test(readFileSync(distIndex, 'utf-8')) &&
  existsSync(join(repoRoot, 'dist', 'dev', 'zod-v4.mjs'))

describe.skipIf(!isRealBuild)('dist dev flavor: single registry in a dev boot (e2e)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/dist-flavor', import.meta.url)),
    dev: true,
  })

  it('renders a form whose plugin and composable share one module graph', async () => {
    const html = await $fetch('/')
    expect(html).toContain('dist-flavor-ok')
  })

  it('delivers v-register through the rewrite: SSR emits the bound value', async () => {
    // The rewrite leaves no runtime resolveDirective fallback: if the
    // injected `attaform/directive` import didn't resolve through the
    // real exports map, this SSR render would fail outright. The value=
    // assertion then locks the full v-register SSR pipeline (transforms
    // + directive) working against the shipped dist — the template
    // authors no :value of its own.
    const html = await $fetch('/')
    expect(html).toMatch(/<input[^>]*id="probe-input"[^>]*value="dist-flavor-ok"/)
  })
})
