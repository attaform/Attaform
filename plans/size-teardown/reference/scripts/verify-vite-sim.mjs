// Simulate a Vite-class consumer: flat (scope-hoisted) bundle, unminified,
// prod define applied, THEN a single minify pass over the flat file.
// This answers whether esbuild's minifier propagates the file-local
// `const __DEV__ = (typeof process!=="undefined"?"production":"production")!=="production"`
// into branch elimination when it owns the whole scope.
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/ozzy/Projects/attaform'
function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  const parts = (d) => d.slice('esbuild@'.length).split('.').map((n) => parseInt(n, 10))
  dirs.sort((a, b) => { const [A0,A1,A2]=parts(a); const [B0,B1,B2]=parts(b); return A0-B0||A1-B1||A2-B2 })
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

async function flatBundle(plugins = []) {
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true, minify: false, format: 'esm', target: 'es2020',
    platform: 'neutral', packages: 'external', splitting: false,
    define: PROD, write: false, outdir: 'out', legalComments: 'none',
    logLevel: 'silent', plugins,
  })
  return r.outputFiles[0].text
}

const gz = (t) => gzipSync(Buffer.from(t), { level: 9 }).length

const flat = await flatBundle()
const flatStrip = await flatBundle([stripPlugin])

// Does the flat unminified output keep __DEV__ as a named const?
const devConstMatch = flat.match(/__DEV__\s*=\s*[^;]+;/)
console.log('flat __DEV__ decl:', devConstMatch ? devConstMatch[0].slice(0, 120) : 'NOT FOUND (inlined)')

const min = await esbuild.transform(flat, { minify: true, target: 'es2020', format: 'esm' })
const minStrip = await esbuild.transform(flatStrip, { minify: true, target: 'es2020', format: 'esm' })

console.log('vite-sim prod gz:      ', gz(min.code))
console.log('vite-sim strip gz:     ', gz(minStrip.code))
console.log('vite-sim leak:         ', gz(min.code) - gz(minStrip.code))
console.log('markers in vite-sim prod: if(!1):', (min.code.match(/if\(!1\)/g)||[]).length,
  ' !1&&:', (min.code.match(/!1&&/g)||[]).length,
  ' [attaform]:', (min.code.match(/\[attaform\]/g)||[]).length,
  ' __DEV__ survives:', /__DEV__/.test(min.code))
console.log('markers in vite-sim strip: [attaform]:', (minStrip.code.match(/\[attaform\]/g)||[]).length)

// Terser-class check unavailable (no terser install allowed) — esbuild minify
// on the flat file is Vite's actual default pipeline anyway.
