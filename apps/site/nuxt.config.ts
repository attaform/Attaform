import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger as nuxtKitLogger } from '@nuxt/kit'
import tailwindcss from '@tailwindcss/vite'
import attaformModule from 'attaform/nuxt'
import { rendererRich, transformerTwoslash } from '@shikijs/twoslash'
import type { Logger, LogOptions, Plugin as VitePlugin } from 'vite'
import attaformPkg from '../../package.json'
import vuePkg from 'vue/package.json'
import zodPkg from 'zod/package.json'
// `zod-v3` is an npm alias: pnpm installs zod@3.x under that directory
// name (root package.json, `"zod-v3": "npm:zod@^3.24"`), so this path
// resolves to its own package.json and a v3.x version field.
import zodV3Pkg from 'zod-v3/package.json'
// Composes each folder demo's gitignored `styles.css` from the shared
// fragment registry plus its `styles.json`. Imported here for the
// dev-server plugin below; build and generate run it through the
// `codegen:demo-styles` package script before typecheck.
import { generateAll, generateOne } from './scripts/demo-styles/codegen.mjs'

// The monorepo root, two levels up. Broadens Vite's `server.fs.allow` so
// the dev server can stream files from the workspace's hoisted
// `node_modules/.pnpm/...` tree; see `vite.server.fs.allow` below.
const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Replace Vite's `vite:asset-import-meta-url` plugin filter with a
// linear-time substring check. Its built-in code filter is
// `/new\s+URL.+import\.meta\.url/s`, and that `.+` under the dotAll flag
// catastrophic-backtracks on dense minified content over 5 MB: V8 blows
// its regex stack and `pattern.test` throws `Maximum call stack size
// exceeded`. `@vue/repl/monaco-editor`'s 7.2 MB prebundle trips it,
// surfacing as an `Internal server error` on the first `/demos/<slug>`
// load.
//
// The filter only has to answer "could this contain such a pattern",
// since the handler re-matches precisely with `assetImportMetaUrlRE`.
// The literal string routes Vite's `patternToCodeFilter` through
// `String.prototype.includes`, which cannot backtrack. A file holding
// `import.meta.url` without `new URL(...)` now reaches the handler,
// finds nothing and returns undefined.
//
// Patching at `configResolved` is what makes the mutation stick: Vite
// caches filters per plugin in a WeakMap built lazily on the first
// transform, which is after this runs. `enforce: 'post'` puts it after
// every upstream plugin has resolved into the config.
const fixViteAssetImportMetaUrlFilter: VitePlugin = {
  name: 'attaform:fix-vite-asset-import-meta-url-filter',
  enforce: 'post',
  configResolved(resolved) {
    const target = resolved.plugins.find((p) => p?.name === 'vite:asset-import-meta-url')
    if (!target?.transform || typeof target.transform === 'function') return
    if (target.transform.filter == null) return
    target.transform.filter.code = 'import.meta.url'
  },
}

// Three modules discover every demo SFC through
// `import.meta.glob('../../docs-demos/*.vue')`, and a glob's key set is
// resolved once at module-eval time. When an SFC lands in `docs-demos/`
// after a consumer has compiled, Vite's invalidation is best-effort: the
// watcher fires, but the consumer's transform cache does not reliably
// rerun before the next SSR render. That shows up as a 404 from
// `/demos/<new-slug>`, or an in-page `[DocsDemo] no demo found for slug`
// throw on the inline embed.
//
// So on `add` and `unlink` under `docs-demos/`, invalidate every glob
// consumer in the dev server's module graph and broadcast a full reload.
// Modify events are deliberately left alone: those invalidate the touched
// SFC through normal HMR, which the consumer already proxies.
const invalidateDemoGlobConsumersOnDemoChange: VitePlugin = {
  name: 'attaform:invalidate-demo-glob-consumers-on-demo-change',
  apply: 'serve',
  configureServer(server) {
    const siteRoot = dirname(fileURLToPath(import.meta.url))
    const demosDir = resolve(siteRoot, 'docs-demos')
    const globConsumers = [
      resolve(siteRoot, 'pages/demos/[slug].vue'),
      resolve(siteRoot, 'pages/demos/index.vue'),
      resolve(siteRoot, 'components/content/DocsDemo.vue'),
    ]
    function invalidate(): void {
      for (const consumer of globConsumers) {
        const mods = server.moduleGraph.getModulesByFile(consumer)
        if (mods == null) continue
        for (const mod of mods) server.moduleGraph.invalidateModule(mod)
      }
      server.ws.send({ type: 'full-reload' })
    }
    function onFsEvent(path: string): void {
      if (!path.startsWith(demosDir)) return
      if (!path.endsWith('.vue')) return
      invalidate()
    }
    server.watcher.on('add', onFsEvent)
    server.watcher.on('unlink', onFsEvent)
  },
}

// Demo styles are generated, not authored, and gitignored, so the dev
// server has to materialize them. `configureServer` runs at startup
// before any module is transformed, which is what makes both App.vue's
// `import './styles.css'` and the playground's `?raw` glob resolve, and
// again on every Nuxt config restart. Editing a `styles.json` re-emits
// that demo alone; editing the registry re-emits all of them.
const generateDemoStylesOnServe: VitePlugin = {
  name: 'attaform:generate-demo-styles-on-serve',
  apply: 'serve',
  configureServer(server) {
    const siteRoot = dirname(fileURLToPath(import.meta.url))
    const demosDir = resolve(siteRoot, 'docs-demos')
    const registryFile = resolve(siteRoot, 'scripts/demo-styles/registry.mjs')
    generateAll()
    function onFsEvent(path: string): void {
      if (path === registryFile) {
        generateAll()
        return
      }
      if (path.startsWith(demosDir) && path.endsWith('styles.json')) {
        generateOne(dirname(path))
      }
    }
    server.watcher.add(registryFile)
    server.watcher.on('add', onFsEvent)
    server.watcher.on('change', onFsEvent)
    server.watcher.on('unlink', onFsEvent)
  },
}

// The playground page seeds the REPL by importing every folder-demo file
// as raw text, generated `styles.css` included, and that glob is evaluated
// during SSR. Vite's `css-post` plugin treats any id ending in `.css` as a
// style request even under `?raw`, appending `?inline&used`, so the id
// becomes `styles.css?raw?inline&used`; Rollup then parses it as
// JavaScript and rejects the first `.demo {` with "Expression expected".
// The client build tolerates raw CSS, the SSR build does not.
//
// Claiming those imports first maps each `styles.css?raw` to an opaque
// virtual id with no `.css` in its path, which `css-post` ignores, and
// loads it as a default-exported string. The REPL still receives the exact
// bytes `App.vue` imports on both render paths.
const DEMO_RAW_CSS_RE = /docs-demos[\\/][^\\/]+[\\/]styles\.css\?raw$/
const DEMO_RAW_CSS_PREFIX = '\0demo-raw-css:'
const demoRawCssFiles = new Map<string, string>()
const serveDemoRawCss: VitePlugin = {
  name: 'attaform:serve-demo-raw-css',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer === undefined || !DEMO_RAW_CSS_RE.test(source)) return null
    const file = resolve(dirname(importer), source.replace(/\?raw$/, ''))
    for (const [existing, mapped] of demoRawCssFiles) if (mapped === file) return existing
    const id = `${DEMO_RAW_CSS_PREFIX}${demoRawCssFiles.size}`
    demoRawCssFiles.set(id, file)
    return id
  },
  load(id) {
    const file = demoRawCssFiles.get(id)
    if (file === undefined) return null
    return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`
  },
}

// Four warning families fire on every build, are not ours to fix, and
// give a maintainer reading the logs nothing to act on. Each filter is
// matched narrowly, so an unrelated warning of the same family still
// surfaces.
//
//   1. "Sourcemap is likely to be incorrect: a plugin (…) was used to
//      transform files, but didn't generate a sourcemap."
//      Tailwind v4's Vite plugin and Nuxt's module-preload-polyfill
//      transform without emitting sourcemaps, and Rollup warns about
//      17 times a build that the resulting maps would be lossy. Nothing
//      ships them: `vite.build.sourcemap` is false.
//
//   2. "new URL(\"assets/(editor|vue).worker-…\", import.meta.url) doesn't
//      exist at build time, it will remain unchanged to be resolved at
//      runtime."
//      @vue/repl's Monaco preset builds its worker URLs from dynamic
//      strings that Vite's static analyser cannot resolve. That runtime
//      resolution is exactly what the Worker-constructor Proxy in
//      DemoReplEditor.client.vue intercepts, rerouting to the static
//      copies `bundle:repl` emits under /lib/repl-workers/.
//
//   3. "Unresolvable optimizeDeps.include entries: @nuxtjs/mdc > …"
//      @nuxtjs/mdc, transitive through @nuxt/content, declares its own
//      remark/rehype/unified sub-deps in its Vite optimizeDeps manifest.
//      Under pnpm's strict hoist those live deep in the workspace store,
//      and Vite's resolver, rooted at apps/site, cannot reach them by
//      `parent > child` traversal because @nuxtjs/mdc is not surfaced at
//      apps/site/node_modules. Harmless: Nuxt re-resolves them through
//      @nuxt/content's pipeline at module-load time. Listing the entries
//      here does not help, since they would add unresolvable copies of
//      their own.
//
//   4. "Payload extraction is recommended for full-static output."
//      Fires under `nuxi dev` because payload extraction is deliberately
//      off in development, to dodge the ENOTDIR Nitro cache collision
//      documented in the `experimental:` block below. The advice is right
//      for production, where the gate does enable it; Nitro reads
//      `nitro.static: true` and warns regardless of mode.
function isFilteredBuildWarning(msg: string): boolean {
  if (msg.includes('Sourcemap is likely to be incorrect')) return true
  if (
    msg.includes("doesn't exist at build time") &&
    /\bassets\/(editor|vue)\.worker-[A-Za-z0-9_-]+\.js\b/.test(msg)
  ) {
    return true
  }
  if (msg.includes('Unresolvable optimizeDeps.include entries') && msg.includes('@nuxtjs/mdc')) {
    return true
  }
  if (msg.includes('Payload extraction is recommended for full-static output')) {
    return true
  }
  return false
}

// Wrap @nuxt/kit's Consola logger at config-evaluation time so the
// Nuxt vite-builder's "Unresolvable optimizeDeps.include entries"
// warning (emitted via `logger.warn(...)` from inside the optimizer
// poll) flows through our filter. The Vite-side `customLogger` wrap
// further down does not catch it: vite-builder constructs a fresh Vite
// logger AND calls into the kit Consola directly for the optimize-deps
// callback, so both layers are needed.
{
  const origWarn = nuxtKitLogger.warn.bind(nuxtKitLogger)
  nuxtKitLogger.warn = ((...args: unknown[]) => {
    const head = args[0]
    if (typeof head === 'string' && isFilteredBuildWarning(head)) return
    return origWarn(...(args as [unknown, ...unknown[]]))
  }) as typeof nuxtKitLogger.warn
}

// `console.warn` self-healing guard. Under Nuxt 4.4, Vite 7 and consola
// 3.4, the SSR bundle pass calls `Consola.wrapAll()`, which writes
// `console[type] = this[type].raw` for every type. On the SSR-targeted
// consola instance `this.warn.raw` is `undefined`, since `.raw` exists
// only on the rich Node consola and not on the browser-shimmed one Vite
// produces once `node:tty` is externalized. `console.warn` becomes
// undefined, and the next Rollup warning during prerender crashes
// `defaultPrintLog` with `TypeError: console.warn is not a function`.
// `nuxi build` then exits non-zero on a warning nobody ever sees.
//
// Rejecting any non-function assignment and falling back to the original
// lets the override land while keeping the global callable, so Rollup's
// warning printer survives to the end of the prerender.
{
  const realWarn = console.warn.bind(console)
  let current: typeof console.warn = realWarn
  Object.defineProperty(console, 'warn', {
    configurable: true,
    get() {
      return typeof current === 'function' ? current : realWarn
    },
    set(v) {
      current = typeof v === 'function' ? v : realWarn
    },
  })
}

export default defineNuxtConfig({
  // Deliberately no font module. Inter and JetBrains Mono are committed
  // as .woff2 under `public/fonts/` and referenced by the @font-face
  // block in `assets/css/fonts.css`, because proxying them through
  // Google Fonts made `fonts.gstatic.com` a single point of failure: a
  // slow response left the page renderer unable to resolve a font and
  // Nitro returned 500, in dev and in CI alike. `nuxt-og-image` still
  // fetches Satori fonts at build time, where a failure is loud and
  // fixable rather than user-facing. `pnpm fonts:refresh` re-fetches the
  // committed .woff2 files when a weight or version changes.
  modules: [attaformModule, '@nuxt/content', '@nuxtjs/color-mode', '@nuxtjs/seo'],
  // Source-alias the attaform subpaths for vue-tsc too, not just Vite and
  // Nitro. Without a tsconfig-level alias, vue-tsc resolves them through
  // the package `exports` map to `dist/*.d.mts`, while the generated
  // `.nuxt/types/plugins.d.ts` reaches the runtime plugin by a relative
  // `../../../../src/runtime/plugins/attaform` path. Both trees then sit
  // in the project graph, carrying two `pathKeyBrand: unique symbol`
  // declarations that TypeScript treats as distinct nominal brands. The
  // `v-register` payload type from the merged GlobalDirectives
  // augmentations ends up checking dist-branded values against
  // src-branded slots, and a `register('termsAccepted')` call goes red.
  // Aliasing here collapses every import back to src, so the project
  // holds one PathKey identity and matches the runtime aliases below.
  alias: {
    attaform: resolve(monorepoRoot, 'src/index.ts'),
    'attaform/abstract': resolve(monorepoRoot, 'src/abstract.ts'),
    'attaform/directive': resolve(monorepoRoot, 'src/directive.ts'),
    'attaform/history': resolve(monorepoRoot, 'src/history.ts'),
    'attaform/zod': resolve(monorepoRoot, 'src/zod.ts'),
    'attaform/zod-v3': resolve(monorepoRoot, 'src/zod-v3.ts'),
    'attaform/zod-v4': resolve(monorepoRoot, 'src/zod-v4.ts'),
    'attaform/vite': resolve(monorepoRoot, 'src/vite.ts'),
    'attaform/transforms': resolve(monorepoRoot, 'src/transforms.ts'),
  },
  // @nuxtjs/seo wires sitemap.xml, robots.txt, per-page canonicals,
  // nuxt-og-image, nuxt-schema-org and nuxt-link-checker behind one
  // module. The sitemap walks the prerendered routes set, and canonicals,
  // OG meta and structured-data URLs all resolve against `site.url`.
  //
  // `site.url` pins the apex. `attaform.dev` is the canonical origin, and
  // `www.attaform.dev` plus both `attaform.com` hosts 301 to it at the
  // Vercel layer, so emitting on the apex means a crawler reaches the
  // canonical URL with no redirect hop and no duplicate-content signal.
  //
  // `indexable` gates the entire SEO-discovery surface on one flag, the
  // same one `scripts/indexnow-ping.mjs` reads. When false, robots.txt
  // becomes `Disallow: /`, the sitemap route is suppressed, and every
  // page emits `<meta name="robots" content="noindex, nofollow">`.
  //
  // It defaults to false, so sandboxed branches, preview deploys, local
  // builds and CI all produce non-indexable output, and only a Vercel
  // production deploy flips it. There is deliberately no force-override:
  // the production gate is the single source of truth, matching the
  // IndexNow script. To see the indexable variant locally, set
  // `VERCEL_ENV=production` on the `pnpm build` command line.
  site: {
    url: 'https://attaform.dev',
    name: 'Attaform',
    description: 'A type-safe, Zod-first form library for Vue 3 and Nuxt.',
    defaultLocale: 'en',
    indexable: process.env.VERCEL_ENV === 'production',
  },
  // nuxt-og-image renders Vue components to 1200x630 PNGs at build time
  // through Satori. The generic Nitro `static` preset is chosen over the
  // platform-specific `vercel-static` for portability, so the resulting
  // `dist/` is servable anywhere. The module reads `nitro.static`, set in
  // the `nitro:` block below, to detect SSG and route to its
  // `nitro-prerender` compatibility profile.
  //
  // `zeroRuntime: true` prerenders every OG image at build time and
  // serves no runtime generation endpoint. That removes both the "OG
  // image URLs are not signed" warning, which has no purchase on pure
  // SSG, and the request-forgery surface it warns about. A
  // NUXT_OG_IMAGE_SECRET would silence the warning too, but at the price
  // of a runtime this site does not ship.
  //
  // No `fonts:` block on purpose: nuxt-og-image v6 dropped it in favour
  // of reading a font module or falling back to its `fontless` resolver,
  // and that resolver fetches font bytes at build time only, where a
  // Google CDN hiccup is a build failure rather than a dev-server 500.
  // The cards use Inter alone (`components/OgImage/Default.satori.vue`),
  // so the resolver narrows to that family at render time.
  ogImage: { zeroRuntime: true },
  // nuxt-link-checker probes every <a>, canonical and og:url on every
  // prerendered page. `failOnError` exits the build non-zero on a broken
  // internal link, the same gate `nitro.prerender.failOnError` applies to
  // 500s. External URLs stay out of the loop by default, so an upstream
  // tool retiring its domain cannot fail CI; link rot on the wider web is
  // a manual cleanup task in exchange.
  //
  // `strictNuxtContentPaths` tells the inspector that markdown source
  // paths map 1:1 to live URLs, so a relative `[label](other-doc.md)`
  // resolves through @nuxt/content's own path map instead of being read
  // as a raw file fetch.
  linkChecker: {
    failOnError: true,
    strictNuxtContentPaths: true,
    // The per-page raw-Markdown endpoints (public/docs/**/*.md, emitted by
    // generate-llms.mjs) are static build artifacts, not Nuxt Content
    // routes, so strictNuxtContentPaths would read the in-page "copy as
    // markdown" links as broken content paths. Exclude the .md endpoints
    // from inspection; the generator guarantees they exist. Merged with
    // (not replacing) the module's default excludeLinks regexes.
    excludeLinks: [/^\/docs\/.*\.md$/],
  },
  // @nuxt/content's Shiki integration. The theme and language sets are
  // pinned deliberately: the default bundles about 50 grammars this site
  // never renders. The light/dark pair flips on the `.dark` selector
  // through Shiki's css-variables theme mode.
  content: {
    build: {
      markdown: {
        highlight: {
          theme: {
            default: 'github-light',
            dark: 'github-dark',
          },
          langs: [
            'ts',
            'tsx',
            'js',
            'jsx',
            'json',
            'vue',
            'vue-html',
            'html',
            'css',
            'bash',
            'sh',
            'yaml',
            'md',
            'diff',
          ],
          // Twoslash adds inline type information to opt-in code blocks
          // (` ```ts twoslash`). Under `explicitTrigger` every other
          // block renders unchanged. `rendererRich()` must be the
          // renderer object; the older string form `'rich'` breaks
          // silently at runtime.
          //
          // @ts-expect-error @nuxt/content v3.13's highlight type omits
          // `transformers`, though the runtime forwards the array
          // straight to Shiki, which accepts it. Drop the directive when
          // @nuxt/content tightens the type.
          transformers: [
            transformerTwoslash({
              explicitTrigger: true,
              renderer: rendererRich(),
              throws: false,
            }),
          ],
        },
      },
    },
  },
  devtools: { enabled: true },
  compatibilityDate: '2025-01-28',
  // Read at build time from the real package.json files, so `pnpm
  // version` stays the only place a version is bumped.
  //
  //   - attaformVersion: the homepage release pill and the footer brand
  //     block.
  //   - replDependencyVersion: pinned on the @vue/repl store's
  //     `dependencyVersion` so Volar skips its slow, unpkg-bound
  //     latest-version lookup.
  runtimeConfig: {
    public: {
      attaformVersion: attaformPkg.version,
      replDependencyVersion: {
        attaform: attaformPkg.version,
        vue: vuePkg.version,
        zod: zodPkg.version,
        'zod-v3': zodV3Pkg.version,
      },
    },
  },
  // On in build, where a prefetched `_payload.json` per route buys
  // SPA-speed navigation at no runtime cost. Off in dev, because Nitro's
  // `payloadCache` writes one fs entry per rendered route and unstorage
  // normalizes the root route's key to an empty string: the fs driver
  // then writes a bare `payload` FILE where the directory belongs, and
  // every subsequent route 500s with `ENOTDIR: ... payload/docs-<hash>`.
  // Production prerendering writes `_payload.json` straight into
  // `.output/public/<route>/` through a different path, untouched by the
  // dev cache.
  //
  // `NODE_ENV` is read at config-eval time. `nuxi dev` sets it to
  // `development`, but `nuxi build` sets nothing, so package.json's
  // `build` and `generate` scripts pin `production` explicitly for this
  // gate and any upstream probe.
  experimental: {
    payloadExtraction: process.env.NODE_ENV === 'production',
  },
  // 301s for the pre-rebuild URL tree, which lived under `/docs/api/*`
  // and `/docs/recipes/*` before the docs were organized by concept.
  // Specific routes beat wildcards in Nuxt's precedence, so each known
  // old URL maps to its successor and the catch-alls at the bottom land
  // anything missed on the docs spine rather than a 404.
  routeRules: {
    // The AI tooling section split the single `ai-agents` page into
    // focused pages (skill + the two machine-readable exports); the old
    // URL lands on the skill page, the section's headline.
    '/docs/reference/ai-agents': {
      redirect: { to: '/docs/ai-tooling/agent-skill', statusCode: 301 },
    },
    // Top-level pre-rebuild slugs.
    '/docs/why': {
      redirect: { to: '/docs/getting-started/why-attaform', statusCode: 301 },
    },
    '/docs/quickstart': {
      redirect: { to: '/docs/getting-started/quick-start', statusCode: 301 },
    },
    '/docs/troubleshooting': {
      redirect: { to: '/docs/devtools-and-debugging/troubleshooting', statusCode: 301 },
    },
    '/docs/perf': {
      redirect: { to: '/docs/server-and-ssr/performance', statusCode: 301 },
    },

    // Every per-entry-point page collapsed into one Reference category.
    '/docs/api/core': {
      redirect: { to: '/docs/reference/entry-points', statusCode: 301 },
    },
    '/docs/api/nuxt': {
      redirect: { to: '/docs/reference/entry-points', statusCode: 301 },
    },
    '/docs/api/vite': {
      redirect: { to: '/docs/reference/entry-points', statusCode: 301 },
    },
    '/docs/api/zod': {
      redirect: { to: '/docs/reference/entry-points', statusCode: 301 },
    },
    '/docs/api/zod-v3': {
      redirect: { to: '/docs/reference/entry-points', statusCode: 301 },
    },
    '/docs/api/zod-v4': {
      redirect: { to: '/docs/reference/entry-points', statusCode: 301 },
    },
    '/docs/api/shared-types': {
      redirect: { to: '/docs/reference/types', statusCode: 301 },
    },
    '/docs/api/transforms': {
      redirect: { to: '/docs/binding-inputs/transforms', statusCode: 301 },
    },
    '/docs/api/use-form-return': {
      redirect: { to: '/docs/reading-the-form/the-form', statusCode: 301 },
    },

    // Task-shaped pages folded into the matching concept page.
    '/docs/recipes/async-validation': {
      redirect: { to: '/docs/validation/async-refinements', statusCode: 301 },
    },
    '/docs/recipes/blank-inputs': {
      redirect: { to: '/docs/validation/blank', statusCode: 301 },
    },
    '/docs/recipes/coerce': {
      redirect: { to: '/docs/binding-inputs/coercion', statusCode: 301 },
    },
    '/docs/recipes/custom-adapter': {
      redirect: { to: '/docs/reference/custom-adapters', statusCode: 301 },
    },
    '/docs/recipes/devtools': {
      redirect: { to: '/docs/devtools-and-debugging/devtools-panel', statusCode: 301 },
    },
    '/docs/recipes/discriminated-unions': {
      redirect: { to: '/docs/schemas/discriminated-unions', statusCode: 301 },
    },
    '/docs/recipes/dynamic-field-arrays': {
      redirect: { to: '/docs/writing-and-mutating/field-arrays', statusCode: 301 },
    },
    '/docs/recipes/error-display': {
      redirect: { to: '/docs/validation/showing-errors', statusCode: 301 },
    },
    '/docs/recipes/field-level-validation': {
      redirect: { to: '/docs/validation/per-field-validation', statusCode: 301 },
    },
    '/docs/recipes/file-uploads': {
      redirect: { to: '/docs/binding-inputs/file', statusCode: 301 },
    },
    '/docs/recipes/focus-on-error': {
      redirect: { to: '/docs/submitting/focus-scroll', statusCode: 301 },
    },
    '/docs/recipes/form-context': {
      redirect: { to: '/docs/cross-cutting-state/inject-form', statusCode: 301 },
    },
    '/docs/recipes/server-errors': {
      redirect: { to: '/docs/submitting/server-side-errors', statusCode: 301 },
    },
    '/docs/recipes/ssr-hydration': {
      redirect: { to: '/docs/server-and-ssr/ssr-nuxt', statusCode: 301 },
    },
    '/docs/recipes/storage-shape': {
      redirect: { to: '/docs/schemas/storage-shape', statusCode: 301 },
    },
    '/docs/recipes/transforms': {
      redirect: { to: '/docs/binding-inputs/transforms', statusCode: 301 },
    },
    '/docs/recipes/undo-redo': {
      redirect: { to: '/docs/cross-cutting-state/undo-redo', statusCode: 301 },
    },

    // Catch-alls. Specific routes above win over these globs.
    '/docs/api/**': {
      redirect: { to: '/docs/getting-started/introduction', statusCode: 301 },
    },
    '/docs/recipes/**': {
      redirect: { to: '/docs/getting-started/introduction', statusCode: 301 },
    },
  },
  // Bind to all interfaces so the docker-compose 3000:3000 mapping
  // reaches the dev server. 0.0.0.0 includes localhost, so host-only dev
  // is unaffected.
  devServer: { host: '0.0.0.0' },
  // The module emits a blocking inline <script> in <head> that resolves
  // the preference and sets `<html class>` before first paint. An empty
  // `classSuffix` keeps the class bare (`.dark`, not `.dark-mode`), which
  // is what the @variant dark selector in tailwind.css matches.
  colorMode: {
    classSuffix: '',
    preference: 'system',
    fallback: 'light',
    storageKey: 'attaform-color-mode',
  },
  // Mount components/content/ without a path prefix, so a file like
  // ProseA.vue resolves under its bare name. That is the convention Nuxt
  // Content's prose-override system expects.
  components: [{ path: '~/components/content', pathPrefix: false, global: true }, '~/components'],
  nitro: {
    // The server half of the source-alias map; `vite.resolve.alias` below
    // carries the full explanation. Nitro resolves `attaform/zod` for
    // every page render and the jiti hop caches per process, so without
    // these entries a `src/` edit after Nitro boots never reaches SSR
    // output: the inline `<DocsDemo>` ships stale form state into
    // hydration while the playground, on the freshly bundled
    // `/lib/attaform.js`, shows current behaviour.
    //
    // Only bare `attaform` and `attaform/zod` are imported in apps/site
    // today; the rest are listed for symmetry with Vite and to cover a
    // future demo reaching for one. Prefix-matching is safe here, since
    // the matcher requires `/` or end-of-string after the key, so
    // `attaform/zod` does not swallow `attaform/zod-v3`.
    alias: {
      attaform: resolve(monorepoRoot, 'src/index.ts'),
      'attaform/abstract': resolve(monorepoRoot, 'src/abstract.ts'),
      'attaform/directive': resolve(monorepoRoot, 'src/directive.ts'),
      'attaform/history': resolve(monorepoRoot, 'src/history.ts'),
      'attaform/zod': resolve(monorepoRoot, 'src/zod.ts'),
      'attaform/zod-v3': resolve(monorepoRoot, 'src/zod-v3.ts'),
      'attaform/zod-v4': resolve(monorepoRoot, 'src/zod-v4.ts'),
      'attaform/vite': resolve(monorepoRoot, 'src/vite.ts'),
      'attaform/transforms': resolve(monorepoRoot, 'src/transforms.ts'),
    },
    // Serve the REPL pipeline's output from `/lib/`, the URLs DemoRepl's
    // import map and Volar callbacks expect, while the artifacts
    // themselves live outside `apps/site/public/`.
    //
    // They have to: the type bundles re-emit `declare global { interface
    // Window { [DEVTOOLS_WINDOW_KEY]?: ... } }` from Attaform's runtime
    // sources. Under `public/` they entered vue-tsc's project graph and
    // collided with the declaration in `src/runtime/core/devtools-shared.ts`
    // as TS2717. It only ever fired locally, since CI runs `typecheck`
    // before `bundle:repl` and the file did not exist yet. `.repl-cache/`
    // sits outside `apps/site/**/*`, so vue-tsc never sees it, and Nitro's
    // publicAssets pipeline applies no project-tree ignore filters, so the
    // `.d.ts` files still ship to `.output/public/lib/types/`.
    publicAssets: [
      {
        dir: resolve(monorepoRoot, 'apps/site/.repl-cache'),
        baseURL: '/lib',
      },
    ],
    // Pure SSG: prerendered HTML and assets, no serverless runtime and no
    // Node server, so Vercel deploys it CDN-only and burns no function
    // quota. Declaring the preset here means `nuxi build`, `nuxi generate`
    // and Vercel's auto-detected build path all produce the same output.
    // Pagefind depends on it too: `pnpm index:search` walks
    // `.output/public` for HTML, and without prerendering it finds only
    // assets and `_payload.json` and exits with "did not find any html
    // files".
    //
    // `crawlLinks` follows internal `<a href>` and NuxtLink targets, so
    // only the entry points need listing. `/docs` links into every doc
    // page; `/` and `/demos` cover the rest of the public surface.
    //
    // `failOnError` gates the build on prerender 500s: a Vue mustache
    // leaking through a markdown code fence onto an undefined variable, an
    // unhandled rejection in an async setup. It deliberately does NOT gate
    // on 404s, since `createError({ statusCode: 404 })` and
    // `setResponseStatus(404)` both log and let the prerender continue.
    // Missing targets are nuxt-link-checker's job, in the `linkChecker:`
    // block above.
    preset: 'static',
    // The flag a few modules read to detect "this build emits HTML at
    // prerender time, no runtime server". nuxt-og-image's
    // `resolveOgImagePreset` returns `'nitro-prerender'` for it, which
    // silences the "Unknown Nitro preset 'static'" warning. `preset:
    // 'static'` does not imply it: the preset and the boolean are sibling
    // concerns.
    static: true,
    prerender: {
      crawlLinks: true,
      routes: ['/', '/docs', '/demos'],
      failOnError: true,
    },
    // Nitropack's built-in /_vfs dev handler, behind Nuxt DevTools'
    // Virtual Files panel, hard-checks the request IP against ::1 and
    // 127.* and 403s everything else as "Forbidden IP". Under Docker the
    // request arrives from the bridge IP, so the panel breaks, and there
    // is no config knob. This pre-handler shares the /_vfs prefix,
    // shadows `socket.remoteAddress` to 127.0.0.1, and returns nothing,
    // so the real VFS handler runs after it.
    devHandlers: [
      {
        route: '/_vfs',
        handler: (event: { node?: { req?: { socket?: unknown } } }) => {
          const socket = event?.node?.req?.socket as { remoteAddress?: string } | undefined
          if (socket && socket.remoteAddress !== '127.0.0.1') {
            try {
              Object.defineProperty(socket, 'remoteAddress', {
                value: '127.0.0.1',
                configurable: true,
              })
            } catch {
              // Some Node versions expose remoteAddress as a non-configurable
              // getter; nothing we can do at this layer.
            }
          }
        },
      },
    ],
  },
  vite: {
    plugins: [
      tailwindcss(),
      fixViteAssetImportMetaUrlFilter,
      invalidateDemoGlobConsumersOnDemoChange,
      generateDemoStylesOnServe,
      serveDemoRawCss,
    ],
    // Source-resolve the workspace `attaform` package for the docs site's
    // Vite environments. Without these aliases every `attaform/*` import
    // resolves through the package `exports` map to `dist/*.mjs`, which
    // under `pnpm dev:prepare` is an `unbuild --stub` jiti shim.
    //
    // That shim works in Node, where jiti's `node:module` runtime is real,
    // and fails in the browser on the very first import: Vite serves the
    // relative `lib/jiti.mjs`, runs its CJS-to-ESM lexer over the
    // webpack-bundled `dist/jiti.cjs`, and the missing `default` export
    // throws a `SyntaxError` up through `MDCRenderer`'s
    // `resolveContentComponents(...)`. Every docs-page nav after the
    // homepage hard-crashes client-side.
    //
    // Aliasing each subpath to its `src/*.ts` file routes every consumer
    // through Vite and @vitejs/plugin-vue's normal TS compilation instead.
    // Live-reload is unaffected, since `src/` is already inside the dev
    // server's `fs.allow` root.
    //
    // Two paths deliberately have no alias. `attaform/nuxt` is consumed by
    // Nuxt's `modules:` array, which Nuxt evaluates with its own jiti
    // process before Vite boots; its setup work runs once and never spans
    // a post-edit boundary. `attaform/devtools-panel` resolves to a `.vue`
    // file through the exports map's `"default"` condition and is loaded
    // by the DevTools overlay, never imported from site code.
    resolve: {
      alias: [
        { find: /^attaform$/, replacement: resolve(monorepoRoot, 'src/index.ts') },
        { find: /^attaform\/abstract$/, replacement: resolve(monorepoRoot, 'src/abstract.ts') },
        // directive and history need their own exact rules. Without one,
        // the import falls through to the top-level `alias:` block's bare
        // `attaform` STRING alias, whose rollup-style matcher
        // prefix-matches any `attaform/*` specifier and rewrites it to
        // `src/index.ts/<sub>`. Load-bearing for the whole docs build:
        // the compile-time v-register rewrite injects `attaform/directive`
        // into every demo that uses the directive.
        { find: /^attaform\/directive$/, replacement: resolve(monorepoRoot, 'src/directive.ts') },
        { find: /^attaform\/history$/, replacement: resolve(monorepoRoot, 'src/history.ts') },
        { find: /^attaform\/zod$/, replacement: resolve(monorepoRoot, 'src/zod.ts') },
        { find: /^attaform\/zod-v3$/, replacement: resolve(monorepoRoot, 'src/zod-v3.ts') },
        { find: /^attaform\/zod-v4$/, replacement: resolve(monorepoRoot, 'src/zod-v4.ts') },
        { find: /^attaform\/vite$/, replacement: resolve(monorepoRoot, 'src/vite.ts') },
        { find: /^attaform\/transforms$/, replacement: resolve(monorepoRoot, 'src/transforms.ts') },
      ],
    },
    // Mirror `devServer.host` onto Vite's own `server.host`, because
    // @vitejs/devtools reads `viteDevServer.config.server.host` directly
    // when picking its WebSocket bind. Without it the RPC server binds to
    // ::1 inside the container and the docker port forward cannot reach
    // it. Nuxt's type for `vite.server` omits `host`, expecting the
    // top-level `devServer.host`, but Vite accepts the value and devtools
    // needs it here.
    server: {
      // @ts-expect-error Nuxt's `vite.server` type omits `host`; the
      // runtime accepts it. See above for why devtools needs it here.
      host: '0.0.0.0',
      // A request to `/@fs/app/node_modules/.pnpm/...` for a module in
      // `optimizeDeps.exclude` arrives BEFORE its importer is analyzed, so
      // the file never reaches `config.safeModulePaths` through the
      // import-analysis pass and `fs.allow` is the only gate that lets the
      // static-serve middleware emit it. The symptom is a 404 on
      // `@vue/repl/monaco-editor` on first page load while its
      // already-analyzed siblings serve cleanly. Naming the monorepo root
      // explicitly makes the allowance unambiguous and survives
      // Vite-detected-root drift across pnpm-workspace layouts.
      fs: {
        allow: [monorepoRoot],
      },
      // Force chokidar to poll inside the Docker bind mount. macOS host
      // fsevents do not reliably propagate through the mount layer to the
      // Linux container, so the native watcher misses edits under
      // `/app/src/**` after the dev server starts. It works for the
      // apps/site project root, which Vite's own scan boots with the bind
      // mount's first pass, but a src/ edit silently no-ops: HMR never
      // fires, the transform graph stays frozen at boot, and SSR keeps
      // replaying whatever `src/runtime/**` was when Nuxt started.
      //
      // It hides well, because the playground at `/demos/<slug>` DOES
      // update: `bundle-repl-deps.mjs --watch` runs esbuild's watcher,
      // which is bind-mount-reliable. Two parallel watchers, one working,
      // and nothing looks wrong until a src/ edit fails to reach a
      // Vite-resolved consumer.
      //
      // 300 ms is the conventional Docker interval, fast enough that HMR
      // feels instant and slow enough to keep CPU quiet. `binaryInterval`
      // matches it so built artifacts (jiti shims, .repl-cache bundles)
      // invalidate at the same cadence as the sources behind them.
      watch: {
        usePolling: true,
        interval: 300,
        binaryInterval: 300,
      },
    },
    // Vite's startup crawl scans index.html and statically discoverable
    // imports, missing anything inside a `.client.vue` component, which
    // SSR skips, or inside a lazy page chunk. When one of those surfaces
    // mid-session Vite re-bundles and broadcasts an "Outdated Optimize
    // Dep" 504 to in-flight requests, which is the once-per-cold-boot
    // vue-router 504 that breaks the first navigation. Pre-declaring the
    // heavy site-only deps makes the boot crawl comprehensive.
    optimizeDeps: {
      // Hold every dev-server request until the crawl finishes its FULL
      // scan, the static pre-bundle pass and the runtime-discovery
      // follow-up alike. By default Vite serves as soon as the static
      // scan completes and re-bundles quietly when a new dep surfaces,
      // and every re-bundle rotates `browserHash`, deletes the previous
      // prebundle files, and 404s any in-flight fetch keyed to the old
      // hash: the `monaco-editor.js?v=<old>` cascade `make up` documents.
      //
      // The cost is a slower cold start, since the first request waits for
      // the crawl to settle. Race-free serves are worth more than fast
      // first paint in dev. Pinned explicitly because the default varies
      // by Vite version and by dev-server environment shape.
      holdUntilCrawlEnd: true,
      // `@vue/repl` and `@vue/repl/monaco-editor` are prebundled together
      // because the editor wrapper mounts only inside a `.client.vue`
      // component, which the SSR scan skips, so the boot crawl would
      // otherwise miss them and the first `/demos/<slug>` navigation would
      // trigger the mid-session rebundle described above.
      //
      // One batch also keeps a single vue identity across the editor
      // wrapper, the Monaco preset and the docs site:
      // `EditorContainer.provide(propsKey, …)` and
      // `MonacoEditor.inject(propsKey)` need referentially equal
      // InjectionKey symbols across module boundaries.
      //
      // The Monaco preset is the 7.2 MB prebundle that trips Vite's
      // `vite:asset-import-meta-url` filter; see
      // `fixViteAssetImportMetaUrlFilter` at the top of this file.
      include: [
        'lucide-vue-next',
        '@vue/repl',
        '@vue/repl/monaco-editor',
        // Discovered at runtime via `<DocsDemo>`'s dynamic `import('shiki')`
        // for SSR-side code highlighting, and via the Zod-typed demo SFCs
        // that ship through the docs-demos/*.vue glob.
        'shiki',
        'zod',
        // In the dep graph because `apps/site` aliases `attaform/zod` to
        // the workspace `src/zod.ts`, whose unified adapter statically
        // imports both adapters so runtime dispatch can pick per schema.
        // The boot crawl misses it otherwise.
        'zod-v3',
        // A transitive of one of the @nuxtjs/seo sub-modules, the
        // schema-org or sitemap chain. Same reason as the entries above.
        'lodash-es',
      ],
      // The remark/rehype/unified cluster is excluded for the opposite
      // reason. @nuxtjs/mdc, transitive through @nuxt/content, pushes
      // these specifiers into Vite's include list from its own module
      // manifest, but under pnpm's strict hoist they do not surface at
      // apps/site/node_modules and Vite cannot resolve them by
      // `parent > child` traversal. On a cold container the scanner
      // re-enters resolution on every unresolvable entry and
      // stack-overflows the plugin pipeline on the first transform
      // request: `Internal server error: Maximum call stack size
      // exceeded` from `EnvironmentPluginContainer.transform`. Excluding
      // them short-circuits the scanner, since Nuxt's own machinery
      // resolves them at module-load time. This block prevents the
      // overflow; `isFilteredBuildWarning` above only hides the residual
      // log noise.
      //
      // Dev-only workaround, not a fix: it papers over a pnpm-hoist and
      // Vite resolution mismatch rather than resolving it.
      exclude: [
        'remark-gfm',
        'remark-emoji',
        'remark-mdc',
        'remark-rehype',
        'rehype-raw',
        'parse5',
        'unist-util-visit',
        'unified',
        'debug',
        'extend',
      ],
    },
    build: {
      // Pure overhead for a docs site: every chunk would ship a .map
      // sidecar, and Tailwind v4's Vite plugin and the
      // module-preload-polyfill emit inaccurate maps anyway.
      sourcemap: false,
      // The @vue/repl Monaco preset bundles Monaco and the Vue/TS
      // language services into one chunk of roughly 5.4 MB minified. The
      // default 500 KB threshold flags it every build with nothing to act
      // on: the chunk already loads dynamically behind the `.client.vue`
      // `<DemoReplEditor>`, so it never blocks first paint, and splitting
      // it further would mean forking @vue/repl. 6 MB still catches an
      // unrelated chunk growing past Monaco.
      chunkSizeWarningLimit: 6000,
    },
  },
  hooks: {
    // Strip the Shiki/Twoslash transformers from public runtimeConfig
    // before Nitro's serializer runs. @nuxt/content copies the whole
    // `content.build.markdown.highlight` block into
    // `runtimeConfig.public.mdc` for client-side MDC rendering, but the
    // Twoslash transformer carries function callbacks that do not survive
    // JSON serialization, and the build warns about each. Harmless to
    // remove: build-time markdown parsing reads transformers from
    // `nuxt.options.content`, and the callbacks only run during
    // prerender.
    'nitro:config'(nitroConfig) {
      const mdc = (nitroConfig.runtimeConfig as { public?: { mdc?: unknown } } | undefined)?.public
        ?.mdc as { highlight?: { transformers?: unknown[] } } | undefined
      if (mdc?.highlight?.transformers) {
        delete mdc.highlight.transformers
      }

      // Let the REPL type bundles under `.repl-cache/` ship in the static
      // output. `@nuxt/schema` puts `**/*.d.{cts,mts,ts}` in the default
      // `ignore` array, assuming declaration files are not for the
      // browser, and Nitro applies it to every publicAssets globby pass,
      // stripping them from `.output/public/lib/types/`. Without them
      // Volar 404s on its declaration fetches through @vue/repl's
      // `pkgFileTextUrl` callback and intellisense degrades to `any` in
      // production.
      //
      // Only Nitro's copy is filtered. Nuxt's component and layout
      // scanners read `nuxt.options.ignore` directly, so they go on
      // skipping ambient `.d.ts` files outside the publicAssets pipeline.
      const declRe = /\bd\.\{?(cts|mts|ts|c|m)/
      if (Array.isArray(nitroConfig.ignore)) {
        nitroConfig.ignore = nitroConfig.ignore.filter(
          (p): p is string => typeof p === 'string' && !declRe.test(p)
        )
      }
    },
    // Wrap Vite's logger to filter the warning families documented at the
    // top of this file. Nuxt's vite-builder installs its own
    // `customLogger` forwarding to Consola, and a user-supplied
    // `vite.customLogger` is clobbered during the config merge, so the
    // only reliable seam is `vite:configResolved`, where Nuxt's logger is
    // already on the resolved config. Fires once per Vite build, client
    // and server, and wraps both.
    'vite:configResolved'(config) {
      const lg = (config as { customLogger?: Logger }).customLogger
      if (!lg) return
      const origWarn = lg.warn.bind(lg)
      const origWarnOnce = lg.warnOnce.bind(lg)
      lg.warn = (msg: string, opts?: LogOptions) => {
        if (isFilteredBuildWarning(msg)) return
        origWarn(msg, opts)
      }
      lg.warnOnce = (msg: string, opts?: LogOptions) => {
        if (isFilteredBuildWarning(msg)) return
        origWarnOnce(msg, opts)
      }
    },
  },
  css: ['@shikijs/twoslash/style-rich.css', '~/assets/css/tailwind.css'],
})
