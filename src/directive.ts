/**
 * `attaform/directive` — the `v-register` directive and its app-level
 * installer, as a standalone entry so the form core doesn't carry the
 * directive's DOM machinery for apps that never render it.
 *
 * Most consumers never import this entry:
 *
 * - Vite and Nuxt apps get `v-register` bound at compile time by the
 *   `attaform/vite` plugin / `attaform/nuxt` module.
 * - Everyone else — webpack-family bundlers, no-build / CDN pages,
 *   runtime-compiled templates — installs it once per app:
 *
 *   ```ts
 *   import { installVRegister } from 'attaform/directive'
 *   installVRegister(app)
 *   ```
 *
 * The directive objects themselves (`vRegister`, and the file-input
 * variant `vRegisterFile` it dispatches to) are exported for advanced
 * integrations: a `<script setup>` local binding, manual
 * `withDirectives` render functions, or a hand-rolled registration
 * under a different name.
 *
 * The miss signal when no delivery ran is Vue's own dev warning,
 * `Failed to resolve directive: register`.
 */

export { installVRegister, vRegister } from './runtime/core/directive'
export { vRegisterFile } from './runtime/core/directive-file'
