// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseCompile } from '@vue/compiler-core'
import { createApp, defineComponent, type App } from 'vue'
import * as VueRuntime from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'
import { waitUntil } from '../utils/form-harness'

/**
 * Two v-register modifier hazards from spike section 16, each mounted
 * through the production transform stack in `src/vite.ts` order and
 * driven with the exact keystroke sequence reported:
 *
 *   16b. `<input v-register.trim>` and the spacebar. Trimming on every
 *        input event replaces the `form.value` identity even with no
 *        semantic change, Vue re-renders the input, and the `:value`
 *        binding's patchDOMProp compares against the live `el.value`
 *        carrying the user's space and writes the trimmed value back
 *        over it.
 *
 *   16e. `<input type="number">` backspaced from "1" to empty. The
 *        auto-cast runs `looseToNumber('')`, which hands the string
 *        straight back, and the slim-primitive gate rejects a string
 *        heading for a numeric slot with a dev warning.
 */

function compileTemplateToRender(template: string): (...args: unknown[]) => unknown {
  const { code } = baseCompile(template, {
    mode: 'function',
    prefixIdentifiers: false,
    nodeTransforms: [
      componentBridgeTransform,
      inputTextAreaNodeTransform,
      vRegisterPreambleTransform,
      vRegisterHintTransform,
    ],
  })
  return new Function('Vue', code)(VueRuntime) as (...args: unknown[]) => unknown
}

describe('regression: 16b — `<input v-register.trim>` spacebar after content', () => {
  let app: App | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
    warnSpy.mockRestore()
  })

  it('typing a trailing space after content preserves the space in the DOM', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const App = defineComponent({
      setup() {
        const form = useForm({
          schema: z.object({ field: z.string() }),
          key: 'spike-16b-trailing-space',
          defaultValues: { field: '' },
        })
        return { form }
      },
      render: compileTemplateToRender(
        `<input v-register.trim="form.register('field')" class="probe" />`
      ),
    })

    app = createApp(App)
    app.use(createAttaform({ ssr: false }))
    app.mount(root)
    await waitUntil(() => root.querySelector<HTMLInputElement>('input.probe'))

    const input = root.querySelector<HTMLInputElement>('input.probe')
    if (input === null) throw new Error('input not rendered')

    // Type "hello".
    input.focus()
    input.value = 'hello'
    input.dispatchEvent(new Event('input'))
    await waitUntil(() => (input.value === 'hello' ? true : null))
    expect(input.value).toBe('hello')

    // Type a trailing space. The trim modifier strips it before
    // setValue, so the form value stays "hello". The user's space
    // must remain visible in the DOM so they can keep typing.
    input.value = 'hello '
    input.dispatchEvent(new Event('input'))
    await waitUntil(() => (input.value === 'hello ' ? true : null))
    expect(input.value).toBe('hello ')

    // Type the next character. The internal space survives,
    // String.prototype.trim() only strips leading/trailing.
    input.value = 'hello w'
    input.dispatchEvent(new Event('input'))
    await waitUntil(() => (input.value === 'hello w' ? true : null))
    expect(input.value).toBe('hello w')
  })

  it('typing a single leading space into an empty `.trim` input keeps the space visible', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const App = defineComponent({
      setup() {
        const form = useForm({
          schema: z.object({ field: z.string() }),
          key: 'spike-16b-leading-space',
          defaultValues: { field: '' },
        })
        return { form }
      },
      render: compileTemplateToRender(
        `<input v-register.trim="form.register('field')" class="probe" />`
      ),
    })

    app = createApp(App)
    app.use(createAttaform({ ssr: false }))
    app.mount(root)
    await waitUntil(() => root.querySelector<HTMLInputElement>('input.probe'))

    const input = root.querySelector<HTMLInputElement>('input.probe')
    if (input === null) throw new Error('input not rendered')

    input.focus()
    input.value = ' '
    input.dispatchEvent(new Event('input'))
    await waitUntil(() => (input.value === ' ' ? true : null))

    // The user typed a space. With deferred trim the input listener
    // writes the raw " " to the model, DOM and model agree, Vue's:
    // value patch leaves el.value alone, the user's space stays
    // visible. The trim is committed later on blur (`change`).
    expect(input.value).toBe(' ')
  })
})

describe('regression: 16e — `<input type="number">` backspace-to-empty', () => {
  let app: App | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
    warnSpy.mockRestore()
  })

  it('typing "1" then backspace does not emit the slim-primitive-gate dev warning', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const App = defineComponent({
      setup() {
        const form = useForm({
          schema: z.object({ count: z.number() }),
          key: 'spike-16e-backspace',
          defaultValues: { count: 0 },
        })
        return { form }
      },
      render: compileTemplateToRender(
        `<input v-register="form.register('count')" type="number" class="probe" />`
      ),
    })

    app = createApp(App)
    app.use(createAttaform({ ssr: false }))
    app.mount(root)
    await waitUntil(() => root.querySelector<HTMLInputElement>('input.probe'))

    const input = root.querySelector<HTMLInputElement>('input.probe')
    if (input === null) throw new Error('input not rendered')

    input.focus()

    // Type "1".
    input.value = '1'
    input.dispatchEvent(new Event('input'))
    await waitUntil(() => (input.value === '1' ? true : null))

    // Backspace to empty. The directive reads empty plus castToNumber
    // as a transient mid-edit state and skips the assigner, rather than
    // calling `setValue('')` for the gate to reject with a dev warning.
    input.value = ''
    input.dispatchEvent(new Event('input'))
    await waitUntil(() => (input.value === '' ? true : null))

    const matched = warnSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('write rejected')
    )
    expect(matched.length).toBe(0)
  })
})
