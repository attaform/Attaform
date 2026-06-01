/**
 * Shared build-time Zod-major detection and `attaform/zod` alias
 * resolution for the bundler plugins (`attaform/vite`, `attaform/rollup`,
 * `attaform/esbuild`, `attaform/webpack`, `attaform/rspack`).
 *
 * The unified `attaform/zod` entry runtime-dispatches between the v3 and
 * v4 adapters, so a bundler that does not rewrite the import ships BOTH.
 * Each plugin rewrites `attaform/zod` to the single matching adapter
 * subpath (`attaform/zod-v3` or `attaform/zod-v4`) based on the Zod major
 * resolved from the consumer's project, so the consumer bundle carries
 * one adapter instead of two. This module holds the detection (pure Node,
 * no bundler API) plus the shared diagnostic copy so every plugin behaves
 * and reads identically.
 *
 * Build-time only: imported by the build-tool entries at `src/*.ts`,
 * never by runtime code, so it never reaches a consumer's browser bundle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

export const ZOD_UNIFIED_SPECIFIER = 'attaform/zod'
export const ZOD_V3_SPECIFIER = 'attaform/zod-v3'
export const ZOD_V4_SPECIFIER = 'attaform/zod-v4'

export type ZodMajorDetection =
  | { major: 3 }
  | { major: 4 }
  | { major: 'missing' }
  | { major: 'unknown' }

/**
 * Read the consumer's installed Zod major by resolving
 * `zod/package.json` from their project root. ESM resolution
 * (`import.meta.resolve`) is sync and stable on Node 20.6+, follows
 * pnpm symlinks, and works with attaform's ESM-only `exports` map.
 *
 * Returns:
 *  - `{ major: 3 | 4 }` when zod is resolvable AND its `version`
 *    field parses to a known major;
 *  - `{ major: 'missing' }` when zod can't be resolved at all;
 *  - `{ major: 'unknown' }` for any other failure (corrupted
 *    package.json, unexpected version string, monorepo edge case).
 */
export function detectZodMajor(consumerRootDir: string): ZodMajorDetection {
  const consumerURL = pathToFileURL(join(consumerRootDir, 'package.json')).href
  let resolved: string
  try {
    resolved = import.meta.resolve('zod/package.json', consumerURL)
  } catch {
    return { major: 'missing' }
  }
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(resolved), 'utf8')) as { version?: unknown }
    const version = pkg.version
    if (typeof version !== 'string') return { major: 'unknown' }
    const major = Number.parseInt(version.split('.')[0] ?? '', 10)
    if (major === 3) return { major: 3 }
    if (major === 4) return { major: 4 }
    return { major: 'unknown' }
  } catch {
    return { major: 'unknown' }
  }
}

/**
 * One-shot latch so a plugin warns about an unclassifiable Zod version
 * only once, however many times its detection runs across a build.
 */
export interface ZodDetectionWarnState {
  warned: boolean
}

function missingZodError(tag: string): string {
  return (
    `[${tag}] zod is not installed. attaform requires zod as a peer dependency. ` +
    'Install `zod@^3` or `zod@^4`, OR pass `attaform({ resolveZodAlias: false })` ' +
    'to keep the runtime-dispatch unified entry (and silence this check).'
  )
}

function unclassifiableZodWarning(tag: string): string {
  return (
    `[${tag}] Could not classify the installed Zod major (corrupted package.json, ` +
    'monorepo edge case, or an unexpected version string). Falling through to runtime ' +
    'dispatch — both Zod adapters will ship in the bundle. ' +
    'Pass `attaform({ resolveZodAlias: false })` to silence this warning.'
  )
}

/**
 * Resolve the rewrite target for the unified `attaform/zod` specifier,
 * shared by every bundler plugin so they diagnose identically:
 *   - returns `attaform/zod-v3` / `attaform/zod-v4` when the consumer's
 *     Zod major is detected;
 *   - returns `null` to leave `attaform/zod` on its runtime-dispatch
 *     entry, either because `resolveZodAlias` is off or because the
 *     version could not be classified (warned once via `warnState`);
 *   - throws when zod is not installed at all, a fatal misconfiguration
 *     the consumer must fix.
 *
 * `tag` brands the diagnostics (`attaform/vite`, `attaform/rollup`, etc).
 * `resolveZodAlias` and `warnState` are supplied by the calling plugin:
 * its consumer-facing default and its per-instance warn latch live at the
 * plugin surface, not here.
 */
export function resolveZodAliasTarget(
  consumerRootDir: string,
  tag: string,
  resolveZodAlias: boolean,
  warnState: ZodDetectionWarnState
): string | null {
  if (!resolveZodAlias) return null
  const detection = detectZodMajor(consumerRootDir)
  if (detection.major === 'missing') {
    throw new Error(missingZodError(tag))
  }
  if (detection.major === 'unknown') {
    if (!warnState.warned) {
      warnState.warned = true
      console.warn(unclassifiableZodWarning(tag))
    }
    return null
  }
  return detection.major === 4 ? ZOD_V4_SPECIFIER : ZOD_V3_SPECIFIER
}
