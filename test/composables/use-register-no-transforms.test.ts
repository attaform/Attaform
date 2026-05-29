// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { baseCompile } from '@vue/compiler-core'
import { createApp, defineComponent, type App } from 'vue'
import * as VueRuntime from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { useRegister } from '../../src/runtime/composables/use-register'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

/**
 * Failure-mode test: useRegister inside a child component must keep
 * working even when the consumer's bundler did NOT install attaform's
 * compile-time transforms. Two real-world scenarios trip this gap:
 *
 *   - The @vue/repl playground (the docs site's standalone editor)
 *     compiles SFCs with its own pipeline; attaform-vite isn't wired
 *     in, so `<MyWrapper v-register="form.register('email')" />`
 *     never gets the `:registerValue` bridge prop injected by
 *     `componentBridgeTransform`. The child's useRegister() sees no bridge
 *     attr and falls back to `undefined`, so the inner input never
 *     wires up — typing has no effect.
 *
 *   - A consumer using a non-Vite bundler that doesn't accept
 *     compile-time transforms (esbuild-plain, Rollup without the
 *     attaform Vue compiler plugin, etc.). Same shape: any wrapper
 *     between the directive and the native input quietly stops
 *     propagating the binding.
 *
 * The directive itself (the runtime side) is still registered
 * globally via `createAttaform()`; the consumer's app boots fine, and
 * `<input v-register>` directly on a native input works. The
 * failure is specifically the component-wrapper case where the
 * bridge prop is the only current propagation channel.
 *
 * This file mounts that exact misuse-at-the-limits shape: NO
 * compile-time transforms in the compiler pipeline, just plain Vue
 * template compilation. The expectation is that useRegister() still
 * captures the parent's binding, via whatever fallback the library
 * provides for environments without the transforms.
 */

const schema = z.object({ email: z.string(), name: z.string() })

function compileTemplateWithoutTransforms(template: string): (...args: unknown[]) => unknown {
  // Crucially: no `nodeTransforms` array. This is what a stock Vue
  // compile looks like — no `componentBridgeTransform`, no
  // `inputTextAreaNodeTransform`, no `vRegisterPreambleTransform`, no
  // `vRegisterHintTransform`. Mirrors the @vue/repl playground's
  // compile path and the bare-bundler scenario.
  const { code } = baseCompile(template, {
    mode: 'function',
    prefixIdentifiers: false,
  })
  return new Function('Vue', code)(VueRuntime) as (...args: unknown[]) => unknown
}

describe('useRegister — works without attaform compile-time transforms', () => {
  let app: App | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('captures the parent v-register binding without the componentBridgeTransform bridge prop', async () => {
    const captured: { api?: UseFormReturn<typeof schema>; childRv?: unknown } = {}

    const Child = defineComponent({
      name: 'FieldRow',
      setup() {
        const rv = useRegister()
        captured.childRv = rv
        return { rv }
      },
      render: compileTemplateWithoutTransforms(
        `<label class="wrapper"><input v-register="rv" class="inner" /></label>`
      ),
    })

    const Parent = defineComponent({
      components: { Child },
      setup() {
        const form = useForm({ schema, key: 'use-register-no-transforms-test' })
        captured.api = form
        return { form }
      },
      render: compileTemplateWithoutTransforms(`<Child v-register="form.register('email')" />`),
    })

    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (captured.api !== undefined ? true : null))

    if (captured.api === undefined) throw new Error('unreachable')

    // useRegister must surface the parent's binding. Today (RED), the
    // child's rv reads as an unbound proxy because the bridge attr
    // never appears in attrs.
    const rv = captured.childRv as { path?: string; segments?: readonly (string | number)[] }
    expect(rv?.path).toBeDefined()
    expect(rv?.segments).toEqual(['email'])
  })

  it('typing in the inner input writes to the form when no transforms are installed', async () => {
    const captured: { api?: UseFormReturn<typeof schema> } = {}

    const Child = defineComponent({
      name: 'FieldRow',
      setup() {
        const rv = useRegister()
        return { rv }
      },
      render: compileTemplateWithoutTransforms(
        `<label class="wrapper"><input v-register="rv" class="inner" /></label>`
      ),
    })

    const Parent = defineComponent({
      components: { Child },
      setup() {
        const form = useForm({ schema, key: 'use-register-no-transforms-typing-test' })
        captured.api = form
        return { form }
      },
      render: compileTemplateWithoutTransforms(`<Child v-register="form.register('email')" />`),
    })

    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (captured.api !== undefined ? true : null))

    if (captured.api === undefined) throw new Error('unreachable')

    const innerInput = root.querySelector('input.inner') as HTMLInputElement | null
    expect(innerInput).not.toBeNull()
    if (innerInput === null) throw new Error('unreachable')

    innerInput.value = 'typed-without-transforms'
    innerInput.dispatchEvent(new Event('input', { bubbles: true }))
    await waitUntil(() => (captured.api?.values.email === 'typed-without-transforms' ? true : null))

    expect(captured.api.values.email).toBe('typed-without-transforms')
  })
})
