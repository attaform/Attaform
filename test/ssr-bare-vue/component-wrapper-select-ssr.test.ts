import { baseCompile } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, defineComponent, h } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * End-to-end SSR coverage for #394. A `v-register` on a component wrapper
 * (`<CustomSelect>` whose template is `<select><slot/></select>`) projects
 * its `<option>`s as parent-authored slot content. The compiled-template
 * path must SSR-mark the selected option exactly like an inline `<select>`,
 * otherwise the server HTML omits `selected` and the browser flashes the
 * first option until hydration corrects it.
 *
 * Mirrors `use-register-ssr.test.ts`: compile the parent template to a render
 * function (`baseCompile` `mode:'function'` → `new Function`), wire it onto a
 * parent that registers the wrapper child and seeds the model via `useForm`,
 * then assert the serialized HTML. Both zod majors are covered for parity.
 */

function compileFn(template: string): (this: unknown, ctx: unknown) => unknown {
  const result = baseCompile(template, {
    nodeTransforms: [componentBridgeTransform, vRegisterPreambleTransform, vRegisterHintTransform],
    mode: 'function',
    prefixIdentifiers: true,
    hoistStatic: false,
  })
  const fn = new Function('Vue', `${result.code}\nreturn render`)
  return fn(Vue) as (this: unknown, ctx: unknown) => unknown
}

// The styled wrapper under test: `<select><slot/></select>`, forwarding
// `multiple` to the inner native control. `inheritAttrs: false` keeps the
// bridged host props (registerValue / value / data-atta-pre-mark) off the
// <select>, matching a real component wrapper.
const CustomSelect = defineComponent({
  name: 'CustomSelect',
  props: { multiple: { type: Boolean, default: false } },
  inheritAttrs: false,
  setup(props, { slots }) {
    return () => h('select', { multiple: props.multiple }, [slots['default']?.()])
  },
})

// Extract the full `<option ...>` open tag carrying value="<value>", whatever
// the attribute order — so the `selected` assertion is order-independent.
function optionTag(html: string, value: string): string {
  const match = html.match(new RegExp(`<option\\b[^>]*\\bvalue="${value}"[^>]*>`))
  return match ? match[0] : ''
}

const OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
]

type UseFormish = (config: Record<string, unknown>) => unknown

function mountSingle(useForm: UseFormish, makeSchema: () => unknown, template: string) {
  const render = compileFn(template)
  const Parent = defineComponent({
    name: 'Parent',
    components: { CustomSelect },
    setup() {
      const form = useForm({
        schema: makeSchema(),
        key: `wrap-single-${Math.random()}`,
        defaultValues: { role: 'editor' },
      })
      return { form, options: OPTIONS }
    },
    render,
  })
  return createSSRApp(Parent).use(createAttaform())
}

function mountMulti(useForm: UseFormish, makeSchema: () => unknown, template: string) {
  const render = compileFn(template)
  const Parent = defineComponent({
    name: 'Parent',
    components: { CustomSelect },
    setup() {
      const form = useForm({
        schema: makeSchema(),
        key: `wrap-multi-${Math.random()}`,
        defaultValues: { roles: ['editor', 'viewer'] },
      })
      return { form, options: OPTIONS }
    },
    render,
  })
  return createSSRApp(Parent).use(createAttaform())
}

const SINGLE_TPL = `<CustomSelect v-register="form.register('role')"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></CustomSelect>`
const MULTI_TPL = `<CustomSelect v-register="form.register('roles')" multiple><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></CustomSelect>`

function runSuite(
  label: string,
  useForm: UseFormish,
  single: () => unknown,
  multi: () => unknown
): void {
  describe(`component-wrapped <select> SSR marks slotted options (${label})`, () => {
    it('single-select: the seeded option renders selected in the SSR HTML', async () => {
      const html = await renderToString(mountSingle(useForm, single, SINGLE_TPL))
      expect(optionTag(html, 'editor')).toContain('selected')
      expect(optionTag(html, 'admin')).not.toContain('selected')
      expect(optionTag(html, 'viewer')).not.toContain('selected')
    })

    it('multi-select: every member option renders selected, non-members do not', async () => {
      const html = await renderToString(mountMulti(useForm, multi, MULTI_TPL))
      expect(optionTag(html, 'editor')).toContain('selected')
      expect(optionTag(html, 'viewer')).toContain('selected')
      expect(optionTag(html, 'admin')).not.toContain('selected')
    })
  })
}

runSuite(
  'v4',
  useFormV4 as unknown as UseFormish,
  () => zV4.object({ role: zV4.string() }),
  () => zV4.object({ roles: zV4.array(zV4.string()) })
)

runSuite(
  'v3',
  useFormV3 as unknown as UseFormish,
  () => zV3.object({ role: zV3.string() }),
  () => zV3.object({ roles: zV3.array(zV3.string()) })
)
