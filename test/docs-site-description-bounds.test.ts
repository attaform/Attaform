import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Description-length gate for the docs content collection.
 *
 * `apps/site/content.config.ts` declares a `description` contract on
 * every docs page: a min (below which a SERP snippet collapses to a
 * headline) and a max (above which Google truncates it). Nuxt Content
 * validates that zod schema at parse time, but a violation only WARNS —
 * the page still ships. So an over-cap description never fails the
 * build, and 17 pages had silently drifted past the max before this
 * gate existed.
 *
 * This test is the real enforcement. It reads the bounds straight out
 * of content.config.ts (single source of truth, so the two can't drift)
 * and fails CI on any docs page whose description is missing or out of
 * range, listing every offender at once.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const docsDir = join(repoRoot, 'docs')
const contentConfigPath = join(repoRoot, 'apps/site/content.config.ts')

/** Pull the description min/max out of the docs collection schema. */
function readDescriptionBounds(): { min: number; max: number } {
  const src = readFileSync(contentConfigPath, 'utf8')
  // Isolate the `description:` field block so a `.min()` / `.max()` on
  // any other field can't be misread.
  const start = src.indexOf('description:')
  const end = src.indexOf('metaRows:', start)
  const block = src.slice(start, end === -1 ? undefined : end)
  const min = Number(block.match(/\.min\((\d+)/)?.[1])
  const max = Number(block.match(/\.max\((\d+)/)?.[1])
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(
      'could not read the description min/max from apps/site/content.config.ts — ' +
        'the schema shape changed; update readDescriptionBounds()'
    )
  }
  return { min, max }
}

function collectMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectMarkdown(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * The `description:` value from a page's YAML frontmatter, or undefined
 * when the page declares none. Descriptions are single-line scalars;
 * strip matching quotes and unescape YAML's doubled single-quote so the
 * measured length matches what Nuxt Content's zod schema sees.
 */
function frontmatterDescription(text: string): string | undefined {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1]
  if (fm === undefined) return undefined
  const line = fm.split('\n').find((l) => /^description:\s/.test(l))
  if (line === undefined) return undefined
  let value = line.replace(/^description:\s*/, '').trim()
  if (value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1).replace(/''/g, "'")
  } else if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  return value
}

describe('docs description length contract', () => {
  const { min, max } = readDescriptionBounds()
  const files = collectMarkdown(docsDir)

  it(`every docs page has a description within [${min}, ${max}] characters`, () => {
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(repoRoot, file)
      const description = frontmatterDescription(readFileSync(file, 'utf8'))
      if (description === undefined) {
        violations.push(`${rel}: missing description`)
      } else if (description.length < min) {
        violations.push(`${rel}: ${description.length} chars (under ${min})`)
      } else if (description.length > max) {
        violations.push(`${rel}: ${description.length} chars (over ${max})`)
      }
    }
    expect(
      violations,
      `${violations.length} docs page(s) break the description contract (min ${min}, max ${max}). ` +
        `Nuxt Content only warns on these, so this gate fails the build instead:\n  ` +
        violations.join('\n  ')
    ).toEqual([])
  })

  // Second failure mode, same silent class. An UNQUOTED frontmatter value
  // that contains a colon-space parses as a nested mapping, not a string:
  // `description: How it compares: bundle size` becomes an object, and the
  // rendered <meta> reads `[object Object]`. Nuxt Content mis-parses the
  // offending field without erroring, so nothing catches it. Flag any
  // unquoted value carrying a `: ` so the author quotes it (or drops the
  // colon).
  it('no frontmatter value carries an unquoted colon that parses to an object', () => {
    const violations: string[] = []
    for (const file of files) {
      const frontmatter = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1]
      if (frontmatter === undefined) continue
      const lines = frontmatter.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? ''
        const assignment = /^(\s*(?:-\s+)?[A-Za-z][\w-]*):\s+(\S.*)$/.exec(line)
        if (assignment === null) continue
        const value = assignment[2] ?? ''
        // Quoted scalars and flow / block collections manage their own colons.
        if (/^['"[{>|]/.test(value)) continue
        if (/:\s/.test(value)) {
          // Frontmatter starts on file line 2 (line 1 is the opening `---`).
          violations.push(`${relative(repoRoot, file)}:${i + 2} — ${line.trim()}`)
        }
      }
    }
    expect(
      violations,
      `${violations.length} frontmatter value(s) carry an unquoted colon and parse to an object ` +
        `(the rendered meta reads "[object Object]"). Quote the value or drop the colon:\n  ` +
        violations.join('\n  ')
    ).toEqual([])
  })
})
