#!/usr/bin/env node
/**
 * Published-tarball regression gate. Runs `npm pack --dry-run` against the
 * real `dist/` and fails if the packed tarball exceeds the committed budget
 * or if any file that packaging is configured to exclude (sourcemaps, CJS,
 * duplicate declaration flavors) shows up in the file list. The by-name
 * check is the load-bearing half: a build-config or `files` regression
 * re-ships weight by category long before the total drifts past budget.
 *
 * Usage:
 *   pnpm check:tarball
 *
 * Side effects:
 *   - Builds `dist/` if missing or stubbed (calls `pnpm prepack`), same
 *     sentinel logic as check-bundled-types.mjs.
 */
import { execSync, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Budget history (packed bytes, `npm pack --dry-run` "size"):
//   350_000 (2026-08-23, size-teardown P0): first lock. sourcemap off,
//     emitCJS off, declaration 'node16' (single .d.mts flavor), ./types +
//     legacy main dropped, files negation guards. Measured 282 kB packed
//     from 1.8 MB on main; ~68 kB headroom for ordinary feature growth.
//   450_000 (2026-08-23, size-teardown P1a): the dev/prod dual dist adds
//     the dev flavor under dist/dev (runtime entries with `__DEV__`
//     resolved to `true`, no declarations) behind the `development`
//     export condition. Measured 377.6 kB packed, 75 files; the P0 plan
//     sketched ~500k for this raise, but the measured landing point
//     supports the tighter lock with the same ~70 kB growth margin.
const BUDGET_BYTES = 450_000

// Shapes packaging is configured to keep out of the tarball. `.vue.d.ts`
// matches the `.d.ts` rule by design: mkdist emits two declaration-stub
// shapes per shipped `.vue` file and only `.d.vue.ts` (the TS
// allowArbitraryExtensions shape, which the rule does not match) ships.
const FORBIDDEN = [
  { label: 'sourcemap', test: (p) => p.endsWith('.map') },
  { label: 'CJS module', test: (p) => p.endsWith('.cjs') },
  { label: 'CJS declaration', test: (p) => p.endsWith('.d.cts') },
  { label: 'legacy .d.ts declaration', test: (p) => p.endsWith('.d.ts') },
]

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sentinelDts = resolve(repoRoot, 'dist/zod-v4.d.mts')

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
  console.log('[check-tarball-size] dist/ missing or stubbed — building real bundle first')
  execSync('pnpm prepack', { stdio: 'inherit', cwd: repoRoot })
}

const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const [report] = JSON.parse(raw)

const offenders = []
for (const file of report.files) {
  for (const { label, test } of FORBIDDEN) {
    if (test(file.path)) offenders.push(`  ${file.path} (${label})`)
  }
}

const kb = (n) => `${(n / 1000).toFixed(1)} kB`
console.log(
  `[check-tarball-size] packed ${kb(report.size)} (budget ${kb(BUDGET_BYTES)}), ` +
    `unpacked ${kb(report.unpackedSize)}, ${report.files.length} files`
)

let failed = false
if (offenders.length > 0) {
  failed = true
  console.error('[check-tarball-size] FAILED — excluded file shapes are back in the tarball:')
  console.error(offenders.join('\n'))
  console.error('  Check package.json "files" negations and build.config.ts')
  console.error('  (sourcemap / emitCJS / declaration).')
}
if (report.size > BUDGET_BYTES) {
  failed = true
  console.error(
    `[check-tarball-size] FAILED — packed size ${report.size} B exceeds the ` +
      `${BUDGET_BYTES} B budget. If the growth is intentional, raise BUDGET_BYTES ` +
      'with a dated reason in the budget history above.'
  )
}

if (failed) process.exit(1)
console.log('[check-tarball-size] ok')
