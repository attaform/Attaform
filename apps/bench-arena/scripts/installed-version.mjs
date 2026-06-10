/**
 * Read an installed package's version WITHOUT going through its `exports` map.
 *
 * Several cohort packages deliberately omit `./package.json` from `exports`
 * (so `require('<pkg>/package.json')` throws ERR_PACKAGE_PATH_NOT_EXPORTED),
 * and ESM-only packages such as @formisch/vue cannot be `require.resolve`d
 * from a CJS context at all. Reading the package's own package.json straight
 * off disk, following pnpm's node_modules symlink, sidesteps both: it works
 * uniformly across the entire cohort.
 *
 * Used by run-arena.mjs (the provenance block's resolved `libVersions`) and
 * measure-bundles.mjs (the per-entry version label), so every reported number
 * carries the exact version the lockfile pinned and the harness measured.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/installed-version.mjs -> scripts/ -> package root.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Resolved version string for one installed package (throws if absent). */
export function readInstalledVersion(name) {
  const pkgPath = join(PACKAGE_ROOT, 'node_modules', name, 'package.json')
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version
}

/** Map of name -> resolved version for a list of packages. */
export function readInstalledVersions(names) {
  const out = {}
  for (const name of names) out[name] = readInstalledVersion(name)
  return out
}
