import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `reference/types.md` opens with "Every public type Attaform exports",
 * so this ties the page to the barrel in both directions. Exporting a
 * type fails here until the page names it, and removing an export fails
 * too, which is the half that keeps the page from accumulating rows for
 * types nobody can import any more.
 *
 * An enumeration is what drifts: `FormStatus` had already gone
 * under-documented once, and a reference that omits a type is how that
 * keeps happening.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PAGE = 'docs/reference/types.md'

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

/** Names re-exported as types from the shared barrel. */
function exportedTypeNames(): string[] {
  const source = read('src/runtime/_shared-exports.ts')
  const names = new Set<string>()
  for (const block of source.matchAll(/export type \{([^}]*)\}/g)) {
    for (const entry of (block[1] ?? '').split(',')) {
      const name = entry.trim().replace(/ as .*/, '')
      if (name.length > 0) names.add(name)
    }
  }
  return [...names]
}

/** Backticked identifiers on the page, with any generic arguments dropped. */
function namedOnPage(): Set<string> {
  return new Set(
    [...read(PAGE).matchAll(/`([A-Za-z][A-Za-z0-9]*)(?:<[^`]*>)?`/g)].map((m) => m[1] ?? '')
  )
}

describe('the public type surface vs the reference that enumerates it', () => {
  it('names every exported type', () => {
    const exported = exportedTypeNames()
    expect(exported.length, 'the barrel went empty; the regex or the file moved').toBeGreaterThan(
      50
    )
    const documented = namedOnPage()
    expect(exported.filter((name) => !documented.has(name)).sort()).toEqual([])
  })
})
