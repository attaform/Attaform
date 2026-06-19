// @vitest-environment jsdom
import { compileTemplate } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App, type DirectiveBinding } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { RegisterValue } from '../../src/runtime/types/types-api'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { SSR_COMPONENT_HOST_MODIFIER } from '../../src/runtime/core/register-protocol'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'
import { waitUntil } from '../utils/form-harness'

/**
 * Compiled-SSR coverage for #404. Production SSR compiles SFC templates
 * with `@vue/compiler-ssr`, which emits `ssrGetDirectiveProps(...)` and
 * hands the directive a `null` vnode — so the runtime hook cannot tell a
 * component host from a native control there. The fix relies on
 * `componentBridgeTransform` stamping the `SSR_COMPONENT_HOST_MODIFIER`
 * onto a component-host `v-register`, which the directive's `getSSRProps`
 * reads from `binding.modifiers`.
 *
 * This file proves both ends of that null-vnode mechanism directly: the
 * transform stamps the modifier (and only for component hosts), and
 * `getSSRProps` suppresses autoAria when it sees the modifier with a null
 * vnode (while still emitting for a bare native control). The full
 * runtime-vnode SSR path is covered in `aria-ssr.test.ts`; the end-to-end
 * Nuxt build is covered in `test/ssr.test.ts`.
 */

function compileSSR(template: string): string {
  return compileTemplate({
    source: template,
    filename: 'aria-host.vue',
    id: 'aria-host',
    ssr: true,
    compilerOptions: {
      ssr: true,
      nodeTransforms: [
        componentBridgeTransform,
        inputTextAreaNodeTransform,
        vRegisterPreambleTransform,
        vRegisterHintTransform,
      ],
    },
  }).code
}

describe('compiled-SSR transform — component-host modifier (#404)', () => {
  it('stamps the component-host modifier on a <Component v-register> host', () => {
    const code = compileSSR(`<FieldWrapper v-register="form.register('email')" />`)
    expect(code).toContain('ssrGetDirectiveProps')
    expect(code).toContain(SSR_COMPONENT_HOST_MODIFIER)
  })

  it('does NOT stamp the modifier on a bare native <input v-register>', () => {
    const code = compileSSR(`<input type="text" v-register="form.register('email')" />`)
    expect(code).toContain('ssrGetDirectiveProps')
    expect(code).not.toContain(SSR_COMPONENT_HOST_MODIFIER)
  })
})

describe('getSSRProps — null vnode (compiled SSR) honours the host modifier (#404)', () => {
  let app: App | undefined
  const handle: { rv?: RegisterValue | undefined } = {}

  afterEach(() => {
    app?.unmount()
    app = undefined
    handle.rv = undefined
    document.body.innerHTML = ''
  })

  async function captureRequiredRv(): Promise<RegisterValue> {
    const schema = z.object({ email: z.string().min(1) })
    const Comp = defineComponent({
      setup() {
        const form = useForm({ schema, key: `gsp-${Math.random().toString(36).slice(2)}` })
        handle.rv = form.register('email') as unknown as RegisterValue
        return () => h('input', { type: 'text' })
      },
    })
    app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (handle.rv !== undefined ? true : null))
    if (handle.rv === undefined) throw new Error('rv never captured')
    return handle.rv
  }

  function bindingFor(rv: RegisterValue, modifiers: Record<string, boolean>): DirectiveBinding {
    return {
      value: rv,
      oldValue: null,
      modifiers,
      dir: vRegister,
      instance: null,
    } as unknown as DirectiveBinding
  }

  it('suppresses aria for a host-modified binding (the compiled wrapper case)', async () => {
    const rv = await captureRequiredRv()
    const props = vRegister.getSSRProps?.(
      bindingFor(rv, { [SSR_COMPONENT_HOST_MODIFIER]: true }),
      null as never
    )
    expect(props?.['aria-required']).toBeUndefined()
  })

  it('still emits aria-required for an unmodified binding (the compiled native case)', async () => {
    const rv = await captureRequiredRv()
    const props = vRegister.getSSRProps?.(bindingFor(rv, {}), null as never)
    expect(props?.['aria-required']).toBe('true')
  })
})
