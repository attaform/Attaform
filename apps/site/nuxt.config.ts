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
// `zod-v3` is an npm-aliased package — pnpm installs zod@3.x under
// the directory name `zod-v3` (see root package.json:
// `"zod-v3": "npm:zod@^3.24"`). The aliased path resolves to its
// own package.json, whose version field is the v3.x release.
import zodV3Pkg from 'zod-v3/package.json'

// Compute the on-disk path to the monorepo root (two levels up from
// `apps/site`). Used to broaden Vite's `server.fs.allow` so the
// dev server can stream files from the workspace's hoisted
// `node_modules/.pnpm/...` tree (see the `vite.server.fs.allow`
// block below for the full rationale).
const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Replace Vite's `vite:asset-import-meta-url` plugin filter with a
// linear-time substring check. The built-in filter shape (verified at
// `vite@7.3.3/dist/node/chunks/config.js:27704`) is:
//
//   transform: {
//     filter: {
//       id: { exclude: [...] },
//       code: /new\s+URL.+import\.meta\.url/s
//     }
//   }
//
// The `.+` between `new\s+URL` and `import\.meta\.url`, combined with
// the `s` (dotAll) flag, catastrophic-backtracks on dense minified
// content >5 MB. V8's regex engine blows its internal stack and
// throws `Maximum call stack size exceeded` from `pattern.test`.
// Concrete trip-wire: `@vue/repl/monaco-editor`'s 7.2 MB prebundle,
// surfacing as an `Internal server error` on the first `/play/<slug>`
// page load. Captured via filter-trace instrumentation as
// `[filter-trace] THREW plugin=vite:asset-import-meta-url`.
//
// The handler does its own precise position-aware matching inside via
// a more specific regex (`assetImportMetaUrlRE`), so the filter only
// needs to gate the broad "could this contain such a pattern" check.
// Replacing the regex with the literal string `'import.meta.url'`
// triggers `String.prototype.includes` (linear-time, no backtracking)
// in Vite's `patternToCodeFilter`. Files that have `import.meta.url`
// but not `new URL(...)` will reach the handler, do their own regex
// match, find nothing, and return undefined — a no-op transform that
// costs O(file-length) per occurrence but never overflows.
//
// Caching note: Vite caches filters per plugin in a WeakMap keyed by
// the plugin object identity, built lazily on first transform call.
// Mutating `plugin.transform.filter.code` at `configResolved` time
// happens before any transform fires, so Vite reads the patched
// filter on first cache fill. `enforce: 'post'` ensures this runs
// after all upstream plugins have been resolved into the config.
//
// An upstream fix to Vite's regex would benefit every consumer with
// a megabyte-class dep in their graph; this local patch is the
// version that lands today.
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

// `pages/play/[slug].vue`, `pages/play/index.vue`, and
// `components/content/DocsDemo.vue` each discover every demo SFC
// via `import.meta.glob('../../docs-demos/*.vue', { eager: true })`.
// The glob's key set is resolved once at module-eval time. When a
// new SFC lands inside `docs-demos/` after a consumer module has
// already compiled, Vite's default invalidation is best-effort: the
// file watcher fires, but the consumer's transform cache does not
// always rerun before the next SSR render. The symptom is a 404
// from `/play/<new-slug>` (the play routes) or an in-page
// `[DocsDemo] no demo found for slug "..."` throw (the inline
// embed used in docs pages).
//
// This plugin watches `apps/site/docs-demos/` for `add` and `unlink`
// events. On either, it invalidates every glob consumer in the
// dev server's module graph and broadcasts a full reload, so the
// next render sees the fresh glob keys. Modify events are left
// alone — they invalidate the touched SFC via Vite's normal HMR
// path, which the consumer module already proxies.
const invalidateDemoGlobConsumersOnDemoChange: VitePlugin = {
  name: 'attaform:invalidate-demo-glob-consumers-on-demo-change',
  apply: 'serve',
  configureServer(server) {
    const siteRoot = dirname(fileURLToPath(import.meta.url))
    const demosDir = resolve(siteRoot, 'docs-demos')
    const globConsumers = [
      resolve(siteRoot, 'pages/play/[slug].vue'),
      resolve(siteRoot, 'pages/play/index.vue'),
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

// Two warning families fire on every build, are not ours to fix,
// and add nothing actionable for a maintainer reading the logs:
//
//   1. "Sourcemap is likely to be incorrect: a plugin (…) was used
//      to transform files, but didn't generate a sourcemap for the
//      transformation."
//      — Tailwind v4's vite plugin and Nuxt's module-preload-polyfill
//      transform without emitting sourcemaps. Rollup walks the chain
//      and warns ~17×/build that the resulting maps would be lossy.
//      We've disabled sourcemap output anyway (vite.build.sourcemap
//      = false), so the maps don't ship — the warnings are stale.
//
//   2. "new URL(\"assets/(editor|vue).worker-…\", import.meta.url)
//      doesn't exist at build time, it will remain unchanged to be
//      resolved at runtime."
//      — @vue/repl's Monaco preset constructs its worker URLs via
//      dynamic strings; Vite's static analyser can't resolve them
//      and warns. That warning is exactly the trigger condition for
//      the Worker-constructor Proxy in DemoReplEditor.client.vue,
//      which intercepts the runtime resolution and reroutes to
//      /lib/repl-workers/* (the static copies bundle:repl emits).
//      Filtered narrowly to the editor + vue worker filenames; any
//      other "URL doesn't exist at build time" warning still surfaces.
//
//   3. "Unresolvable optimizeDeps.include entries: @nuxtjs/mdc > …"
//      — @nuxtjs/mdc (pulled in transitively by @nuxt/content) declares
//      its own remark/rehype/unified sub-deps in its Vite optimizeDeps
//      manifest. Under pnpm's strict hoist, those sub-deps live deep
//      in the workspace store; Vite's resolver (rooted at apps/site)
//      can't reach them via the `parent > child` traversal because
//      @nuxtjs/mdc itself isn't surfaced at apps/site/node_modules.
//      The warning is harmless — Nuxt's own machinery re-resolves the
//      deps through @nuxt/content's pipeline at module-load time —
//      and listing the entries explicitly in our config doesn't help
//      (they'd just add their own unresolvable copies). Filtered
//      narrowly to the @nuxtjs/mdc prefix.
//
//   4. "Payload extraction is recommended for full-static output. You can
//      enable it by setting experimental.payloadExtraction to true or
//      'client'."
//      — Fires during `nuxi dev` because we INTENTIONALLY disable payload
//      extraction in development to dodge the ENOTDIR Nitro cache collision
//      documented in the `experimental:` block below. The warning is correct
//      for production (we DO want payload extraction in static output), but
//      our `experimental.payloadExtraction` gate already does the right thing
//      based on NODE_ENV — the warning fires in dev anyway because Nitro
//      reads `nitro.static: true` and assumes the warning applies regardless
//      of mode. Filter narrowly to the exact string so any unrelated payload
//      warning still surfaces.
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
// further down doesn't catch this — vite-builder constructs a fresh
// Vite logger AND also calls into the kit Consola directly for the
// optimize-deps callback, so we need both layers.
{
  const origWarn = nuxtKitLogger.warn.bind(nuxtKitLogger)
  nuxtKitLogger.warn = ((...args: unknown[]) => {
    const head = args[0]
    if (typeof head === 'string' && isFilteredBuildWarning(head)) return
    return origWarn(...(args as [unknown, ...unknown[]]))
  }) as typeof nuxtKitLogger.warn
}

// `console.warn` self-healing guard. Background: under Nuxt 4.4 +
// Vite 7 + consola 3.4, the SSR bundle pass calls
// `Consola.wrapAll() → wrapConsole()`, which writes `console[type] =
// this[type].raw` for every type. For the SSR-targeted consola
// instance, `this.warn.raw` resolves to `undefined` (the .raw
// property is set up only on the rich Node consola, not the
// browser-shimmed one Vite produces when `node:tty` is externalized).
// `console.warn` then becomes `undefined` — and the next time
// Rollup's `defaultPrintLog` tries to surface a warning during
// prerender, it crashes with `TypeError: console.warn is not a
// function`.
//
// The downstream symptom is that `nuxi build` / `nuxi generate` exit
// non-zero on a hidden Rollup warning rather than completing the
// prerender. The fix lives at the boundary where the bug lands:
// reject any non-function assignment to `console.warn` and quietly
// fall back to the original. The override survives the swap but the
// global `console.warn` keeps working, so Rollup's warning printer
// stays alive long enough for prerender to finish.
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
  // `@nuxt/fonts` was here previously to proxy Inter + JetBrains Mono
  // through Google Fonts at dev time and build time. Removing it
  // because that proxy was a single-point-of-failure: an
  // intermittently slow `fonts.gstatic.com` 500'd the dev server
  // (the page renderer can't resolve fonts → Nitro returns 500) and
  // — separately — failed CI on the bad-luck day. The .woff2 files
  // now live committed under `public/fonts/` and are referenced by
  // the @font-face block in `assets/css/fonts.css` (imported by
  // `tailwind.css`). `nuxt-og-image` still pulls Satori fonts from
  // Google at build time, but a build-time failure there is loud
  // and fixable — not a user-facing 500.
  modules: [attaformModule, '@nuxt/content', '@nuxtjs/color-mode', '@nuxtjs/seo'],
  // Source-alias attaform subpath imports for vue-tsc as well, not
  // just Vite and Nitro. Without a tsconfig-level alias, vue-tsc
  // resolves `attaform`, `attaform/zod`, etc. through the package
  // `exports` map to `dist/*.d.mts`. The generated
  // `.nuxt/types/plugins.d.ts` references the runtime plugin via a
  // relative `../../../../src/runtime/plugins/attaform` path (Nuxt
  // resolves the addPlugin src against the workspace), so src also
  // enters the project graph. Result: TWO `pathKeyBrand: unique
  // symbol` declarations — one inside dist's bundled .d.ts, one
  // inside src's paths.ts — and TS treats them as distinct nominal
  // brands. The `v-register` directive's expected payload type
  // (from the merged GlobalDirectives augmentations) ends up
  // checking dist-branded values against src-branded slots, and
  // shipment-demo's checkbox `register('termsAccepted')` calls
  // light up red. Aliasing in tsconfig collapses every consumer
  // import back to src, giving the project a single PathKey
  // identity and matching the runtime aliases below.
  alias: {
    attaform: resolve(monorepoRoot, 'src/index.ts'),
    'attaform/zod': resolve(monorepoRoot, 'src/zod.ts'),
    'attaform/zod-v3': resolve(monorepoRoot, 'src/zod-v3.ts'),
    'attaform/zod-v4': resolve(monorepoRoot, 'src/zod-v4.ts'),
    'attaform/vite': resolve(monorepoRoot, 'src/vite.ts'),
    'attaform/transforms': resolve(monorepoRoot, 'src/transforms.ts'),
  },
  // @nuxtjs/seo is the umbrella that wires sitemap.xml + robots.txt +
  // per-page canonical links + nuxt-og-image (per-route social cards)
  // + nuxt-schema-org (JSON-LD) + nuxt-link-checker behind one module.
  // The auto-generated sitemap walks the prerendered routes set;
  // canonicals + OG meta + structured-data URLs all resolve against
  // `site.url`.
  //
  // Pin to the **www** host — the apex `attaform.com` 301s to
  // `www.attaform.com` at the Vercel layer. Emitting sitemap entries
  // (and canonicals, and og:url) on the apex would mean every URL the
  // crawler hits redirects, wasting crawl budget and signaling
  // duplicate content. The canonical host is www; everything we ship
  // points there directly.
  //
  // `indexable` gates the ENTIRE SEO-discovery surface on a single
  // env flag — same gate the IndexNow ping uses
  // (`scripts/indexnow-ping.mjs`). When `false`:
  //
  //   - `robots.txt` flips to `User-agent: * \n Disallow: /`
  //   - The sitemap.xml route is suppressed
  //   - Every page emits `<meta name="robots" content="noindex, nofollow">`
  //   - Schema.org JSON-LD `url` resolution stays internally consistent
  //     but crawlers honoring the meta tag won't follow.
  //
  // Default posture is `false` — sandboxed branches, preview deploys,
  // local builds, and CI all produce non-indexable output. Only a
  // Vercel **production** deploy (`VERCEL_ENV === 'production'`) flips
  // to `true`. There is intentionally no force-override flag: the
  // production gate is the single source of truth, matching the
  // IndexNow script's posture. If you need to manually test the
  // indexable variant locally, set `VERCEL_ENV=production` explicitly
  // on the `pnpm build` command line.
  //
  // Belt + suspenders: the static output may still be reachable at
  // its deploy URL, but search engines that respect `robots.txt` AND
  // the `noindex` meta tag will skip it. Bing's IndexNow endpoint is
  // never pinged (separate gate in the index:bing script). The
  // attack surface for "sandbox URL appears in Google" collapses to
  // direct backlinks from indexable pages — which production never
  // emits to preview hostnames.
  site: {
    url: 'https://www.attaform.com',
    name: 'Attaform',
    description:
      'A type-safe, schema-driven form library for Vue 3 and Nuxt with first-class Zod support.',
    defaultLocale: 'en',
    indexable: process.env.VERCEL_ENV === 'production',
  },
  // nuxt-og-image renders Vue components to 1200×630 PNGs at build
  // time via Satori. We're on the generic Nitro `static` preset
  // (rather than the platform-specific `vercel-static`) for
  // portability — the resulting `dist/` is servable anywhere. The
  // og-image module reads `nitro.static` (set in the `nitro:` block
  // below) to detect SSG and route to its `nitro-prerender`
  // compatibility profile.
  //
  // `zeroRuntime: true` disables dynamic image generation entirely —
  // every OG image is prerendered at build time, no runtime image
  // generation endpoint is served. Two effects:
  //   1. The "OG image URLs are not signed. Anyone can craft arbitrary
  //      image generation requests" warning goes away. Pure SSG: there
  //      IS no runtime to sign requests against.
  //   2. The static output excludes the dynamic-generation entry, so the
  //      attack surface (request forgery → free CPU on a server we
  //      don't have) collapses to nothing.
  // Setting a NUXT_OG_IMAGE_SECRET would also silence the warning, but
  // we'd be paying for a runtime we don't ship.
  ogImage: { zeroRuntime: true },
  //
  // No `fonts:` block here on purpose. nuxt-og-image v6 dropped
  // that field in favour of reading from `@nuxt/fonts` (now gone
  // in this app — see the `modules:` comment) or falling back to
  // its `fontless` resolver. The fontless resolver fetches font
  // bytes at PREVIEW / BUILD time only, so a Google CDN hiccup
  // there is a build failure (loud, fixable in CI) rather than a
  // user-facing dev-server 500. The OG cards themselves only ever
  // use Inter (see `components/OgImage/Default.satori.vue`), so
  // the resolver narrows to that family at render time.
  // nuxt-link-checker walks every prerendered HTML page and probes
  // each <a> + canonical / og:url for resolvability. With
  // `failOnError: true`, a broken internal link exits the build
  // non-zero — the same gate that `nitro.prerender.failOnError` uses
  // for 500s, applied at the link layer. `fetchRemoteUrls: false`
  // (the default) keeps external URLs out of the loop: an upstream
  // dev tool retiring its domain shouldn't fail our CI. The trade-
  // off is real internal breakage gets caught in CI, while link rot
  // on the wider web stays a manual cleanup task.
  //
  // `strictNuxtContentPaths: true` tells the inspector that our
  // markdown source paths map 1:1 to live URLs (docs/foo.md ↔
  // /docs/foo). That sharpens detection for relative refs inside
  // markdown (a `[label](other-doc.md)` resolves through the same
  // path map @nuxt/content uses, instead of being treated as a raw
  // file fetch).
  linkChecker: {
    failOnError: true,
    strictNuxtContentPaths: true,
  },
  // @nuxt/content's Shiki integration. Pinning the themes and lang
  // set here is intentional — the default theme set is broad and
  // bundles ~50 grammars we don't need; whitelisting brings the
  // build smaller and faster. Light / dark theme pair flips with the
  // `.dark` selector through Shiki's css-variables theme mode.
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
          // Twoslash adds inline TS type information to opt-in code
          // blocks (` ```ts twoslash` or ` ```vue twoslash`). With
          // explicitTrigger true, every other code block renders
          // unchanged — Twoslash only kicks in when a doc page asks
          // for it. `rendererRich()` returns the standard Twoslash
          // popover UI; passing the string `'rich'` (an older API
          // shape) silently breaks at runtime because the transformer
          // expects a renderer object.
          //
          // @ts-expect-error @nuxt/content v3.13's highlight type
          // omits `transformers` even though the runtime forwards
          // the array straight to Shiki, which does accept it. The
          // upstream type fix is tracked at
          // https://github.com/nuxt/content/issues — when @nuxt/content
          // tightens this, drop the directive.
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
  // Webfonts are committed to the repo (no runtime / build-time
  // dependency on Google). The .woff2 binaries live under
  // `public/fonts/` and the @font-face declarations are in
  // `assets/css/fonts.css` (imported by `tailwind.css`). Run
  // `pnpm fonts:refresh` to re-fetch from Google when adding a
  // weight or bumping the font version.
  devtools: { enabled: true },
  compatibilityDate: '2025-01-28',
  // Public runtimeConfig values are read at build time from the actual
  // package.json files and surfaced to the client via
  // useRuntimeConfig(). One source of truth per concern — `pnpm
  // version` is the only place to bump.
  //
  //   - attaformVersion: shown in the homepage release pill and the
  //     footer brand block. Reads from attaform's root package.json.
  //   - replDependencyVersion: pinned on the @vue/repl store's
  //     dependencyVersion so Volar skips the (slow + unpkg-bound)
  //     latest-version lookup. Reads from each package's package.json.
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
  // Payload extraction strategy: ON in build (full-static output
  // benefits from prefetched `_payload.json` per route — SPA-style
  // nav speed at zero runtime cost), OFF in dev.
  //
  // Why dev is excluded: Nitro's `payloadCache` (mounted under
  // `cache:nuxt:payload` with an fs base of `.nuxt/cache/nuxt/payload`)
  // writes one cache entry per rendered route. For the root route `/`,
  // unstorage normalizes the key down to an empty string, which the
  // fs driver writes as a bare `payload` *file* at the cache base —
  // collision with the directory it's supposed to be. Every
  // subsequent route then 500s with `ENOTDIR: ... payload/docs-<hash>`
  // when its payload tries to write to `payload/<safe-key>`.
  // Production prerendering writes `_payload.json` files directly to
  // `.output/public/<route>/` via a different code path that doesn't
  // touch the dev cache, so the static build is unaffected.
  //
  // The detection: `process.env.NODE_ENV` is read at config-eval time.
  // `nuxi dev` runs with `NODE_ENV=development` (Vite dev server), so
  // the gate evaluates to `false`. `nuxi build` doesn't pre-set
  // NODE_ENV — package.json's `build` / `generate` scripts pin it to
  // `production` explicitly so this gate (and any other `NODE_ENV`
  // probes upstream) sees the right value. Without that prefix, Nuxt
  // emits a "Payload extraction is recommended for full-static output"
  // warning at every build.
  experimental: {
    payloadExtraction: process.env.NODE_ENV === 'production',
  },
  // 301 redirects for the pre-rebuild URL tree. The old docs lived
  // under `/docs/api/*` and `/docs/recipes/*`; the new IA splits them
  // by concept (`getting-started`, `reading-the-form`, `validation`,
  // `persistence`, `devtools-and-debugging`, etc.). Specific routes
  // win over wildcards in Nuxt's route specificity, so the catch-all
  // globs land any not-individually-mapped URL on the docs spine.
  //
  // Phase 1 maps only the destinations whose new pages exist. The
  // recipes/* and api/* catch-alls drop readers on /docs/getting-started/introduction
  // — a real page they can read — rather than 404. Phase 2–4 will
  // tighten these to specific per-recipe targets as the per-concept
  // pages land.
  routeRules: {
    // Specific Phase 1 targets.
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
    '/docs/recipes/persistence': {
      redirect: { to: '/docs/persistence/overview', statusCode: 301 },
    },
    // Catch-alls for the pre-rebuild subtrees. Specific routes above
    // win over these globs.
    '/docs/api/**': {
      redirect: { to: '/docs/getting-started/introduction', statusCode: 301 },
    },
    '/docs/recipes/**': {
      redirect: { to: '/docs/getting-started/introduction', statusCode: 301 },
    },
  },
  // Bind to all interfaces so the docker-compose port mapping
  // (3000:3000) reaches the dev server. Local-only dev still works —
  // 0.0.0.0 includes localhost.
  devServer: { host: '0.0.0.0' },
  // The module emits a blocking inline <script> in <head> that resolves
  // the user's preference (localStorage → system → fallback) and sets
  // <html class="…"> before first paint. classSuffix: '' makes the class
  // bare (`.dark` instead of `.dark-mode`), matching our @variant dark
  // selector in tailwind.css.
  colorMode: {
    classSuffix: '',
    preference: 'system',
    fallback: 'light',
    storageKey: 'attaform-color-mode',
  },
  // Mount components/content/ without a path prefix so files in there
  // (e.g. ProseA.vue overriding the default <a> renderer in MDC content)
  // resolve under their bare names — the convention Nuxt Content's
  // prose-override system expects.
  components: [{ path: '~/components/content', pathPrefix: false, global: true }, '~/components'],
  // Nitropack's built-in /_vfs dev handler (powering Nuxt DevTools'
  // Virtual Files panel) hard-checks the request IP against ::1 / 127.*
  // and 403s anything else as "Forbidden IP". In Docker our requests
  // arrive from the bridge IP, so the panel breaks. There's no config
  // knob — register a dev pre-handler on the same /_vfs prefix that
  // shadows socket.remoteAddress to 127.0.0.1 and falls through (no
  // response) to the real VFS handler that runs after it. Dev-only via
  // devHandlers.
  nitro: {
    // Source-alias attaform subpath imports to `src/*.ts` on the
    // server side too. Without this, Nitro (Vue SSR) resolves
    // `attaform/zod` to `dist/zod.mjs` — a `jiti --stub` shim
    // whose top-level `await jiti.import('/app/src/zod.ts')` runs
    // ONCE per process and caches the result. Edits to `src/`
    // after Nitro's startup never propagate to SSR output, so a
    // page rendered server-side ships stale form state into
    // hydration and the client inherits it (even though the
    // client itself has fresh `src/` via the Vite alias below).
    // Observed when `count: unset` against `z.number().default(10)`
    // SSR'd as `10` while the playground (which uses the rebuilt
    // browser bundle) showed `0`. See the matching comment on
    // `vite.resolve.alias` for the browser side and the jiti
    // staleness story.
    //
    // Limited to subpaths actually imported in apps/site (bare
    // `attaform` and `attaform/zod`); the others are listed for
    // symmetry with Vite and to harden against future demo
    // additions that reach for them. Prefix-matching is safe:
    // `attaform/zod` does NOT match `attaform/zod-v3` because the
    // matcher requires `/` or end-of-string after the key.
    alias: {
      attaform: resolve(monorepoRoot, 'src/index.ts'),
      'attaform/zod': resolve(monorepoRoot, 'src/zod.ts'),
      'attaform/zod-v3': resolve(monorepoRoot, 'src/zod-v3.ts'),
      'attaform/zod-v4': resolve(monorepoRoot, 'src/zod-v4.ts'),
      'attaform/vite': resolve(monorepoRoot, 'src/vite.ts'),
      'attaform/transforms': resolve(monorepoRoot, 'src/transforms.ts'),
    },
    // Mount the REPL pipeline's output (`apps/site/.repl-cache/`)
    // at the `/lib/` URL prefix. This keeps the bundled REPL
    // artifacts (runtime JS, worker copies, type declaration
    // bundles, package manifests) out of `apps/site/public/` while
    // continuing to serve them from the same URLs DemoRepl's import
    // map and Volar callbacks expect.
    //
    // Why this matters: the type bundles re-emit `declare global {
    // interface Window { [DEVTOOLS_WINDOW_KEY]?: ... } }` from
    // attaform's runtime sources. Inside `public/`, those bundles
    // landed in vue-tsc's project graph (`include: ["../**/*"]`)
    // and collided with the runtime declaration in
    // `src/runtime/core/devtools-shared.ts` (TS2717 "subsequent
    // property declarations"). The collision only fired locally
    // after a dev session populated the public bundle — CI builds
    // run `typecheck` before `bundle:repl`, so the public-side file
    // didn't exist yet. Moving the artifacts to `.repl-cache/`
    // (outside `apps/site/**/*`) gets vue-tsc out of the picture
    // entirely; Nitro's publicAssets pipeline doesn't apply the
    // Nuxt project-tree ignore filters either, so `.d.ts` files
    // ship straight through to `.output/public/lib/types/` on prod
    // builds.
    publicAssets: [
      {
        dir: resolve(monorepoRoot, 'apps/site/.repl-cache'),
        baseURL: '/lib',
      },
    ],
    // Pure SSG. The `static` preset tells Nitro to emit only
    // prerendered HTML + assets — no serverless runtime, no Node
    // server. Vercel deploys the result as a CDN-only site (zero
    // serverless function quota used). Same effect as `nuxi
    // generate`; declaring it here means `nuxi build`, `nuxi
    // generate`, and Vercel's auto-detected build path all produce
    // the same static output.
    //
    // The Pagefind step (`pnpm index:search` after build) walks
    // `.output/public` for HTML files; without prerendering the
    // directory holds only assets and `_payload.json`, and
    // Pagefind exits with "did not find any html files." With the
    // static preset, every reachable route lands as HTML.
    //
    // `crawlLinks: true` follows internal `<a href>` and NuxtLink
    // targets from the seed routes, so we only have to list the
    // entry points. `/docs` is the index page that links into every
    // doc; `/play` and `/` round out the rest of the public
    // surface.
    //
    // `failOnError: true` gates the build on prerender 500s — a Vue
    // mustache leaking through a markdown code fence and binding to
    // an undefined variable (see the post-mortem on the {{{ payload }}}
    // ssr-hydration bug), an unhandled rejection inside an async
    // setup, that class of bug. It does NOT fail the build on
    // prerender 404s — `createError({ statusCode: 404 })` and
    // `setResponseStatus(404)` both log a fatal-error line and let
    // the prerender keep going. That's deliberate; 404 catching is
    // nuxt-link-checker's job (see the `linkChecker:` block earlier
    // in this file, where `failOnError: true` makes a single broken
    // internal link exit the build non-zero). Together they cover
    // both edge classes — 500s gated here, missing-target links
    // gated by the checker.
    preset: 'static',
    // `static: true` is the SSG flag a few modules read to detect
    // "this build emits HTML at prerender time, no runtime server."
    // nuxt-og-image specifically uses it (its `resolveOgImagePreset`
    // returns `'nitro-prerender'` for `nitro.static`), which puts it
    // on a known preset and silences the "Unknown Nitro preset
    // 'static'" warning. Setting `preset: 'static'` alone doesn't
    // flip this flag — Nitro's `static` preset and the `static`
    // boolean are sibling concerns rather than one-implies-the-other.
    static: true,
    prerender: {
      crawlLinks: true,
      routes: ['/', '/docs', '/play'],
      failOnError: true,
    },
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
    ],
    // Source-resolve the workspace `attaform` package for the docs
    // site's Vite environments. Without these aliases, every
    // `import { useForm } from 'attaform/zod'` (and every other
    // `attaform/*` subpath) resolves via the package's `exports`
    // map to `dist/zod.mjs` — which, under the monorepo's
    // `pnpm dev:prepare` flow, is an `unbuild --stub` jiti shim:
    //
    //   import { createJiti } from "../node_modules/.pnpm/jiti@2.6.1/.../jiti.mjs"
    //   const jiti = createJiti(import.meta.url, { … })
    //   const _module = await jiti.import("/app/src/zod.ts")
    //   export const useForm = _module.useForm
    //   …
    //
    // The shim works in Node (where jiti's `node:module` /
    // `createRequire` runtime is real) but fails in the browser
    // at the very first import: Vite serves the relative-path
    // `lib/jiti.mjs`, runs its CJS-to-ESM lexer over webpack-bundled
    // `dist/jiti.cjs`, and the missing `default` export trips a
    // `SyntaxError` that propagates up through `MDCRenderer`'s
    // `await resolveContentComponents(...)` — visible as every
    // docs-page nav after the homepage hard-crashing client-side.
    //
    // Aliasing each subpath to the corresponding `src/*.ts` file
    // routes the docs-demos and every other `attaform/*` consumer
    // through Vite + @vitejs/plugin-vue's normal TS compilation
    // path. No jiti hop, no CJS-to-ESM analyzer in the loop, and
    // live-reload works exactly the same — Vite already watches
    // `src/` because it's inside the dev server's `fs.allow` root.
    //
    // SSR-runtime caveats:
    //
    //   - `attaform/nuxt` is consumed by Nuxt's `modules:` array,
    //     which Nuxt evaluates with its OWN jiti process before
    //     Vite ever boots. That path loads `dist/nuxt.mjs` directly
    //     via jiti at module-init time, which is fine because the
    //     module's setup work runs once and doesn't span post-edit
    //     boundaries.
    //
    //   - Nitro's Vue SSR side is a different story: it resolves
    //     `attaform/zod` for every page render, and the dist/jiti
    //     hop caches per process. Edits to `src/` after Nitro
    //     boots NEVER reach those imports. That's why the parallel
    //     `nitro.alias` block above mirrors these entries on the
    //     server side; without it, the inline `<DocsDemo>` SSR
    //     ships stale form state while the client-only playground
    //     (which uses the freshly bundled `/lib/attaform.js`) shows
    //     the current behavior. The two aliases together keep
    //     browser and server in lockstep on src/.
    //
    //   - `attaform/devtools-panel` resolves to a `.vue` file
    //     via the package exports' `"default"` condition. The
    //     consumer site never imports it from a `.ts` / `.vue`
    //     file; the Nuxt DevTools overlay loads it directly. No
    //     alias needed.
    //
    //   - `attaform/types` is types-only (no `import` condition
    //     in the export map). Aliasing it would be a no-op at
    //     runtime, so skip it.
    resolve: {
      alias: [
        { find: /^attaform$/, replacement: resolve(monorepoRoot, 'src/index.ts') },
        { find: /^attaform\/zod$/, replacement: resolve(monorepoRoot, 'src/zod.ts') },
        { find: /^attaform\/zod-v3$/, replacement: resolve(monorepoRoot, 'src/zod-v3.ts') },
        { find: /^attaform\/zod-v4$/, replacement: resolve(monorepoRoot, 'src/zod-v4.ts') },
        { find: /^attaform\/vite$/, replacement: resolve(monorepoRoot, 'src/vite.ts') },
        { find: /^attaform\/transforms$/, replacement: resolve(monorepoRoot, 'src/transforms.ts') },
      ],
    },
    // Mirror Nuxt's devServer.host into Vite's server.host so
    // @vitejs/devtools (which reads viteDevServer.config.server.host
    // directly when picking its WebSocket bind) lands on 0.0.0.0
    // instead of localhost. Without this, devtools' RPC server binds
    // to ::1 inside the container and the docker port forward can't
    // reach it. Nuxt's typing of `vite.server` Omits `host` (it
    // expects you to use the top-level `devServer.host`), but Vite
    // itself accepts the value and devtools needs it set on Vite's
    // own config, so we suppress the type error.
    server: {
      // @ts-expect-error Nuxt's `vite.server` type Omits `host`; the
      // runtime accepts it (see comment above for why devtools needs
      // this set on Vite's own config).
      host: '0.0.0.0',
      // Vite's strict `fs.allow` defaults to the workspace root, but
      // requests to `/@fs/app/node_modules/.pnpm/...` for modules in
      // `optimizeDeps.exclude` arrive BEFORE the importer is analyzed
      // — so the target file never lands in `config.safeModulePaths`
      // via the import-analysis pass, and `fs.allow` is the only gate
      // that lets the static-serve middleware emit the file. The
      // symptom is a 404 on `@vue/repl/monaco-editor` (7.2 MB) on
      // first page load while smaller siblings in the same directory
      // (already-analyzed) serve cleanly. Explicitly listing the
      // monorepo root (two levels up from `apps/site`) here makes the
      // allowance unambiguous and survives any Vite-detected-root
      // drift across pnpm-workspace layouts.
      fs: {
        allow: [monorepoRoot],
      },
      // Force chokidar to poll for file changes inside the Docker
      // bind mount. macOS host fsevents don't always propagate
      // through Docker's mount layer to the Linux container, so
      // chokidar's native watcher misses edits to monorepo-root
      // paths (anywhere under `/app/src/**`) AFTER the dev server
      // starts. Native works for the apps/site project root (Vite's
      // own scan boots that watcher with the bind mount's first
      // pass), but src/ edits silently no-op: HMR never fires, the
      // in-memory Vite transform graph stays frozen at boot, and
      // SSR keeps reusing whatever `src/runtime/**` looked like
      // when Nuxt started.
      //
      // The symptom: edit `src/runtime/core/unset-walker.ts`, hard-
      // reload `/docs/schemas/defaults`, see no change. The
      // playground at `/play/schema-defaults` updates because
      // `bundle-repl-deps.mjs --watch` uses esbuild's watcher,
      // which IS bind-mount-reliable. Two parallel watchers, one
      // working, one not — invisible until a src/ edit fails to
      // land in a Vite-resolved consumer.
      //
      // `usePolling: true` switches chokidar to a poll loop. The
      // poll interval below (300 ms) is the conventional Docker
      // setting — fast enough that HMR feels instant, slow enough
      // to keep CPU quiet on a busy laptop. `binaryInterval`
      // governs binary-file polling separately; we set it equal to
      // `interval` so dist/* tarball-like artifacts (jiti shims,
      // .repl-cache bundles) invalidate at the same cadence as the
      // .ts/.vue sources they're built from.
      watch: {
        usePolling: true,
        interval: 300,
        binaryInterval: 300,
      },
    },
    // Vite's startup crawl scans index.html + statically discoverable
    // imports; it misses imports inside `.client.vue` components (which
    // SSR skips) and inside Nuxt's lazy page chunks. When those land
    // mid-session, Vite re-bundles and broadcasts an "Outdated Optimize
    // Dep" 504 to in-flight requests — visible as the once-per-cold-
    // boot vue-router 504 that breaks the first navigation. Pre-
    // declaring the heavy site-only deps here makes the boot crawl
    // comprehensive, so first-paint requests resolve cleanly.
    optimizeDeps: {
      // Hold every dev-server request until the dep crawl finishes
      // its FULL scan — both the static pre-bundle pass and the
      // runtime-discovery follow-up. Without this gate, Vite's
      // default behavior is to start serving as soon as the static
      // scan completes, then quietly re-bundle when new deps surface
      // mid-session (e.g. a `.client.vue` file's imports that SSR
      // skipped, a dynamic `import('shiki')` inside a deeply-nested
      // component). Every re-bundle rotates `browserHash`, deletes
      // the previous prebundle files, and 404s any in-flight asset
      // fetch keyed to the old hash — visible as the "monaco-editor.js?v=<old>"
      // 404 cascade documented in `make up`'s comment block.
      //
      // `holdUntilCrawlEnd: true` makes the boot deterministic at
      // the cost of a slower cold start (the first request waits
      // for the crawl to settle). The trade-off is exactly what we
      // want in dev: race-free serves over fast first-paint. Vite
      // 5.1 introduced this option; defaults vary by version and
      // by the dev-server environment shape, so pinning it
      // explicitly is the only way to guarantee the race window
      // closes regardless of upstream changes.
      holdUntilCrawlEnd: true,
      // `@vue/repl` + `@vue/repl/monaco-editor` are prebundled together
      // so Vite's boot crawl finds them even though the editor wrapper
      // itself only mounts inside a `.client.vue` component (which the
      // SSR scan skips). Without pre-declaring, the first `/play/<slug>`
      // navigation discovers the deps mid-session, the optimizer
      // rebundles, the browser hash flips, and any in-flight
      // prebundled-dep request 504s with "Outdated Optimize Dep".
      //
      // Pinning both into one prebundle batch keeps a single vue
      // identity across the editor wrapper, the Monaco preset, and the
      // docs site itself — `EditorContainer.provide(propsKey, …)` and
      // `MonacoEditor.inject(propsKey)` need referentially-equal
      // InjectionKey symbols across module boundaries.
      //
      // The 7.2 MB minified Monaco preset previously blew V8's regex
      // stack inside Vite's built-in `vite:asset-import-meta-url`
      // plugin filter (`/new\s+URL.+import\.meta\.url/s`). The
      // `fixViteAssetImportMetaUrlFilter` plugin declared above
      // replaces that regex with a linear-time string check at
      // `configResolved` time, so any megabyte-class prebundle stays
      // safe through Vite's filter pass. The original Vite intent
      // (gate the handler on files that could contain
      // `new URL(..., import.meta.url)`) is preserved — the handler
      // still does precise matching internally.
      include: [
        'lucide-vue-next',
        '@vue/repl',
        '@vue/repl/monaco-editor',
        // Discovered at runtime via `<DocsDemo>`'s dynamic `import('shiki')`
        // for SSR-side code highlighting, and via the Zod-typed demo SFCs
        // that ship through the docs-demos/*.vue glob.
        'shiki',
        'zod',
        // `zod-v3` is npm-aliased to `zod@3.x` (see root package.json's
        // `"zod-v3": "npm:zod@^3.24"`). It surfaces in the docs-site
        // dep graph because `apps/site` aliases `attaform/zod` to the
        // workspace `src/zod.ts`, whose unified adapter
        // (`src/runtime/adapters/unified/use-form.ts`) statically
        // imports both the v3 and v4 adapters so its runtime-dispatch
        // can pick the right shape per schema. Without `zod-v3` in
        // this list, Vite's boot crawl misses it; the first docs-demo
        // mount discovers the dep mid-session, the optimizer rebundles,
        // the browser hash flips, and any in-flight prebundled-dep
        // request (e.g. shiki.js) 504s with "Outdated Optimize Dep".
        // Pre-declaring it keeps the boot crawl comprehensive.
        'zod-v3',
        // `lodash-es` is a transitive of one of the @nuxtjs/seo
        // sub-modules (the schema-org or sitemap chain). Same
        // motivation: pre-declaring it here means the boot crawl
        // catches it once, so a mid-session discovery doesn't
        // re-trigger an Outdated-Optimize-Dep rebundle.
        'lodash-es',
      ],
      // The remark/rehype/unified cluster is excluded for a different
      // reason: @nuxtjs/mdc (transitive via @nuxt/content) pushes these
      // specifiers into Vite's `optimizeDeps.include` list via its own
      // module manifest, but under pnpm's strict hoist they don't
      // surface at apps/site/node_modules and Vite can't resolve them
      // through the `parent > child` traversal. On a cold container
      // (`make up` after `docker compose down` clears Vite's dep
      // cache), the scanner re-enters resolution on every unresolvable
      // entry and stack-overflows the plugin pipeline on the first
      // transform request — visible as `Internal server error: Maximum
      // call stack size exceeded` from `EnvironmentPluginContainer.transform`.
      // Listing them as `exclude` short-circuits the scanner and tells
      // Vite "Nuxt's machinery already resolves these at module-load
      // time, don't pre-bundle them." The warning filter in
      // `isFilteredBuildWarning` (top of this file) suppresses the
      // residual log noise; this `exclude` block prevents the actual
      // overflow on cold start.
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
      // Production sourcemaps are pure overhead for a docs site —
      // every chunk would ship a .map sidecar, and several plugins
      // in the build chain (Tailwind v4's vite plugin, the
      // module-preload-polyfill) don't emit accurate maps anyway.
      sourcemap: false,
      // The @vue/repl Monaco preset bundles Monaco + the Vue/TS
      // language services into one chunk weighing ~5.4 MB minified
      // (~1.3 MB gzipped). Vite's default 500 KB threshold flags it
      // every build with no actionable remediation — the chunk is
      // already dynamically loaded behind `<DemoReplEditor>` (a
      // `.client.vue` component) so it never blocks first paint, and
      // splitting it further isn't possible without forking
      // @vue/repl. Bumping the threshold to 6000 (6 MB) silences
      // the existing warning while still catching any unrelated
      // chunk that grows past Monaco's size.
      chunkSizeWarningLimit: 6000,
    },
  },
  hooks: {
    // Strip the Shiki/Twoslash transformers from public runtimeConfig
    // before Nitro's serializer runs. @nuxt/content copies the whole
    // `content.build.markdown.highlight` block into
    // `runtimeConfig.public.mdc` so client-side MDC rendering can
    // read it — but the Twoslash transformer carries function
    // callbacks (`preprocess`, `tokens`, `pre`, `code`) that don't
    // survive JSON serialization, producing "may not be able to be
    // serialized" warnings during build. Build-time markdown parsing
    // reads transformers directly from `nuxt.options.content` (not
    // from runtimeConfig), so removing them here is harmless — the
    // functions only run during prerender anyway.
    'nitro:config'(nitroConfig) {
      const mdc = (nitroConfig.runtimeConfig as { public?: { mdc?: unknown } } | undefined)?.public
        ?.mdc as { highlight?: { transformers?: unknown[] } } | undefined
      if (mdc?.highlight?.transformers) {
        delete mdc.highlight.transformers
      }

      // Allow `.d.ts` / `.d.cts` / `.d.mts` files in the REPL
      // publicAssets directory (`.repl-cache/`, mounted at `/lib/`)
      // to ship in the static output. Nuxt's `@nuxt/schema` ships
      // `**/*.d.{cts,mts,ts}` in the default `ignore` array on the
      // assumption that declaration files aren't meant for the
      // browser; Nitro inherits this and applies it to every
      // publicAssets globby pass, stripping our REPL type bundles
      // from `.output/public/lib/types/`. Without those files, Volar
      // (via @vue/repl's `pkgFileTextUrl` callback) 404s on
      // `attaform`/`attaform/zod`/`vue`/`zod` declaration fetches
      // and intellisense degrades to "any" in production.
      //
      // We strip the .d.ts ignore pattern from Nitro's options only.
      // Nuxt's own component / layout scanners read from
      // `nuxt.options.ignore` directly (not `nitroConfig.ignore`),
      // so their behaviour is unaffected — they keep skipping
      // ambient `.d.ts` files outside the publicAssets pipeline
      // exactly as before.
      const declRe = /\bd\.\{?(cts|mts|ts|c|m)/
      if (Array.isArray(nitroConfig.ignore)) {
        nitroConfig.ignore = nitroConfig.ignore.filter(
          (p): p is string => typeof p === 'string' && !declRe.test(p)
        )
      }
    },
    // Wrap Vite's logger to filter the two warning families documented
    // at the top of the file. Nuxt's vite-builder installs its own
    // `customLogger` (which forwards to Consola); user-supplied
    // `vite.customLogger` gets clobbered during the Nuxt config
    // merge. By the time `vite:configResolved` fires, Nuxt's logger
    // is on the resolved config as `customLogger` — wrap its `warn` /
    // `warnOnce` in place so every Vite-emitted warning passes
    // through our filter before reaching Consola. Fires twice (once
    // per Vite build: client + server); both loggers get wrapped.
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
