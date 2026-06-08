// @vitest-environment jsdom
//
// The no-flash proof. The SSR value/checked fix is only worth anything
// if the seeded value is in the markup the browser parses BEFORE any
// client JS runs (so there's no empty-then-fills-in flash) AND the
// client hydrates that markup without a mismatch warning (a mismatch
// forces Vue to re-render the subtree — its own kind of flash).
//
// Covers both render paths that drop the value pre-fix:
//   - runtime `h()` + `withDirectives` (getSSRProps — Fix B)
//   - compiled template with a dynamic `:type` (nodeTransform — Fix A)
// across both zod adapters (first-class v3/v4 parity).
import { baseCompile } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { waitUntil } from '../utils/form-harness'

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

function compileRender(template: string): (this: unknown, ctx: unknown) => unknown {
  const result = baseCompile(template, {
    nodeTransforms: [inputTextAreaNodeTransform],
    mode: 'function',
    prefixIdentifiers: true,
    hoistStatic: false,
  })
  const fn = new Function('Vue', `${result.code}\nreturn render`)
  return fn(Vue) as (this: unknown, ctx: unknown) => unknown
}

describe.each(ADAPTERS)(
  'SSR value hydration, no flash/mismatch ($name)',
  ({ name, z, useForm }) => {
    let app: App | undefined
    let warnings: string[]
    let warnSpy: ReturnType<typeof vi.spyOn>
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnings = []
      const capture = (...args: unknown[]): void => {
        warnings.push(args.map((a) => String(a)).join(' '))
      }
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture)
      errorSpy = vi.spyOn(console, 'error').mockImplementation(capture)
    })

    afterEach(() => {
      app?.unmount()
      app = undefined
      warnSpy.mockRestore()
      errorSpy.mockRestore()
      document.body.innerHTML = ''
    })

    function hydrationMismatchWarnings(): string[] {
      return warnings.filter((w) => /hydrat|mismatch/i.test(w))
    }

    function makeRuntimeComponent(key: string): Vue.Component {
      return defineComponent({
        setup() {
          const form = useForm({
            schema: z.object({ orgName: z.string() }),
            defaultValues: { orgName: 'Acme PHA' },
            key,
          })
          const rv = form.register('orgName')
          return () => withDirectives(h('input', { type: 'text' }), [[vRegister, rv]])
        },
      })
    }

    function makeCompiledComponent(key: string): Vue.Component {
      return defineComponent({
        setup() {
          const form = useForm({
            schema: z.object({ orgName: z.string() }),
            defaultValues: { orgName: 'Acme PHA' },
            key,
          })
          return { form, t: 'text' }
        },
        render: compileRender(`<input :type="t" v-register="form.register('orgName')" />`),
      })
    }

    async function assertNoFlashNoMismatch(Component: Vue.Component): Promise<void> {
      // SSR pass.
      const html = await renderToString(createSSRApp(Component).use(createAttaform()))
      // The value is in the markup the browser parses — no empty first paint.
      expect(html).toContain('value="Acme PHA"')

      // Plant the SSR markup and confirm the parsed DOM carries the value
      // before any client JS touches it.
      const root = document.createElement('div')
      document.body.appendChild(root)
      root.innerHTML = html
      const inputPre = root.querySelector('input') as HTMLInputElement | null
      if (inputPre === null) throw new Error('input missing from SSR HTML')
      expect(inputPre.getAttribute('value')).toBe('Acme PHA')

      // Client hydration over the populated container.
      app = createSSRApp(Component).use(createAttaform())
      app.mount(root)
      await waitUntil(() => (root.querySelector('input')?.value === 'Acme PHA' ? true : null))

      // No hydration-mismatch warning — the SSR markup and the client's
      // first render agree, so there's no corrective re-render flash.
      expect(hydrationMismatchWarnings()).toEqual([])
      // Value survives hydration.
      expect((root.querySelector('input') as HTMLInputElement).value).toBe('Acme PHA')
    }

    it('runtime h() + withDirectives: value present pre-hydration, hydrates clean', async () => {
      await assertNoFlashNoMismatch(makeRuntimeComponent(`ssr-hydrate-runtime-${name}`))
    })

    it('compiled dynamic :type: value present pre-hydration, hydrates clean', async () => {
      await assertNoFlashNoMismatch(makeCompiledComponent(`ssr-hydrate-compiled-${name}`))
    })
  }
)
