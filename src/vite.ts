/**
 * `attaform/vite` — Vite plugin that wires the compile-time node
 * transforms with @vitejs/plugin-vue, binds `v-register` into each
 * compiled template that uses it (so no app-level directive
 * registration exists or is needed), AND rewrites `attaform` and
 * `attaform/zod` imports to either `attaform/zod-v3` or `attaform/zod-v4`
 * at build time, based on the consumer's installed Zod major. The result
 * is one Zod adapter shipped per bundle, with no manual subpath choice.
 *
 * Usage (bare Vue 3 consumers):
 *
 *   // vite.config.ts
 *   import vue from '@vitejs/plugin-vue'
 *   import { attaform } from 'attaform/vite'
 *
 *   export default defineConfig({
 *     plugins: [vue(), attaform()],
 *   })
 *
 * The transforms inject `:value`, `:checked`, and `:selected` bindings
 * into elements that use the `v-register` directive — load-bearing for
 * SSR initial-render correctness. Omitting this plugin under CSR is
 * tolerable (one-frame flash on mount); omitting it under SSR produces
 * visibly wrong initial HTML.
 *
 * The `resolveZodAlias` option (default `true`) controls the build-time
 * rewrite of `attaform` / `attaform/zod`. Set to `false` if your project
 * intentionally mixes Zod versions or has a non-standard Zod resolution;
 * the unified entry's runtime dispatch covers that case at the cost of
 * bundling both adapters.
 *
 * Implementation note: this plugin mutates @vitejs/plugin-vue's options
 * via the documented but somewhat informal `api.options` surface used
 * by VueUse, Vite PWA, and other Vue ecosystem plugins. If you're
 * using a custom Vue plugin wrapper, fall back to `attaform/transforms`
 * and wire them yourself.
 */
import type { Plugin } from 'vite'
import { isRewritableZodSpecifier, resolveZodAliasTarget } from './core/detect-zod-major'
import { componentBridgeTransform } from './runtime/lib/core/transforms/component-bridge-transform'
import { rewriteDirectiveDelivery } from './runtime/lib/core/transforms/directive-delivery-transform'
import { inputTextAreaNodeTransform } from './runtime/lib/core/transforms/input-text-area-transform'
import { redundantBindingWarnTransform } from './runtime/lib/core/transforms/redundant-binding-warn-transform'
import { vRegisterHintTransform } from './runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from './runtime/lib/core/transforms/v-register-preamble-transform'
import { transformSsrAccessed } from './runtime/lib/core/transforms/ssr-accessed-transform'

/** Options for `attaform()`. */
export interface AttaformVitePluginOptions {
  /**
   * Rewrite `attaform` and `attaform/zod` imports at build time to
   * either `attaform/zod-v3` or `attaform/zod-v4`, based on the
   * consumer's installed Zod major. Default `true` — produces a leaner
   * bundle for the common case of one Zod version per project.
   *
   * Set to `false` to fall through to the unified entry's runtime
   * dispatch. Useful when:
   *   - your project intentionally has both `zod` and `zod-v3`
   *     installed (e.g. via a pnpm alias) and the schema-shape
   *     dispatch is the right behavior;
   *   - your monorepo's Zod resolution is non-standard and the
   *     plugin's detection (`import.meta.resolve('zod/package.json')`)
   *     would land on the wrong copy.
   */
  resolveZodAlias?: boolean
}

interface VitePluginVueApi {
  options?: {
    template?: {
      compilerOptions?: {
        nodeTransforms?: unknown[]
      }
    }
  }
}

/**
 * Vite plugin that wires the form library's compile-time template
 * transforms into `@vitejs/plugin-vue`, binds the `v-register`
 * directive into each compiled template that uses it, and rewrites the
 * bare `attaform` barrel and the unified `attaform/zod` import to the
 * matching adapter subpath. Required for SSR and for hydration
 * accuracy under bare Vue 3.
 *
 * ```ts
 * // vite.config.ts
 * import vue from '@vitejs/plugin-vue'
 * import { attaform } from 'attaform/vite'
 *
 * export default defineConfig({
 *   plugins: [vue(), attaform()],
 * })
 * ```
 *
 * Place the call after `vue()` in the plugins array. Nuxt projects
 * don't need this — `attaform/nuxt` handles it.
 *
 * Returns a two-plugin array (Vite flattens nested plugin arrays): the
 * main pre-plugin above, plus a post-plugin that rewrites each compiled
 * SFC's `resolveDirective("register")` to a static import from
 * `attaform/directive`. The rewrite is why no app-level directive
 * registration exists or is needed here — see
 * `runtime/lib/core/transforms/directive-delivery-transform.ts` for the
 * mechanism and its scope.
 */
export function attaform(options: AttaformVitePluginOptions = {}): Plugin[] {
  const resolveZodAlias = options.resolveZodAlias !== false
  // Resolution is computed once per plugin instance from the resolved
  // Vite root in `configResolved`, then cached for every `resolveId`
  // call (the hook fires many times during dev/build).
  let aliasTarget: string | null = null
  const warnState = { warned: false }

  const main: Plugin = {
    name: 'attaform',
    enforce: 'pre',
    configResolved(resolved) {
      const vuePlugin = resolved.plugins.find((p) => p.name === 'vite:vue')
      // Two distinct failure modes — separate error messages so the
      // consumer's fix is unambiguous:
      //   1. plugin not in the plugins array → install + register vue()
      //   2. plugin found but version-incompatible (no `api.options`) →
      //      version mismatch with @vitejs/plugin-vue
      if (vuePlugin === undefined) {
        throw new Error(
          '[attaform/vite] @vitejs/plugin-vue is not installed (or not registered before attaform()). ' +
            'Install @vitejs/plugin-vue and place `attaform()` after `vue()` in your plugins array.'
        )
      }
      const api = (vuePlugin as unknown as { api?: VitePluginVueApi }).api
      if (api?.options === undefined) {
        throw new Error(
          '[attaform/vite] Found @vitejs/plugin-vue but it does not expose `api.options`. ' +
            'This usually means a version-incompatible @vitejs/plugin-vue (or a wrapper plugin re-exporting it). ' +
            'Pin @vitejs/plugin-vue to a version compatible with the documented `api.options.template.compilerOptions.nodeTransforms` surface.'
        )
      }
      api.options.template ??= {}
      api.options.template.compilerOptions ??= {}
      const existing = api.options.template.compilerOptions.nodeTransforms ?? []
      // Idempotent install: if a previous attaform() invocation
      // (vite + nuxt module + manual `plugins: [attaform()]`) has
      // already pushed our transforms, skip — re-pushing would double
      // every binding the AST emits, breaking the IIFE-wrapping
      // invariants downstream transforms depend on. We detect the
      // sentinel via reference equality; user-supplied transforms with
      // the same name don't collide.
      if (!existing.includes(vRegisterPreambleTransform as unknown)) {
        // Two ordering constraints:
        //   1. redundantBindingWarnTransform MUST come before
        //      componentBridgeTransform and inputTextAreaNodeTransform. It
        //      reads the author's props to warn about a redundant :value /
        //      :checked / :selected beside v-register; those two transforms
        //      strip and re-inject that channel, so anything after them sees
        //      the injected props, not what the author wrote.
        //   2. vRegisterPreambleTransform MUST come before
        //      vRegisterHintTransform — the preamble's pre-order captures each
        //      `v-register` expression in its raw (un-wrapped) form, and the
        //      hint then mutates the same directive's `exp` to wrap it.
        //      Reversing the order would have the preamble pick up an
        //      already-wrapped IIFE, double-wrapping it when injected at the
        //      root.
        api.options.template.compilerOptions.nodeTransforms = [
          ...existing,
          redundantBindingWarnTransform,
          componentBridgeTransform,
          inputTextAreaNodeTransform,
          vRegisterPreambleTransform,
          vRegisterHintTransform,
        ]
      }

      // Build-time alias resolution, shared with the other bundler
      // plugins. Returns null (leave the unified runtime-dispatch entry
      // in place) when the consumer opted out or the Zod version can't be
      // classified (warned once via `warnState`), and throws only when
      // zod isn't installed at all.
      aliasTarget = resolveZodAliasTarget(
        resolved.root,
        'attaform/vite',
        resolveZodAlias,
        warnState
      )
    },
    configureServer(server) {
      // Dev-only middleware that serves the Nuxt DevTools overlay panel's
      // iframe HTML at `/_attaform_devtools`. The middleware lives at the
      // Vite layer so the route is intercepted BEFORE vue-router sees it —
      // crucial for consumers using `app.vue`-only (no `pages/` directory).
      // Earlier prototypes injected a Nuxt page via `extendPages`, which
      // implicitly activates Nuxt's pages mode and broke app.vue-only
      // setups by stranding `/` without a NuxtPage host.
      //
      // The HTML pulls Vue + the panel component via bare specifiers;
      // `transformIndexHtml` rewrites them through Vite's resolver so the
      // browser-side `<script type="module">` runs cleanly. Production
      // builds skip the middleware entirely — `configureServer` only
      // fires for the dev server.
      server.middlewares.use(
        '/_attaform_devtools',
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        async (req, res, next) => {
          if (req.method !== 'GET') {
            next()
            return
          }
          // Brand mark served at `/_attaform_devtools/icon.svg` and
          // referenced by the module's `addCustomTab({ icon })`. Data:
          // URIs render unreliably across Nuxt DevTools versions; a real
          // URL is the robust path.
          if (req.url === '/icon.svg') {
            const svg =
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
              `<rect width="24" height="24" rx="5" fill="#6938ef"/>` +
              `<g fill="none" stroke="#ffffff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">` +
              `<path d="M8 16 L12 8 L16 16"/>` +
              `<path d="M9.5 13 L14.5 13"/>` +
              `</g></svg>`
            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
            res.setHeader('Cache-Control', 'public, max-age=3600')
            res.end(svg)
            return
          }
          try {
            const rawHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Attaform DevTools</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0f172a; }
      @media (prefers-color-scheme: light) {
        html, body { background: #ffffff; }
      }
      #atf-loading {
        padding: 1rem;
        color: #94a3b8;
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div id="atf-app"><div id="atf-loading">Loading Attaform DevTools…</div></div>
    <script type="module">
      import { createApp, h } from 'vue'
      import AttaformDevtoolsPanel from 'attaform/devtools-panel'

      // The panel runs inside Nuxt DevTools' overlay iframe, which itself
      // is nested in the consumer's main page. \`window.parent\` only
      // crosses one frame boundary — the overlay UI — which doesn't have
      // the bridge attached. The bridge lives on the consumer's main
      // page, which sits at the top of the frame hierarchy. Walk the
      // chain checking each ancestor frame so the same code works whether
      // the panel is opened in 0, 1, or 2+ iframe layers deep.
      //
      // Same-origin assumption holds (everything served from the dev
      // server's origin) so cross-frame property access doesn't throw.
      // If a future Nuxt DevTools build sandboxes the overlay iframe,
      // the try/catch falls through to the empty-bridge path with a
      // clear "not found" message.
      function findBridge() {
        let frame = window
        for (let depth = 0; depth < 10; depth++) {
          try {
            const candidate = frame.__attaform_devtools__
            if (candidate !== undefined) return candidate
          } catch {
            return undefined
          }
          if (frame.parent === frame) return undefined
          frame = frame.parent
        }
        return undefined
      }

      const start = Date.now()
      function bootstrap() {
        const bridge = findBridge()
        if (bridge !== undefined) {
          const root = document.getElementById('atf-app')
          root.innerHTML = ''
          createApp({ render: () => h(AttaformDevtoolsPanel, { bridge }) }).mount(root)
          return
        }
        if (Date.now() - start < 2000) {
          setTimeout(bootstrap, 50)
          return
        }
        document.getElementById('atf-loading').textContent =
          'Attaform devtools bridge not found. The host app may not have the Nuxt module installed.'
      }
      bootstrap()
    </script>
  </body>
</html>`
            const html = await server.transformIndexHtml('/_attaform_devtools', rawHtml)
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(html)
          } catch (err) {
            next(err)
          }
        }
      )
    },
    async resolveId(source, importer) {
      // Intercept the bare `attaform` barrel AND the explicit
      // `attaform/zod` — both carry the runtime dispatcher, so both
      // collapse to the one detected adapter. The pinned subpaths
      // (`attaform/zod-v3`, `attaform/zod-v4`) pass through unchanged:
      // that's the documented escape hatch for power users who want a
      // specific adapter regardless of what's installed.
      if (!resolveZodAlias) return null
      if (aliasTarget === null) return null
      if (!isRewritableZodSpecifier(source)) return null
      // Returning the bare specifier directly would freeze it as the
      // resolved id — Vite then ships `/@id/attaform/zod-v4` to the
      // browser and 404s because no plugin loads that virtual URL.
      // Re-run the new specifier through the resolver chain so the
      // matching subpath export lands as a real file path.
      // `skipSelf: true` is defensive — our filter rejects the rewritten
      // target anyway, but keeps the hook reentrant under future edits.
      return this.resolve(aliasTarget, importer, { skipSelf: true })
    },
    transform(code, id) {
      // SFC pre-pass: when a `<script setup>` binds `useForm` or
      // `injectForm` and the surrounding `<template>` references that
      // binding, inject `__ssrAccessed: true` into the call's options
      // bag. The runtime registry uses the flag to enqueue the form
      // on the SSR prefetch queue before `onServerPrefetch` fires.
      // Runs ahead of `@vitejs/plugin-vue` thanks to `enforce: 'pre'`
      // so its rewrites are part of the source the Vue plugin sees.
      return transformSsrAccessed(code, id)
    },
  }

  // Second plugin, post-ordered so it sees @vitejs/plugin-vue's COMPILED
  // module output (the main plugin's `enforce: 'pre'` transform sees raw
  // SFC source, where no `resolveDirective` call exists yet). Applies to
  // both the client and SSR module graphs, which is what keeps the two
  // render paths on one directive object.
  const delivery: Plugin = {
    name: 'attaform:directive-delivery',
    enforce: 'post',
    transform(code, id) {
      const rewritten = rewriteDirectiveDelivery(code, id)
      // `map: null` is Rollup's documented "no code moved" contract: the
      // rewrite pads in place and appends at end-of-file, so original
      // positions all survive and upstream sourcemaps stay valid.
      return rewritten === null ? null : { code: rewritten, map: null }
    },
  }

  return [main, delivery]
}

/**
 * Attaform's auto-import manifest, re-exported for plain-Vite projects
 * that drive auto-imports with `unplugin-auto-import`. A Vite consumer
 * already reaches for `attaform/vite` to register this plugin, so the
 * preset rides along on the same entry, with no second Attaform import
 * path to remember.
 *
 * `unplugin-auto-import`'s `imports` array takes an imports-map keyed by
 * module, which is exactly `attaformAutoImportsMap`:
 *
 * ```ts
 * // vite.config.ts
 * import AutoImport from 'unplugin-auto-import/vite'
 * import vue from '@vitejs/plugin-vue'
 * import { attaform, attaformAutoImportsMap } from 'attaform/vite'
 *
 * export default defineConfig({
 *   plugins: [
 *     AutoImport({ imports: ['vue', attaformAutoImportsMap] }),
 *     vue(),
 *     attaform(),
 *   ],
 * })
 * ```
 *
 * The flat `attaformAutoImports` (`{ name, from }[]`) is exported too for
 * tooling that wants the raw list, e.g. Nuxt's `addImports` shape. Nuxt
 * users need neither: `attaform/nuxt` registers the same manifest.
 */
export { attaformAutoImports, attaformAutoImportsMap } from './runtime/auto-imports'
export type { AttaformAutoImport } from './runtime/auto-imports'
