#!/usr/bin/env node
/**
 * Bundled-types regression gate. Verifies that every fixture under
 * `tests/fixtures/bundled-types/*.ts` typechecks against the published
 * `.d.ts` shape, the artifact a real consumer sees through
 * `attaform/zod-v4` and `attaform`. The fixture tsconfig globs the
 * directory, so adding a new `.ts` next to the existing ones brings it
 * under the gate without any wiring changes here.
 *
 * Acceptance tests carried by the fixtures:
 *   - `4-form-wizard.ts`: depth efficiency. A 4-form
 *     `useWizard` pattern with discriminated unions, nested objects,
 *     arrays, and tuples must not trip TS2589 ("Type instantiation is
 *     excessively deep") under the bundled `.d.ts`.
 *   - `mixed-wizard.ts`: the wizard v2 surface. String / function /
 *     `defer()` step slots, the universal `wizard.handleSubmit` context,
 *     and the namespaced aggregation surfaces (`wizard.allValues`,
 *     `wizard.allErrors`, `wizard.forms.<key>`) must compile against the
 *     bundled `.d.ts` without surface-shape drift between src and dist.
 *
 * A second fixture project, `tests/fixtures/bundled-types-v3/`, compiles
 * the unified `attaform/zod` entry with `zod` remapped (via tsconfig
 * `paths`) to a single v3 install, recreating the one-Zod-major consumer
 * the repo itself cannot represent, since it installs both majors.
 * It guards the read-slot regression where the unified entry's v4
 * overload greedily matched a v3 schema and collapsed `form.values` /
 * `form.fields` to `never`.
 *
 * Usage:
 *   pnpm check:bundled-types
 *
 * Side effects:
 *   - Builds `dist/` when it is missing, stubbed, or behind `src/`
 *     (`ensureFreshDist`, shared with the other dist-reading gates).
 *   - Runs `tsc --project <fixture>/tsconfig.json` for each fixture set.
 *   - Exits non-zero on any compile error.
 */
import { execSync } from 'node:child_process'
import { ensureFreshDist } from './dist-bundle.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const fixtureProjects = [
  {
    label: 'v4 / default consumer',
    tsconfig: resolve(repoRoot, 'tests/fixtures/bundled-types/tsconfig.json'),
  },
  {
    label: 'v3-only consumer (zod remapped to a single v3 install)',
    tsconfig: resolve(repoRoot, 'tests/fixtures/bundled-types-v3/tsconfig.json'),
  },
]

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', cwd: repoRoot, ...opts })
}

ensureFreshDist('check-bundled-types')

let failed = false
for (const { label, tsconfig } of fixtureProjects) {
  console.log(`[check-bundled-types] typechecking ${label} against bundled .d.ts`)
  try {
    run(`pnpm exec tsc --project "${tsconfig}"`)
    console.log(`[check-bundled-types] ok — ${label}`)
  } catch {
    failed = true
    console.error(`[check-bundled-types] FAILED — ${label} did not compile.`)
  }
}

if (failed) {
  console.error('[check-bundled-types] FAILED — a bundled-types fixture did not compile.')
  console.error('  Depth-efficiency regression suspects: DefaultValuesInput, LeafWalker,')
  console.error('  internal-helper exports, WriteShape. Surface-shape drift suspects: any')
  console.error('  recent change to public types that did not propagate through unbuild to dist.')
  console.error('  v3-only consumer regression suspects: the unified entry v4 overload')
  console.error('  matching a v3 schema (read slot collapses to `never`); see')
  console.error('  src/runtime/adapters/unified/ and the ZodV4 structural marker.')
  process.exit(1)
}

console.log('[check-bundled-types] ok — all bundled-types fixtures compile cleanly')
