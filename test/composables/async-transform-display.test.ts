// @vitest-environment jsdom
//
// Commit 6 — plan item 11 (finding D): an async transform rides the gated
// display projection, never carving a hole in the reveal contract.
//
// `displayState` (and the `aria-busy` it drives) is the GATED view: it surfaces
// `'pending'` only where a validation would — past the reveal gate, past the
// show-delay. A transform on a fresh, un-revealed field must stay `'idle'` with
// no `aria-busy`, exactly as an in-flight validation there would. The RAW
// signals (`field.transforming` / `field.busy`) stay ungated — they report
// in-flight work honestly so a consumer can light a spinner on an un-revealed
// field by binding them directly. On a revealed field the same transform drives
// `displayState` → `'pending'` + `aria-busy` past the 120ms show-delay, holding
// any earned success under the spinner rather than flashing it.
//
// Fake timers drive both the engine's deadline `setTimeout` and the injected
// `now` (vitest mocks `Date.now()`); the transform itself parks on a manual
// gate so the test owns settlement independently of the clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { DEFAULT_TIMINGS } from '../../src'

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

describe.each(adapters)('async transform — gated display ($name)', ({ useForm, z }) => {
  const apps: App[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mount(transform: () => Promise<unknown>): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: any
    input: HTMLInputElement
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: z.object({ field: z.string() }),
          key: `gated-${Math.random().toString(36).slice(2)}`,
          strict: false,
          defaultValues: { field: '' },
        })
        handle.api = api
        const rv = api.register('field', { transforms: [transform] })
        return () =>
          withDirectives(h('input', { type: 'text', 'data-field': 'field' }), [[vRegister, rv]])
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const input = root.querySelector('[data-field="field"]')
    if (handle.api === undefined || !(input instanceof HTMLInputElement)) {
      throw new Error('mount: api / input never set')
    }
    return { api: handle.api, input }
  }

  it('a fresh (un-revealed) field stays idle with no aria-busy, while raw transforming/busy flip true', async () => {
    const gate = makeGate()
    const { api, input } = mount(gate.transform)

    // Type but never blur, never submit — the reveal gate stays closed.
    input.value = 'hello'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // Raw signals report the in-flight work honestly...
    expect(api.fields('field').transforming).toBe(true)
    expect(api.fields('field').busy).toBe(true)

    // ...but the GATED projection holds idle, even past the show-delay: a
    // transform can never trip pending where a validation wouldn't have.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay * 2)
    expect(api.fields('field').displayState).toBe('idle')
    expect(api.fields('field').showPending).toBe(false)
    expect(input.hasAttribute('aria-busy')).toBe(false)

    gate.resolve('HELLO')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fields('field').transforming).toBe(false)
  })

  it('a revealed field drives pending + aria-busy past the show-delay, holding success under the spinner', async () => {
    const gate = makeGate()
    const { api, input } = mount(gate.transform)

    // Seed a valid, dirty value and reveal the field via a submit. With the
    // gate open and the field earned-valid, displayState is 'success'.
    api.setValue('field', 'SEED')
    await api.handleSubmit(() => {})()
    await nextTick()
    expect(api.fields('field').displayState).toBe('success')

    // Edit through the directive → async transform in flight (value deferred,
    // so the committed 'SEED' is still the verdict source).
    input.value = 'edited'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(api.fields('field').transforming).toBe(true)

    // Inside the show-delay: the prior success is HELD — no spinner flash, no
    // drop to idle, and the earned success is not yet swapped for pending.
    expect(api.fields('field').displayState).toBe('success')
    expect(input.hasAttribute('aria-busy')).toBe(false)

    // Cross the show-delay: the long-running transform earns the spinner, and
    // the held success is now suppressed under pending (never flashed).
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(api.fields('field').displayState).toBe('pending')
    expect(input.getAttribute('aria-busy')).toBe('true')

    // Resolve + clear min-visible: back to the settled verdict on the
    // freshly-committed value.
    gate.resolve('EDITED')
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    await nextTick()
    expect(api.fields('field').transforming).toBe(false)
    expect(api.fields('field').displayState).toBe('success')
    expect(input.hasAttribute('aria-busy')).toBe(false)
  })
})
