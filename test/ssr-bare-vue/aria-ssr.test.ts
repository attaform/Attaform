import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, ref, withDirectives } from 'vue'
import { z } from 'zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { DisplayState, RegisterValue } from '../../src/runtime/types/types-api'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'

/**
 * SSR coverage for auto-aria. The directive's lifecycle hooks don't run
 * on the server, so `getSSRProps` is what emits the aria attributes
 * during `renderToString`. A native-element `<input v-register>`
 * compiles to `withDirectives(createVNode('input'), [[vRegister, rv]])`,
 * which is exactly the shape exercised here, so `getSSRProps` fires.
 */

const schema = z.object({ email: z.string().min(1), note: z.string().optional() })
type Api = UseFormReturn<typeof schema>

/**
 * Bind a register value whose `ariaDisplayState` is a fixed verdict.
 * The display heuristic decides WHEN a verdict lands (and under SSR the
 * gate is closed at first paint by design, so a real error never
 * surfaces here); these cases are about which attributes the SSR path
 * emits for a GIVEN verdict, so forcing it is what isolates them.
 */
async function renderField(opts?: {
  display?: DisplayState
  dropChannel?: boolean
  authored?: Record<string, unknown>
  path?: 'email' | 'note'
}): Promise<{ html: string; api: Api }> {
  const handle: { api?: Api } = {}
  const Comp = defineComponent({
    setup() {
      const api = useForm({
        schema,
        key: `ssr-aria-${Math.random().toString(36).slice(2)}`,
      })
      handle.api = api
      const real = api.register(opts?.path ?? 'email')
      const { ariaDisplayState: _dropped, ...withoutChannel } = real
      const rv =
        opts?.dropChannel === true
          ? (withoutChannel as RegisterValue)
          : { ...real, ariaDisplayState: ref<DisplayState>(opts?.display ?? 'idle') }
      return () =>
        withDirectives(h('input', { type: 'text', ...(opts?.authored ?? {}) }), [[vRegister, rv]])
    },
  })
  const app = createSSRApp(Comp).use(createAttaform())
  const html = await renderToString(app)
  if (handle.api === undefined) throw new Error('renderField: api never set')
  return { html, api: handle.api }
}

describe('auto-aria SSR', () => {
  it('emits aria-required for a required field', async () => {
    const { html } = await renderField({ display: 'idle' })
    expect(html).toContain('aria-required="true"')
    // Idle: no error/busy attrs.
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('aria-busy')
  })

  it('omits aria-required for an optional field', async () => {
    const { html } = await renderField({ path: 'note', display: 'idle' })
    expect(html).not.toContain('aria-required')
  })

  it('emits aria-invalid + a deterministic aria-describedby in the error state', async () => {
    const { html, api } = await renderField({ display: 'error' })
    expect(html).toContain('aria-invalid="true"')
    // The server-rendered id matches the value the client reads after
    // hydration (formInstanceId is SSR-stable via Vue's useId).
    expect(html).toContain(`aria-describedby="${api.fields.email.aria.errorId}"`)
  })

  it('emits aria-busy in the pending state', async () => {
    const { html } = await renderField({ display: 'pending' })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('aria-invalid')
  })

  it('never overwrites an authored aria attribute on the server', async () => {
    const { html } = await renderField({
      display: 'error',
      authored: { 'aria-invalid': 'false' },
    })
    expect(html).toContain('aria-invalid="false"')
    expect(html).not.toContain('aria-invalid="true"')
  })

  it('emits nothing for a binding carrying no ariaDisplayState', async () => {
    // A hand-rolled register factory has no field-state accessor to close
    // over, so `buildRegister` omits `ariaDisplayState`. That is the one
    // remaining "aria off" path: there is no opt-out flag.
    const { html } = await renderField({ dropChannel: true })
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('aria-required')
  })
})

describe('auto-aria SSR — array-member checkboxes (#381)', () => {
  it('omits aria-required on every checkbox bound to a required array path', async () => {
    const schema = z.object({ permissions: z.array(z.string()) })
    const Comp = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: `ssr-381-${Math.random().toString(36).slice(2)}`,
          defaultValues: { permissions: ['role_create'] },
        })
        return () =>
          h(
            'fieldset',
            ['role_create', 'role_update', 'member_invite'].map((v) =>
              withDirectives(h('input', { type: 'checkbox', value: v }), [
                [vRegister, form.register('permissions')],
              ])
            )
          )
      },
    })
    const html = await renderToString(createSSRApp(Comp).use(createAttaform()))
    expect(html).not.toContain('aria-required')
  })

  it('still emits aria-required for a required single boolean checkbox', async () => {
    const schema = z.object({ agree: z.boolean() })
    const Comp = defineComponent({
      setup() {
        const form = useForm({ schema, key: `ssr-381-bool-${Math.random().toString(36).slice(2)}` })
        return () =>
          withDirectives(h('input', { type: 'checkbox' }), [[vRegister, form.register('agree')]])
      },
    })
    const html = await renderToString(createSSRApp(Comp).use(createAttaform()))
    expect(html).toContain('aria-required="true"')
  })
})

describe('auto-aria SSR — component host (#404)', () => {
  it('does not stamp aria-required on a component host root', async () => {
    const schema = z.object({ email: z.string() })
    // Presentational wrapper whose root is a non-control <div>.
    const FieldWrapper = defineComponent({
      name: 'FieldWrapper',
      setup:
        (_, { slots }) =>
        () =>
          h('div', { class: 'field-wrapper' }, slots['default']?.()),
    })
    const Comp = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: `ssr-404-${Math.random().toString(36).slice(2)}`,
          defaultValues: { email: '' },
        })
        return () =>
          withDirectives(h(FieldWrapper, null, { default: () => h('input', { type: 'text' }) }), [
            [vRegister, form.register('email')],
          ])
      },
    })
    const html = await renderToString(createSSRApp(Comp).use(createAttaform()))
    // The role-less wrapper <div> must not carry aria-required.
    expect(html).not.toContain('aria-required')
  })

  it('still emits aria-required on a bare native control (positive control)', async () => {
    const schema = z.object({ email: z.string() })
    const Comp = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: `ssr-404-native-${Math.random().toString(36).slice(2)}`,
        })
        return () =>
          withDirectives(h('input', { type: 'text' }), [[vRegister, form.register('email')]])
      },
    })
    const html = await renderToString(createSSRApp(Comp).use(createAttaform()))
    expect(html).toContain('aria-required="true"')
  })
})
