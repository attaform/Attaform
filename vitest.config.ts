import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { rewriteDirectiveDelivery } from './src/runtime/lib/core/transforms/directive-delivery-transform'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Vitest config for the unit suite.
 *
 * Coverage `include` is scoped to the core primitives, useAbstractForm and
 * the v4 adapter. The v3 adapter and `use-form.ts` are exercised only
 * through the Nuxt SSR fixture in test/ssr.test.ts, which the v8 provider
 * cannot instrument, so counting them would understate coverage rather
 * than measure it.
 */
export default defineConfig({
  // Vue SFC support, for test files that import `.vue` components.
  //
  // The second plugin is the production v-register delivery: the same
  // post-compile rewrite `attaform/vite` ships, binding each compiled
  // SFC's `v-register` to the directive by static import, since
  // createAttaform registers no app-level directive. Registering it here
  // means every SFC-based suite, the docs-demos smoke in particular,
  // mounts through the real delivery mechanism. The injected
  // `attaform/directive` specifier resolves through the alias map below.
  plugins: [
    vue(),
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
    // Source-alias `attaform/*` to `src/*.ts` so tests read the live
    // source. Without this, a bare `attaform` import resolves through
    // `dist/*.mjs`, which in dev is a `jiti --stub` shim carrying the
    // Docker build's `attaform: /app` alias, and throws
    // `Cannot find module '/app/src/index.ts'` when the suite runs on the
    // host. Mirrors the vite and nitro alias maps in
    // `apps/site/nuxt.config.ts`.
    //
    // The array form with anchored regex patterns is required. The object
    // form prefix-matches, so the bare `attaform` entry was iterated first
    // and rewrote `attaform/zod` to `${rootDir}src/index.ts/zod`;
    // anchoring each `find` to an exact specifier stops an entry
    // swallowing a sibling.
    alias: [
      { find: /^attaform\/zod-v3$/, replacement: `${rootDir}src/zod-v3.ts` },
      { find: /^attaform\/zod-v4$/, replacement: `${rootDir}src/zod-v4.ts` },
      { find: /^attaform\/zod$/, replacement: `${rootDir}src/zod.ts` },
      { find: /^attaform\/abstract$/, replacement: `${rootDir}src/abstract.ts` },
      { find: /^attaform\/directive$/, replacement: `${rootDir}src/directive.ts` },
      { find: /^attaform\/history$/, replacement: `${rootDir}src/history.ts` },
      { find: /^attaform\/vite$/, replacement: `${rootDir}src/vite.ts` },
      { find: /^attaform\/transforms$/, replacement: `${rootDir}src/transforms.ts` },
      { find: /^attaform$/, replacement: `${rootDir}src/index.ts` },
    ],
  },
  test: {
    // Anchor the picker to the unit suite. Vitest's default glob otherwise
    // collects `apps/bench-arena/tests/*.spec.ts`, Playwright specs that
    // throw on import.
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // Same anchoring for `vitest bench`. Its default glob is repo-wide, so
    // a nested checkout (a git worktree, a vendored copy) makes every
    // scenario run twice, and `check-bench` then gates on both halves.
    benchmark: {
      include: ['bench/**/*.bench.?(c|m)[jt]s?(x)'],
      // vitest 5 wraps every module export in a counting getter while
      // benchmarks run, so it can warn about benches that read imported
      // bindings more than a million times. The counter is not free, and
      // it is charged ONLY to code that crosses a module boundary.
      //
      // That is the worst possible shape for a ratio gate. The paired
      // suites compare a historical implementation, written inline in the
      // bench file and importing nothing, against the one that replaced
      // it, which calls into `src/`. The tracker taxes the replacement
      // and leaves the baseline alone, so it moves the numerator only.
      // Measured on the vitest 5 bump, tracker on vs off, same commit:
      // keystroke 100-leaf 3.03x -> 5.61x, keystroke 500-leaf 6.24x ->
      // 10.74x, materializeErrors 3.40x -> 6.70x. The first of those sat
      // 1% above the 3x floor purely as an artefact of the measurement.
      //
      // The warning it buys would not have caught this: its threshold is
      // a million accesses per export and it never fired, while the
      // overhead is paid on every access regardless.
      suppressExportGetterWarnings: true,
    },
    // Stubs `window.isSecureContext = true`, so the secure-context gate
    // does not disable persistence under jsdom, and resets the one-shot
    // dev-warning dedup between tests.
    setupFiles: ['./test/setup.ts'],
    // Materialize the docs-demos' generated `styles.css` once up front.
    // Those files are gitignored and written at dev/build time by
    // `apps/site/scripts/demo-styles/codegen.mjs`, but the docs-demos smoke
    // suite imports each demo's App.vue, which imports `./styles.css`, so
    // the import has to resolve on a fresh checkout.
    globalSetup: ['./test/global-setup.ts'],
    // Shuffle file order AND intra-file test order on every run, so an
    // implicit ordering dependency (leaked state, a load-order side
    // effect) surfaces instead of hiding behind a stable default order.
    // CI reruns with fresh seeds, so a flake pinned to one ordering is a
    // blocker.
    sequence: {
      shuffle: {
        files: true,
        tests: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 75,
        branches: 70,
        functions: 80,
        statements: 75,
      },
      include: [
        'src/runtime/core/**',
        'src/runtime/composables/use-abstract-form.ts',
        'src/runtime/adapters/zod-v4/**',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/test/**',
        '**/*.d.ts',
        // A port of Vue's v-model runtime, covered through the SSR fixture
        // in test/ssr.test.ts. v8 cannot instrument directive hooks that
        // fire through Vue's compile-time bindings, so counting the file
        // would understate coverage by roughly 400 lines without any loss
        // of rigour behind it.
        'src/runtime/core/directive.ts',
      ],
    },
  },
})
