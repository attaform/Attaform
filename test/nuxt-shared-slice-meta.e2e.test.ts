import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * End-to-end proof for #577, against a REAL production build.
 *
 * A schema that registers field metadata from a module in Nuxt's
 * `shared/` directory lost that metadata on the server only: the label
 * resolved on the client and fell back to the humanised path during
 * SSR. Two faults stacked, and neither is visible to a unit render
 * because neither exists until after bundling:
 *
 *  1. `shared/` is compiled by Nitro while the page that reads the
 *     metadata comes from the Vite SSR pass, so attaform is inlined
 *     into both and the field-meta store's `WeakMap`s split in two.
 *     `.register(fieldMeta, ...)` wrote one copy, the resolver read
 *     the other. This is the load-bearing fault: the schema instance
 *     is shared across the two graphs, only the module state was not.
 *
 *  2. The path-map builder rode a module-scoped slot installed from
 *     `fieldMeta.add`. In a registration-only graph nothing reads that
 *     slot, so the write is a provably dead store and Rollup dropped
 *     the install call along with the entire walk.
 *
 * Both are closed by carrying the state in a cross-copy slot (see
 * `src/runtime/core/cross-copy-state.ts`).
 * `test/core/cross-copy-state.test.ts` pins that invariant cheaply on
 * every run; this file pins the symptom in the topology that produced
 * it, and is the only thing here that would catch a NEW way for the
 * two to come apart.
 *
 * Why the build is driven here rather than through
 * `@nuxt/test-utils`'s `setup({ build: true })`: that helper returned
 * a passing render in ~5s without ever emitting `.output/`, so the
 * spec was green against no production build at all. The bug does not
 * exist until after bundling, so a harness that may skip the bundle
 * cannot be trusted to hold this line. `nuxi build` plus the emitted
 * node server is visibly the real thing.
 *
 * Runs only against a real build (skipped while dist/ holds
 * `unbuild --stub` shims), the same guard as
 * `nuxt-dist-flavor.e2e.test.ts`: the fixture resolves attaform
 * through its real exports map.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const distIndex = join(repoRoot, 'dist', 'index.mjs')
const isRealBuild =
  existsSync(distIndex) && !/from\s*['"][^'"]*jiti[^'"]*['"]/.test(readFileSync(distIndex, 'utf-8'))

const fixtureDir = fileURLToPath(new URL('./fixtures/shared-slice-meta', import.meta.url))
const serverEntry = join(fixtureDir, '.output', 'server', 'index.mjs')
const PORT = 4577

async function waitForServer(url: string, attempts: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`production server never answered on ${url}`)
}

describe.skipIf(!isRealBuild)('shared/ field metadata survives a production build (e2e)', () => {
  let server: ChildProcess | undefined

  beforeAll(async () => {
    // Always build from clean: a stale .output would let this spec pass
    // against an artifact the current source never produced.
    rmSync(join(fixtureDir, '.nuxt'), { recursive: true, force: true })
    rmSync(join(fixtureDir, '.output'), { recursive: true, force: true })
    execFileSync(join(repoRoot, 'node_modules', '.bin', 'nuxi'), ['build'], {
      cwd: fixtureDir,
      stdio: 'pipe',
      timeout: 600_000,
    })
    expect(existsSync(serverEntry), 'nuxi build produced no .output/server').toBe(true)
    server = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'pipe',
    })
    await waitForServer(`http://localhost:${PORT}/`, 120)
  }, 900_000)

  afterAll(() => {
    server?.kill()
  })

  it('SSR renders the registered label, not the humanised path', async () => {
    const html = await (await fetch(`http://localhost:${PORT}/`)).text()
    const label = /<label[^>]*id="lbl"[^>]*>([^<]*)</.exec(html)?.[1]
    // 'First Name' is what a split store produces. Naming it keeps a
    // failure self-explanatory.
    expect(label).toBe('Given name')
  })

  it('the emitted Nitro bundle keeps the walk and one shared state slot', () => {
    const chunkDir = join(fixtureDir, '.output', 'server', 'chunks', 'build')
    const pages = readFileSync(
      join(
        chunkDir,
        execFileSync('ls', [chunkDir], { encoding: 'utf-8' })
          .split('\n')
          .filter((f) => f.startsWith('pages-') && f.endsWith('.mjs'))[0] ?? ''
      ),
      'utf-8'
    )
    // Fault 2: the install call and the walk it pulls in must survive
    // tree-shaking of the registration-only slice.
    expect(pages).toContain('installFieldMetaPathMapBuilder')
    expect(pages).toContain('walkForMeta')
    // Fault 1: attaform is still inlined into both passes, so the
    // module copies remain. They must agree on one state slot.
    expect(pages).toContain('attaform:field-meta-state')
  })
})
