/**
 * `attaform/rspack` — Rspack plugin that rewrites `attaform/zod` imports
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
 * This plugin only does the adapter rewrite. The Vue SFC `v-register`
 * transforms that `attaform/vite` wires (load-bearing for SSR initial
 * render) are `@vitejs/plugin-vue`-specific and do not transfer; a
 * non-Vite consumer that needs them wires `attaform/transforms` into
 * their Vue compiler separately. The `v-register` directive itself is
 * also delivered by the Vite plugin's compile-time binding, so outside
 * that pipeline register it once per app:
 *
 *   import { installVRegister } from 'attaform/directive'
 *   installVRegister(app)
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

export function attaform(options: AttaformRspackPluginOptions = {}): AttaformRspackPlugin {
  return createWebpackFamilyPlugin('attaform/rspack', options)
}
