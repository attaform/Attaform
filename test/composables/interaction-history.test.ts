// @vitest-environment jsdom
/**
 * Interaction history survives removal (#705).
 *
 * `touched`, `interacted` and `blurredAfterInteraction` are history: they
 * record that the user worked on a field. A removal that drops a record
 * (a typed `remove`, a shrinking `setValue`, a dropped key, a container set
 * to `null`, a variant switch) folds those three flags into the own record
 * of every ancestor, and a container reads them alongside its present
 * descendants. Before, the history left with the row: removing the edited
 * row read `touched: false` on the array and the root, and the array's own
 * `min` error, which that very removal caused, stayed hidden behind a gate
 * that no longer saw the blur.
 *
 * Live state stays derived from what exists now: `focused` and `connected`
 * do not travel.
 *
 * `reset()` clears the history everywhere. `resetField(path)` clears its
 * subtree only, the history containers there kept included, and leaves the
 * ancestors above `path` with theirs.
 *
 * Mirrored across both adapters.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

const makeSchema = (z: any): any =>
  z.object({
    rows: z.array(z.object({ n: z.string().min(2) })).min(2, 'two rows'),
    addr: z.object({ line: z.string(), unit: z.string().optional() }),
    contact: z.object({ email: z.string() }).nullable(),
    channel: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('email'), address: z.string() }),
      z.object({ kind: z.literal('sms'), number: z.string() }),
    ]),
    note: z.string(),
  })

const defaults = () => ({
  rows: [{ n: 'aa' }, { n: 'bb' }],
  addr: { line: 'l', unit: 'u' },
  contact: { email: 'e@x.co' },
  channel: { kind: 'email', address: 'a@x.co' },
  note: '',
})

const apps: App[] = []

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mount(adapter: (typeof ADAPTERS)[number], render?: (form: any) => any) {
  const handle: { form?: any } = {}
  const App = defineComponent({
    setup() {
      handle.form = adapter.useForm({
        schema: makeSchema(adapter.z),
        key: `history-${Math.random().toString(36).slice(2)}`,
        defaultValues: defaults(),
      })
      return () => (render === undefined ? h('div') : render(handle.form))
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  return { form: handle.form, root }
}

const history = (state: any) => ({
  touched: state.touched,
  interacted: state.interacted,
  blurredAfterInteraction: state.blurredAfterInteraction,
})
const ALL = { touched: true, interacted: true, blurredAfterInteraction: true }
const NONE = { touched: false, interacted: false, blurredAfterInteraction: false }

const ownErrorCodes = (state: any): string[] => state.ownErrors.map((e: any) => e.code)

describe.each(ADAPTERS)('interaction history survives removal ($name)', (adapter) => {
  it.each([
    ['a typed remove', (form: any) => form.remove('rows', 1)],
    ['a shrinking setValue', (form: any) => form.setValue('rows', [{ n: 'aa' }])],
  ] as const)(
    'after %s of the edited row, the array keeps its history and shows its own error',
    async (_label, op) => {
      const { form } = mount(adapter)
      await form.interact('rows.1')
      op(form)
      await waitUntil(() => (ownErrorCodes(form.fields(['rows'])).length > 0 ? true : null))

      expect(history(form.fields(['rows']))).toEqual(ALL)
      expect(history(form.meta)).toEqual(ALL)
      // The removal is what broke `min(2)`, and the blur it follows is the
      // removed row's, so the error shows on the array and at the root.
      expect(ownErrorCodes(form.fields(['rows']))).toEqual(['zod:too_small'])
      expect(form.fields(['rows']).displayState).toBe('error')
      expect(form.meta.displayState).toBe('error')
      // The surviving row carries none of it.
      expect(history(form.fields(['rows', 0]))).toEqual(NONE)
    }
  )

  it('history travels with a removal, live state does not', async () => {
    const { form, root } = mount(adapter, (f) =>
      h(
        'div',
        f.values.rows.map((_row: unknown, i: number) =>
          withDirectives(h('input', { key: f.fields(['rows', i]).key }), [
            [vRegister, f.register(`rows.${i}.n`)],
          ])
        )
      )
    )
    await nextTick()
    const input = root.querySelectorAll('input')[1]
    if (input === undefined) throw new Error('the second row rendered no input')
    input.dispatchEvent(new FocusEvent('focus'))
    input.value = 'b'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur'))
    input.dispatchEvent(new FocusEvent('focus'))
    expect(form.fields(['rows']).focused).toBe(true)

    form.remove('rows', 1)
    await nextTick()

    expect(history(form.fields(['rows']))).toEqual(ALL)
    expect(form.fields(['rows']).focused).toBe(false)
    expect(form.fields(['rows']).connected).toBe(true)
    expect(root.querySelectorAll('input')).toHaveLength(1)
  })

  it('a dropped key hands its history to its container', async () => {
    const { form } = mount(adapter)
    await form.interact('addr.unit')
    form.setValue('addr', { line: 'l' })

    expect(form.values.addr).toEqual({ line: 'l' })
    expect(history(form.fields(['addr']))).toEqual(ALL)
    expect(history(form.meta)).toEqual(ALL)
  })

  it('a container set to null keeps the history of the leaves it held', async () => {
    const { form } = mount(adapter)
    await form.interact('contact.email')
    form.setValue('contact', null)

    expect(form.values.contact).toBe(null)
    expect(history(form.fields(['contact']))).toEqual(ALL)
    expect(history(form.meta)).toEqual(ALL)
  })

  it("a variant switch hands the outgoing variant's history to the union", async () => {
    const { form } = mount(adapter)
    await form.interact('channel.address')
    form.setValue('channel.kind', 'sms')

    expect(form.values.channel).toEqual({ kind: 'sms', number: '' })
    expect(history(form.fields(['channel']))).toEqual(ALL)
    expect(history(form.fields(['channel', 'number']))).toEqual(NONE)
  })

  it('reset() clears the history containers kept', async () => {
    const { form } = mount(adapter)
    await form.interact('rows.1')
    form.remove('rows', 1)
    expect(history(form.fields(['rows']))).toEqual(ALL)

    form.reset()

    expect(history(form.fields(['rows']))).toEqual(NONE)
    expect(history(form.meta)).toEqual(NONE)
  })

  it("resetField(path) clears its subtree's history and leaves the ancestors' own", async () => {
    const { form } = mount(adapter)
    await form.interact('rows.1')
    form.remove('rows', 1)
    expect(history(form.fields(['rows']))).toEqual(ALL)

    form.resetField('rows')

    expect(history(form.fields(['rows']))).toEqual(NONE)
    expect(history(form.fields(['rows', 0]))).toEqual(NONE)
    // The root's own record kept the history when the row went; the root
    // is above the reset subtree, so it keeps it.
    expect(history(form.meta)).toEqual(ALL)
  })
})
