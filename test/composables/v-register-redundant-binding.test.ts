// @vitest-environment jsdom
//
// Runtime half of the #464 redundant-binding guard. These mount via `h()`
// + `withDirectives` — no compiler plugin runs, so the compile-active
// marker is ABSENT and the runtime detection path is live (the CSR-only
// consumer, "most apps" per the docs). The compile layer is covered by
// test/transforms/redundant-binding-warn.test.ts.
//
// The runtime dedupe is keyed by a coarse `tag:type:binding` signature and
// lives at module scope, so every case below is chosen to have a DISTINCT
// signature (or to add none at all). That keeps the suite robust under
// vitest's shuffled order — no two tests race on the same key.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App, type VNode } from 'vue'
import { z } from 'zod'
import { useForm, type UseFormReturn } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { V_REGISTER_COMPILED_MODIFIER } from '../../src/runtime/core/register-protocol'
import { waitUntil } from '../utils/form-harness'

const schema = z.object({
  name: z.string(),
  agree: z.boolean(),
  fruit: z.string(),
  country: z.string(),
})
type Form = UseFormReturn<typeof schema>

let app: App | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

// Mount a render function under a fresh attaform app, capturing every
// console.warn, and return only the redundant-binding diagnostics (so an
// unrelated dev-warn from another variant can't skew the count).
async function redundantWarnsFromRender(build: (form: Form) => () => VNode): Promise<string[]> {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '))
  })
  const Comp = defineComponent({
    setup() {
      const form = useForm({ schema, key: `rb-${Math.random().toString(36).slice(2)}` })
      return build(form)
    },
  })
  app = createApp(Comp).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (root.firstElementChild !== null ? true : null))
  spy.mockRestore()
  return warns.filter((w) => w.includes('redundant beside v-register'))
}

describe('v-register runtime redundant-binding warn — state bindings warn', () => {
  it('warns on a native text input with v-model beside v-register', async () => {
    // Native v-model desugars to an `onUpdate:modelValue` prop; that key
    // is the author-only signal (the transforms never emit it).
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('name')
      return () =>
        withDirectives(h('input', { 'onUpdate:modelValue': () => undefined }), [[vRegister, rv]])
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('v-model')
    expect(warns[0]).toContain('<input>')
  })

  it('warns on a checkbox with :checked', async () => {
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('agree')
      return () =>
        withDirectives(h('input', { type: 'checkbox', checked: true }), [[vRegister, rv]])
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':checked')
  })

  it('warns on a radio with :checked (its :value identity is untouched)', async () => {
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('fruit')
      return () =>
        withDirectives(h('input', { type: 'radio', value: 'apple', checked: true }), [
          [vRegister, rv],
        ])
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':checked')
  })

  it('warns on a select with :value', async () => {
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('country')
      return () =>
        withDirectives(h('select', { value: 'us' }, [h('option', { value: 'us' }, 'US')]), [
          [vRegister, rv],
        ])
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('<select>')
  })
})

describe('v-register runtime redundant-binding warn — identity carve-out stays silent', () => {
  it('is silent on a radio with :value (radio identity)', async () => {
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('fruit')
      return () => withDirectives(h('input', { type: 'radio', value: 'apple' }), [[vRegister, rv]])
    })
    expect(warns).toHaveLength(0)
  })

  it('is silent on a checkbox with :value (member identity)', async () => {
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('agree')
      return () => withDirectives(h('input', { type: 'checkbox', value: 'x' }), [[vRegister, rv]])
    })
    expect(warns).toHaveLength(0)
  })
})

describe('v-register runtime redundant-binding warn — dedupe and stand-down', () => {
  it('warns once for a v-for of identical redundant text inputs', async () => {
    // Five distinct elements, one shared misuse signature (input::value):
    // the coarse dedupe collapses a field-array footgun to a single line.
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('name')
      return () =>
        h(
          'div',
          [0, 1, 2, 3, 4].map((i) =>
            withDirectives(h('input', { key: i, value: `v${i}` }), [[vRegister, rv]])
          )
        )
    })
    expect(warns).toHaveLength(1)
  })

  it('stands down when the compile-active marker is present (no double-warn, no false positive)', async () => {
    // A plugin consumer's compiled directive carries the marker. The
    // runtime must not read vnode.props (post-injection there) — the
    // compile layer already owns detection.
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('name')
      return () =>
        withDirectives(h('input', { value: 'x' }), [
          [vRegister, rv, undefined, { [V_REGISTER_COMPILED_MODIFIER]: true }],
        ])
    })
    expect(warns).toHaveLength(0)
  })

  it('is silent on a non-interactive host root (component-binding channel)', async () => {
    // A v-register on a <div> host with a :value is the component-binding
    // path, not a redundant native binding — the runtime guard only fires
    // on INPUT / SELECT / TEXTAREA.
    const warns = await redundantWarnsFromRender((form) => {
      const rv = form.register('name')
      return () => withDirectives(h('div', { value: 'x' }), [[vRegister, rv]])
    })
    expect(warns).toHaveLength(0)
  })
})
