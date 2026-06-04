// @vitest-environment jsdom
//
// Commit 6 — plan item 12 (finding E): an async transform composes with a
// consumer `@update:registerValue` override.
//
// The override branch hands the value to the consumer's handler instead of
// writing storage itself. For an async transform the deferred orchestrator must
// therefore INVOKE the handler (not `setValueWithInternalPath`) with the
// resolved, coerced value once the run lands, exactly once — and the busy
// machinery still tracks the in-flight window even though the consumer owns the
// write. Verified across both zod adapters.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'

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

describe.each(adapters)('async transform — consumer override ($name)', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('invokes the override handler once with the resolved, coerced value and tracks busy', async () => {
    const gate = makeGate()
    const captured: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: z.object({ age: z.number() }),
          key: `override-${Math.random().toString(36).slice(2)}`,
          strict: false,
          defaultValues: { age: 0 },
        })
        handle.api = api
        const rv = api.register('age', { transforms: [gate.transform] })
        return () =>
          withDirectives(
            h('input', {
              type: 'text',
              'data-field': 'age',
              'onUpdate:registerValue': (value: unknown) => {
                captured.push(value)
              },
            }),
            [[vRegister, rv]]
          )
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const api = handle.api
    const input = root.querySelector('[data-field="age"]') as HTMLInputElement
    if (api === undefined || input === null) throw new Error('mount: api / input never set')

    input.value = '42'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await awaitSettle()

    // In flight on the override path too — busy tracks the window even though
    // the consumer owns the write. The handler has NOT fired yet.
    expect(api.fields('age').transforming).toBe(true)
    expect(api.fields('age').busy).toBe(true)
    expect(captured).toEqual([])

    // Resolve with a string — coerce (z.number()) runs AFTER the transform, so
    // the handler must receive the coerced number, exactly once.
    gate.resolve('42')
    await waitUntil(() => (captured.length === 1 ? true : null))

    expect(captured).toEqual([42])
    expect(typeof captured[0]).toBe('number')
    expect(api.fields('age').transforming).toBe(false)
    expect(api.fields('age').busy).toBe(false)
  })
})
