// @vitest-environment jsdom
import { baseCompile, type NodeTransform } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, defineComponent } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { selectNodeTransform } from '../../src/runtime/lib/core/transforms/select-transform'

/**
 * DIR-F4 characterization. The Array→`.includes` / Set→`.has` / scalar→`===`
 * decision ladder is encoded three times — once each in
 * `input-text-area-transform.ts`, `select-transform.ts`, and at runtime in
 * `directive.ts` (`setChecked` / `setSelected`). The two compile-time
 * emitters diverge in their scalar branch:
 *
 *   - `input-text-area-transform`: strict `===` between `innerRef.value`
 *     and the raw scalar target.
 *   - `select-transform`:           coerced `String(...) === String(...)`.
 *
 * The runtime uses Vue's `looseEqual`, which routes primitives through
 * `String(...)` (so it agrees with the select transform on a canonical
 * `<option value="1">` × `z.number()` + model `1`, but disagrees with the
 * input-text-area transform on the equivalent `<input type="radio" value="1">`
 * × `z.number()` + model `1`).
 *
 * Pin both ladders at the source-string level AND at the SSR-output level
 * so the divergence surfaces as a single failing assertion the moment
 * either branch shifts. Updating the ladder in a future commit will need
 * to touch these pins explicitly, which is the point — silent drift is
 * what got us here.
 */

function compileInputTextArea(template: string): string {
  const result = baseCompile(template, {
    nodeTransforms: [inputTextAreaNodeTransform],
    mode: 'module',
  })
  return result.code
}

function compileSelect(template: string): string {
  const result = baseCompile(template, {
    nodeTransforms: [selectNodeTransform],
    mode: 'module',
  })
  return result.code
}

describe('DIR-F4 compile-time emitter ladders', () => {
  it('input-text-area emits a strict `===` against the raw scalar target', () => {
    const code = compileInputTextArea(
      `<input type="radio" v-register="form.register('size')" value="2" />`
    )
    // The radio branch lands the option-value as `"2"` (the static
    // attribute, rendered as a quoted JS string literal). The synthesized
    // equality expression is strict `===` against that literal.
    expect(code).toContain('innerRef?.value === ("2")')
    // It does NOT route through String() for primitives — that's the
    // crux of the divergence with the select transform below.
    expect(code).not.toMatch(/String\(\([^)]*innerRef\?\.value\)\)\s*===\s*String/)
  })

  it('select emits a coerced `String(...) === String(...)` for the scalar branch', () => {
    const code = compileSelect(
      `<select v-register="form.register('age')"><option value="2">2</option></select>`
    )
    // Multi-select (`findIndex(el => el === optionValue)`) uses strict
    // `===`; the single-select branch coerces via String() on both sides.
    // This is the literal shape we depend on for SSR parity with the
    // runtime's `looseEqual` — pinning here makes any silent flattening
    // of this expression visible to review.
    expect(code).toMatch(/String\(.+?\?\.innerRef\?\.value\)\s*===\s*String\(\("2"\)\)/)
  })
})

/**
 * The SSR pin the plan asks for: render the canonical
 * `<select>` × `z.number()` × `<option value="1">` against a model of
 * `1`, and assert SSR emits the `selected` attribute (matching what
 * `setSelected` would do at CSR time).
 *
 * Add the symmetric radio case to surface the strict-vs-coerced
 * divergence: same shape (`z.number()` + `value="2"` + model `2`), but
 * the input-text-area transform's strict `===` against the raw `"2"`
 * string literal evaluates to `false` at SSR. The runtime `setChecked`
 * routes through `looseEqual(applyCoerce("2"), 2) === true`, so the
 * DOM flips to checked on hydration. Visible flicker.
 */
function makeTemplateModule(template: string, nodeTransforms: NodeTransform[]): Vue.Component {
  const result = baseCompile(template, {
    nodeTransforms,
    mode: 'function',
    prefixIdentifiers: true,
    hoistStatic: false,
  })
  const fn = new Function('Vue', `${result.code}\nreturn render`)
  const render = fn(Vue) as (this: unknown, ctx: unknown) => unknown
  return defineComponent({
    setup() {
      const form = useForm({
        schema: z.object({ size: z.number(), age: z.number() }),
        defaultValues: { size: 2, age: 1 },
      })
      return { form }
    },
    render,
  })
}

async function ssr(template: string, nodeTransforms: NodeTransform[]): Promise<string> {
  const Component = makeTemplateModule(template, nodeTransforms)
  const app = createSSRApp(Component)
  app.use(createAttaform())
  return renderToString(app)
}

describe('DIR-F4 SSR-output verdict', () => {
  it('select with z.number() × <option value="1"> emits SSR `selected` (matches setSelected verdict)', async () => {
    const html = await ssr(
      `<select v-register="form.register('age')"><option value="1">one</option><option value="2">two</option></select>`,
      [selectNodeTransform]
    )
    // The single-select branch coerces via String(), so the SSR pass
    // sees `"1" === "1"` and emits `selected` on the matching option.
    // This is the canonical happy path; the runtime `setSelected` ends
    // at the same verdict via `looseEqual(applyCoerce("1"), 1)`.
    expect(html).toMatch(/<option[^>]*value="1"[^>]*selected/)
    expect(html).not.toMatch(/<option[^>]*value="2"[^>]*selected/)
  })

  it('CHARACTERIZATION (current bug): radio with z.number() × value="2" DOES NOT emit SSR `checked` despite model === 2', async () => {
    const html = await ssr(`<input type="radio" v-register="form.register('size')" value="2" />`, [
      inputTextAreaNodeTransform,
    ])
    // PRE-FIX behaviour — the strict `===` against the string literal
    // `"2"` evaluates to `false` at SSR even though the runtime's
    // `looseEqual(applyCoerce("2"), 2)` returns `true`. The input
    // therefore SSRs unchecked and flips to checked on hydration — a
    // visible flicker.
    //
    // This assertion documents the current diverged behaviour. If a
    // future fix unifies the input-text-area ladder with the select
    // ladder (or with the runtime `looseEqual`), this test flips and
    // the assertion below will need to update. That's the intended
    // gate — the divergence is no longer silent.
    expect(html).not.toMatch(/\bchecked\b/)
  })
})
