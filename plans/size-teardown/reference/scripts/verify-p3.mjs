// P3 pre-measure, verify-unweld methodology: stub the history weld out of
// use-abstract-form.ts (simulating the historyPlugin DI seam) and measure the
// eager delta. history.ts leaves the graph; esbuild then tree-shakes
// applyPatchesForward/Inverse out of diff-apply.ts and deleteAtPath out of
// path-walker.ts (history was their only importer), so this single stub
// captures the full (a)-half eager credit. The (b) arrays consolidation is
// not stub-measurable; its credit comes from the ratchet after landing.
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

const UAF_PATH = join(ROOT, 'src', 'runtime', 'composables', 'use-abstract-form.ts')

// Stub: same module-cache semantics, no createHistoryModule import — the
// wiring goes through an attach() call on the (opaque) config object, which
// is exactly the historyPlugin protocol shape.
const stubHistoryWeld = {
  name: 'stub-history-weld',
  setup(build) {
    build.onLoad({ filter: /composables\/use-abstract-form\.ts$/ }, (args) => {
      if (args.path !== UAF_PATH) return null
      let src = readFileSync(UAF_PATH, 'utf8')
      src = src.replace(
        "import { createHistoryModule, type HistoryModule } from '../core/history'\n",
        ''
      )
      src = src.replace(
        'const historyModule = createHistoryModule(state, merged.history)',
        'const historyModule = (merged.history as { attach: (s: unknown) => never }).attach(state)'
      )
      src = src.replace(
        'state.modules.get(HISTORY_MODULE_KEY) as HistoryModule | undefined',
        'state.modules.get(HISTORY_MODULE_KEY) as never'
      )
      if (src.includes('createHistoryModule')) {
        throw new Error('residual createHistoryModule ref')
      }
      return {
        contents: stripDevFlag(src),
        loader: 'ts',
        resolveDir: join(ROOT, 'src', 'runtime', 'composables'),
      }
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
const stub = await measure([stubHistoryWeld, stripPlugin])
console.log('baseline eager gz:', base.eagerGz)
console.log('stubbed  eager gz:', stub.eagerGz)
console.log('delta (a-half prediction):', base.eagerGz - stub.eagerGz)

const gone = base.eagerInputs.filter((i) => !stub.eagerInputs.includes(i))
console.log('\nmodules removed from eager set:')
for (const g of gone) console.log('  ', g)
const added = stub.eagerInputs.filter((i) => !base.eagerInputs.includes(i))
console.log('modules ADDED:', added)
console.log('\nhistory gone:', !stub.eagerInputs.some((i) => i.includes('core/history')))
console.log('diff-apply still eager:', stub.eagerInputs.some((i) => i.includes('diff-apply')))
console.log('path-walker still eager:', stub.eagerInputs.some((i) => i.includes('path-walker')))
