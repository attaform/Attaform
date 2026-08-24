import { describe, expect, it } from 'vitest'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { rewriteDirectiveDelivery } from '../../src/runtime/lib/core/transforms/directive-delivery-transform'

/**
 * The v-register delivery rewrite (P2 un-weld). The transform binds each
 * compiled template's `resolveDirective("register")` to a static
 * `attaform/directive` import, because createAttaform registers no
 * app-level directive. These tests pin the compiler-output shapes the
 * rewrite matches (via real @vue/compiler-sfc compiles, the same way
 * @vitejs/plugin-vue drives it) and the transform's scope rules.
 */

const CALL = '_resolveDirective("register")'

function compileClient(source: string, { prod }: { prod: boolean }): string {
  const { descriptor } = parse(source, { filename: 'Comp.vue' })
  const script = descriptor.scriptSetup
    ? compileScript(descriptor, { id: 'test-id', isProd: prod })
    : null
  const template = descriptor.template
  if (template === null) return script?.content ?? ''
  const tpl = compileTemplate({
    id: 'test-id',
    filename: 'Comp.vue',
    source: template.content,
    isProd: prod,
    compilerOptions: script?.bindings !== undefined ? { bindingMetadata: script.bindings } : {},
  })
  return `${script?.content ?? ''}\n${tpl.code}`
}

function compileSsr(source: string): string {
  const { descriptor } = parse(source, { filename: 'Comp.vue' })
  const script = descriptor.scriptSetup
    ? compileScript(descriptor, { id: 'test-id', isProd: true })
    : null
  const tpl = compileTemplate({
    id: 'test-id',
    filename: 'Comp.vue',
    source: descriptor.template?.content ?? '',
    ssr: true,
    isProd: true,
    compilerOptions: script?.bindings !== undefined ? { bindingMetadata: script.bindings } : {},
  })
  return `${script?.content ?? ''}\n${tpl.code}`
}

const SETUP_SFC = `<script setup>
const form = { register: (p) => p }
</script>
<template>
  <input v-register="form.register('email')" />
</template>`

describe('directive-delivery rewrite — compiled shapes', () => {
  it('rewrites the client compile (dev and prod) and appends one import', () => {
    for (const prod of [false, true]) {
      const compiled = compileClient(SETUP_SFC, { prod })
      expect(compiled, `compiler emits the canonical call (prod=${prod})`).toContain(CALL)
      const out = rewriteDirectiveDelivery(compiled, '/app/src/Comp.vue')
      expect(out).not.toBeNull()
      expect(out).not.toContain(CALL)
      expect(out).toContain('from "attaform/directive"')
      expect(out?.match(/from "attaform\/directive"/g)).toHaveLength(1)
    }
  })

  it('rewrites the SSR compile, keeping ssrGetDirectiveProps on the injected symbol', () => {
    const compiled = compileSsr(SETUP_SFC)
    expect(compiled).toContain(CALL)
    expect(compiled).toContain('ssrGetDirectiveProps')
    const out = rewriteDirectiveDelivery(compiled, '/app/src/Comp.vue')
    expect(out).not.toBeNull()
    expect(out).not.toContain(CALL)
    expect(out).toContain('ssrGetDirectiveProps')
  })

  it('leaves a script-setup local vRegister binding alone (compiler emits no resolveDirective)', () => {
    const local = `<script setup>
import { vRegister } from 'attaform/directive'
const form = { register: (p) => p }
</script>
<template>
  <input v-register="form.register('email')" />
</template>`
    const compiled = compileClient(local, { prod: true })
    expect(compiled).not.toContain(CALL)
    expect(rewriteDirectiveDelivery(compiled, '/app/src/Comp.vue')).toBeNull()
  })

  it('preserves every original position: same-length padding, import appended at EOF', () => {
    const compiled = compileClient(SETUP_SFC, { prod: false })
    const out = rewriteDirectiveDelivery(compiled, '/app/src/Comp.vue')
    expect(out).not.toBeNull()
    if (out === null) return
    // Line count grows only by the appended import; every original line
    // keeps its length (the replacement pads to the call's width), which
    // is what makes `map: null` the honest sourcemap answer.
    const before = compiled.split('\n')
    const after = out.split('\n')
    for (const [i, line] of before.entries()) {
      expect(after[i]?.length, `line ${i} width`).toBe(line.length)
    }
  })

  it('replaces every occurrence in a module with multiple compiled render fns', () => {
    // Dev-split builds can concatenate script and template modules; two
    // occurrences of the call in one module must both bind.
    const compiled = compileClient(SETUP_SFC, { prod: false })
    const doubled = `${compiled}\n${compiled}`
    const out = rewriteDirectiveDelivery(doubled, '/app/src/Comp.vue')
    expect(out).not.toBeNull()
    expect(out).not.toContain(CALL)
  })
})

describe('directive-delivery rewrite — scope rules', () => {
  it('handles the dev template virtual-module id (query after .vue)', () => {
    const code = `const _directive_register = ${CALL}\n`
    const out = rewriteDirectiveDelivery(code, '/app/src/Comp.vue?vue&type=template&id=abc&lang.js')
    expect(out).not.toBeNull()
    expect(out).not.toContain(CALL)
  })

  it('skips non-.vue modules', () => {
    const code = `const _directive_register = ${CALL}\n`
    expect(rewriteDirectiveDelivery(code, '/app/src/render-helpers.ts')).toBeNull()
  })

  it('skips compiled SFCs inside node_modules (third-party register directives stay theirs)', () => {
    const code = `const _directive_register = ${CALL}\n`
    expect(rewriteDirectiveDelivery(code, '/app/node_modules/some-lib/dist/Comp.vue')).toBeNull()
  })

  it('returns null when the module never resolves the directive', () => {
    expect(rewriteDirectiveDelivery('export default {}\n', '/app/src/Comp.vue')).toBeNull()
  })
})
