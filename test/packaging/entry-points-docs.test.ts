import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * `reference/entry-points.md` is the "which import line do I need?"
 * lookup, and its frontmatter states a count. The four bundler plugins
 * (`attaform/rollup`, `/esbuild`, `/webpack`, `/rspack`) had no section
 * of their own, only a line inside the Vite one saying "the same plugin
 * ships for other bundlers": which is the part that was wrong. The
 * Vite plugin binds `v-register` and marks SSR state; the other four do
 * only the Zod-adapter rewrite, because the template work is
 * `@vitejs/plugin-vue`-specific. A consumer who read that line shipped a
 * webpack build with no directive at all.
 *
 * The count said 16 against 15 importable subpaths.
 *
 * `test/packaging/exports.test.ts` checks the exports map resolves. This
 * checks the page that tells people it exists.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PAGE = 'docs/reference/entry-points.md'

function importableSubpaths(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>
  }
  return Object.keys(pkg.exports)
    .filter((key) => key !== './package.json')
    .map((key) => (key === '.' ? 'attaform' : `attaform${key.slice(1)}`))
}

function page(): string {
  return readFileSync(join(REPO_ROOT, PAGE), 'utf8')
}

describe('the exports map vs the entry-point reference', () => {
  it('gives every importable subpath a section heading', () => {
    const headed = new Set(
      [...page().matchAll(/^## .*$/gm)].flatMap((line) =>
        [...line[0].matchAll(/`(attaform(?:\/[a-z0-9-]+)?)`/g)].map((m) => m[1] ?? '')
      )
    )
    expect(
      importableSubpaths()
        .filter((entry) => !headed.has(entry))
        .sort()
    ).toEqual([])
  })

  it('states the right entry-point count in its frontmatter', () => {
    const stated = /- label: Entry points\n {4}value: (\d+)/.exec(page())
    expect(stated, 'the Entry points metaRow moved or was renamed').not.toBeNull()
    expect(Number(stated?.[1])).toBe(importableSubpaths().length)
  })

  it('the toolkit import block lists every shared value export', () => {
    // "Every entry re-exports the same schema-agnostic core, so this set
    // is identical whether you import it from `attaform`, `attaform/zod`,
    // or `attaform/abstract`": the block below that sentence listed 31
    // of 38. Among the seven missing was `gate`, which the same page
    // names as a Nuxt auto-import two sections earlier, so the page told
    // a reader the symbol exists and not where it comes from.
    const block =
      /## The framework-agnostic toolkit[\s\S]*?```ts\nimport \{\n([^`]*?)\n\} from 'attaform'/.exec(
        page()
      )
    expect(block, 'the toolkit import block moved or was renamed').not.toBeNull()
    const listed = (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line.length > 0 && !line.startsWith('//'))

    const source = readFileSync(join(REPO_ROOT, 'src/runtime/_shared-exports.ts'), 'utf8')
    const exported = new Set<string>()
    for (const group of source.matchAll(/export \{([^}]*)\} from/g)) {
      for (const entry of (group[1] ?? '').split(',')) {
        const name = entry.trim().replace(/ as .*/, '')
        if (name.length > 0) exported.add(name)
      }
    }
    expect(exported.size, 'the shared barrel went empty').toBeGreaterThan(20)
    expect([...listed].sort()).toEqual([...exported].sort())
  })
})
