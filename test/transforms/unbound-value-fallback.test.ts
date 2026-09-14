import { baseCompile } from '@vue/compiler-core'
import { describe, expect, it } from 'vitest'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'

/**
 * The compiled half of #620: what the value injection emits when the
 * author already bound the element themselves.
 *
 * The whole dual-mode fix lives in generated code, so the behaviour pins
 * in `test/composables/dual-mode-wrapper.test.ts` prove it works while
 * these prove WHAT was emitted to make it work. Two properties matter
 * and neither is visible from the runtime side:
 *
 *  1. An author-written value binding survives as the unbound leg. It is
 *     `??` on the value channel (the injected read is `undefined` only
 *     for a nullish register, never for an empty field) and an explicit
 *     nullish test on the checked channel (the equality expression
 *     resolves to `false`, which `??` would not catch).
 *  2. An element with NO author binding emits exactly what it emitted
 *     before. That is the claim that makes this change safe for every
 *     existing consumer, and it is worth a pin rather than a promise.
 */

function compile(template: string): string {
  return baseCompile(template, {
    nodeTransforms: [componentBridgeTransform, inputTextAreaNodeTransform],
    mode: 'module',
  }).code
}

describe('the author keeps their binding as the unbound leg', () => {
  it('a <select> falls back to the author :value', () => {
    const code = compile(
      `<select v-register="rv" :value="model"><option value="a">A</option></select>`
    )
    expect(code).toContain('(_ctx.rv)?.displayValue.value ?? (_ctx.model)')
  })

  it('a text input falls back to the author :value', () => {
    expect(compile(`<input v-register="rv" :value="model" />`)).toContain(
      '(_ctx.rv)?.displayValue?.value ?? (_ctx.model)'
    )
  })

  it('a textarea falls back to the author :value', () => {
    expect(compile(`<textarea v-register="rv" :value="model"></textarea>`)).toContain(
      '(_ctx.rv)?.displayValue?.value ?? (_ctx.model)'
    )
  })

  it('a text input falls back to a STATIC author value= too', () => {
    expect(compile(`<input v-register="rv" value="hi" />`)).toContain(
      '(_ctx.rv)?.displayValue?.value ?? ("hi")'
    )
  })

  it('a checkbox falls back to the author :checked through a nullish test', () => {
    // Not `??`: the equality expression resolves to `false` for a nullish
    // register, and `false ?? x` keeps the `false`.
    const code = compile(`<input type="checkbox" v-register="rv" value="x" :checked="on" />`)
    expect(code).toContain('(_ctx.rv) == null ? (_ctx.on)')
  })

  it("keeps the author's expression scope-prefixed, not spliced raw", () => {
    // A bare identifier spliced into the injected expression would throw
    // `ReferenceError` under `prefixIdentifiers`. The author's props are
    // read off the element's OWN prop bag, which the compiler has already
    // processed by the time either transform runs, so what comes back is
    // already `_ctx.`-qualified. (#566 is the same rule seen from the
    // other side.)
    const code = compile(`<input v-register="rv" :value="model" />`)
    expect(code).toContain('_ctx.model')
    expect(code).not.toMatch(/\?\?\s*\(model\)/)
  })
})

describe('an element with no author binding is untouched', () => {
  // The safety claim, pinned: adding a fallback leg changed nothing for
  // anyone who never wrote one.
  it.each([
    ['text input', `<input v-register="rv" />`],
    ['textarea', `<textarea v-register="rv"></textarea>`],
    ['select', `<select v-register="rv"><option value="a">A</option></select>`],
    ['checkbox', `<input type="checkbox" v-register="rv" value="x" />`],
    ['radio', `<input type="radio" v-register="rv" value="x" />`],
  ])('%s emits no fallback leg', (_label, template) => {
    const code = compile(template)
    expect(code).not.toContain('??')
    expect(code).not.toContain('== null')
  })
})

describe('an <option> keeps its own :selected as the unbound leg', () => {
  it('falls back to the author :selected through a nullish test', () => {
    const code = compile(
      `<select v-register="rv"><option value="a" :selected="pick === 'a'">A</option></select>`
    )
    expect(code).toContain("(_ctx.rv) == null ? (_ctx.pick === 'a')")
  })

  it('resolves a loop alias and an outer ref in the same expression', () => {
    // The shape that made this impossible from the `<select>`: one
    // expression referencing both a `v-for` alias (must stay bare, it is
    // lexically in scope inside the loop callback) and an outer ref (must
    // be prefixed). Only the option's own visit knows which is which.
    const code = compile(
      `<select v-register="rv"><option v-for="o in opts" :key="o" :value="o" :selected="o === pick">X</option></select>`
    )
    expect(code).toContain('(_ctx.rv) == null ? (o === _ctx.pick)')
  })
})
