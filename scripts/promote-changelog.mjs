#!/usr/bin/env node
/**
 * Promote the CHANGELOG's `## Unreleased` block to the version npm is
 * about to tag. Runs from the `version` npm hook: `pnpm version X` bumps
 * package.json first, fires this script, then commits and tags. Adding
 * CHANGELOG.md to the working tree here means it rides along on the
 * version commit rather than drifting behind the tag.
 *
 * With no `## Unreleased` block the file is left untouched, since the
 * release machinery should not fail a publish over a changelog that has
 * already been hand-promoted.
 *
 * An EMPTY block is the opposite case and fails the release. Promoting the
 * placeholder is silent and looks like success, so it kept happening: 17
 * released versions carry `_No unreleased changes yet._` as their entire
 * entry, v0.30.0 and v0.13.0 among them, both of which shipped breaking
 * changes the README promises are documented here. A release with nothing
 * to say can say so, by writing that sentence itself; what it cannot do is
 * inherit it from the placeholder by accident.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
const changelogPath = resolve(repoRoot, 'CHANGELOG.md')
const content = readFileSync(changelogPath, 'utf8')

const unreleased = /^## Unreleased\s*$/m
if (!unreleased.test(content)) {
  console.error(
    `[promote-changelog] no "## Unreleased" header in CHANGELOG.md, skipping (version=${pkg.version})`
  )
  process.exit(0)
}

const PLACEHOLDER = '_No unreleased changes yet._'

// The block runs from the `## Unreleased` heading to the next `## ` one.
const body = content
  .slice(content.search(unreleased))
  .replace(/^## Unreleased[^\n]*\n/, '')
  .split(/^## /m)[0]
  .trim()
if (body === '' || body === PLACEHOLDER) {
  console.error(
    `[promote-changelog] the "## Unreleased" block is still empty, so v${pkg.version} ` +
      'would ship with no changelog entry. Write what this release changes, or write ' +
      '"_No consumer-facing changes._" to say so deliberately.'
  )
  process.exit(1)
}

// Replace `## Unreleased` with `## v<version>` AND seed a fresh
// placeholder for the next cycle. The placeholder makes it obvious at
// a glance that the release cycle has reset, and the guard above is what
// stops that same sentence becoming a release's entire entry.
const replacement = `## Unreleased\n\n${PLACEHOLDER}\n\n## v${pkg.version}`
const updated = content.replace(unreleased, replacement)
writeFileSync(changelogPath, updated)
console.log(`[promote-changelog] promoted "## Unreleased" → "## v${pkg.version}"`)
