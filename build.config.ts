import aliasPlugin from '@rollup/plugin-alias'
import type { BuildConfig } from 'unbuild'
import { defineBuildConfig } from 'unbuild'

// Two flavors of the runtime ship in one package (size-teardown P1a):
//
//   dist/*          prod flavor — `__DEV__` resolved to `false` at package
//                   build, so every dev-only branch, warning string, and
//                   diagnostic module is stripped BEFORE publish. Consumer
//                   bundlers that fail to fold a cross-module const (Rollup
//                   and webpack without scope-hoisted const-chasing, and
//                   esbuild's tree-shake-before-fold ordering for functions
//                   only called from dead branches) previously shipped
//                   ~2.5-4.4 kB gz of dev code to production; a literal
//                   `false` at build time closes that class entirely.
//   dist/dev/*      dev flavor — `__DEV__` resolved to `true`: the full
//                   diagnostic surface, unconditionally. Served through the
//                   `development` export condition (Vite dev, webpack
//                   development mode, Nitro dev). No declarations: the
//                   `types` condition always resolves the prod-path .d.mts.
//
// The prod flavor keeps today's paths, so tooling that bypasses the exports
// map degrades to prod — the safe direction. Bundlers that ignore the
// `development` condition serve prod in dev (diagnostics silently absent,
// same as the CDN path today); Node SSR without conditions resolves prod
// (diagnostics-only loss). Both are accepted degradations, not bugs.
//
// Node-only tooling entries (nuxt, vite, rollup, esbuild, webpack, rspack,
// transforms) are single-flavor: they run at consumer build time, import
// no `__DEV__`-gated runtime code, and gain nothing from a dev twin.
const RUNTIME_ENTRIES = [
  'src/index',
  'src/zod',
  'src/zod-v3',
  'src/zod-v4',
  'src/abstract',
  'src/directive',
  'src/history',
  // Nuxt-only plugin file registered by literal path from src/nuxt.ts
  // (`addPlugin({ src: resolver.resolve(...) })`), so it must exist on
  // disk in BOTH flavors: the module picks `./dev/runtime/plugins/...`
  // under `nuxt.options.dev` so the plugin joins the same module graph
  // the app's own imports resolve to. A prod plugin path plus dev app
  // imports would mean two module graphs and two registries, and
  // `useForm` would throw `Registry not found`. Unbuild's shared-chunk
  // splitter deduplicates `core/plugin` + `core/serialize` across this
  // entry and `src/zod` / `src/index` within each flavor.
  'src/runtime/plugins/attaform',
]

const TOOLING_ENTRIES = [
  'src/nuxt',
  'src/vite',
  'src/rollup',
  'src/esbuild',
  'src/webpack',
  'src/rspack',
  'src/transforms',
]

/**
 * Resolve `__DEV__` to a literal at package build. Textual, not
 * define-based: `__DEV__` is an imported const (`src/runtime/core/dev.ts`),
 * and esbuild's `define` only substitutes free identifiers, so a define
 * cannot reach the bound import. Dropping the import line and inlining the
 * literal makes the dead branches visible to Rollup's tree-shaker at parse
 * time — including the function-only-called-from-a-dead-branch shape that
 * survives a consumer-side define-fold.
 *
 * Runs before the esbuild transform (prepended plugin), so it sees raw TS.
 * The import-shape guard throws on any `__DEV__` import this regex pair
 * would not rewrite cleanly, instead of emitting corrupted code.
 */
function devFlagStripPlugin(flag: boolean) {
  return {
    name: 'attaform:dev-flag-strip',
    transform(code: string, id: string): { code: string; map: null } | null {
      const posixId = id.replace(/\\/g, '/')
      if (posixId.endsWith('/src/runtime/core/dev.ts')) {
        // With every importer's import line removed below, this module
        // drops out of the graph; the literal body covers any import
        // shape the guard has not seen yet.
        return { code: `export const __DEV__: boolean = ${String(flag)}\n`, map: null }
      }
      if (!/\b__DEV__\b/.test(code)) return null
      let out = code.replace(/^import\s*\{\s*__DEV__\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, '')
      const unhandledImportShape =
        /\b(?:import|export)\s*(?:type\s*)?\{[^}]*\b__DEV__\b[^}]*\}\s*from/.test(out) ||
        /\bimport\s+__DEV__\b/.test(out)
      if (unhandledImportShape) {
        throw new Error(
          `[build.config] unexpected __DEV__ import/export shape in ${posixId}; ` +
            'the dev-flag strip only rewrites the solo named-import form'
        )
      }
      out = out.replace(/\b__DEV__\b/g, String(flag))
      return { code: out, map: null }
    },
  }
}

/**
 * Shared `rollup:options` hook for both flavors.
 *
 * Alias half: the source imports `from 'zod-v3'` (our pnpm-alias dev
 * install for zod@3) but published bundles need `from 'zod'` so consumers
 * can install zod@3 themselves. @rollup/plugin-alias does the rewrite —
 * but rollup calls `external(id)` BEFORE the resolveId chain runs, and
 * unbuild's default external warns "Implicitly bundling zod-v3" before
 * plugin-alias has a chance. The wrapper marks `zod-v3` explicitly
 * *not*-external (lets resolveId run → plugin-alias rewrites →
 * post-resolve external sees 'zod' and marks it external) and silences
 * the implicit-bundling warning for the specific zod-v3 case.
 */
function rollupOptionsHook(devFlag: boolean): NonNullable<BuildConfig['hooks']> {
  return {
    'rollup:options'(_ctx, options) {
      const originalExternal = options.external
      // Rollup's `external` accepts string / RegExp / array of either /
      // function. Collapse every shape to a boolean match so a future
      // unbuild change that swaps the runtime shape doesn't silently
      // turn every external into a bundled dependency.
      const matchesOriginal = (
        id: string,
        parentId: string | undefined,
        isResolved: boolean
      ): boolean => {
        if (originalExternal === undefined || originalExternal === null) return false
        if (typeof originalExternal === 'function') {
          return Boolean(originalExternal(id, parentId, isResolved))
        }
        const entries = Array.isArray(originalExternal) ? originalExternal : [originalExternal]
        return entries.some((entry) => {
          if (typeof entry === 'string') return entry === id
          if (entry instanceof RegExp) return entry.test(id)
          return false
        })
      }
      options.external = (id, parentId, isResolved) => {
        if (id === 'zod-v3') return false
        return matchesOriginal(id, parentId, isResolved)
      }
      options.plugins = [
        devFlagStripPlugin(devFlag),
        aliasPlugin({ entries: [{ find: 'zod-v3', replacement: 'zod' }] }),
        ...(Array.isArray(options.plugins) ? options.plugins : []),
      ]
    },
  }
}

const SHARED_EXTERNALS = [
  '@vue/compiler-core',
  'nuxt',
  'nuxt/app',
  '@nuxt/kit',
  '@nuxt/schema', // re-exported by @nuxt/kit; silences "implicitly bundling"
  'vite',
  'vue',
  'zod',
  'typescript',
  /lodash-es.*/,
]

const SHARED_ROLLUP: NonNullable<BuildConfig['rollup']> = {
  // ESM-only. Nothing resolves the CJS tree: Node >=22 and every
  // bundler read the import conditions, and Nuxt loads the module
  // through jiti. The package.json exports map carries no require
  // condition (dropped in the same commit as this flag).
  emitCJS: false,
  // `hoistTransitiveImports: false` stops Rollup from emitting bare
  // `import './shared/chunk.mjs'` statements into an entry for chunks
  // that the entry only reaches transitively (through another shared
  // chunk it directly imports). With `"sideEffects": false` in the
  // package.json, those defensive bare imports conflict — consumer
  // bundlers correctly drop them (they have no named imports and no
  // declared side effects), emitting an "Ignoring this import"
  // warning for every occurrence. The transitive chunks still load
  // because the directly-imported chunk's own imports pull them in.
  // Turning off hoisting means no redundant bare imports and no
  // warnings, at the cost of a marginal extra network roundtrip for
  // consumers who load our `.mjs` directly without a bundler (a
  // non-goal for a library published to npm).
  output: {
    hoistTransitiveImports: false,
  },
  dts: {
    // respectExternal:false avoids re-rolling type-only deps whose TS shape
    // (e.g. typescript's own nested namespaces) can't be bundled by
    // rollup-plugin-dts.
    respectExternal: false,
  },
  esbuild: {
    format: 'esm',
    target: 'es2020',
    // Libraries should NOT minify for npm consumers:
    //   - Consumer bundlers (Vite, Webpack, Rollup+Terser) minify in
    //     production mode. Upstream minification saves no bytes.
    //   - Minified output produces useless stack traces
    //     (single-letter identifiers) and hostile `cd node_modules`
    //     debugging for anyone investigating a bug in our code.
    //   - Tarball gzip compression closes most of the on-disk delta
    //     between minified and readable output.
    // Tree-shaking stays on — it drops unreachable code without
    // mangling what remains.
    minify: false,
    // No sourcemaps in the published package: the shipped .mjs is
    // readable unminified source, so a map adds nothing to consumer
    // debugging while roughly doubling the tarball. Consumers who
    // step into our code land in the actual shipped module.
    sourcemap: false,
    treeShaking: true,
    legalComments: 'inline',
  },
}

export default defineBuildConfig([
  // Prod flavor. Runs FIRST: unbuild cleans each config's outDir, and
  // cleaning `dist` wipes `dist/dev` with it, so the dev flavor must
  // build after.
  {
    entries: [
      ...RUNTIME_ENTRIES,
      ...TOOLING_ENTRIES,
      // `.vue` files for the Nuxt DevTools overlay panel. Rollup builds
      // .ts entries; the consumer's Vite + @vitejs/plugin-vue compiles
      // the raw `.vue` source at consumer build time when the iframe HTML
      // (served by `attaform/vite`'s middleware) imports
      // `attaform/devtools-panel`. Dev-only — production builds never
      // load the panel.
      //
      // Directional contract: `input` is read-only — mkdist NEVER writes
      // back to `src/runtime/components/`. Every artifact (the lossy
      // `.vue` post-transform output AND the Volar-emitted `.d.vue.ts` /
      // `.vue.d.ts` declaration stubs) lands in `outDir`. If those stubs
      // ever materialise inside `input/`, the regression is in whatever
      // wrote them (a Volar emit-on-save misconfig in the editor, a
      // stale `vue-tsc` invocation without `--noEmit`, a manual file
      // copy), not in this config. `test/source-shape.test.ts` is the
      // standing tripwire that catches the corruption regardless of
      // writer.
      {
        builder: 'mkdist',
        input: './src/runtime/components/',
        outDir: './dist/runtime/components/',
        pattern: ['**/*.vue'],
      },
    ],
    externals: SHARED_EXTERNALS,
    // 'node16' emits a single .d.mts flavor per entry instead of the
    // .d.ts / .d.mts / .d.cts triple. The package is ESM-only ("type":
    // "module", import-only exports), so one flavor is all any resolver
    // consults; the other two were dead weight tripling the packed
    // declaration payload.
    declaration: 'node16',
    failOnWarn: false,
    hooks: rollupOptionsHook(false),
    rollup: SHARED_ROLLUP,
    sourcemap: false,
    parallel: false,
    name: 'attaform',
  },
  // Dev flavor: runtime entries only, no declarations (the `types`
  // condition always resolves the prod-path .d.mts, and TS consults
  // conditions in declaration order with `types` first).
  {
    entries: [...RUNTIME_ENTRIES],
    outDir: 'dist/dev',
    externals: SHARED_EXTERNALS,
    declaration: false,
    failOnWarn: false,
    hooks: rollupOptionsHook(true),
    rollup: SHARED_ROLLUP,
    sourcemap: false,
    parallel: false,
    name: 'attaform-dev',
  },
])
