import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { addImports, addPlugin, addVitePlugin, createResolver, defineNuxtModule } from '@nuxt/kit'
import { attaformAutoImports } from './runtime/auto-imports'
import { attaform as attaformVitePlugin } from './vite'

// Read the published version from the package's own package.json so the
// module's DevTools panel surfaces the live version pill without a
// build-time string injection. `createRequire` reads sync at module
// load, once, so it is free at steady state. Works under unbuild's
// Rollup output
// without bundler-specific JSON-import handling.
const pkgVersion = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version

/**
 * Options accepted by `attaform/nuxt` under the `attaform`
 * config key.
 *
 * ```ts
 * // nuxt.config.ts
 * export default defineNuxtConfig({
 *   modules: ['attaform/nuxt'],
 *   attaform: {
 *     autoImports: false,
 *   },
 * })
 * ```
 */
export interface AttaformModuleOptions {
  /**
   * Forwarded to `attaform/vite`'s `resolveZodAlias` option.
   * Default `true`, so `attaform` and `attaform/zod` imports are
   * rewritten at build time to `attaform/zod-v3` or `attaform/zod-v4`,
   * based
   * on the consumer's installed Zod major. Set to `false` to bypass
   * the rewrite and ship the runtime-dispatch unified entry instead.
   */
  resolveZodAlias?: boolean
  /**
   * Auto-import Attaform's form composables (`useForm`, `useWizard`,
   * `injectForm`, `injectWizard`, `fieldMeta`, `withMeta`, `lazy`,
   * `gate`, `useRegister`) so components can call them without an
   * explicit `import`. Default `true`. The set is declared in
   * Attaform's auto-import manifest and resolves from `attaform/zod`,
   * so the build-time adapter rewrite still ships a single Zod major.
   * Set to `false` to suppress the names entirely and import the
   * composables yourself. Note a Nuxt auto-import already loses to an
   * explicit or local binding of the same name, so opting out is only
   * needed to keep the names out of global scope altogether.
   */
  autoImports?: boolean
}

/**
 * Shape of the Nuxt public runtime-config slot the module populates.
 * Reach it via `useRuntimeConfig().public.attaform` if you need to
 * read the library version outside the form library itself.
 */
export type AttaformRuntimeConfig = {
  /**
   * Library version, read from the package's own `package.json` at
   * module setup. Surfaced to the runtime plugin so the DevTools
   * overlay panel can render a version pill. One source of truth, so it
   * matches the `meta.version` Nuxt DevTools sees in the Modules panel.
   */
  version: string
}

/**
 * Whether `specifier` resolves from either the consumer's project root
 * or Attaform's own module location. True here means Vite will
 * pre-bundle the dep for `optimizeDeps.include` without warning.
 *
 * Two probe locations, because they see different things: the consumer
 * root finds direct deps and their declared peers, while the Attaform
 * module location finds peers Attaform itself declares, notably the
 * optional `@vue/devtools-api`, which lands in Attaform's own tree even
 * when the consumer never references it.
 *
 * It must stay ESM resolution rather than `createRequire(...).resolve`.
 * Attaform's exports map declares only `import` conditions outside
 * `/nuxt`, so CJS resolve hits ERR_PACKAGE_PATH_NOT_EXPORTED; and pnpm
 * strict isolation hides hoisted transitives behind the virtual store,
 * which CJS resolve walks past and ESM resolve follows correctly.
 */
function isResolvableForVite(specifier: string, consumerRootDir: string): boolean {
  const consumerURL = pathToFileURL(join(consumerRootDir, 'package.json')).href
  return canResolve(specifier, consumerURL) || canResolve(specifier, import.meta.url)
}

function canResolve(specifier: string, fromURL: string): boolean {
  try {
    import.meta.resolve(specifier, fromURL)
    return true
  } catch {
    return false
  }
}

export default defineNuxtModule<AttaformModuleOptions>({
  meta: {
    name: 'Attaform',
    configKey: 'attaform',
    version: pkgVersion,
    docs: 'https://attaform.dev/docs',
    compatibility: {
      nuxt: '>=3.0.0',
    },
  },
  defaults: {},
  setup(_options, nuxt) {
    // One Vite plugin instance handles every Vite-surface concern, so a
    // Nuxt build gets exactly the DX a bare-Vite build does.
    addVitePlugin(attaformVitePlugin({ resolveZodAlias: _options.resolveZodAlias !== false }))

    // Publish the module's version to public runtime config so the
    // plugin can read it at install time on both server and client.
    const runtimePublic = nuxt.options.runtimeConfig.public as Record<string, unknown>
    runtimePublic['attaform'] = {
      version: pkgVersion,
    } satisfies AttaformRuntimeConfig

    // Force-include Attaform's own peers, which Vite's startup crawl
    // misses on Nuxt projects: it scans index.html and the statically
    // known entries but does not follow into dynamically routed pages,
    // so a dep imported only from a page chunk is discovered on first
    // request, the optimizer rebundles, and Vite broadcasts a silent
    // full-reload. Consumers experience that as "the page loads, then
    // reloads itself a second later". Vite's own "discovered new
    // dependencies at runtime" warning recommends this remediation.
    //
    // Only deps Attaform owns the relationship with belong here:
    // `@vue/devtools-api` and `zod`. A consumer's own deps are theirs
    // to declare. Each push is gated on the spec resolving, so a
    // consumer without an optional peer sees no boot warning.
    nuxt.options.vite.optimizeDeps ??= {}
    nuxt.options.vite.optimizeDeps.include ??= []
    const include = nuxt.options.vite.optimizeDeps.include
    for (const spec of ['@vue/devtools-api', 'zod']) {
      if (!isResolvableForVite(spec, nuxt.options.rootDir)) continue
      if (!include.includes(spec)) include.push(spec)
    }

    const resolver = createResolver(import.meta.url)

    // The manifest in `./runtime/auto-imports` is the single source of
    // truth, shared with the `attaform/vite` preset re-export.
    //
    // Every entry must keep resolving from `attaform/zod` rather than
    // the bare barrel: the bundler plugin rewrites that exact specifier
    // to the one installed Zod major, so the bundle ships a single
    // adapter instead of the runtime dispatcher. The two surfaces are
    // identical, so this costs nothing. It must also stay a public
    // subpath rather than a relative `./runtime/...` path, since
    // `attaform/zod` maps to a real built artifact and a source path
    // would not.
    //
    // A Nuxt auto-import always loses to an explicit or local binding,
    // so these never shadow a consumer's own `useForm`.
    if (_options.autoImports !== false) {
      addImports(attaformAutoImports)
    }

    // Installs `createAttaform()` on the Vue app and wires the payload
    // serialize/hydrate bridge.
    //
    // It must stay a PHYSICAL file rather than an inline plugin
    // template. A template's `import { createAttaform } from 'attaform'`
    // resolves through the package entry, which under local dev
    // (`unbuild --stub`) is a jiti runtime transpiler whose
    // `node:module` imports Nitro's Rollup build cannot bundle. A
    // physical file lets Nitro follow imports directly.
    //
    // `addPlugin` prepends, and `enforce: 'pre'` in the plugin body
    // says so again at the Nuxt layer, which together guarantee the
    // registry is installed and the SSR payload staged before any
    // `useForm` call runs.
    //
    // Flavor selection matters because this plugin is registered by
    // LITERAL path, outside the exports map, while the published
    // package ships the runtime twice (prod, plus a dev flavor behind
    // the `development` condition). In dev the app's own `attaform/*`
    // imports resolve the dev flavor, so the plugin must point at the
    // dev copy too: a prod plugin path beside dev app imports loads two
    // module graphs with two registries, and `useForm` throws
    // `Registry not found`. The existence probe keeps source and stub
    // contexts on the single-path behavior, since no `dev/` twin exists
    // there.
    const prodPluginSrc = resolver.resolve('./runtime/plugins/attaform')
    const devPluginSrc = resolver.resolve('./dev/runtime/plugins/attaform')
    const devPluginExists = ['.mjs', '.ts'].some((ext) => existsSync(devPluginSrc + ext))
    addPlugin({
      src: nuxt.options.dev && devPluginExists ? devPluginSrc : prodPluginSrc,
    })

    // Dev-only Nuxt DevTools overlay tab, pointing at an iframe that
    // mounts the Attaform inspector. `attaform/vite` serves that URL
    // from a Vite-layer middleware rather than `extendPages`, so the
    // route stays invisible to vue-router and works whether the
    // consumer uses a `pages/` directory or app.vue only.
    //
    // `@nuxt/devtools-kit` is NOT a transitive peer of `@nuxt/kit`; it
    // ships alongside `@nuxt/devtools`. The try/import gives a consumer
    // without Nuxt DevTools a silent no-op rather than an unresolved
    // import, matching the `@vue/devtools-api` wire-up.
    if (nuxt.options.dev) {
      nuxt.hook('ready', async () => {
        try {
          const { addCustomTab } = await import('@nuxt/devtools-kit')
          addCustomTab({
            name: 'attaform',
            title: 'Attaform',
            // Served by the `attaform/vite` middleware, sibling to the
            // panel HTML. A real URL renders reliably across Nuxt
            // DevTools versions where `data:` URIs do not.
            icon: '/_attaform_devtools/icon.svg',
            view: {
              type: 'iframe',
              src: '/_attaform_devtools',
              persistent: true,
            },
          })
        } catch {
          // Nuxt DevTools is not installed here. Attaform still works;
          // only the overlay tab is missing.
        }
      })
    }
  },
})
