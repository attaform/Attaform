import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The AF## production diagnostics are raw string literals at their
 * call sites (deliberately: the twin literals gzip to nothing and
 * every site stays greppable), so nothing in the type system ties a
 * logged code to a documented one. This suite is that tie. The pages
 * under docs/e/ are the code registry: one af##.md per code, served
 * at attaform.dev/e/af##, the URL every production message embeds.
 *
 * Enforced:
 * 1. Every `[attaform] AF##` literal in src/ is the full documented
 *    shape, uppercase code plus its own lowercase slug, so a message
 *    can never point at another code's page or at a casing the docs
 *    router treats as a 404.
 * 2. Every code logged from src/ has a docs page.
 * 3. Every docs page is emitted by at least one live call site, so
 *    retiring a code is a conscious entry in RETIRED_CODES below,
 *    never silence.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Codes no longer emitted by the runtime. A retired code keeps its
 * docs page forever (older builds in the wild still print it and its
 * URL), it is never reassigned, and it must be listed here the moment
 * its last call site goes away.
 */
const RETIRED_CODES = new Set<string>([])

function walkFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
  }
  return out
}

function documentedCodes(): Set<string> {
  const codes = new Set<string>()
  for (const name of readdirSync(join(REPO_ROOT, 'docs/e'))) {
    expect(name, `unexpected file in docs/e: ${name}`).toMatch(/^af\d{2}\.md$/)
    codes.add(name.slice(0, -'.md'.length).toUpperCase())
  }
  return codes
}

type LoggedCode = { file: string; code: string; slug: string }

function loggedCodes(): LoggedCode[] {
  const out: LoggedCode[] = []
  for (const file of walkFiles(join(REPO_ROOT, 'src'), [])) {
    const content = readFileSync(file, 'utf8')
    const rel = file.slice(REPO_ROOT.length)

    const full = [...content.matchAll(/\[attaform\] (AF\d{2}) attaform\.dev\/e\/(af\d{2})/g)]
    // Any `[attaform] AF##` prefix that the full-shape regex did not
    // consume is a malformed literal (a missing URL, a wrong slug
    // shape, or a lowercase code).
    const prefixes = content.match(/\[attaform\] AF\d{2}/g) ?? []
    expect(full.length, `malformed AF literal in ${rel}`).toBe(prefixes.length)

    // Every URL mention must be a lowercase af## slug, including ones
    // outside a log literal (a docblock pointing at a code's page).
    for (const [, slug] of content.matchAll(/attaform\.dev\/e\/([\w-]+)/gi)) {
      expect(slug, `non-registry error URL in ${rel}`).toMatch(/^af\d{2}$/)
    }

    for (const match of full) {
      // '' appeases noUncheckedIndexedAccess; the groups are
      // unconditional, and '' would fail every assertion below.
      out.push({ file: rel, code: match[1] ?? '', slug: match[2] ?? '' })
    }
  }
  return out
}

describe('AF## production diagnostics', () => {
  const docs = documentedCodes()
  const logged = loggedCodes()

  it('finds the literals (the scan is alive)', () => {
    expect(logged.length).toBeGreaterThan(0)
  })

  it('every literal links its own page', () => {
    for (const { file, code, slug } of logged) {
      expect(slug, `${code} carries a foreign slug in ${file}`).toBe(code.toLowerCase())
    }
  })

  it('every logged code has a docs page', () => {
    const undocumented = [...new Set(logged.filter((l) => !docs.has(l.code)).map((l) => l.code))]
    expect(undocumented, 'codes logged from src/ with no docs/e page').toEqual([])
  })

  it('every docs page is a live code or a listed retirement', () => {
    const used = new Set(logged.map((l) => l.code))
    const orphaned = [...docs].filter((code) => !used.has(code) && !RETIRED_CODES.has(code)).sort()
    expect(orphaned, 'docs/e pages no call site emits (retire them explicitly)').toEqual([])
  })

  it('retired codes stay retired and stay documented', () => {
    const used = new Set(logged.map((l) => l.code))
    for (const code of RETIRED_CODES) {
      expect(used.has(code), `${code} is listed as retired but still logged`).toBe(false)
      expect(docs.has(code), `${code} is retired; its docs page must remain`).toBe(true)
    }
  })
})
