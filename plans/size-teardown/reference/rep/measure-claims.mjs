// Adversarial verification: measure real eager-gz deltas for
//  (a) proxy-zoo replacement (values/errors/fields lean modules)
//  (b) loop-generated getter forests in build-form-api
// Same methodology as scripts/check-eager-size.mjs / attribution.mjs.
import { gzipSync } from 'node:zlib'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = '/Users/ozzy/Projects/attaform'
const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(ROOT, 'src', 'runtime', 'core')

function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  const parts = (d) => d.slice('esbuild@'.length).split('.').map((n) => parseInt(n, 10))
  dirs.sort((a, b) => { const A = parts(a), B = parts(b); return A[0]-B[0]||A[1]-B[1]||A[2]-B[2] })
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

const V4 = join(ROOT, 'src', 'zod-v4.ts')
const SCENARIO = `import { useForm } from '${V4}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`

const REDIRECTS_PROXY = {
  'errors-proxy': join(HERE, 'errors-rep.ts'),
  'field-state-proxy': join(HERE, 'fields-rep.ts'),
  'values-proxy': join(HERE, 'values-rep.ts'),
}

function makePlugin({ proxyRep, modBfa }) {
  return {
    name: 'redirect',
    setup(build) {
      // CORE/x imports inside replacement files.
      build.onResolve({ filter: /^CORE\// }, (args) => ({
        path: join(CORE, args.path.slice('CORE/'.length)) + '.ts',
      }))
      build.onResolve({ filter: /./ }, (args) => {
        if (args.kind === 'entry-point' || !args.path.startsWith('.')) return undefined
        const base = args.path.replace(/^.*\//, '')
        if (proxyRep && REDIRECTS_PROXY[base] && args.importer.includes('build-form-api')) {
          return { path: REDIRECTS_PROXY[base] }
        }
        if (modBfa && base === 'build-form-api') {
          return { path: join(HERE, 'build-form-api-mod.ts') }
        }
        // Relative imports written inside build-form-api-mod.ts (which
        // lives in scratchpad) must resolve against the real core dir.
        if (args.importer === join(HERE, 'build-form-api-mod.ts')) {
          return { path: join(CORE, args.path) + '.ts' }
        }
        return undefined
      })
    },
  }
}

async function measure(label, opts) {
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true, minify: true, format: 'esm', target: 'es2020', platform: 'neutral',
    packages: 'external', splitting: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true, write: false, outdir: 'out', legalComments: 'none', logLevel: 'warning',
    plugins: [makePlugin(opts)],
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
  // Confirm which proxy modules made it into the eager set.
  const inputs = new Set()
  for (const k of eager) for (const inp of Object.keys(outputs[k].inputs || {})) inputs.add(inp)
  const zoo = [...inputs].filter((i) => /surface-proxy|errors-proxy|field-state-proxy|values-proxy|callable-readonly|proxy-live-keys|proxy-readonly|-rep\.ts|build-form-api/.test(i))
  console.log(`${label}: eager ${raw} raw / ${gz} gz`)
  for (const z of zoo.sort()) console.log('   in-bundle:', z)
  return gz
}

const base = await measure('baseline', {})
const prox = await measure('proxy-replacement', { proxyRep: true })
const forest = await measure('forest-loops', { modBfa: true })
const both = await measure('both', { proxyRep: true, modBfa: true })
console.log('\ndelta proxy-replacement:', base - prox)
console.log('delta forest-loops:', base - forest)
console.log('delta both:', base - both)
