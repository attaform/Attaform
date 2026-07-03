import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * End-to-end proof that attaform/nuxt's auto-imports resolve in a real
 * Nuxt build. The fixture's app.vue calls `useForm` / `injectForm` and
 * references the rest of the manifest with NO import line; the module is
 * the only thing that can make those names resolve. A registration
 * regression would fail the build or ReferenceError during SSR, so a
 * missing marker in the rendered HTML is the failure signal.
 */
describe('attaform/nuxt auto-imports (e2e)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/auto-imports', import.meta.url)),
  })

  it('renders a form built from the auto-imported useForm', async () => {
    const html = await $fetch('/')
    expect(html).toContain('auto-import-ok')
  })

  it('resolves the auto-imported injectForm (no ancestor form present)', async () => {
    const html = await $fetch('/')
    expect(html).toContain('no-parent')
  })

  it('resolves the full auto-imported composable surface', async () => {
    const html = await $fetch('/')
    expect(html).toContain('all-composables-resolved')
  })
})
