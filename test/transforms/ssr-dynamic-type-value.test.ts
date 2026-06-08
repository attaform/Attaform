// @vitest-environment jsdom
import { baseCompile } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, defineComponent, ref } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useRegister } from '../../src'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * SSR value/checked emission for `<input>` / `<textarea>` carrying a
 * DYNAMIC `:type` binding — the wrapper-component shape (e.g. a
 * `UiTextField` re-binding its inner `<input v-register :type="type">`).
 *
 * Pre-fix, `inputTextAreaNodeTransform` bailed on any non-provably-
 * static `type` (couldn't prove it wasn't `file`), so the value binding
 * was never injected and the field painted empty for one frame, then
 * filled in on client mount — a visible first-paint flash on every
 * SSR'd wrapper field. Static `type="text"` already worked; this pins
 * the dynamic-type parity AND the file-input safety (a runtime
 * `type="file"` must NEVER receive a `value` binding — browsers reject
 * it).
 *
 * Both zod adapters per first-class v3/v4 parity.
 */

// zV3 / useFormV3 are cast to their v4 static types so the shared
// describe.each loop type-checks (the two adapters' static types don't
// unify, but their runtime surface used here is identical). The real v3
// instances run at runtime; this only satisfies the compiler.
const ADAPTERS = [
  { name: 'zod-v4', z: zV4, useForm: useFormV4 },
  {
    name: 'zod-v3',
    z: zV3 as unknown as typeof zV4,
    useForm: useFormV3 as unknown as typeof useFormV4,
  },
] as const

const TRANSFORMS = [
  componentBridgeTransform,
  inputTextAreaNodeTransform,
  vRegisterPreambleTransform,
  vRegisterHintTransform,
]

function compileRender(template: string): (this: unknown, ctx: unknown) => unknown {
  const result = baseCompile(template, {
    nodeTransforms: TRANSFORMS,
    mode: 'function',
    prefixIdentifiers: true,
    hoistStatic: false,
  })
  const fn = new Function('Vue', `${result.code}\nreturn render`)
  return fn(Vue) as (this: unknown, ctx: unknown) => unknown
}

describe.each(ADAPTERS)('SSR dynamic :type value/checked emission ($name)', ({ z, useForm }) => {
  function ssr(
    template: string,
    schema: unknown,
    defaultValues: Record<string, unknown>,
    extraSetup: Record<string, unknown> = {}
  ): Promise<string> {
    const Component = defineComponent({
      setup() {
        // The schema is statically `unknown` here (the helper is generic
        // over every case's shape); useForm needs a concrete type, so the
        // single cast lives here rather than at every call site.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const form = useForm({ schema: schema as any, defaultValues })
        return { form, ...extraSetup }
      },
      render: compileRender(template),
    })
    const app = createSSRApp(Component)
    app.use(createAttaform())
    return renderToString(app)
  }

  it('dynamic :type resolving to text emits the seeded value (the wrapper bug)', async () => {
    const html = await ssr(
      `<input :type="t" v-register="form.register('orgName')" />`,
      z.object({ orgName: z.string() }),
      { orgName: 'Acme PHA' },
      { t: 'text' }
    )
    expect(html).toContain('value="Acme PHA"')
  })

  it('dynamic :type resolving to checkbox emits `checked` and keeps the static value discriminator', async () => {
    const html = await ssr(
      `<input :type="t" v-register="form.register('picks')" value="apple" />`,
      z.object({ picks: z.array(z.string()) }),
      { picks: ['apple'] },
      { t: 'checkbox' }
    )
    expect(html).toMatch(/\bchecked\b/)
    expect(html).toContain('value="apple"')
  })

  it('dynamic :type resolving to radio emits `checked` and keeps the static value', async () => {
    const html = await ssr(
      `<input :type="t" v-register="form.register('size')" value="b" />`,
      z.object({ size: z.string() }),
      { size: 'b' },
      { t: 'radio' }
    )
    expect(html).toMatch(/\bchecked\b/)
    expect(html).toContain('value="b"')
  })

  it('dynamic :type resolving to file emits NO value (browsers reject value on file inputs)', async () => {
    const html = await ssr(
      `<input :type="t" v-register="form.register('doc')" />`,
      z.object({ doc: z.string() }),
      { doc: 'should-not-leak' },
      { t: 'file' }
    )
    expect(html).not.toContain('value=')
    expect(html).not.toContain('should-not-leak')
  })

  it('regression: static type="text" still emits the value', async () => {
    const html = await ssr(
      `<input type="text" v-register="form.register('orgName')" />`,
      z.object({ orgName: z.string() }),
      { orgName: 'Acme PHA' }
    )
    expect(html).toContain('value="Acme PHA"')
  })

  it('regression: static type="file" still emits no value', async () => {
    const html = await ssr(
      `<input type="file" v-register="form.register('doc')" />`,
      z.object({ doc: z.string() }),
      { doc: 'should-not-leak' }
    )
    expect(html).not.toContain('value=')
  })

  it('wrapper component (useRegister + inner <input v-register :type>) emits the value through SSR', async () => {
    const UiTextField = defineComponent({
      name: 'UiTextField',
      inheritAttrs: false,
      setup() {
        const register = useRegister()
        const type = ref('text')
        return { register, type }
      },
      render: compileRender(`<input v-register="register" :type="type" />`),
    })

    const Parent = defineComponent({
      name: 'WrapperParent',
      components: { UiTextField },
      setup() {
        const form = useForm({
          schema: z.object({ orgName: z.string() }),
          defaultValues: { orgName: 'Acme PHA' },
        })
        return { form }
      },
      render: compileRender(`<div><UiTextField v-register="form.register('orgName')" /></div>`),
    })
    const app = createSSRApp(Parent)
    app.use(createAttaform())
    const html = await renderToString(app)
    expect(html).toContain('value="Acme PHA"')
  })
})
