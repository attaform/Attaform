import { fileURLToPath } from 'node:url'
import { defineNuxtConfig, type DefineNuxtConfig } from 'nuxt/config'
import MyModule from '../../../src/nuxt'

// The Nuxt module auto-imports the form composables from `attaform/zod`
// (src/runtime/auto-imports). Source-alias that subpath to src so the
// build resolves real TS instead of the `unbuild --stub` jiti shim in
// dist, whose `node:module` / `createRequire` imports leak into the
// browser bundle and fail the Rollup build. Mirrors
// test/fixtures/auto-imports and apps/site. See project memory:
// "unbuild --stub jiti leak".
const zodEntry = fileURLToPath(new URL('../../../src/zod.ts', import.meta.url))
// The module's Vite plugin rewrites each compiled template's v-register
// to an `attaform/directive` import — alias it to src for the same
// stub-shim reason as `attaform/zod` above.
const directiveEntry = fileURLToPath(new URL('../../../src/directive.ts', import.meta.url))

export default defineNuxtConfig({
  modules: [MyModule],
  alias: {
    '@runtime': '../../../src/runtime',
    'attaform/zod': zodEntry,
    'attaform/directive': directiveEntry,
  },
}) as DefineNuxtConfig
