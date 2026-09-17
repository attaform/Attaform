/**
 * `attaform/directive`, the `v-register` directive and its app-level
 * installer, kept a standalone entry so the form core does not carry
 * the directive's DOM machinery for apps that never render it.
 *
 * Most consumers never import it. Vite and Nuxt apps get `v-register`
 * bound at compile time by the `attaform/vite` plugin or the
 * `attaform/nuxt` module. Everyone else, meaning webpack-family
 * bundlers, no-build and CDN pages, and runtime-compiled templates,
 * installs it once per app:
 *
 * ```ts
 * import { installVRegister } from 'attaform/directive'
 * installVRegister(app)
 * ```
 *
 * The directive objects themselves, `vRegister` and the file-input
 * variant `vRegisterFile` it dispatches to, are exported for advanced
 * integrations: a `<script setup>` local binding, a manual
 * `withDirectives` render function, or registration under a different
 * name.
 *
 * When no delivery ran, the miss shows up as Vue's own dev warning,
 * `Failed to resolve directive: register`.
 */

export { installVRegister, vRegister } from './runtime/core/directive'
export { vRegisterFile } from './runtime/core/directive-file'
