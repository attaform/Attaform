#!/usr/bin/env node
/**
 * Bundled-types regression gate. Verifies that every fixture under
 * `tests/fixtures/bundled-types/*.ts` typechecks against the published
 * `.d.ts` shape — the artifact a real consumer sees through
 * `attaform/zod-v4` and `attaform`. The fixture tsconfig globs the
 * directory, so adding a new `.ts` next to the existing ones brings it
 * under the gate without any wiring changes here.
 *
 * Acceptance tests carried by the fixtures:
 *   - `4-form-wizard.ts` — depth-efficiency regression. A 4-form
 *     `useWizard` pattern with discriminated unions, nested objects,
 *     arrays, and tuples must not trip TS2589 ("Type instantiation is
 *     excessively deep") under the bundled `.d.ts`.
 *   - `mixed-wizard.ts` — v2 surface regression. String / function /
 *     `defer()` step slots, the universal `wizard.handleSubmit` context,
 *     and the namespaced aggregation surfaces (`wizard.allValues`,
 *     `wizard.allErrors`, `wizard.forms.<key>`) must compile against the
 *     bundled `.d.ts` without surface-shape drift between src and dist.
 *
 * Usage:
 *   pnpm check:bundled-types
 *
 * Side effects:
 *   - Builds `dist/` if missing (calls `pnpm prepack`).
 *   - Runs `tsc --project tests/fixtures/bundled-types/tsconfig.json`.
 *   - Exits non-zero on any compile error.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const distDir = resolve(repoRoot, 'dist')
const fixtureTsConfig = resolve(repoRoot, 'tests/fixtures/bundled-types/tsconfig.json')
const sentinelDts = resolve(distDir, 'zod-v4.d.ts')

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', cwd: repoRoot, ...opts })
}

function distIsRealBundle() {
  try {
    const head = readFileSync(sentinelDts, 'utf8').slice(0, 256)
    // `unbuild --stub` writes `export * from "/app/src/..."` (absolute
    // source paths). A real bundle imports from `./shared/...` chunks.
    return !head.includes('/src/')
  } catch {
    return false
  }
}

if (!distIsRealBundle()) {
  console.log('[check-bundled-types] dist/ missing or stubbed — building real bundle first')
  run('pnpm prepack')
}

console.log('[check-bundled-types] typechecking bundled-types fixtures against bundled .d.ts')
try {
  run(`pnpm exec tsc --project "${fixtureTsConfig}"`)
  console.log('[check-bundled-types] ok — bundled-types fixtures compile cleanly')
} catch {
  console.error('[check-bundled-types] FAILED — a bundled-types fixture did not compile.')
  console.error(
    '  Depth-efficiency regression suspects: DefaultValuesInput, LeafWalker,'
  )
  console.error(
    '  internal-helper exports, WriteShape. Surface-shape drift suspects: any'
  )
  console.error(
    '  recent change to public types that did not propagate through unbuild to dist.'
  )
  process.exit(1)
}
