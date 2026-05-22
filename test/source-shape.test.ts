import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Standing tripwire for dist-shape leak into `src/runtime/components/`.
 *
 * `mkdist` (build.config.ts) compiles every `.vue` file under
 * `src/runtime/components/` into `dist/runtime/components/`, stripping
 * `lang="ts"` and `//` comments along the way — the dist `.vue` output
 * is intentionally lossy. It's an artifact, not editable source.
 *
 * During the wizard QC session, a copy of that dist output silently
 * overwrote the source files (writer unconfirmed; most likely a Volar
 * emit-on-save firing against the host editor's TS project graph,
 * possibly compounded by stale `.d.vue.ts` / `.vue.d.ts` stubs that
 * survive a `git checkout`). Reverted manually before commit. This
 * test catches the same class of corruption regardless of writer —
 * both symptoms are observable from the file-system shape:
 *
 *  - `<script setup lang="ts">` reduces to `<script setup>` → the
 *    dist transform leaked back into source.
 *  - Files matching `*.d.vue.ts` or `*.vue.d.ts` appear in the source
 *    directory → Volar / vue-tsc emit into the wrong directory.
 *
 * `.gitignore` prevents the stubs from being committed; this test
 * surfaces them in CI before a `git add -f` could sneak past the
 * ignore rules.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const componentsDir = resolve(repoRoot, 'src/runtime/components')

function listVueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listVueFiles(full))
    } else if (entry.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

const vueFiles = listVueFiles(componentsDir)

describe('source shape: src/runtime/components/ stays source-only', () => {
  it.each(vueFiles.map((f) => [relative(repoRoot, f)]))(
    '%s declares <script setup lang="ts">',
    (rel) => {
      const content = readFileSync(resolve(repoRoot, rel), 'utf8')
      expect(content).toMatch(/<script\s+setup\s+lang="ts">/)
    }
  )

  it('contains no .d.vue.ts or .vue.d.ts stubs', () => {
    const stubs: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
        } else if (entry.endsWith('.d.vue.ts') || entry.endsWith('.vue.d.ts')) {
          stubs.push(relative(repoRoot, full))
        }
      }
    }
    walk(componentsDir)
    expect(stubs).toEqual([])
  })
})
