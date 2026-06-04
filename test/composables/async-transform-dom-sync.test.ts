// @vitest-environment jsdom
//
// Commit 6 — plan item 10 (finding C): an async transform must NOT revert the
// user's input mid-flight.
//
// Every directive variant re-reads storage after the assigner write and snaps
// the DOM to it (the force-sync that fixes the clamp-divergence bug). With a
// deferred async commit, storage is still the OLD value at that instant — so a
// naive force-sync would erase the typed text / un-tick the box / drop the
// selection the moment the user acts. The directive skips the synchronous
// force-sync while a transform is in flight (`isTransforming(value)` is already
// true) and instead repaints from the freshly-committed storage inside the
// deferred `.then`. This file pins both halves for text, checkbox, and select
// — each owns a distinct force-sync block — across both zod adapters.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'

// A transform whose single call parks on an externally-resolvable promise, so
// the test can sit inside the in-flight window and assert the DOM mid-flight.
function makeGate(): {
  transform: () => Promise<unknown>
  resolve: (value: unknown) => void
} {
  let resolveFn: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((resolve) => {
    resolveFn = resolve
  })
  return { transform: () => promise, resolve: (value) => resolveFn(value) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)('async transform — no mid-flight DOM revert ($name)', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mount(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any
    field: string
    defaultValues: Record<string, unknown>
    transform: () => Promise<unknown>
    render: (rv: unknown) => ReturnType<typeof h>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): { api: any; root: HTMLElement } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: opts.schema,
          key: `dom-sync-${Math.random().toString(36).slice(2)}`,
          strict: false,
          defaultValues: opts.defaultValues,
        })
        handle.api = api
        const rv = api.register(opts.field, { transforms: [opts.transform] })
        return () => opts.render(rv)
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (handle.api === undefined) throw new Error('mount: api never set')
    return { api: handle.api, root }
  }

  it('text input keeps the typed value during the await, then repaints the resolved value', async () => {
    const gate = makeGate()
    const { api, root } = mount({
      schema: z.object({ field: z.string() }),
      field: 'field',
      defaultValues: { field: '' },
      transform: gate.transform,
      render: (rv) =>
        withDirectives(h('input', { type: 'text', 'data-field': 'field' }), [[vRegister, rv]]),
    })
    const input = root.querySelector('[data-field="field"]') as HTMLInputElement

    input.value = 'hello'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await awaitSettle()

    // Mid-flight: the DOM holds the user's text; storage is untouched (the
    // commit is deferred). A force-sync here would have snapped it back to ''.
    expect(input.value).toBe('hello')
    expect(api.values.field).toBe('')
    expect(api.fields('field').transforming).toBe(true)

    gate.resolve('HELLO')
    await waitUntil(() => (api.values.field === 'HELLO' ? true : null))

    // Committed + repainted to the normalized value.
    expect(api.values.field).toBe('HELLO')
    expect(input.value).toBe('HELLO')
    expect(api.fields('field').transforming).toBe(false)
  })

  it('checkbox keeps the toggle during the await, then repaints the resolved state', async () => {
    const gate = makeGate()
    const { api, root } = mount({
      schema: z.object({ box: z.boolean() }),
      field: 'box',
      defaultValues: { box: false },
      transform: gate.transform,
      render: (rv) =>
        withDirectives(h('input', { type: 'checkbox', 'data-field': 'box' }), [[vRegister, rv]]),
    })
    const box = root.querySelector('[data-field="box"]') as HTMLInputElement

    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await awaitSettle()

    // Mid-flight: stays ticked while storage is still false.
    expect(box.checked).toBe(true)
    expect(api.values.box).toBe(false)

    // Resolve to `false` — the repaint must un-tick it to match storage.
    gate.resolve(false)
    await waitUntil(() => (api.fields('box').transforming === false ? true : null))

    expect(api.values.box).toBe(false)
    expect(box.checked).toBe(false)
  })

  it('select keeps the chosen option during the await, then repaints the resolved option', async () => {
    const gate = makeGate()
    const { api, root } = mount({
      schema: z.object({ pick: z.enum(['a', 'b', 'c']) }),
      field: 'pick',
      defaultValues: { pick: 'a' },
      transform: gate.transform,
      render: (rv) =>
        withDirectives(
          h('select', { 'data-field': 'pick' }, [
            h('option', { value: 'a' }, 'a'),
            h('option', { value: 'b' }, 'b'),
            h('option', { value: 'c' }, 'c'),
          ]),
          [[vRegister, rv]]
        ),
    })
    const select = root.querySelector('[data-field="pick"]') as HTMLSelectElement

    select.value = 'b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await awaitSettle()

    // Mid-flight: holds 'b' while storage is still 'a'.
    expect(select.value).toBe('b')
    expect(api.values.pick).toBe('a')

    // Resolve to 'c' — the repaint moves the selection to match storage.
    gate.resolve('c')
    await waitUntil(() => (api.values.pick === 'c' ? true : null))

    expect(api.values.pick).toBe('c')
    expect(select.value).toBe('c')
  })
})
