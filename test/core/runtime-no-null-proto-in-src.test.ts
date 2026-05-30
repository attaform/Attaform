/**
 * Standing diagnostic for issue #314 — `Object.create(null)` must not
 * reappear inside `src/runtime/` as a defensive idiom.
 *
 * The prototype-pollution hardening that landed in PRs #308-310 used
 * `Object.create(null)` containers as the defense. That idiom leaked
 * null-prototype objects out through `renderAttaformState`, `form.values`,
 * `form.record(path)`, and `form.errors`, breaking any third-party
 * code that called `.hasOwnProperty(...)` (most prominently
 * `@pinia/nuxt`'s payload reducer, which 500s every SSR page with a
 * form when both modules are installed).
 *
 * The fix swapped every container to a regular `{}` plus a `safeAssign`
 * helper (`Object.defineProperty` for the `__proto__` key) and
 * `safeOwnRead` / `safeOwnHas` for untrusted-key reads. After the
 * sweep, the runtime contains no `Object.create(null)` calls.
 *
 * This test fails any PR that reintroduces the idiom — a contributor
 * tempted to "tighten the defense" by reaching back for null-prototype
 * gets caught at CI, and the failure message links to this docblock
 * so the rationale travels with the gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RUNTIME_ROOT = join(__dirname, '..', '..', 'src', 'runtime')

/**
 * Walk `dir` recursively and yield every `.ts` / `.tsx` file path.
 * Skips `.d.ts` files (declarations have no runtime allocators).
 */
function* walkRuntimeFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      yield* walkRuntimeFiles(path)
      continue
    }
    if (!stat.isFile()) continue
    if (path.endsWith('.d.ts')) continue
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue
    yield path
  }
}

/**
 * Strip block + line comments from `source` so the audit only inspects
 * runtime expressions. Conservative: a `//` or block-comment token
 * inside a string literal would also be stripped, but the false-positive
 * shape (a literal "Object.create(null)" inside a string) doesn't
 * appear anywhere in the runtime, and would itself be worth flagging.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('src/runtime contains no `Object.create(null)` defensive allocators', () => {
  it('finds zero call sites across every runtime .ts file', () => {
    const offenders: string[] = []
    for (const path of walkRuntimeFiles(RUNTIME_ROOT)) {
      const stripped = stripComments(readFileSync(path, 'utf8'))
      if (stripped.includes('Object.create(null)')) {
        offenders.push(path)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
