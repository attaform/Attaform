import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// Absolute path to this package, so the isolation plugin resolves the aliased
// `zod-v4` from the arena's OWN node_modules no matter which file imports it.
const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * Per-package zod-version isolation for the dual-zod cohort.
 *
 * Attaform's published zod-v4 adapter imports bare `zod`, expecting zod@^4 (its
 * zod-v3 adapter imports the `zod-v3` alias instead, so the two never collide).
 * The arena pins zod@3 for the whole v3 cohort (vee-validate, TanStack, FormKit,
 * Regle, Attaform-zod3), so redirect ONLY that one dist import to the aliased
 * `zod-v4` package. Every other bare `zod` import (the v3 validators, the v3
 * schema builders) is left untouched and keeps resolving to the arena's v3, so
 * adding the zod-v4 row cannot move a single v3-cohort number. This is the
 * general shape for hosting mixed zod majors in one bundle: redirect each
 * v4-requiring package's bare `zod` to the v4 alias by importer, v3 world intact.
 */
function attaformZodVersionIsolation(): Plugin {
  return {
    name: 'attaform-zod-version-isolation',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (
        source === 'zod' &&
        importer !== undefined &&
        /[\\/]attaform[\\/]dist[\\/]/.test(importer)
      ) {
        return this.resolve('zod-v4', `${BENCH_DIR}vite.config.ts`, { skipSelf: true })
      }
      return null
    },
  }
}

/**
 * Harness build for the benchmark arena.
 *
 * Fairness spine: this app consumes the REAL published Attaform build
 * (`dist/*.mjs`, resolved through the package `exports` by the
 * `workspace:*` dependency), never the `attaform -> src/*.ts` alias the
 * docs site uses for dev. Run `pnpm prepack` at the repo root before
 * building or serving this app so `dist` is current. Every library in the
 * cohort, Attaform included, is bundled and minified the same way a
 * consumer would install it, so no entry gets an unearned advantage.
 *
 * The driver measures against a production `build` + `preview` (stable,
 * representative of shipped code); `dev` exists only for manual probing.
 */
export default defineConfig({
  plugins: [vue(), attaformZodVersionIsolation()],
  resolve: {
    // Force a single copy of each shared runtime. Attaform is a symlinked
    // workspace package, so without this its internal `import 'zod'` (and
    // `vue`) hoist to the repo ROOT's versions while the arena resolves its
    // OWN deps. That split feeds an adapter the wrong schemas and silently
    // breaks it. A real consumer installs ONE zod per major, so deduping to
    // the arena's copies faithfully mirrors them. `zod` is the v3 cohort's
    // single copy; `zod-v4` is the isolated v4 copy the plugin above routes
    // Attaform's zod-v4 adapter onto.
    dedupe: ['vue', 'zod', 'zod-v4', 'valibot'],
  },
  build: {
    target: 'es2020',
    // Keep everything in one chunk: the arena mounts one adapter per page
    // load, so code-splitting would only add fetch latency to the timing.
    modulePreload: false,
  },
  server: {
    port: 4173,
    strictPort: true,
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
})
