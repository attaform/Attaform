import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Component, Plugin } from 'vue'

/** The parts of a vue-router instance these tests drive. */
export type TestRouter = Plugin & {
  push(to: string): Promise<unknown>
  isReady(): Promise<void>
  readonly options: { readonly history: { destroy(): void } }
}

type RouteRecord = { readonly path: string; readonly component: Component }

/** The parts of the vue-router module these tests use. */
export type VueRouterModule = {
  createRouter(options: { history: unknown; routes: ReadonlyArray<RouteRecord> }): TestRouter
  createWebHistory(): unknown
  RouterView: Component
}

function isVueRouterModule(value: unknown): value is VueRouterModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createRouter' in value &&
    typeof value.createRouter === 'function' &&
    'createWebHistory' in value &&
    typeof value.createWebHistory === 'function' &&
    'RouterView' in value
  )
}

/**
 * vue-router as Nuxt installs it. Attaform takes no dependency on
 * vue-router, so these tests load the copy Nuxt, a dev dependency, brings
 * along, resolved from Nuxt's own location.
 */
export async function loadVueRouter(): Promise<VueRouterModule> {
  const fromNuxt = createRequire(createRequire(import.meta.url).resolve('nuxt/package.json'))
  const entry = join(dirname(fromNuxt.resolve('vue-router/package.json')), 'dist/vue-router.js')
  const loaded: unknown = await import(pathToFileURL(entry).href)
  if (!isVueRouterModule(loaded)) throw new Error(`vue-router did not load from ${entry}`)
  return loaded
}
