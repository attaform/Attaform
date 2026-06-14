import { beforeEach } from 'vitest'

/**
 * Global vitest setup. Loaded by `setupFiles` in vitest.config.ts.
 *
 * Note on `localStorage` / `sessionStorage`: Node 25 ships native
 * `localStorage` on by default. Without `--localstorage-file=<path>`,
 * the global lands as a non-functional shell, and jsdom does not
 * forcibly re-install its own Storage afterward, so unqualified
 * `localStorage` reads in tests hit Node's shell instead of jsdom's
 * real Storage. The package.json vitest scripts route through
 * `scripts/run-with-webstorage-flag.mjs`, which appends
 * `--no-experimental-webstorage` to NODE_OPTIONS only on Node 22+
 * (the version that added the flag to NODE_OPTIONS' allowlist;
 * Node 20 rejects it and crashes before any test code runs).
 * No polyfill is needed here as a result.
 */

// Reset `window.location` to the jsdom default before each test so
// wizard history tests can't leak `?step=<key>` into the next test's
// initial-seed read. The default `http://localhost:3000/` matches
// jsdom's origin so `history.replaceState` won't trip a SecurityError.
beforeEach(() => {
  if (typeof window !== 'undefined') {
    try {
      window.history.replaceState(null, '', 'http://localhost:3000/')
    } catch {
      // jsdom origin policy may reject in unusual configs; the local
      // beforeEach in wizard tests handles their cases explicitly.
    }
  }
})
