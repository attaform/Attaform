// Adversarial reproduction of the dev/prod dual-dist claim.
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/ozzy/Projects/attaform'

function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  const parts = (d) => d.slice('esbuild@'.length).split('.').map((n) => parseInt(n, 10))
  dirs.sort((a, b) => {
    const [A0, A1, A2] = parts(a); const [B0, B1, B2] = parts(b)
    return A0 - B0 || A1 - B1 || A2 - B2
  })
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

const V4 = join(ROOT, 'src', 'zod-v4.ts')
const SCENARIO = `import { useForm } from '${V4}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`

const PROD = { 'process.env.NODE_ENV': '"production"' }
const DEV = { 'process.env.NODE_ENV': '"development"' }

// True-strip plugin: textually replace the __DEV__ identifier with false
// in every source file BEFORE parse, so esbuild's own branch elimination
// sees literal `if (false)`. This simulates a package-build-time strip.
const stripPlugin = {
  name: 'dev-strip',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(ROOT + '/src/')) return null
      let text = readFileSync(args.path, 'utf8')
      if (!/\b__DEV__\b/.test(text)) return null
      text = text.replace(/^import\s*\{\s*__DEV__\s*\}\s*from\s*'[^']*'\s*;?\s*$/gm, '')
      text = text.replace(/\b__DEV__\b/g, 'false')
      return { contents: text, loader: 'ts' }
    })
  },
}

async function measure(define, plugins = [], minify = true) {
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true, minify, format: 'esm', target: 'es2020',
    platform: 'neutral', packages: 'external', splitting: true,
    define, metafile: true, write: false, outdir: 'out',
    legalComments: 'none', logLevel: 'silent', plugins,
  })
  const fileOf = (k) => k.replace(/^.*\//, '')
  const byPath = new Map(r.outputFiles.map((f) => [fileOf(f.path), f.text]))
  const outputs = {}
  for (const [k, v] of Object.entries(r.metafile.outputs)) outputs[fileOf(k)] = v
  const entryKey =
    Object.keys(outputs).find((k) => outputs[k].entryPoint === '<stdin>') ||
    Object.keys(outputs).find((k) => k.startsWith('stdin'))
  const eager = new Set(); const queue = [entryKey]
  while (queue.length) {
    const cur = queue.shift()
    if (eager.has(cur) || !outputs[cur]) continue
    eager.add(cur)
    for (const imp of outputs[cur].imports || []) {
      const t = fileOf(imp.path)
      if (imp.kind === 'import-statement' && outputs[t]) queue.push(t)
    }
  }
  const gz = (t) => gzipSync(Buffer.from(t), { level: 9 }).length
  let eagerGz = 0, eagerRaw = 0
  const texts = []
  for (const k of eager) {
    const t = byPath.get(k) || ''
    eagerGz += gz(t); eagerRaw += Buffer.byteLength(t); texts.push(t)
  }
  const eagerInputs = [...eager].flatMap((k) => Object.keys(outputs[k].inputs || {}))
  return { eagerGz, eagerRaw, eagerText: texts.join('\n'), eagerInputs, eagerChunks: [...eager].map(k => byPath.get(k) || '') }
}

// Second-pass minify: re-minify each already-minified eager chunk as a
// standalone file. After bundling, __DEV__ is a chunk-local const, so this
// approximates what a scope-hoisting bundler + minifier (Vite prod,
// webpack+terser with concatenation) can fold that single-pass esbuild misses.
async function reMinify(chunks) {
  let gzTotal = 0
  for (const c of chunks) {
    const out = await esbuild.transform(c, { minify: true, target: 'es2020', format: 'esm', logLevel: 'silent' })
    gzTotal += gzipSync(Buffer.from(out.code), { level: 9 }).length
  }
  return gzTotal
}

const [prod, dev, strip] = await Promise.all([
  measure(PROD), measure(DEV), measure(PROD, [stripPlugin]),
])

console.log('baseline prod eager gz:', prod.eagerGz, 'raw:', prod.eagerRaw)
console.log('dev define eager gz:   ', dev.eagerGz)
console.log('true-strip eager gz:   ', strip.eagerGz)
console.log('leak (prod - strip):   ', prod.eagerGz - strip.eagerGz)
console.log('dev mass (dev - strip):', dev.eagerGz - strip.eagerGz)

console.log('\n--- leak markers in baseline prod eagerText ---')
const t = prod.eagerText
console.log('if(!1) count:', (t.match(/if\(!1\)/g) || []).length)
console.log('!1&& count:  ', (t.match(/!1&&/g) || []).length)
console.log('[attaform] count:', (t.match(/\[attaform\]/g) || []).length)
console.log('dev-stack-trace eager:', prod.eagerInputs.some((i) => i.includes('dev-stack-trace')))
console.log('strip: [attaform] count:', (strip.eagerText.match(/\[attaform\]/g) || []).length)
console.log('strip: dev-stack-trace eager:', strip.eagerInputs.some((i) => i.includes('dev-stack-trace')))

const prod2 = await reMinify(prod.eagerChunks)
const strip2 = await reMinify(strip.eagerChunks)
console.log('\n--- second-pass minify (scope-hoisted consumer simulation) ---')
console.log('prod re-minified eager gz:', prod2)
console.log('strip re-minified eager gz:', strip2)
console.log('residual leak after 2nd pass:', prod2 - strip2)
