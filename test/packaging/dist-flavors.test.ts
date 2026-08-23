import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Structural gates on the dev/prod dual dist (size-teardown P1a).
 *
 * The package ships the runtime twice: dist/* is the prod flavor with
 * `__DEV__` resolved to `false` at package build, dist/dev/* the dev
 * flavor with `true`, served through the `development` export condition.
 * These tests walk each flavor's import closure from its runtime entries
 * and assert the properties the split exists for:
 *
 *   - the prod closure is genuinely stripped: no `__DEV__`, no
 *     `process.env.NODE_ENV`, no `typeof process` (CDN safety), no
 *     dev-stack-trace machinery, and no `[attaform]` prose beyond the
 *     intentional production messages;
 *   - the dev closure actually carries the diagnostic surface;
 *   - the flavors are isolated module graphs (a relative import that
 *     crossed flavors would mean two registry instances in one app);
 *   - each flavor defines the registry-installing plugin exactly once
 *     (the module-level guarantee behind "one registry per app").
 *
 * Like exports.test.ts, skipped against a stubbed dist; `pnpm check`
 * exercises it after `check:size` produces the real build.
 */

const repoRoot = join(__dirname, '..', '..')
const distDir = join(repoRoot, 'dist')

const isRealBuild =
  existsSync(join(distDir, 'index.mjs')) &&
  !/from\s*['"][^'"]*jiti[^'"]*['"]/.test(readFileSync(join(distDir, 'index.mjs'), 'utf-8'))

/** Runtime entries per flavor; tooling entries stay single-flavor. */
const RUNTIME_ENTRIES = [
  'index.mjs',
  'zod.mjs',
  'zod-v3.mjs',
  'zod-v4.mjs',
  'abstract.mjs',
  'directive.mjs',
  'runtime/plugins/attaform.mjs',
]

/**
 * Transitive closure over relative imports, both static (`from './x'`)
 * and dynamic (`import('./x')`), so lazily-loaded chunks (fingerprint,
 * devtools, key-collision warnings) are part of the walked graph.
 */
function closureFiles(baseDir: string): string[] {
  const seen = new Set<string>()
  const stack = RUNTIME_ENTRIES.map((entry) => join(baseDir, entry))
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || seen.has(current) || !existsSync(current)) continue
    seen.add(current)
    const src = readFileSync(current, 'utf-8')
    for (const match of src.matchAll(/from\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec !== undefined) stack.push(join(current, '..', spec))
    }
    for (const match of src.matchAll(/import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      const spec = match[1]
      if (spec !== undefined) stack.push(join(current, '..', spec))
    }
  }
  return [...seen]
}

/**
 * The intentional production `[attaform]` messages across the WHOLE prod
 * runtime closure: the eager-path list from dev-dce.test.ts plus the two
 * zod-v3 walker invariants that only the v3/unified entries reach. P1b
 * converts most of these to AF## codes — additions here are reviewed,
 * never incidental.
 */
const PROD_PROSE_ALLOWLIST = [
  '[attaform] useForm received an invalid configuration',
  '[attaform] No registry attached to this Vue app',
  '[attaform] useForm / injectForm called outside Vue setup()',
  '[attaform] Form key ',
  '[attaform] onFormChange threw:',
  '[attaform] onSubmitSuccess threw:',
  '[attaform] cleanup threw:',
  '[attaform] onReset threw:',
  '[attaform] form.rehydrate(): no defaultValues factory was captured',
  '[attaform] resetField: leaf write rejected for path ',
  '[attaform] resetField: subtree write rejected at path ',
  '[attaform] transform error',
  '[attaform] transform result for path ',
  '[attaform] zod-v3 adapter: no schema at path ',
  '[attaform] zod-v3 adapter: unsupported schema kind ',
]

describe.skipIf(!isRealBuild)('packaging: dev/prod flavor split', () => {
  const prodFiles = closureFiles(distDir)
  const devFiles = closureFiles(join(distDir, 'dev'))
  const prodText = prodFiles.map((f) => readFileSync(f, 'utf-8')).join('\n')
  const devText = devFiles.map((f) => readFileSync(f, 'utf-8')).join('\n')

  it('both flavors ship every runtime entry', () => {
    for (const entry of RUNTIME_ENTRIES) {
      expect(existsSync(join(distDir, entry)), `dist/${entry}`).toBe(true)
      expect(existsSync(join(distDir, 'dev', entry)), `dist/dev/${entry}`).toBe(true)
    }
  })

  it('prod closure contains no dev flag or process reads', () => {
    expect(prodText).not.toMatch(/\b__DEV__\b/)
    expect(prodText).not.toContain('process.env.NODE_ENV')
    expect(prodText).not.toContain('typeof process')
  })

  it('dev closure resolves the flag statically too (no process reads)', () => {
    // The dev flavor is unconditionally dev — flavor selection happens at
    // resolution time via the `development` condition, never at runtime.
    expect(devText).not.toMatch(/\b__DEV__\b/)
    expect(devText).not.toContain('process.env.NODE_ENV')
    expect(devText).not.toContain('typeof process')
  })

  it('prod closure [attaform] prose stays within the allowlist', () => {
    const found = [...new Set(prodText.match(/\[attaform\][^"'`]*/g) ?? [])]
    const offenders = found.filter(
      (s) => !PROD_PROSE_ALLOWLIST.some((prefix) => s.startsWith(prefix))
    )
    expect(offenders).toEqual([])
  })

  it('prod closure carries no dev diagnostic machinery', () => {
    expect(prodText).not.toContain('captureUserCallSite')
    expect(prodText).not.toContain('createAttaform() install was called twice')
  })

  it('dev closure carries the diagnostic surface', () => {
    expect(devText).toContain('captureUserCallSite')
    expect(devText).toContain('createAttaform() install was called twice')
    expect(devText).toContain('Checkbox bound to an array model')
  })

  it('flavor graphs are isolated (no cross-flavor imports)', () => {
    const devDir = join(distDir, 'dev') + '/'
    const escapedProd = prodFiles.filter((f) => f.startsWith(devDir))
    const escapedDev = devFiles.filter((f) => !f.startsWith(devDir))
    expect(escapedProd).toEqual([])
    expect(escapedDev).toEqual([])
  })

  it('each flavor defines createAttaform exactly once', () => {
    // One definition per closure means one registry module per graph —
    // the property that keeps `useForm` and the Nuxt plugin on the same
    // registry instance no matter which flavor a bundler resolves.
    const definition = /function createAttaform\(/g
    expect(prodText.match(definition)).toHaveLength(1)
    expect(devText.match(definition)).toHaveLength(1)
  })

  it('the built Nuxt module selects the plugin flavor by nuxt.options.dev', () => {
    const nuxtModule = readFileSync(join(distDir, 'nuxt.mjs'), 'utf-8')
    expect(nuxtModule).toContain('./runtime/plugins/attaform')
    expect(nuxtModule).toContain('./dev/runtime/plugins/attaform')
  })
})
