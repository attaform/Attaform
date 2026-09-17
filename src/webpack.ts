/**
 * `attaform/webpack` — webpack plugin that rewrites `attaform/zod`
 * imports to the single matching adapter subpath (`attaform/zod-v3` or
 * `attaform/zod-v4`) at build time, based on the consumer's installed Zod
 * major. Without it, webpack ships both adapters because the unified
 * `attaform/zod` entry imports both for runtime dispatch.
 *
 * Usage (ESM config — the plugin is ESM-only, matching attaform's package):
 *
 *   // webpack.config.mjs
 *   import { attaform } from 'attaform/webpack'
 *
 *   export default {
 *     plugins: [attaform()],
 *   }
 *
 * The adapter rewrite is all this plugin does. Two things
 * `attaform/vite` also provides do NOT transfer, because both are
 * `@vitejs/plugin-vue`-specific: wire `attaform/transforms` into your
 * Vue compiler for the SSR-critical template transforms, and register
 * the directive once per app with `installVRegister(app)` from
 * `attaform/directive`.
 *
 * Zero-dep: the plugin imports nothing from `webpack` (it taps the resolve
 * hook the compiler injects at the consumer's build). Shares its body with
 * `attaform/rspack` via `createWebpackFamilyPlugin`.
 */
import {
  createWebpackFamilyPlugin,
  type WebpackFamilyPlugin,
  type WebpackFamilyPluginOptions,
} from './core/webpack-family-plugin'

/** Options for the webpack `attaform()` plugin. */
export type AttaformWebpackPluginOptions = WebpackFamilyPluginOptions
/** The structural shape webpack requires of the plugin. */
export type AttaformWebpackPlugin = WebpackFamilyPlugin

export function attaform(options: AttaformWebpackPluginOptions = {}): AttaformWebpackPlugin {
  return createWebpackFamilyPlugin('attaform/webpack', options)
}
