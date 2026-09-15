import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * `llms.txt` and `llms-full.txt` are what an agent is handed instead
 * of the site, and both pages described them as carrying "every
 * documentation page". The generator excludes two directories, so the
 * dump held 84 of the 100 pages on disk. The 16 missing are the whole
 * `AF##` error-code registry plus the scorecard, and the registry is
 * exactly what an agent needs when it is handed a production console
 * line like `[attaform] AF10 attaform.dev/e/af10`.
 *
 * The exclusion is reasonable (those pages are not served under
 * `/docs`). Describing it as "every documentation page" was not. This
 * ties the generator's exclusions to the prose that scopes them.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const GENERATOR = 'apps/site/scripts/generate-llms.mjs'
const PAGES = ['docs/ai-tooling/llms-txt.md', 'docs/ai-tooling/llms-full-txt.md']

function excludedDirs(): string[] {
  const source = readFileSync(join(REPO_ROOT, GENERATOR), 'utf8')
  const literal = /const EXCLUDED_DIRS = new Set\(\[([^\]]*)\]\)/.exec(source)
  expect(literal, 'EXCLUDED_DIRS moved or was renamed').not.toBeNull()
  return [...(literal?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '').sort()
}

describe('the llms artifacts vs the pages that scope them', () => {
  it('excludes the directories the pages account for', () => {
    // Changing this set changes what an agent can see. Both pages say
    // the artifacts carry every page under `/docs` and name the
    // error-code registry as the exception; a new entry here needs
    // that prose revisited, not just this list updated.
    expect(excludedDirs()).toEqual(['e', 'scorecard'])
  })

  for (const page of PAGES) {
    it(`${page} scopes its claim and points at the registry it omits`, () => {
      const text = readFileSync(join(REPO_ROOT, page), 'utf8')
      expect(
        /every (documentation|Attaform documentation) page/i.test(text),
        'the artifacts do not carry every documentation page; say which ones'
      ).toBe(false)
      expect(text, 'a reader with an AF## code needs somewhere to go').toContain('/e/af')
    })
  }
})
