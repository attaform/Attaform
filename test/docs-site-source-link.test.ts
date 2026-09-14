import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Docs and the Agent Skill link into this repo by URL, to point a reader
 * at the bench that produced a number or the test that proves a claim.
 * Nothing resolved those links: a moved or deleted file leaves a 404 in
 * published prose, and the claim it was supporting keeps reading as
 * sourced.
 *
 * The performance page is the reason this exists. Its table cited a
 * bench by name for numbers the bench had not produced in a long time,
 * and the link still worked, so nothing looked wrong.
 *
 * Nuxt's link checker covers in-site routes and `docs-site-prose-link`
 * covers how they render. This covers the ones that leave the site for
 * the repo they came from.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_LINK = /https:\/\/github\.com\/attaform\/Attaform\/(?:blob|tree)\/main\/([^)"'\s#]+)/g

function markdownFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) markdownFiles(rel, out)
    else if (entry.name.endsWith('.md')) out.push(rel)
  }
  return out
}

describe('links from docs into this repo', () => {
  it('every blob / tree link resolves to a real path', () => {
    const broken: string[] = []
    for (const file of [...markdownFiles('docs', []), ...markdownFiles('skills', [])]) {
      readFileSync(join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(REPO_LINK)) {
            const target = match[1] ?? ''
            if (existsSync(join(REPO_ROOT, target))) continue
            broken.push(`${file}:${index + 1} → ${target}`)
          }
        })
    }
    expect(broken).toEqual([])
  })
})
