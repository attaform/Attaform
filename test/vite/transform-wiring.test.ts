import vue from '@vitejs/plugin-vue'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig, type Plugin, type ResolvedConfig } from 'vite'
import { attaform } from '../../src/vite'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * Lock the load-bearing wiring contract for `attaform/vite`:
 *
 *   1. After `configResolved`, all four compile-time node transforms
 *      land in `api.options.template.compilerOptions.nodeTransforms`.
 *   2. The preamble transform comes BEFORE the hint transform
 *      (`vite.ts:177-190`) — reversed order double-wraps every
 *      v-register IIFE because the preamble's pre-order capture would
 *      pick up an already-wrapped expression.
 *   3. The push is idempotent. A second `configResolved` invocation
 *      (a separate plugin instance, or any caller re-running the
 *      pipeline) must not re-append the same transforms.
 *   4. The `transform(code, id)` hook invokes `transformSsrAccessed`
 *      for an SFC whose `<script setup>` binds `useForm` and whose
 *      `<template>` references it — the only path that injects
 *      `__ssrAccessed: true` into the call's options literal.
 *
 * No prior coverage existed for any of this — the resolve-alias suite
 * (`resolve-alias.test.ts`) only exercises the build-time zod rewrite.
 * Pinning these invariants now so every subsequent transform-layer
 * dedup is guarded by behavior-locking tests rather than guesses.
 */

let zodV4Root: string

function makeFixtureWithZod(name: string, zodVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), `attaform-vite-${name}-`))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: `${name}-fixture`, private: true }),
    'utf8'
  )
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
  return root
}

beforeAll(() => {
  zodV4Root = makeFixtureWithZod('wiring-zod-v4', '4.3.0')
})

async function resolveWithRoot(plugins: Plugin[], root: string): Promise<ResolvedConfig> {
  return resolveConfig({ plugins, configFile: false, root }, 'serve')
}

interface CompilerOptionsShape {
  nodeTransforms?: unknown[]
}
interface VueApiShape {
  options?: {
    template?: {
      compilerOptions?: CompilerOptionsShape
    }
  }
}

function readVueNodeTransforms(config: ResolvedConfig): unknown[] {
  const vuePlugin = config.plugins.find((p) => p.name === 'vite:vue')
  if (vuePlugin === undefined) throw new Error('vite:vue plugin not found in resolved config')
  const api = (vuePlugin as unknown as { api?: VueApiShape }).api
  const transforms = api?.options?.template?.compilerOptions?.nodeTransforms
  if (transforms === undefined)
    throw new Error('nodeTransforms not populated on @vitejs/plugin-vue')
  return transforms
}

describe('attaform/vite — node-transform wiring', () => {
  it('registers all four compile-time transforms on @vitejs/plugin-vue', async () => {
    const config = await resolveWithRoot([vue(), attaform()], zodV4Root)
    const transforms = readVueNodeTransforms(config)
    expect(transforms).toContain(componentBridgeTransform)
    expect(transforms).toContain(inputTextAreaNodeTransform)
    expect(transforms).toContain(vRegisterPreambleTransform)
    expect(transforms).toContain(vRegisterHintTransform)
  })

  it('orders the preamble transform before the hint transform', async () => {
    const config = await resolveWithRoot([vue(), attaform()], zodV4Root)
    const transforms = readVueNodeTransforms(config)
    const preambleIdx = transforms.indexOf(vRegisterPreambleTransform)
    const hintIdx = transforms.indexOf(vRegisterHintTransform)
    expect(preambleIdx).toBeGreaterThanOrEqual(0)
    expect(hintIdx).toBeGreaterThanOrEqual(0)
    // Reversing this order makes the preamble capture an already-wrapped
    // IIFE expression and double-wrap every v-register binding at the
    // template root.
    expect(preambleIdx).toBeLessThan(hintIdx)
  })

  it('does not re-push when the same nodeTransforms array already carries the sentinel', async () => {
    // Two plugin instances sharing the same vue() — exercises the
    // `if (!existing.includes(...))` idempotency gate that protects
    // against vite + nuxt + manual `plugins: [attaform()]` stacking.
    const sharedVue = vue()
    const config = await resolveWithRoot([sharedVue, attaform(), attaform()], zodV4Root)
    const transforms = readVueNodeTransforms(config)
    const occurrences = (target: unknown): number =>
      transforms.reduce<number>((n, t) => (t === target ? n + 1 : n), 0)
    expect(occurrences(componentBridgeTransform)).toBe(1)
    expect(occurrences(inputTextAreaNodeTransform)).toBe(1)
    expect(occurrences(vRegisterPreambleTransform)).toBe(1)
    expect(occurrences(vRegisterHintTransform)).toBe(1)
  })

  it('preserves user-supplied nodeTransforms already on @vitejs/plugin-vue', async () => {
    // Custom transform users may have pre-registered via vue()'s own
    // template.compilerOptions. We must extend, not replace.
    const sentinel = () => {}
    const customVue = vue({
      template: { compilerOptions: { nodeTransforms: [sentinel] } },
    })
    const config = await resolveWithRoot([customVue, attaform()], zodV4Root)
    const transforms = readVueNodeTransforms(config)
    expect(transforms).toContain(sentinel)
    expect(transforms).toContain(vRegisterPreambleTransform)
    expect(transforms.indexOf(sentinel)).toBeLessThan(
      transforms.indexOf(vRegisterPreambleTransform)
    )
  })
})

describe('attaform/vite — transform hook (SSR-accessed injection)', () => {
  it('injects __ssrAccessed: true for a useForm binding referenced in the template', async () => {
    const config = await resolveWithRoot([vue(), attaform()], zodV4Root)
    const plugin = config.plugins.find((p) => p.name === 'attaform')
    if (plugin === undefined) throw new Error('attaform plugin missing from resolved config')
    const hook = plugin.transform
    if (hook === undefined) throw new Error('attaform plugin exposes no transform hook')
    const handler = typeof hook === 'function' ? hook : hook.handler

    const sfc = `
<script setup lang="ts">
import { useForm } from 'attaform/zod'
import { z } from 'zod'
const form = useForm({ schema: z.object({ email: z.string() }) })
</script>
<template>
  <input v-register="form.register('email')" />
</template>
`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (handler as any).call({}, sfc, '/abs/path/to/example.vue') as
      | { code: string }
      | null
      | undefined
    expect(result).not.toBeNull()
    expect(result).not.toBeUndefined()
    expect(result?.code).toContain('__ssrAccessed: true')
  })

  it('returns null for non-Vue ids (no .vue suffix)', async () => {
    const config = await resolveWithRoot([vue(), attaform()], zodV4Root)
    const plugin = config.plugins.find((p) => p.name === 'attaform')
    if (plugin === undefined) throw new Error('attaform plugin missing from resolved config')
    const hook = plugin.transform
    if (hook === undefined) throw new Error('attaform plugin exposes no transform hook')
    const handler = typeof hook === 'function' ? hook : hook.handler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (handler as any).call(
      {},
      "import { useForm } from 'attaform/zod'\nconst form = useForm()",
      '/abs/path/to/example.ts'
    )
    expect(result).toBeNull()
  })
})
