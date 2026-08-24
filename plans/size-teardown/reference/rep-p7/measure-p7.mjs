// P7 rep-first measurement: eager-gz deltas for the three P7 arms on
// the current tree (P8 boundary, anchor 34,530). Same methodology as
// scripts/check-eager-size.mjs / the P8 rep harness.
//
//   armA  sign-off 7: strip.ts loses getSlimSchema+stripRefinements;
//         default-values parses against original-or-stripAsync.
//   armB  introspect diet: kindOf alias table + data-driven walkSchemaTree.
//   armC  sign-off 6: class ZodV4AbstractSchema absorbs
//         abstract-schema-factory + the services record.
//   armD  all three (the phase's eager claim, pre-realization-discount).
import { gzipSync } from 'node:zlib'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = '/Users/ozzy/Projects/attaform'
const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(ROOT, 'src', 'runtime', 'core')
const V4 = join(ROOT, 'src', 'runtime', 'adapters', 'zod-v4')

function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  const parts = (d) => d.slice('esbuild@'.length).split('.').map((n) => parseInt(n, 10))
  dirs.sort((a, b) => { const A = parts(a), B = parts(b); return A[0]-B[0]||A[1]-B[1]||A[2]-B[2] })
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

const ENTRY = join(ROOT, 'src', 'zod-v4.ts')
const SCENARIO = `import { useForm } from '${ENTRY}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`

// basename (no ext) -> rep file, per arm flag.
const ARM_REDIRECTS = {
  a: { strip: 'strip-rep.ts', 'default-values': 'default-values-rep.ts' },
  b: { introspect: 'introspect-rep.ts' },
  c: { adapter: 'adapter-rep.ts' },
}

function activeRedirects(arms) {
  const map = {}
  for (const arm of arms) Object.assign(map, ARM_REDIRECTS[arm])
  return map
}

function makePlugin(arms) {
  const redirects = activeRedirects(arms)
  const resolveV4 = (name) =>
    redirects[name] !== undefined ? join(HERE, redirects[name]) : join(V4, name) + '.ts'
  return {
    name: 'p7-redirect',
    setup(build) {
      build.onResolve({ filter: /^V4\// }, (args) => ({ path: resolveV4(args.path.slice(3)) }))
      build.onResolve({ filter: /^CORE\// }, (args) => ({
        path: join(CORE, args.path.slice(5)) + '.ts',
      }))
      build.onResolve({ filter: /./ }, (args) => {
        if (args.kind === 'entry-point' || !args.path.startsWith('.')) return undefined
        const base = args.path.replace(/^.*\//, '')
        if (redirects[base] !== undefined && args.importer.includes('adapters/zod-v4')) {
          return { path: join(HERE, redirects[base]) }
        }
        return undefined
      })
    },
  }
}

async function measure(label, arms) {
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true, minify: true, format: 'esm', target: 'es2020', platform: 'neutral',
    packages: 'external', splitting: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true, write: false, outdir: 'out', legalComments: 'none', logLevel: 'warning',
    plugins: [makePlugin(arms)],
  })
  const fileOf = (k) => k.replace(/^.*\//, '')
  const byPath = new Map(r.outputFiles.map((f) => [fileOf(f.path), f.text]))
  const outputs = {}
  for (const [k, v] of Object.entries(r.metafile.outputs)) outputs[fileOf(k)] = v
  const entryKey = Object.keys(outputs).find((k) => outputs[k].entryPoint === '<stdin>') || Object.keys(outputs).find((k) => k.startsWith('stdin'))
  const eager = new Set(); const q = [entryKey]
  while (q.length) {
    const c = q.shift(); if (eager.has(c) || !outputs[c]) continue; eager.add(c)
    for (const imp of outputs[c].imports || []) {
      const t = fileOf(imp.path)
      if (imp.kind === 'import-statement' && outputs[t]) q.push(t)
    }
  }
  let raw = 0, gz = 0
  for (const k of eager) {
    const text = byPath.get(k) || ''
    raw += Buffer.byteLength(text)
    gz += gzipSync(Buffer.from(text), { level: 9 }).length
  }
  const inputs = new Set()
  for (const k of eager) for (const inp of Object.keys(outputs[k].inputs || {})) inputs.add(inp)
  const cluster = [...inputs].filter((i) =>
    /adapters\/zod-v4|abstract-schema-factory|-rep\.ts|walk-derive-default|walk-path-segments|walk-slim-primitives/.test(i)
  )
  console.log(`${label}: eager ${raw} raw / ${gz} gz`)
  for (const c of cluster.sort()) console.log('   in-bundle:', c)
  return gz
}

const base = await measure('baseline', [])
const a = await measure('armA-strip-diet', ['a'])
const b = await measure('armB-introspect-diet', ['b'])
const c = await measure('armC-class-adapter', ['c'])
const d = await measure('armD-all', ['a', 'b', 'c'])
console.log('\ndelta armA (sign-off 7):', base - a)
console.log('delta armB (introspect):', base - b)
console.log('delta armC (sign-off 6):', base - c)
console.log('delta armD (all):       ', base - d)
console.log('armD scaled x0.6 (P8 realization discount):', Math.round((base - d) * 0.6))
