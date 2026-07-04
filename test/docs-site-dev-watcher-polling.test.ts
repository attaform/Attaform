import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Docs-site config regression check: Vite's file watcher must use
 * polling so src/ edits during `make up` actually propagate to HMR
 * + SSR.
 *
 * The dev experience runs inside Docker with the monorepo
 * bind-mounted at `/app`. macOS host fsevents don't always
 * propagate through Docker's mount layer to the Linux container,
 * so chokidar's native watcher (Vite's default) misses edits to
 * `/app/src/**` after the dev server starts. Two consequences:
 *
 *   1. HMR never fires for src/ edits. The in-memory Vite
 *      transform graph stays frozen at whatever `src/runtime/**`
 *      looked like when Nuxt booted.
 *
 *   2. SSR keeps reusing those frozen transforms. Server-rendered
 *      pages ship stale form state into hydration; the client
 *      preserves it. Hard-reload doesn't help — the dev server
 *      itself is the staleness source.
 *
 * The silent-failure mode is the worst part: the playground at
 * `/play/<slug>` (which uses `.repl-cache/attaform.js`, rebuilt by
 * `bundle-repl-deps.mjs --watch` via esbuild's bind-mount-reliable
 * watcher) reflects the latest src/ instantly, while the inline
 * `<DocsDemo>` at `/docs/...` stays frozen. Two parallel watchers,
 * one working, one not; the divergence is invisible until a src/
 * edit fails to land in a Vite-resolved consumer.
 *
 * `vite.server.watch.usePolling: true` switches chokidar to a poll
 * loop; the docs-site config sets that plus a `300 ms` interval
 * for binary and non-binary alike. This test pins both. A
 * contributor removing the block fails this test before they
 * reintroduce the silent-staleness window.
 */

describe('docs-site config: Vite watcher polling for Docker bind-mount reliability', () => {
  const configPath = fileURLToPath(new URL('../apps/site/nuxt.config.ts', import.meta.url))
  const source = readFileSync(configPath, 'utf8')

  it('vite.server.watch enables polling', () => {
    expect(source).toMatch(/watch:\s*\{[\s\S]{0,200}usePolling:\s*true/)
  })

  it('vite.server.watch sets a poll interval', () => {
    expect(source).toMatch(/interval:\s*\d+/)
    expect(source).toMatch(/binaryInterval:\s*\d+/)
  })
})

/**
 * @nuxt/content runs its OWN chokidar source watcher over `docs/`, separate
 * from Vite's above. It passes no `usePolling` and exposes no config knob, so
 * across the Docker bind mount it misses docs/ adds + edits and keeps serving
 * a stale SQLite DB until the dev server restarts (a new page 404s, an edit
 * doesn't hot-reload). chokidar 5 reads `CHOKIDAR_USEPOLLING` as a global
 * override that reaches content's watcher regardless of dependency depth; the
 * docs-dev container sets it plus a matching interval. This pins both so a
 * contributor dropping them fails before reintroducing the staleness window.
 */
describe('docs-site config: @nuxt/content watcher polling for Docker bind-mount reliability', () => {
  const composePath = fileURLToPath(new URL('../docker-compose.yml', import.meta.url))
  const compose = readFileSync(composePath, 'utf8')

  it('the dev container forces chokidar polling', () => {
    expect(compose).toMatch(/CHOKIDAR_USEPOLLING:\s*'?(?:true|1)'?/)
  })

  it('the dev container sets a chokidar poll interval', () => {
    expect(compose).toMatch(/CHOKIDAR_INTERVAL:\s*'?\d+'?/)
  })
})
