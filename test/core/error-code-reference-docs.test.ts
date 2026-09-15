import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'

/**
 * `reference/errors.md` publishes `AttaformErrorCode` as a table and tells
 * readers to branch on `code` rather than on message strings. It listed
 * six of nine. The three it omitted were `atta:user-error` (on every
 * `setErrors` entry), `atta:submit-error` (a thrown `onSubmit`), and
 * `atta:gate-not-cleared` (an unsubmitted wizard gate) — which is to say,
 * the three a consumer template is most likely to want.
 *
 * `error-code-pages.test.ts` does this job for the `AF##` throw codes and
 * their `docs/e/` pages. This is the same tie for the `atta:` validation
 * codes and the one table that enumerates them.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PAGE = 'docs/reference/errors.md'

describe('AttaformErrorCode vs the reference table that enumerates it', () => {
  it('the table has a row for every code, with its constant name', () => {
    const page = readFileSync(`${REPO_ROOT}${PAGE}`, 'utf8')
    const rows = new Map<string, string>()
    for (const match of page.matchAll(
      /^\| `(atta:[a-z-]+)`\s*\| `AttaformErrorCode\.([A-Za-z]+)`/gm
    )) {
      rows.set(match[1] ?? '', match[2] ?? '')
    }
    const expected = new Map(
      Object.entries(AttaformErrorCode).map(([name, value]) => [value, name])
    )
    expect(Object.fromEntries([...rows].sort())).toEqual(Object.fromEntries([...expected].sort()))
  })
})
