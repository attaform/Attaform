import { defineNuxtConfig, type DefineNuxtConfig } from 'nuxt/config'

// Deliberately NO source aliases, unlike every other fixture: this one
// exists to exercise the PUBLISHED resolution path. `node_modules/
// attaform` is a committed symlink to the repo root, so every attaform
// specifier here resolves through the real package.json exports map —
// `attaform/nuxt` to the built module, and in dev the app's runtime
// imports through the `development` condition to the dist/dev flavor.
// The e2e test that boots this fixture skips itself while dist/ holds
// `unbuild --stub` shims.
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
}) as DefineNuxtConfig
