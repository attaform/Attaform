import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, withDirectives } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { vRegister } from '../../src'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * SSR value/checked emission on the RUNTIME render-function path
 * (`h()` + `withDirectives`, no compile-time transform). The bug
 * report's literal repro: a seeded text input rendered through a
 * render function came out with `aria-*` (from `getSSRProps`) but no
 * `value`, so the field painted empty for one frame and filled in on
 * client mount.
 *
 * `getSSRProps` receives a real vnode on this path (compiled SSR passes
 * `null`), so it can dispatch by tag/type and emit the same form-state
 * the client directive applies on mount. Both zod adapters per
 * first-class v3/v4 parity.
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

describe.each(ADAPTERS)('runtime getSSRProps form-state ($name)', ({ z, useForm }) => {
  function ssr(setup: () => () => unknown): Promise<string> {
    const app = createSSRApp(defineComponent({ setup }))
    app.use(createAttaform())
    return renderToString(app)
  }

  it('text input emits the seeded value (the report repro)', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ orgName: z.string() }),
        defaultValues: { orgName: 'Acme PHA' },
      })
      return () =>
        withDirectives(h('input', { type: 'text' }), [[vRegister, form.register('orgName')]])
    })
    expect(html).toContain('value="Acme PHA"')
  })

  it('textarea emits the seeded value', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ bio: z.string() }),
        defaultValues: { bio: 'hello world' },
      })
      return () => withDirectives(h('textarea'), [[vRegister, form.register('bio')]])
    })
    // Vue's server renderer routes a `value` prop on a <textarea> to its
    // text content (the spec'd way to seed a textarea), not a `value=`
    // attribute — so the seeded value rides along as content, no flash.
    expect(html).toContain('hello world</textarea>')
  })

  it('checkbox (boolean scalar model) emits `checked` when true', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ agree: z.boolean() }),
        defaultValues: { agree: true },
      })
      return () =>
        withDirectives(h('input', { type: 'checkbox' }), [[vRegister, form.register('agree')]])
    })
    expect(html).toMatch(/\bchecked\b/)
  })

  it('checkbox (array model) emits `checked` for a member option', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ picks: z.array(z.string()) }),
        defaultValues: { picks: ['apple'] },
      })
      return () =>
        withDirectives(h('input', { type: 'checkbox', value: 'apple' }), [
          [vRegister, form.register('picks')],
        ])
    })
    expect(html).toMatch(/\bchecked\b/)
  })

  it('radio emits `checked` when the model matches the option value', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ size: z.string() }),
        defaultValues: { size: 'b' },
      })
      return () =>
        withDirectives(h('input', { type: 'radio', value: 'b' }), [
          [vRegister, form.register('size')],
        ])
    })
    expect(html).toMatch(/\bchecked\b/)
  })

  it('radio emits NO `checked` when the model does not match', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ size: z.string() }),
        defaultValues: { size: 'a' },
      })
      return () =>
        withDirectives(h('input', { type: 'radio', value: 'b' }), [
          [vRegister, form.register('size')],
        ])
    })
    expect(html).not.toMatch(/\bchecked\b/)
  })

  it('file input emits NO value (browsers reject value on file inputs)', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ doc: z.string() }),
        defaultValues: { doc: 'should-not-leak' },
      })
      return () => withDirectives(h('input', { type: 'file' }), [[vRegister, form.register('doc')]])
    })
    expect(html).not.toContain('value=')
    expect(html).not.toContain('should-not-leak')
  })

  it('runtime <select> is a documented no-op (option-level state is not element-expressible)', async () => {
    const html = await ssr(() => {
      const form = useForm({
        schema: z.object({ country: z.string() }),
        defaultValues: { country: 'uk' },
      })
      return () =>
        withDirectives(
          h('select', null, [
            h('option', { value: 'us' }, 'US'),
            h('option', { value: 'uk' }, 'UK'),
          ]),
          [[vRegister, form.register('country')]]
        )
    })
    // The select renders without crashing; option-level `selected` is
    // intentionally NOT emitted from the element-level getSSRProps
    // (compiled templates carry it via componentBridgeTransform). Pin
    // the limitation so a future change to it is a deliberate edit.
    expect(html).toContain('<select')
    expect(html).not.toContain('selected')
  })
})
