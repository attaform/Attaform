import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import { defineConfig } from 'vitest/config'
import { rewriteDirectiveDelivery } from './src/runtime/lib/core/transforms/directive-delivery-transform'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Dedicated vitest config for the Nuxt UI slice of the cross-library matrix.
 *
 * Nuxt UI's components import Nuxt virtual modules (`#build/ui/*` for the theme,
 * `#imports` for `useAppConfig`), so they cannot mount under the bare
 * `@vitejs/plugin-vue` harness the rest of the suite (reka-ui, PrimeVue) uses.
 * `@nuxt/ui/vite` synthesizes those virtuals -- but it also pulls in Tailwind v4
 * plus `unplugin-auto-import` / `unplugin-vue-components` globally, which we do
 * not want loaded across the 4000+ test main suite. So this stays a separate,
 * opt-in config: the main `vitest.config.ts` is left untouched, and this runs
 * via `pnpm test:nuxt-ui` (wired into `pnpm check`).
 *
 * `autoImport.dts` / `components.dts` are disabled so the unplugins do not write
 * `auto-imports.d.ts` / `components.d.ts` into the repo root (which `tsc` would
 * otherwise sweep into the typecheck). The `#imports` virtual itself stays live;
 * only the generated declaration files are suppressed.
 */
export default defineConfig({
  // Same production v-register delivery as the main vitest config: the
  // post-compile rewrite binds each compiled SFC's v-register to the
  // directive by static import (createAttaform registers no directive).
  plugins: [
    vue(),
    ui({ autoImport: { dts: false }, components: { dts: false } }),
    {
      name: 'attaform:directive-delivery',
      enforce: 'post',
      transform(code, id) {
        const rewritten = rewriteDirectiveDelivery(code, id)
        return rewritten === null ? null : { code: rewritten, map: null }
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^attaform\/zod-v3$/, replacement: `${rootDir}src/zod-v3.ts` },
      { find: /^attaform\/zod-v4$/, replacement: `${rootDir}src/zod-v4.ts` },
      { find: /^attaform\/zod$/, replacement: `${rootDir}src/zod.ts` },
      { find: /^attaform\/directive$/, replacement: `${rootDir}src/directive.ts` },
      { find: /^attaform$/, replacement: `${rootDir}src/index.ts` },
    ],
  },
  test: {
    include: ['test/third-party-components/nuxt-ui.cross.ts'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
})
