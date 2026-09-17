/**
 * `attaform/rspack`, the Rspack plugin that rewrites `attaform/zod`
 * imports
 * to the single matching adapter subpath (`attaform/zod-v3` or
 * `attaform/zod-v4`) at build time, based on the consumer's installed Zod
 * major. Without it, Rspack ships both adapters because the unified
 * `attaform/zod` entry imports both for runtime dispatch.
 *
 * Usage:
 *
 *   // rspack.config.mjs
 *   import { attaform } from 'attaform/rspack'
 *
 *   export default {
 *     plugins: [attaform()],
 *   }
 *
 * Rspack mirrors webpack's plugin API for the resolve hook attaform taps,
 * so this shares its body with `attaform/webpack` via
 * `createWebpackFamilyPlugin`; only the diagnostic tag differs.
 *
 * The adapter rewrite is all this plugin does. Two things
 * `attaform/vite` also provides do NOT transfer, because both are
 * `@vitejs/plugin-vue`-specific: wire `attaform/transforms` into your
 * Vue compiler for the SSR-critical template transforms, and register
 * the directive once per app with `installVRegister(app)` from
 * `attaform/directive`.
 *
 * Zero-dep: the plugin imports nothing from `@rspack/core` (it taps the
 * resolve hook the compiler injects at the consumer's build).
 */
import {
  createWebpackFamilyPlugin,
  type WebpackFamilyPlugin,
  type WebpackFamilyPluginOptions,
} from './core/webpack-family-plugin'

/** Options for the Rspack `attaform()` plugin. */
export type AttaformRspackPluginOptions = WebpackFamilyPluginOptions
/** The structural shape Rspack requires of the plugin. */
export type AttaformRspackPlugin = WebpackFamilyPlugin

/**
 * Rspack plugin that resolves `attaform/zod` to the one adapter subpath
 * matching the installed Zod major, so the build ships a single adapter
 * instead of both.
 *
 * ```js
 * import { attaform } from 'attaform/rspack'
 *
 * export default { plugins: [attaform()] }
 * ```
 */
export function attaform(options: AttaformRspackPluginOptions = {}): AttaformRspackPlugin {
  return createWebpackFamilyPlugin('attaform/rspack', options)
}
