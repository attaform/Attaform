import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { attaform as rollupAttaform } from '../../src/rollup'
import { attaform as esbuildAttaform } from '../../src/esbuild'
import { attaform as webpackAttaform } from '../../src/webpack'
import { attaform as rspackAttaform } from '../../src/rspack'
import { detectZodMajor, resolveZodAliasTarget } from '../../src/core/detect-zod-major'

/**
 * Cross-bundler `attaform/zod` adapter-rewrite plugins (Block E).
 *
 * Each plugin is exercised against its bundler's hook in ISOLATION with a
 * stub context — no real bundler is spun up, so the suite needs no extra
 * bundler devDeps (webpack / rspack aren't installed, per the zero-dep
 * rule; esbuild is only transitively present). The stubs mirror the
 * minimal hook surface each plugin touches and assert the one thing the
 * plugin owns: rewriting the bare `attaform/zod` specifier to the matching
 * adapter subpath. Whether the bundler actually invokes the hook is the
 * bundler's contract, not attaform's.
 *
 * Per-test fixture roots carry a synthetic `node_modules/zod/package.json`
 * so detection resolves a controlled Zod version without touching the real
 * install (mirrors test/vite/resolve-alias.test.ts).
 */

let zodV4Root: string
let zodV3Root: string
let noZodRoot: string
let corruptZodRoot: string

function makeFixtureWithZod(name: string, zodVersion: string | null): string {
  const root = mkdtempSync(join(tmpdir(), `attaform-plugin-fixture-${name}-`))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: `${name}-fixture`, private: true }),
    'utf8'
  )
  if (zodVersion !== null) {
    const zodDir = join(root, 'node_modules', 'zod')
    mkdirSync(zodDir, { recursive: true })
    writeFileSync(
      join(zodDir, 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: zodVersion,
        main: './index.js',
        exports: { './package.json': './package.json', '.': './index.js' },
      }),
      'utf8'
    )
    writeFileSync(join(zodDir, 'index.js'), 'module.exports = {}\n', 'utf8')
  }
  return root
}

beforeAll(() => {
  zodV4Root = makeFixtureWithZod('zod-v4-only', '4.3.0')
  zodV3Root = makeFixtureWithZod('zod-v3-only', '3.24.0')
  noZodRoot = makeFixtureWithZod('no-zod', null)
  corruptZodRoot = makeFixtureWithZod('zod-corrupt', 'not-a-real-version')
})

describe('shared zod-major detection', () => {
  it('classifies installed Zod majors from the consumer root', () => {
    expect(detectZodMajor(zodV4Root)).toEqual({ major: 4 })
    expect(detectZodMajor(zodV3Root)).toEqual({ major: 3 })
    expect(detectZodMajor(noZodRoot)).toEqual({ major: 'missing' })
    expect(detectZodMajor(corruptZodRoot)).toEqual({ major: 'unknown' })
  })

  it('maps a detected major to its adapter subpath', () => {
    expect(resolveZodAliasTarget(zodV4Root, 'attaform/test', true, { warned: false })).toBe(
      'attaform/zod-v4'
    )
    expect(resolveZodAliasTarget(zodV3Root, 'attaform/test', true, { warned: false })).toBe(
      'attaform/zod-v3'
    )
  })

  it('returns null without throwing when resolveZodAlias is off (even with no zod)', () => {
    expect(resolveZodAliasTarget(noZodRoot, 'attaform/test', false, { warned: false })).toBeNull()
  })

  it('throws a branded error when zod is not installed', () => {
    expect(() =>
      resolveZodAliasTarget(noZodRoot, 'attaform/test', true, { warned: false })
    ).toThrow('[attaform/test] zod is not installed')
  })

  it('warns once across calls (not per call) and falls through on an unclassifiable version', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const warnState = { warned: false }
      expect(resolveZodAliasTarget(corruptZodRoot, 'attaform/test', true, warnState)).toBeNull()
      expect(resolveZodAliasTarget(corruptZodRoot, 'attaform/test', true, warnState)).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not classify the installed Zod major')
      )
    } finally {
      warn.mockRestore()
    }
  })
})

// ── Rollup ──────────────────────────────────────────────────────────
interface RollupResolveCtx {
  resolve(
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean }
  ): Promise<{ id: string; external: boolean } | null>
}

// The plugin's `resolveId` forwards through `this.resolve(...)`; echo the
// rewritten specifier back as `{ id }` so the test reads the chosen subpath
// without a real resolver.
const rollupCtx = (): RollupResolveCtx => ({ resolve: async (id) => ({ id, external: false }) })

describe('attaform/rollup — resolveId rewrite', () => {
  it('rewrites attaform/zod to the v4 subpath when zod@4 is installed', async () => {
    const plugin = rollupAttaform({ root: zodV4Root })
    plugin.buildStart()
    const resolved = await plugin.resolveId.call(rollupCtx(), 'attaform/zod', undefined)
    expect(resolved?.id).toBe('attaform/zod-v4')
  })

  it('rewrites attaform/zod to the v3 subpath when zod@3 is installed', async () => {
    const plugin = rollupAttaform({ root: zodV3Root })
    plugin.buildStart()
    const resolved = await plugin.resolveId.call(rollupCtx(), 'attaform/zod', undefined)
    expect(resolved?.id).toBe('attaform/zod-v3')
  })

  it('passes through explicit subpaths and the root entry unchanged', async () => {
    const plugin = rollupAttaform({ root: zodV4Root })
    plugin.buildStart()
    for (const source of ['attaform/zod-v3', 'attaform/zod-v4', 'attaform']) {
      expect(await plugin.resolveId.call(rollupCtx(), source, undefined)).toBeNull()
    }
  })

  it('throws at buildStart when zod is not installed', () => {
    expect(() => rollupAttaform({ root: noZodRoot }).buildStart()).toThrow(
      '[attaform/rollup] zod is not installed'
    )
  })

  it('does not rewrite (and does not throw) when resolveZodAlias is false', async () => {
    const plugin = rollupAttaform({ root: noZodRoot, resolveZodAlias: false })
    plugin.buildStart()
    expect(await plugin.resolveId.call(rollupCtx(), 'attaform/zod', undefined)).toBeNull()
  })
})

// ── esbuild ─────────────────────────────────────────────────────────
type EsbuildOnResolveCb = (args: {
  path: string
  importer: string
  resolveDir: string
  kind: string
}) => Promise<{ path?: string; external?: boolean; namespace?: string; errors?: unknown[] }>

function makeEsbuildBuild(): {
  build: Parameters<ReturnType<typeof esbuildAttaform>['setup']>[0]
  getCallback: () => EsbuildOnResolveCb | undefined
} {
  let cb: EsbuildOnResolveCb | undefined
  const build: Parameters<ReturnType<typeof esbuildAttaform>['setup']>[0] = {
    initialOptions: {},
    onResolve: (_options, callback) => {
      cb = callback
    },
    // Echo the re-resolved specifier so the test reads which subpath the
    // plugin asked esbuild to resolve.
    resolve: async (path) => ({
      path: `/resolved/${path}`,
      external: false,
      namespace: 'file',
      errors: [],
    }),
  }
  return { build, getCallback: () => cb }
}

describe('attaform/esbuild — onResolve rewrite', () => {
  it('re-resolves attaform/zod through the v4 subpath when zod@4 is installed', async () => {
    const { build, getCallback } = makeEsbuildBuild()
    esbuildAttaform({ root: zodV4Root }).setup(build)
    const cb = getCallback()
    if (cb === undefined) throw new Error('onResolve was not registered')
    const result = await cb({
      path: 'attaform/zod',
      importer: 'app.ts',
      resolveDir: '/app',
      kind: 'import-statement',
    })
    expect(result.path).toBe('/resolved/attaform/zod-v4')
  })

  it('throws at setup when zod is not installed', () => {
    const { build } = makeEsbuildBuild()
    expect(() => esbuildAttaform({ root: noZodRoot }).setup(build)).toThrow(
      '[attaform/esbuild] zod is not installed'
    )
  })

  it('registers no rewrite hook when resolveZodAlias is false', () => {
    const { build, getCallback } = makeEsbuildBuild()
    esbuildAttaform({ root: noZodRoot, resolveZodAlias: false }).setup(build)
    expect(getCallback()).toBeUndefined()
  })
})

// ── webpack / rspack (shared body) ──────────────────────────────────
interface ResolveData {
  request: string
}

function makeWebpackCompiler(root: string): {
  compiler: Parameters<ReturnType<typeof webpackAttaform>['apply']>[0]
  getBeforeResolve: () => ((data: ResolveData) => void) | undefined
} {
  let beforeResolve: ((data: ResolveData) => void) | undefined
  const compiler: Parameters<ReturnType<typeof webpackAttaform>['apply']>[0] = {
    context: root,
    hooks: {
      normalModuleFactory: {
        tap: (_name, factoryFn) => {
          factoryFn({
            hooks: {
              beforeResolve: {
                tap: (_hookName, fn) => {
                  beforeResolve = fn
                },
              },
            },
          })
        },
      },
    },
  }
  return { compiler, getBeforeResolve: () => beforeResolve }
}

const webpackFamily: ReadonlyArray<readonly [string, typeof webpackAttaform]> = [
  ['attaform/webpack', webpackAttaform],
  ['attaform/rspack', rspackAttaform],
]

describe.each(webpackFamily)('%s — beforeResolve rewrite', (tag, factory) => {
  it('rewrites the attaform/zod request to the v4 subpath when zod@4 is installed', () => {
    const { compiler, getBeforeResolve } = makeWebpackCompiler(zodV4Root)
    factory({ root: zodV4Root }).apply(compiler)
    const beforeResolve = getBeforeResolve()
    if (beforeResolve === undefined) throw new Error('beforeResolve was not tapped')
    const data = { request: 'attaform/zod' }
    beforeResolve(data)
    expect(data.request).toBe('attaform/zod-v4')
  })

  it('leaves explicit subpaths and unrelated requests unchanged', () => {
    const { compiler, getBeforeResolve } = makeWebpackCompiler(zodV3Root)
    factory({ root: zodV3Root }).apply(compiler)
    const beforeResolve = getBeforeResolve()
    if (beforeResolve === undefined) throw new Error('beforeResolve was not tapped')
    for (const request of ['attaform/zod-v3', 'attaform/zod-v4', 'attaform', 'vue']) {
      const data = { request }
      beforeResolve(data)
      expect(data.request).toBe(request)
    }
  })

  it('throws at apply when zod is not installed, branded by the plugin', () => {
    const { compiler } = makeWebpackCompiler(noZodRoot)
    expect(() => factory({ root: noZodRoot }).apply(compiler)).toThrow(
      `[${tag}] zod is not installed`
    )
  })

  it('taps no hook when resolveZodAlias is false', () => {
    const { compiler, getBeforeResolve } = makeWebpackCompiler(noZodRoot)
    factory({ root: noZodRoot, resolveZodAlias: false }).apply(compiler)
    expect(getBeforeResolve()).toBeUndefined()
  })
})
