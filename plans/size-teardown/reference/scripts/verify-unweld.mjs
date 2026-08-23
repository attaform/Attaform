// P2 re-measure, aligned with the P1a methodology: the same source-level
// __DEV__ strip the package build and scripts/check-eager-size.mjs apply
// (import-line removal + literal inline) runs on every src module, including
// the stubbed plugin.ts, so baseline/stubbed both measure shipped
// prod-flavor bytes. Baseline must reproduce the ratchet number exactly.
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/ozzy/Projects/attaform'

const stripDevFlag = (text) =>
  text
    .replace(/^import\s*\{\s*__DEV__\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, '')
    .replace(/\b__DEV__\b/g, 'false')

const stripPlugin = {
  name: 'dev-flag-strip',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(ROOT + '/src/')) return null
      const text = readFileSync(args.path, 'utf8')
      if (!/\b__DEV__\b/.test(text)) return null
      return { contents: stripDevFlag(text), loader: 'ts' }
    })
  },
}

function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  dirs.sort()
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

const V4 = join(ROOT, 'src', 'zod-v4.ts').replace(/\\/g, '/')
const SCENARIO = `import { useForm } from '${V4}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`
const PROD_DEFINE = { 'process.env.NODE_ENV': '"production"' }

const PLUGIN_PATH = join(ROOT, 'src', 'runtime', 'core', 'plugin.ts')

// Stub: same registry semantics, no vRegister import / app.directive call.
// Applies the dev-flag strip itself: esbuild gives the load to the first
// plugin whose onLoad returns content, so stripPlugin never sees plugin.ts.
const stubPlugin = {
  name: 'stub-plugin-ts',
  setup(build) {
    build.onLoad({ filter: /runtime\/core\/plugin\.ts$/ }, (args) => {
      if (args.path !== PLUGIN_PATH) return null
      let src = readFileSync(PLUGIN_PATH, 'utf8')
      src = src.replace("import { vRegister } from './directive'\n", '')
      src = src.replace("app.directive('register', vRegister)", '/* directive un-weld */')
      if (src.includes('vRegister')) throw new Error('residual vRegister ref: ' + src.match(/.*vRegister.*/g))
      return { contents: stripDevFlag(src), loader: 'ts', resolveDir: join(ROOT, 'src', 'runtime', 'core') }
    })
  },
}

async function measure(plugins) {
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    platform: 'neutral',
    packages: 'external',
    splitting: true,
    define: PROD_DEFINE,
    metafile: true,
    write: false,
    outdir: 'out',
    legalComments: 'none',
    logLevel: 'silent',
    plugins,
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
  const gzOf = (k) => {
    const c = byPath.get(k)
    return c ? gzipSync(Buffer.from(c), { level: 9 }).length : 0
  }
  const eagerGz = [...eager].reduce((a, k) => a + gzOf(k), 0)
  const eagerInputs = [...eager].flatMap((k) => Object.keys(outputs[k].inputs || {}))
  return { eagerGz, eagerInputs }
}

const base = await measure([stripPlugin])
const stub = await measure([stubPlugin, stripPlugin])
console.log('baseline eager gz:', base.eagerGz)
console.log('stubbed  eager gz:', stub.eagerGz)
console.log('delta:', base.eagerGz - stub.eagerGz)

const gone = base.eagerInputs.filter((i) => !stub.eagerInputs.includes(i))
console.log('\nmodules removed from eager set:')
for (const g of gone) console.log('  ', g)
const added = stub.eagerInputs.filter((i) => !base.eagerInputs.includes(i))
console.log('modules ADDED:', added)
// sanity: directive gone, store dom-binding still present
console.log('\nstore still eager:', stub.eagerInputs.some((i) => i.includes('create-form-store')))
console.log('register-api still eager:', stub.eagerInputs.some((i) => i.includes('register-api')))
