// @vitest-environment jsdom
import { baseCompile } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, defineComponent } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * SSR emission of the HTML `disabled` attribute for a frozen form
 * (`useForm({ disabled })`). The compiled transform injects a
 * `:disabled="(register)?.disabled?.value"` bind next to the value bind,
 * so a server-rendered control paints disabled on the first frame instead
 * of flashing interactive until the client directive runs. Both zod
 * adapters, since the freeze lives below the adapter layer.
 */

// zV3 / useFormV3 cast to their v4 static types so the shared describe.each
// loop type-checks; the real v3 instances run at runtime (identical surface).
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

describe.each(ADAPTERS)('SSR disabled attribute emission ($name)', ({ z, useForm }) => {
  function ssr(
    template: string,
    schema: unknown,
    disabled: boolean,
    defaultValues: Record<string, unknown> = {}
  ): Promise<string> {
    const Component = defineComponent({
      setup() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const form = useForm({ schema: schema as any, disabled, defaultValues })
        return { form }
      },
      render: compileRender(template),
    })
    const app = createSSRApp(Component)
    app.use(createAttaform())
    return renderToString(app)
  }

  it('emits `disabled` on a frozen <input v-register>', async () => {
    const html = await ssr(
      `<input v-register="form.register('email')" />`,
      z.object({ email: z.string() }),
      true,
      { email: 'a@b.com' }
    )
    expect(html).toMatch(/<input[^>]*\sdisabled/)
  })

  it('omits `disabled` on an un-frozen <input v-register>', async () => {
    const html = await ssr(
      `<input v-register="form.register('email')" />`,
      z.object({ email: z.string() }),
      false,
      { email: 'a@b.com' }
    )
    expect(html).not.toContain('disabled')
  })

  it('emits `disabled` on a frozen <textarea v-register>', async () => {
    const html = await ssr(
      `<textarea v-register="form.register('note')" />`,
      z.object({ note: z.string() }),
      true,
      { note: 'hi' }
    )
    expect(html).toMatch(/<textarea[^>]*\sdisabled/)
  })

  it('emits `disabled` on a frozen native <select>', async () => {
    const html = await ssr(
      `<select v-register="form.register('fruit')"><option value="apple">Apple</option></select>`,
      z.object({ fruit: z.string() }),
      true,
      { fruit: 'apple' }
    )
    expect(html).toMatch(/<select[^>]*\sdisabled/)
  })
})
