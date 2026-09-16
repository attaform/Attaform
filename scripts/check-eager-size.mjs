#!/usr/bin/env node
/**
 * Eager-byte regression gate. Measures the gzipped EAGER cost of a
 * minimal `useForm` consumer: the bytes paid on first paint by every
 * consumer, before any lazy feature runs. Fails if it exceeds the
 * committed budget.
 *
 * Why a bespoke script and not a `.size-limit.js` entry: size-limit's
 * esbuild config has no `splitting`, so it inlines dynamic `import()`
 * back into the entry and measures eager + async together. That total
 * is blind to whether a feature sits on the eager path, so it cannot
 * gate the eager/async split that the lazy-loading work banks. This
 * script builds with `splitting: true`, walks the esbuild metafile from
 * the entry following only `import-statement` edges (the eager set),
 * and gzips just those chunks. Same methodology as
 * analysis/measure-split.mjs, kept as a standing CI guard.
 *
 * The measurement applies the same source-level `__DEV__` strip the
 * package build uses (size-teardown P1a): the dev-flag import is removed
 * and the identifier inlined to a literal before esbuild parses, exactly
 * as `build.config.ts` pre-strips the shipped prod flavor. The ratchet
 * therefore equals shipped prod-flavor bytes — not the weaker
 * define-fold, which leaves behind functions that are only called from
 * dead branches (esbuild marks references before it folds the define).
 * The `define` still selects the flavor: a production define measures
 * the prod strip, anything else the dev flavor's literal `true`.
 *
 * Zero new deps: esbuild is already installed (transitively, via vite /
 * size-limit). pnpm keeps it under node_modules/.pnpm, so we resolve
 * the newest installed copy from there.
 *
 * CLI: `node scripts/check-eager-size.mjs` enforces the budget.
 * Library: `import { measureEager }` powers test/packaging/dev-dce.test.ts.
 */
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { argv, env, exit } from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Where `src/` is read from. Defaults to this checkout. `eager-delta.mjs`
// points it at a worktree of the merge base so both revisions are measured
// with ONE method — this script's. That is the comparison that attributes a
// byte delta to the source change: measuring each revision with its own
// harness would fold a harness edit into the number. Dependency resolution
// (esbuild, and the externals list) always stays on ROOT.
// realpath, because esbuild reports real paths on `onLoad`: a source root
// under a symlinked directory (macOS `/tmp` -> `/private/tmp`) would fail
// the `__DEV__` strip's prefix test, silently measure the DEV flavour, and
// report a base ~2.5 kB heavier than it is.
const SRC_ROOT = realpathSync(env.ATTAFORM_EAGER_SRC_ROOT ?? ROOT)

// Resolve esbuild from the pnpm store. It is a transitive dep (not in
// top-level node_modules), and several versions can coexist; pick the
// newest by numeric semver so a version bump needs no edit here.
function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
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

const V4 = join(SRC_ROOT, 'src', 'zod-v4.ts').replace(/\\/g, '/')

// Exercise the full minimal-useForm surface so tree-shaking keeps the
// real eager set. A bare `import { useForm }` with no uses would shake
// most of it away and under-measure.
const SCENARIO = `import { useForm } from '${V4}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`

const PROD_DEFINE = { 'process.env.NODE_ENV': '"production"' }

/**
 * Source-level `__DEV__` strip, mirroring the devFlagStripPlugin in
 * build.config.ts: drop the solo named-import line, inline the literal.
 * With every importer's import removed, core/dev.ts falls out of the
 * graph entirely (its own body is never rewritten, so no special case
 * is needed here — esbuild simply never loads it).
 * @param {boolean} flag
 */
const devFlagStripPlugin = (flag) => ({
  name: 'attaform-dev-flag-strip',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      const posixPath = args.path.replace(/\\/g, '/')
      if (!posixPath.startsWith(SRC_ROOT.replace(/\\/g, '/') + '/src/')) return null
      const text = readFileSync(args.path, 'utf8')
      if (!/\b__DEV__\b/.test(text)) return null
      const out = text
        .replace(/^import\s*\{\s*__DEV__\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, '')
        .replace(/\b__DEV__\b/g, String(flag))
      return { contents: out, loader: 'ts' }
    })
  },
})

/**
 * Build the scenario with code-splitting and return the eager/async
 * byte split plus the per-chunk input lists (so callers can assert a
 * module is or isn't on a given path) and the concatenated output text
 * (so callers can assert a dev-only string was dead-code-eliminated).
 * The `define` doubles as the flavor selector for the source strip.
 * @param {Record<string, string>} define
 */
export async function measureEager(define = PROD_DEFINE) {
  const prodFlavor = define['process.env.NODE_ENV'] === '"production"'
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    platform: 'neutral',
    packages: 'external',
    splitting: true,
    define,
    plugins: [devFlagStripPlugin(!prodFlavor)],
    metafile: true,
    write: false,
    outdir: 'out',
    legalComments: 'none',
    logLevel: 'silent',
  })
  const fileOf = (k) => k.replace(/^.*\//, '')
  const byPath = new Map(r.outputFiles.map((f) => [fileOf(f.path), f.text]))
  const outputs = {}
  for (const [k, v] of Object.entries(r.metafile.outputs)) outputs[fileOf(k)] = v

  const entryKey =
    Object.keys(outputs).find((k) => outputs[k].entryPoint === '<stdin>') ||
    Object.keys(outputs).find((k) => k.startsWith('stdin'))
  const eager = new Set()
  const queue = [entryKey]
  while (queue.length) {
    const cur = queue.shift()
    if (eager.has(cur) || !outputs[cur]) continue
    eager.add(cur)
    for (const imp of outputs[cur].imports || []) {
      const t = fileOf(imp.path)
      if (imp.kind === 'import-statement' && outputs[t]) queue.push(t)
    }
  }
  const asyncSet = Object.keys(outputs).filter((k) => !eager.has(k))

  // Reachable set: BFS over ANY edge kind (statement or dynamic-import).
  // A chunk that no edge reaches is an orphan esbuild emitted but nothing
  // loads (e.g. a dynamic import dead-code-eliminated behind `__DEV__`).
  const reachable = new Set()
  const rq = [entryKey]
  while (rq.length) {
    const cur = rq.shift()
    if (reachable.has(cur) || !outputs[cur]) continue
    reachable.add(cur)
    for (const imp of outputs[cur].imports || []) {
      const t = fileOf(imp.path)
      if (outputs[t]) rq.push(t)
    }
  }

  const gzOf = (k) => {
    const c = byPath.get(k)
    return c ? gzipSync(Buffer.from(c), { level: 9 }).length : 0
  }
  const sumGz = (set) => [...set].reduce((a, k) => a + gzOf(k), 0)
  const inputsOf = (set) => [...set].flatMap((k) => Object.keys(outputs[k].inputs || {}))

  return {
    eagerGz: sumGz(eager),
    asyncGz: sumGz([...asyncSet]),
    eagerInputs: inputsOf(eager),
    asyncInputs: inputsOf(asyncSet),
    // Inputs of every chunk a consumer actually loads. Excludes orphans,
    // so a `__DEV__`-gated dynamic import drops out of the prod build.
    reachableInputs: inputsOf(reachable),
    // Concatenated text of the eager chunks only (where the eager `import`
    // call sites live). Excludes orphan chunk bodies, so a dev-only string
    // that was dead-code-eliminated is genuinely absent here.
    eagerText: [...eager].map((k) => byPath.get(k) || '').join('\n'),
  }
}

// Committed eager budget (gz bytes) for a minimal `useForm` (zod-v4):
// what a consumer pays on first paint, before any lazy feature runs.
//
// Every move of this number, with its measurement and its reason, is in
// `scripts/EAGER-BUDGET-LEDGER.md`. Add an entry there when you move it;
// it is the record, and this is the gate.
//
// The rules, which have not changed:
//
//   - this ratchet is the only byte authority, ledger arithmetic is not;
//   - tighten at every phase boundary, to the new measurement plus about
//     0.3 kB of minifier-drift headroom;
//   - never loosen without a recorded reason, priced against what the
//     bytes bought.
//
// Currently at 33,758 B measured. Last moved UP, 33_450 -> 34_050, by the
// E4 heap-and-hot-paths phase (2026-09-16): +608 B of eager for -22% of a
// form's heap, -36% on a read-swept 100-leaf form, and a 400-row
// `form.list()` going from 278 ms per keystroke to 7.4 ms. Against `main`
// the branch is still 750 B smaller. See the ledger for the full pricing.
const BUDGET_GZ = 33_400

const isMain = import.meta.url === pathToFileURL(realpathSync(argv[1])).href
if (isMain) {
  const { eagerGz, asyncGz } = await measureEager()
  const kb = (b) => (b / 1024).toFixed(2)
  console.log(`eager (minimal useForm, zod-v4, prod): ${kb(eagerGz)} kB gz (${eagerGz} B)`)
  console.log(`async (lazy chunks):                   ${kb(asyncGz)} kB gz`)
  console.log(`budget:                                ${kb(BUDGET_GZ)} kB gz`)
  if (eagerGz > BUDGET_GZ) {
    console.error(`\n✗ eager budget exceeded by ${kb(eagerGz - BUDGET_GZ)} kB gz`)
    exit(1)
  }
  console.log(`\n✓ within budget (${kb(BUDGET_GZ - eagerGz)} kB gz headroom)`)
}
