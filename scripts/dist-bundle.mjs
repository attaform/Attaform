/**
 * Shared `dist/` freshness guard for the gates that typecheck against
 * the published `.d.mts` surface: `check:bundled-types`,
 * `check:doc-snippets`, `check:tarball`.
 *
 * Each of those carried its own copy of a `distIsRealBundle()` check
 * that rebuilt only when `dist/` was MISSING or was an `unbuild --stub`
 * shim. Neither test says anything about whether the build matches the
 * source it was built from, so editing `src/runtime/types/*` and then
 * running `pnpm check:bundled-types` typechecked the fixtures against
 * the PREVIOUS build and reported ok. A green gate that validated an
 * artifact nobody is about to publish is worse than a red one, and
 * these three are the only gates standing between a public type change
 * and a consumer, so they are exactly where a stale read costs the
 * most.
 *
 * `check:bundled-types` and `check:doc-snippets` also live outside
 * `pnpm check` (see the pre-push gates note), which means they are
 * usually run by hand, right after the edit, which is the moment
 * `dist/` is guaranteed to be behind.
 *
 * Staleness is the newest mtime under `src/` (plus the two files that
 * decide what a build emits) against the sentinel `.d.mts`. Mtimes are
 * coarse: a `git checkout` rewrites them without changing content, so
 * this errs toward an unnecessary rebuild. That is the right direction
 * for a gate, since the cost is one `pnpm prepack` and the alternative
 * is a false pass.
 */
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const distDir = resolve(repoRoot, 'dist')

/**
 * `dist/zod-v4.d.mts` stands in for the whole build: unbuild writes it
 * on every run, so its mtime is the build's timestamp, and its first
 * bytes distinguish a real bundle from a stub.
 */
const sentinelDts = resolve(distDir, 'zod-v4.d.mts')

/** Everything whose change should invalidate a build. */
const sources = ['src', 'build.config.ts', 'package.json']

function newestMtimeMs(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const entry of readdirSync(path)) {
    const child = newestMtimeMs(join(path, entry))
    if (child > newest) newest = child
  }
  return newest
}

/** Why the build cannot be trusted, or `null` when it can. */
function staleReason() {
  let head
  try {
    head = readFileSync(sentinelDts, 'utf8').slice(0, 256)
  } catch {
    return 'is missing'
  }
  // `unbuild --stub` writes `export * from "/app/src/..."` (absolute
  // source paths). A real bundle imports from `./shared/...` chunks.
  if (head.includes('/src/')) return 'is a --stub shim'

  const builtAt = statSync(sentinelDts).mtimeMs
  for (const source of sources) {
    if (newestMtimeMs(resolve(repoRoot, source)) > builtAt) {
      return `is older than ${source}/`.replace('.ts/', '.ts').replace('.json/', '.json')
    }
  }
  return null
}

/**
 * Build `dist/` when it is missing, stubbed, or behind `src/`. `label`
 * is the calling gate's log prefix, so the rebuild reads as that gate's
 * own step.
 */
export function ensureFreshDist(label) {
  const reason = staleReason()
  if (reason === null) return
  console.log(`[${label}] dist/ ${reason}, building a real bundle first`)
  execSync('pnpm prepack', { stdio: 'inherit', cwd: repoRoot })
}
