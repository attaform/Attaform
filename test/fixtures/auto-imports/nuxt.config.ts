import { fileURLToPath } from 'node:url'
import { defineNuxtConfig, type DefineNuxtConfig } from 'nuxt/config'
import MyModule from '../../../src/nuxt'

// The module auto-imports the form composables from `attaform/zod`.
// Resolve that subpath to source (exactly as apps/site does in dev) so
// the e2e build is deterministic and never picks up the `unbuild --stub`
// jiti shim that lives in dist during development. See project memory:
// "unbuild --stub jiti leak".
const zodEntry = fileURLToPath(new URL('../../../src/zod.ts', import.meta.url))
const attaformAlias = { 'attaform/zod': zodEntry }

export default defineNuxtConfig({
  modules: [MyModule],
  alias: attaformAlias,
}) as DefineNuxtConfig
