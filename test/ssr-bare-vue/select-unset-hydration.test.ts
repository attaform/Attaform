// @vitest-environment jsdom
/**
 * Hydration must not move a `<select>`'s selection (#569).
 *
 * The cross-path parity matrix asserts what each render path EMITS and
 * that hydration produces no mismatch warning, but a select's
 * `selectedIndex` is a DOM property, not markup: the client can move it
 * without Vue calling that a mismatch. That is the gap #569 came
 * through. For a path the form did not hold, the server marked no
 * option, so the browser parsed the first one as selected, and the
 * client directive then cleared the selection outright — a visible
 * flip from the placeholder to an empty box on every unseeded select.
 *
 * The pin is the property the matrix cannot state: whatever the browser
 * parses out of the server's HTML is what the page still shows once the
 * client has run.
 */
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, withDirectives, type Component } from 'vue'
import { ADAPTERS, compileToRender, settle } from '../utils/ssr-cross-path'
import { installVRegister, vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'

const OPTION_VALUES = ['', 'uk'] as const

const TEMPLATE =
  `<select v-register="form.register('country')">` +
  OPTION_VALUES.map((v) => `<option value="${v}">${v === '' ? 'None' : v}</option>`).join('') +
  `</select>`

/** Render on the server, plant the markup, hydrate over it. */
async function selectedIndexAcrossHydration(
  Comp: Component
): Promise<{ parsed: number; hydrated: number }> {
  const serverApp = createSSRApp(Comp).use(createAttaform())
  installVRegister(serverApp)
  const html = await renderToString(serverApp)

  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  const el = root.querySelector('select')
  if (el === null) throw new Error('no <select> in the server markup')
  const parsed = el.selectedIndex

  const app = createSSRApp(Comp).use(createAttaform())
  installVRegister(app)
  app.mount(root)
  await settle()
  const hydrated = el.selectedIndex

  app.unmount()
  root.remove()
  return { parsed, hydrated }
}

describe.each(ADAPTERS)('an unset <select> survives hydration ($name)', (adapter) => {
  function makeSetup(defaultValues: Record<string, unknown>) {
    return () => {
      const form = adapter.useForm({
        schema: adapter.z.object({ country: adapter.z.string().optional() }),
        key: `select-unset-hydration-${adapter.name}`,
        defaultValues,
      })
      return { form }
    }
  }

  it('keeps the placeholder the server painted (compiled path)', async () => {
    const Comp = defineComponent({ setup: makeSetup({}), render: compileToRender(TEMPLATE) })
    const { parsed, hydrated } = await selectedIndexAcrossHydration(Comp)
    expect(parsed).toBe(0)
    expect(hydrated).toBe(parsed)
  })

  it('keeps the placeholder the server painted (runtime path)', async () => {
    // The runtime path emits no option-level state, so the browser's own
    // "first option" fallback is what it paints. The client has to land
    // on the same option, which it does here because the placeholder
    // leads the list.
    const Comp = defineComponent({
      setup: makeSetup({}),
      render(this: { form: { register: (p: string) => unknown } }) {
        return withDirectives(
          h(
            'select',
            null,
            OPTION_VALUES.map((v) => h('option', { value: v }, v === '' ? 'None' : v))
          ),
          [[vRegister, this.form.register('country')]]
        )
      },
    })
    const { parsed, hydrated } = await selectedIndexAcrossHydration(Comp)
    expect(parsed).toBe(0)
    expect(hydrated).toBe(parsed)
  })

  it('keeps a seeded selection through hydration (compiled path)', async () => {
    const Comp = defineComponent({
      setup: makeSetup({ country: 'uk' }),
      render: compileToRender(TEMPLATE),
    })
    const { parsed, hydrated } = await selectedIndexAcrossHydration(Comp)
    expect(parsed).toBe(1)
    expect(hydrated).toBe(parsed)
  })
})
