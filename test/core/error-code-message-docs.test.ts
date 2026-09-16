import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Each `docs/e/af##.md` page reproduces its code's development
 * message in a blockquote, so a reader who saw the compact production
 * code can match the prose their dev build prints. Nothing tied the
 * two together: `error-code-pages.test.ts` proves a page exists for
 * every logged code, not that the page quotes the message the code
 * actually carries.
 *
 * `af05.md` is why this exists. Its quote had `"**atta:checkout"` and
 * `"**atta:"` where the message says `__atta:`, so the page rendered
 * the reserved prefix as a bold span with the underscores gone. The
 * one page devoted to a reserved-prefix error showed a key without
 * the prefix.
 *
 * The check is fragment-wise: every literal run of the source message
 * (the pieces either side of an interpolation) must appear on the
 * page. Pages fill interpolations with an illustrative value, so those
 * are not compared.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Codes whose development output is not a single quotable string.
 * Anything else must quote.
 */
const NOT_QUOTABLE = new Map<string, string>([
  [
    'AF14',
    // A multi-argument console.error whose second argument is the
    // consumer's thrown error. af14.md describes the shape instead,
    // and explains why production carries none of it.
    'composite console.error carrying the original error object',
  ],
  ['AF02', 'retired, no call site'],
  ['AF03', 'retired, no call site'],
])

/** Source files that hold an AF literal, and the literals in them. */
const SOURCES = [
  'src/runtime/core/errors.ts',
  'src/runtime/core/create-form-store.ts',
  'src/runtime/core/paths.ts',
  'src/runtime/core/assigner-pipeline.ts',
  'src/runtime/adapters/zod-v4/introspect.ts',
  'src/runtime/adapters/zod-v4/adapter.ts',
  'src/runtime/adapters/zod-v3/introspect.ts',
  'src/runtime/adapters/zod-v3/index.ts',
]

/**
 * Pull the string literals out of a slice of source and join them,
 * splitting each template interpolation into a fragment boundary.
 */
function fragmentsOf(slice: string): string[] {
  const parts: string[] = []
  const literal = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  for (const match of slice.matchAll(literal)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  const joined = parts.join('').replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/\\n/g, ' ')
  return joined
    .split(/\$\{[^}]*\}/)
    .map((fragment) => normalize(fragment))
    .filter((fragment) => fragment.length > 0)
}

/**
 * Compare on visible text: collapse the wrapping that either side
 * adds. Markdown underscore escapes and inline-code backticks are
 * presentation, and the source wraps at column width the page does
 * not.
 */
function normalize(text: string): string {
  return text
    .replace(/\\([_*<>])/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every dev message in `src/`, keyed by code. A code may have several (v3 / v4 mirrors). */
function devMessages(): Map<string, string[][]> {
  const byCode = new Map<string, string[][]>()
  for (const rel of SOURCES) {
    const content = readFileSync(join(REPO_ROOT, rel), 'utf8')
    for (const match of content.matchAll(/\[attaform\] (AF\d{2}) attaform\.dev/g)) {
      const code = match[1] ?? ''
      const at = match.index
      const devAt = content.lastIndexOf('__DEV__', at)
      expect(devAt, `${code} in ${rel} has no __DEV__ branch above it`).toBeGreaterThan(-1)
      const fragments = fragmentsOf(content.slice(devAt, at))
      const existing = byCode.get(code) ?? []
      existing.push(fragments)
      byCode.set(code, existing)
    }
  }
  return byCode
}

describe('docs/e pages quote the message their code carries', () => {
  const messages = devMessages()

  it('finds a development message for every code (the scan is alive)', () => {
    expect([...messages.keys()].sort()).toEqual([
      'AF01',
      'AF04',
      'AF05',
      'AF06',
      'AF07',
      'AF08',
      'AF09',
      'AF10',
      'AF11',
      'AF12',
      'AF14',
      'AF15',
    ])
  })

  for (const [code, variants] of [...messages].sort(([a], [b]) => a.localeCompare(b))) {
    const skip = NOT_QUOTABLE.get(code)
    it(`${code} quotes its message${skip === undefined ? '' : ' (skipped)'}`, () => {
      if (skip !== undefined) return
      const page = normalize(
        readFileSync(join(REPO_ROOT, `docs/e/${code.toLowerCase()}.md`), 'utf8')
      )
      // A code emitted from both adapters has a v3 and a v4 wording;
      // the page quotes one of them and names the mirror in prose.
      const missing = variants.map((fragments) => fragments.filter((f) => !page.includes(f)))
      const best = missing.reduce((a, b) => (a.length <= b.length ? a : b))
      expect(best, `docs/e/${code.toLowerCase()}.md drifted from the message in src/`).toEqual([])
    })
  }
})
