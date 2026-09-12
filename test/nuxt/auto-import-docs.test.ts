import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { attaformAutoImports } from '../../src/runtime/auto-imports'

/**
 * The auto-import manifest is a promise made in prose long before a
 * consumer ever reads the array. Four docs sentences and one skill import
 * block enumerate the set by hand, and nothing tied any of them to
 * `attaformAutoImports`. That gap is not hypothetical: `gate` joined the
 * manifest in #523 (v0.27.2, 2026-07-15) and every enumeration still said
 * seven names two months later, while the skill's import block listed
 * `useRegister`, which was not auto-imported at all until #573. A reader
 * who trusted either one wrote code that did not compile.
 *
 * This suite is the tie. Adding or removing a manifest entry now fails
 * here until the prose follows, and a NEW enumeration added anywhere in
 * docs/ or skills/ fails until it is registered below.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MANIFEST = attaformAutoImports.map((entry) => entry.name)
const MANIFEST_SET = new Set(MANIFEST)

/**
 * Every place that spells the set out. `anchor` is a phrase unique to the
 * sentence, so rewording around it is free and only the name list is
 * pinned. Registering a new site here is the deliberate act; forgetting to
 * is what the coverage test below catches.
 */
const ENUMERATIONS: ReadonlyArray<{ file: string; anchor: string }> = [
  {
    file: 'docs/getting-started/installation.md',
    anchor: 'What this gets you: the form composables as auto-imports',
  },
  { file: 'docs/getting-started/installation.md', anchor: 'The set is the same either way:' },
  {
    file: 'docs/server-and-ssr/ssr-nuxt.md',
    anchor: 'The Nuxt module auto-imports the form composables',
  },
  { file: 'docs/reference/entry-points.md', anchor: 'are all global auto-imports' },
]

/** The one skill block a coding agent copies verbatim. */
const SKILL_FILE = 'skills/attaform/SKILL.md'

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

function lineContaining(file: string, anchor: string): string {
  const match = read(file)
    .split('\n')
    .filter((line) => line.includes(anchor))
  expect(match, `no line in ${file} contains "${anchor}"`).toHaveLength(1)
  return match[0] ?? ''
}

/** Backticked identifiers on a line, narrowed to manifest members. */
function manifestNamesIn(text: string): string[] {
  const found = [...text.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((m) => m[1] ?? '')
  return [...new Set(found.filter((name) => MANIFEST_SET.has(name)))]
}

function markdownFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) markdownFiles(rel, out)
    else if (entry.name.endsWith('.md')) out.push(rel)
  }
  return out
}

describe('auto-import manifest vs the prose that enumerates it', () => {
  it.each(ENUMERATIONS)('$file names the whole manifest at "$anchor"', ({ file, anchor }) => {
    expect(manifestNamesIn(lineContaining(file, anchor)).sort()).toEqual([...MANIFEST].sort())
  })

  it("SKILL.md's import block is exactly the auto-imported surface", () => {
    // The block is prefaced by "Everything comes from the `attaform`
    // barrel" and followed by the claim that under Nuxt "this surface
    // auto-imports ... so a component needs no import lines at all". That
    // sentence is only true while the block and the manifest agree.
    const block = /```ts\nimport \{\n([\s\S]*?)\n\} from 'attaform'\n```/.exec(read(SKILL_FILE))
    expect(block, 'SKILL.md lost its barrel import block').not.toBeNull()
    const named = (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line.length > 0)
    expect([...named].sort()).toEqual([...MANIFEST].sort())
  })

  it('registers every auto-import enumeration in docs/ and skills/', () => {
    // A sentence that both invokes auto-imports and spells out three or
    // more manifest names is an enumeration, whether or not anyone
    // remembered to pin it. Catching the unregistered one is the point:
    // the next `gate` should fail here rather than ship stale.
    const anchors = ENUMERATIONS.map((entry) => entry.anchor)
    const unregistered: string[] = []
    for (const file of [...markdownFiles('docs', []), ...markdownFiles('skills', [])]) {
      read(file)
        .split('\n')
        .forEach((line, index) => {
          if (!/auto-?import/i.test(line)) return
          if (manifestNamesIn(line).length < 3) return
          if (anchors.some((anchor) => line.includes(anchor))) return
          unregistered.push(`${file}:${index + 1}`)
        })
    }
    expect(unregistered).toEqual([])
  })
})
