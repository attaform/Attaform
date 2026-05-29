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
 * DIR-F4 characterization. The Array→`.includes` / Set→`.has` / scalar→
 * coerced `String() === String()` decision ladder is encoded three times
 * — once each in `input-text-area-transform.ts`, `select-transform.ts`,
 * and at runtime in `directive.ts` (`setChecked` / `setSelected`). Both
 * compile-time emitters now route primitives through `String(...)`
 * before comparing, mirroring the runtime `looseEqual` behaviour. Pre-
 * fix the input-text-area scalar branch used strict `===`, so an SSR
 * `<input type="radio" value="2">` × `z.number()` + model `2` rendered
 * unchecked (`2 === "2"` → false) and then flipped to checked on
 * hydration via `looseEqual` — a one-tick flicker.
 *
 * Pin both ladders at the source-string level AND at the SSR-output
 * level so a future drift surfaces as a single failing assertion.
 * Updating the ladder will need to touch these pins explicitly, which
 * is the point — silent drift is what got us here in the first place.
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
  it('input-text-area emits a coerced `String(...) === String(...)` for the scalar branch', () => {
    const code = compileInputTextArea(
      `<input type="radio" v-register="form.register('size')" value="2" />`
    )
    // The radio branch lands the option-value as `"2"` (the static
    // attribute, rendered as a quoted JS string literal). Post-fix the
    // synthesized equality expression routes both sides through String()
    // to mirror the runtime `looseEqual` behaviour for primitives.
    expect(code).toMatch(/String\(.+?\?\.innerRef\?\.value\)\s*===\s*String\(\("2"\)\)/)
    // It does NOT use strict `===` on the raw scalar target anymore —
    // that was the source of the SSR/CSR mismatch.
    expect(code).not.toMatch(/innerRef\?\.value\s*===\s*\("2"\)/)
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
 * The symmetric radio case proves the post-fix parity: same shape
 * (`z.number()` + `value="2"` + model `2`) and SSR now emits `checked`.
 * Pre-fix this rendered unchecked and flipped to checked on hydration.
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

  it('radio with z.number() × value="2" emits SSR `checked` when model === 2 (post-fix parity)', async () => {
    const html = await ssr(`<input type="radio" v-register="form.register('size')" value="2" />`, [
      inputTextAreaNodeTransform,
    ])
    // Post-fix the scalar branch coerces via String(...), so the SSR
    // pass evaluates `String(2) === String("2")` → true → emits
    // `checked`. The runtime `setChecked` ends at the same verdict via
    // `looseEqual(applyCoerce("2"), 2) === true`. No hydration flicker.
    expect(html).toMatch(/\bchecked\b/)
  })
})
