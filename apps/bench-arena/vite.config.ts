import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

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
  plugins: [vue()],
  resolve: {
    // Force a single copy of each shared runtime. Attaform is a symlinked
    // workspace package, so without this its internal `import 'zod'` (and
    // `vue`) hoist to the repo ROOT's versions (zod v4, for Attaform's own v4
    // adapter dev) while the arena resolves its OWN deps (zod v3). That split
    // feeds the v3 adapter v4 schemas and silently breaks it. A real consumer
    // installs ONE zod, so deduping to the arena's copies faithfully mirrors
    // them and keeps every library on the exact version the bundle measures.
    dedupe: ['vue', 'zod', 'valibot'],
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
