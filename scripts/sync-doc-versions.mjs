#!/usr/bin/env node
/**
 * Stamp the current package.json version into the raw docs that cite it. Runs from
 * the `version` npm hook (after `pnpm version X` bumps package.json, before the
 * commit), alongside promote-changelog, so the stamped docs ride the version commit
 * instead of drifting behind the tag.
 *
 * The site's homepage and footer read the version from package.json at build time
 * (nuxt.config runtimeConfig). These targets are raw markdown read on GitHub, not
 * rendered by Nuxt Content, so they cannot do that; a release-time stamp is the same
 * idea for a file that is never rendered.
 *
 * Each target names a file and the regex locating its version, whose first capture
 * group is the prefix kept verbatim (only the version after it is overwritten). A
 * target whose marker is absent, or any read/write error, is logged and skipped:
 * a doc may be re-worded, and the release machinery must never block on it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

const targets = [
  {
    file: 'docs/scorecard/cii-best-practices-answers.md',
    pattern: /(current: )\d+\.\d+\.\d+/,
  },
]

for (const { file, pattern } of targets) {
  try {
    const path = resolve(repoRoot, file)
    const content = readFileSync(path, 'utf8')
    if (!pattern.test(content)) {
      console.error(
        `[sync-doc-versions] no version marker in ${file} — skipping (version=${version})`
      )
      continue
    }
    const updated = content.replace(pattern, `$1${version}`)
    if (updated === content) continue
    writeFileSync(path, updated)
    console.log(`[sync-doc-versions] stamped ${file} → ${version}`)
  } catch (error) {
    console.error(`[sync-doc-versions] ${file} skipped: ${error?.message ?? error}`)
  }
}
