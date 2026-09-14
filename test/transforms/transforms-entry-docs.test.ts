import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as transformsEntry from '../../src/transforms'

/**
 * `attaform/transforms` is what a consumer outside the Vite pipeline
 * wires by hand, and the entry-points page's import block is the only
 * instruction they get. It listed two of the five exports, in neither
 * the published order nor a documented one, and the three it omitted
 * are the ones that matter: the two that bake `value` / `checked` /
 * `selected` into server-rendered HTML, and the redundant-binding warn
 * that has to run before them to read what the author wrote.
 *
 * Wiring the documented subset is not a degraded install, it is a
 * silently wrong one: a component-wrapped input renders unset on the
 * server and corrects itself on hydrate.
 *
 * So the block is pinned to the entry's exports AND to the order
 * `attaform/vite` installs them in, which is where the two ordering
 * constraints are enforced and commented.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(file: string): string {
  return readFileSync(`${REPO_ROOT}${file}`, 'utf8')
}

/** The transform names in `src/vite.ts`'s `nodeTransforms` array, in order. */
function viteInstallOrder(): string[] {
  const block = /nodeTransforms = \[\n\s*\.\.\.existing,\n([\s\S]*?)\n\s*\]/.exec(
    read('src/vite.ts')
  )
  expect(block, 'src/vite.ts lost its nodeTransforms array').not.toBeNull()
  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
}

/** The names in the entry-points page's `attaform/transforms` import block. */
function documentedOrder(): string[] {
  const page = read('docs/reference/entry-points.md')
  // `[^`]` so the match cannot start at an earlier fenced block and run
  // forward to this one's closer.
  const block = /```ts\nimport \{\n([^`]*?)\n\} from 'attaform\/transforms'\n```/.exec(page)
  expect(block, 'entry-points.md lost its attaform/transforms import block').not.toBeNull()
  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
}

describe('the attaform/transforms entry vs the prose that enumerates it', () => {
  it('documents every export of the entry', () => {
    expect([...documentedOrder()].sort()).toEqual([...Object.keys(transformsEntry)].sort())
  })

  it('documents them in the order the Vite plugin installs them', () => {
    expect(documentedOrder()).toEqual(viteInstallOrder())
  })
})
