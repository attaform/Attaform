#!/usr/bin/env node
/**
 * Per-library gzipped bundle measurement for the benchmark arena.
 *
 * A structural sibling of the repo-root scripts/check-eager-size.mjs (same
 * pnpm-store esbuild resolver, same gzip level, same production define), but it
 * weighs a different thing: the cost a CONSUMER pays to ship a minimal real
 * form in each library. Every entry under entries/ is the SAME minimal form
 * (one text field, one email field, schema-validated, a submit handler) written
 * in that library's idiomatic API, so the comparison is like against like.
 *
 * Fairness:
 *  - The library AND its validator are bundled and weighed together (vee +
 *    zod, formisch + valibot, FormKit + its zod plugin, Vuelidate + its native
 *    validators). That is the honest "for better or worse" figure, including
 *    where Attaform is heavier.
 *  - `vue` is external: every Vue app ships Vue exactly once, so counting it in
 *    every row would mislead. (Stated as a footnote on the docs page.)
 *  - `zod` and `valibot` resolve to the arena's single installed copy via an
 *    alias, so a symlinked workspace package's own `import 'zod'` cannot pull a
 *    second copy into one row. That is the single-validator install a real
 *    consumer has, and it mirrors the vite config's dedupe.
 *
 * Run `pnpm prepack` at the repo root first so the Attaform row weighs the real
 * published dist, not a stale or stubbed build.
 *
 * CLI: `node scripts/measure-bundles.mjs` prints the table.
 * Library: `import { measureBundles }` powers the orchestrator (run-arena.mjs).
 */
import { readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { readInstalledVersion } from './installed-version.mjs'

// scripts/measure-bundles.mjs -> scripts/ -> package root -> apps/ -> repo root.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = join(PKG_ROOT, '..', '..')
const NODE_MODULES = join(PKG_ROOT, 'node_modules')

// Resolve esbuild from the workspace pnpm store (a transitive dep of vite, not
// in any top-level node_modules); pick the newest by numeric semver so a
// version bump needs no edit here. Same walker as scripts/check-eager-size.mjs.
function resolveEsbuild() {
  const store = join(REPO_ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  if (!dirs.length) throw new Error('esbuild not found under node_modules/.pnpm')
  const parts = (d) =>
    d
      .slice('esbuild@'.length)
      .split('.')
      .map((n) => parseInt(n, 10))
  dirs.sort((a, b) => {
    const [A0, A1, A2] = parts(a)
    const [B0, B1, B2] = parts(b)
    return A0 - B0 || A1 - B1 || A2 - B2
  })
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

/**
 * The cohort entries, in display order. `pkg` is the package whose resolved
 * version labels the row; `validatorPkg` names the validator package weighed
 * alongside it (null for the native-validator libraries, which ship no separate
 * schema package). Regle is measured once, in schema mode, for the Zod row.
 */
const ENTRIES = [
  {
    id: 'attaform',
    lib: 'Attaform',
    file: 'attaform.form.ts',
    pkg: 'attaform',
    validatorPkg: 'zod',
  },
  {
    id: 'vee-validate',
    lib: 'vee-validate',
    file: 'vee-validate.form.ts',
    pkg: 'vee-validate',
    validatorPkg: 'zod',
  },
  {
    id: 'tanstack',
    lib: '@tanstack/vue-form',
    file: 'tanstack.form.ts',
    pkg: '@tanstack/vue-form',
    validatorPkg: 'zod',
  },
  {
    id: 'formisch',
    lib: '@formisch/vue',
    file: 'formisch.form.ts',
    pkg: '@formisch/vue',
    validatorPkg: 'valibot',
  },
  { id: 'regle', lib: 'Regle', file: 'regle.form.ts', pkg: '@regle/core', validatorPkg: 'zod' },
  {
    id: 'formkit',
    lib: 'FormKit',
    file: 'formkit.form.ts',
    pkg: '@formkit/vue',
    validatorPkg: 'zod',
  },
  {
    id: 'vuelidate',
    lib: 'Vuelidate',
    file: 'vuelidate.form.ts',
    pkg: '@vuelidate/core',
    validatorPkg: null,
  },
]

const PROD_DEFINE = { 'process.env.NODE_ENV': '"production"' }

function validatorLabel(validatorPkg) {
  if (validatorPkg === null) return 'native validators'
  return `${validatorPkg} ${readInstalledVersion(validatorPkg)}`
}

/** Bundle one entry (lib + validator, Vue external) and return its gzipped size. */
async function gzippedSize(file) {
  const result = await esbuild.build({
    entryPoints: [join(PKG_ROOT, 'entries', file)],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    platform: 'browser',
    // Vue is shipped once by every app, so it is never counted in a row.
    external: ['vue', '@vue/*'],
    // Pin the single installed validator copy (mirrors the vite dedupe), so a
    // symlinked workspace package's own `import 'zod'` cannot bundle a 2nd copy.
    alias: {
      zod: join(NODE_MODULES, 'zod'),
      valibot: join(NODE_MODULES, 'valibot'),
    },
    define: PROD_DEFINE,
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  })
  const js = result.outputFiles.map((f) => f.text).join('')
  return gzipSync(Buffer.from(js), { level: 9 }).length
}

/**
 * Measure every entry and return one row per library: resolved version, the
 * validator weighed with it, gzipped bytes, and the ratio to Attaform's row
 * (the baseline). The orchestrator embeds these rows verbatim in results.json.
 */
export async function measureBundles() {
  const rows = []
  for (const entry of ENTRIES) {
    const gzBytes = await gzippedSize(entry.file)
    rows.push({
      id: entry.id,
      lib: entry.lib,
      version: readInstalledVersion(entry.pkg),
      validator: validatorLabel(entry.validatorPkg),
      gzBytes,
    })
  }
  const baseline = rows.find((r) => r.id === 'attaform')?.gzBytes ?? 0
  for (const row of rows) {
    row.ratio = baseline > 0 ? Number((row.gzBytes / baseline).toFixed(2)) : 1
  }
  return rows
}

const isMain = import.meta.url === pathToFileURL(realpathSync(argv[1])).href
if (isMain) {
  const rows = await measureBundles()
  const kb = (b) => (b / 1024).toFixed(2)
  for (const row of [...rows].sort((a, b) => a.gzBytes - b.gzBytes)) {
    const size = `${kb(row.gzBytes)} kB gz`.padStart(13)
    const ratio = `x${row.ratio.toFixed(2)}`.padStart(7)
    console.log(`${row.lib.padEnd(20)} ${size} ${ratio}  (${row.validator})`)
  }
}
