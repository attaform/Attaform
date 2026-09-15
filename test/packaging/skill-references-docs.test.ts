import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * The Agent Skill discloses progressively: `SKILL.md` covers the
 * common case and indexes `references/` for depth. Three surfaces name
 * that set, and none of them read the directory.
 *
 * `references/saving.md` landed and none of the prose followed.
 * `SKILL.md`'s own index picked it up; `docs/ai-tooling/agent-skill.md`
 * kept saying "five reference files" and listing the other five, which
 * is the page a reader consults to decide whether the skill covers
 * their case. Persisting each decision as the user makes it is a
 * plausible thing to conclude the skill has nothing to say about.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SKILL_DIR = join(REPO_ROOT, 'skills/attaform')
const PAGE = 'docs/ai-tooling/agent-skill.md'

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]

function referenceStems(): string[] {
  return readdirSync(join(SKILL_DIR, 'references'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort()
}

describe('the reference files vs the prose that indexes them', () => {
  const stems = referenceStems()

  it('finds the reference files (the scan is alive)', () => {
    expect(stems.length).toBeGreaterThan(3)
  })

  it("SKILL.md's own index names every reference file and no other", () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')
    const section = /## Reference files\n([\s\S]*?)(?=\n## |$)/.exec(skill)
    expect(section, 'the Reference files section moved or was renamed').not.toBeNull()
    const indexed = [...(section?.[1] ?? '').matchAll(/`references\/([\w-]+)\.md`/g)].map(
      (match) => match[1] ?? ''
    )
    expect([...new Set(indexed)].sort()).toEqual(stems)
  })

  it('the docs page names every reference file and states the right count', () => {
    const page = readFileSync(join(REPO_ROOT, PAGE), 'utf8').toLowerCase()
    const unnamed = stems.filter((stem) => !page.includes(stem.replace(/-/g, ' ')))
    expect(unnamed, `${PAGE} does not name every reference file`).toEqual([])

    const word = NUMBER_WORDS[stems.length] ?? String(stems.length)
    expect(
      page.includes(`${word} reference file`),
      `${PAGE} should say "${word} reference files"`
    ).toBe(true)
  })
})
