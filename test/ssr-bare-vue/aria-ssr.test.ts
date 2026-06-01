import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, withDirectives } from 'vue'
import { z } from 'zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { GetDisplayState } from '../../src/runtime/types/types-api'
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

const forceState =
  (state: 'idle' | 'pending' | 'error' | 'success'): GetDisplayState =>
  () => ({ display: state })

async function renderField(opts?: {
  getDisplayState?: GetDisplayState
  autoAria?: boolean
  authored?: Record<string, unknown>
  path?: 'email' | 'note'
}): Promise<{ html: string; api: Api }> {
  const handle: { api?: Api } = {}
  const Comp = defineComponent({
    setup() {
      const api = useForm({
        schema,
        key: `ssr-aria-${Math.random().toString(36).slice(2)}`,
        ...(opts?.autoAria === false ? { autoAria: false } : {}),
        ...(opts?.getDisplayState ? { getDisplayState: opts.getDisplayState } : {}),
      })
      handle.api = api
      const rv = api.register(opts?.path ?? 'email')
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
    const { html } = await renderField({ getDisplayState: forceState('idle') })
    expect(html).toContain('aria-required="true"')
    // Idle: no error/busy attrs.
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('aria-busy')
  })

  it('omits aria-required for an optional field', async () => {
    const { html } = await renderField({ path: 'note', getDisplayState: forceState('idle') })
    expect(html).not.toContain('aria-required')
  })

  it('emits aria-invalid + a deterministic aria-describedby in the error state', async () => {
    const { html, api } = await renderField({ getDisplayState: forceState('error') })
    expect(html).toContain('aria-invalid="true"')
    // The server-rendered id matches the value the client reads after
    // hydration (formInstanceId is SSR-stable via Vue's useId).
    expect(html).toContain(`aria-describedby="${api.fields.email.aria.errorId}"`)
  })

  it('emits aria-busy in the pending state', async () => {
    const { html } = await renderField({ getDisplayState: forceState('pending') })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('aria-invalid')
  })

  it('never overwrites an authored aria attribute on the server', async () => {
    const { html } = await renderField({
      getDisplayState: forceState('error'),
      authored: { 'aria-invalid': 'false' },
    })
    expect(html).toContain('aria-invalid="false"')
    expect(html).not.toContain('aria-invalid="true"')
  })

  it('emits nothing when autoAria is disabled', async () => {
    const { html } = await renderField({ autoAria: false, getDisplayState: forceState('error') })
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('aria-required')
  })
})
