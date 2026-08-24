// Per-source-file byte attribution of the eager bundle, using the same
// methodology as scripts/check-eager-size.mjs (splitting build, prod define,
// minified, follow import-statement edges from the stdin entry).
import { gzipSync } from 'node:zlib'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/ozzy/Projects/attaform'

function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  const parts = (d) => d.slice('esbuild@'.length).split('.').map((n) => parseInt(n, 10))
  dirs.sort((a, b) => { const A = parts(a), B = parts(b); return A[0]-B[0]||A[1]-B[1]||A[2]-B[2] })
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

const scenarioName = process.argv[2] || 'v4'
const V4 = join(ROOT, 'src', 'zod-v4.ts')
const V3 = join(ROOT, 'src', 'zod-v3.ts')
const ZOD = join(ROOT, 'src', 'zod.ts')
const IDX = join(ROOT, 'src', 'index.ts')
const ABS = join(ROOT, 'src', 'abstract.ts')

const MINIMAL = (entry) => `import { useForm } from '${entry}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`

const SCENARIOS = {
  v4: MINIMAL(V4),
  v3: MINIMAL(V3),
  zod: MINIMAL(ZOD),
  index: MINIMAL(IDX),
  abstract: `import { useAbstractForm } from '${ABS}'
export const make = (s) => { const f = useAbstractForm({ schema: s, key: 'k' }); return [f.values, f.errors, f.register('x'), f.handleSubmit(() => {}), f.meta] }`,
  wizard: `import { useForm, useWizard } from '${V4}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  const w = useWizard({ steps: [f], key: 'w' })
  return [f.values, w.activeForm, w.tryNext(), w.handleSubmit(() => {}), w.allValues, w.forms]
}`,
  everything: `export * from '${IDX}'`,
}

// P1a alignment: apply the same source-level __DEV__ strip the package
// build and scripts/check-eager-size.mjs use, so attribution numbers match
// shipped prod-flavor bytes (the define-only fold under-strips).
import { readFileSync } from 'node:fs'
const stripPlugin = {
  name: 'dev-flag-strip',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(ROOT + '/src/')) return null
      const text = readFileSync(args.path, 'utf8')
      if (!/\b__DEV__\b/.test(text)) return null
      const out = text
        .replace(/^import\s*\{\s*__DEV__\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, '')
        .replace(/\b__DEV__\b/g, 'false')
      return { contents: out, loader: 'ts' }
    })
  },
}

const r = await esbuild.build({
  stdin: { contents: SCENARIOS[scenarioName], loader: 'ts', resolveDir: ROOT },
  bundle: true, minify: true, format: 'esm', target: 'es2020', platform: 'neutral',
  packages: 'external', splitting: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [stripPlugin],
  metafile: true, write: false, outdir: 'out', legalComments: 'none', logLevel: 'silent',
})

const fileOf = (k) => k.replace(/^.*\//, '')
const byPath = new Map(r.outputFiles.map((f) => [fileOf(f.path), f.text]))
const outputs = {}
for (const [k, v] of Object.entries(r.metafile.outputs)) outputs[fileOf(k)] = v
const entryKey = Object.keys(outputs).find((k) => outputs[k].entryPoint === '<stdin>') || Object.keys(outputs).find((k) => k.startsWith('stdin'))
const eager = new Set(); const q = [entryKey]
while (q.length) { const c = q.shift(); if (eager.has(c) || !outputs[c]) continue; eager.add(c)
  for (const imp of outputs[c].imports || []) { const t = fileOf(imp.path); if (imp.kind === 'import-statement' && outputs[t]) q.push(t) } }

// attribute: per chunk, gz ratio applied to each input's bytesInOutput
const attrib = new Map()
let eagerRaw = 0, eagerGz = 0
for (const k of eager) {
  const text = byPath.get(k) || ''
  const raw = Buffer.byteLength(text)
  const gz = gzipSync(Buffer.from(text), { level: 9 }).length
  eagerRaw += raw; eagerGz += gz
  const ratio = raw ? gz / raw : 0
  for (const [inp, meta] of Object.entries(outputs[k].inputs || {})) {
    const cur = attrib.get(inp) || { raw: 0, gz: 0 }
    cur.raw += meta.bytesInOutput
    cur.gz += meta.bytesInOutput * ratio
    attrib.set(inp, cur)
  }
}

const rows = [...attrib.entries()].map(([f, v]) => ({ file: f, raw: v.raw, gz: Math.round(v.gz) })).sort((a, b) => b.gz - a.gz)
const byDir = new Map()
for (const row of rows) {
  const d = row.file.replace(/\/[^/]*$/, '')
  const cur = byDir.get(d) || { raw: 0, gz: 0, n: 0 }
  cur.raw += row.raw; cur.gz += row.gz; cur.n++
  byDir.set(d, cur)
}
const dirRows = [...byDir.entries()].map(([d, v]) => ({ dir: d, raw: v.raw, gz: v.gz, n: v.n })).sort((a, b) => b.gz - a.gz)

console.log(`SCENARIO: ${scenarioName}`)
console.log(`eager total: raw=${eagerRaw} gz=${eagerGz} (${(eagerGz/1024).toFixed(2)} kB gz) chunks=${eager.size}`)
console.log('\n== BY DIRECTORY (gz-attributed bytes) ==')
for (const d of dirRows) console.log(`${String(Math.round(d.gz)).padStart(7)} gz ${String(d.raw).padStart(8)} raw  ${String(d.n).padStart(3)} files  ${d.dir}`)
console.log('\n== TOP 70 FILES (gz-attributed bytes) ==')
for (const row of rows.slice(0, 70)) console.log(`${String(row.gz).padStart(7)} gz ${String(row.raw).padStart(8)} raw  ${row.file}`)
