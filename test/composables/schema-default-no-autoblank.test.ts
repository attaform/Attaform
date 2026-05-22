// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

type AnyFormReturn = UseFormReturnType<Record<string, unknown>>

/**
 * Regression — the auto-mark side-channel must NOT fire for numeric
 * leaves whose schema-declared default is non-empty.
 *
 * The /docs/schemas/defaults demo's panel 1 ("bare — schema defaults
 * only") wires `z.number().default(10)` with no `defaultValues`. The
 * intent: storage holds `10`, the `<input type="number">` renders
 * `"10"`, the user sees the schema author's prefill. Observed bug:
 * storage was `10` (per JSON readout), but the input rendered `""`.
 *
 * Root cause: `walkUnspecified` auto-marked every numeric primitive
 * encountered in the slim subtree, regardless of WHICH numeric. The
 * slim subtree at root comes from `getDefaultAtPath([])`, which
 * honors `.default(10)` and returns `{ count: 10, … }`. The walker
 * saw `count: 10` (numeric), auto-marked it, and the display path
 * collapsed to `''` — even though the schema author explicitly asked
 * for `10` as the starting value.
 *
 * The auto-mark side-channel exists for one reason: `<input
 * type="number">` can't render the slim `0` as anything other than
 * `"0"`, so the runtime records "storage holds `0`, display blank"
 * to distinguish "user supplied nothing" from "user typed 0". That
 * divergence only exists for the slim primitives (`0` / `0n`); any
 * other numeric value (including the schema's declared default) has
 * no divergence — the input can render `10` as `"10"` natively.
 *
 * The contract this test pins: auto-mark fires for `value === 0 ||
 * value === 0n`, and ONLY for those. Schema authors who declare a
 * `.default(N)` for non-empty N opt out of the side-channel and the
 * field renders their value.
 */

describe('bare useForm + z.number().default(10) — no auto-mark, input renders 10', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mountCountInput() {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const schema = z.object({
      count: z.number().default(10),
    })
    let captured!: AnyFormReturn
    const App = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: `bare-default-${Math.random().toString(36).slice(2)}`,
        })
        captured = form as unknown as AnyFormReturn
        return () =>
          withDirectives(
            h('input', {
              type: 'number',
              'data-test': 'count',
            }),
            [
              [
                vRegister,
                form.register('count'),
                undefined,
                { number: true } as unknown as Record<string, true>,
              ],
            ]
          )
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(root)
    return { app, form: captured, root }
  }

  it('storage holds 10 and the input renders "10"', async () => {
    const { app, form } = mountCountInput()
    apps.push(app)
    // Storage holds the schema's declared default.
    expect(form.values['count']).toBe(10)
    // The input must render "10", NOT "". The form's display-value
    // pipeline runs after mount + the initial reactive flush, so
    // poll rather than read immediately.
    await waitUntil(() => {
      const el = document.querySelector('input[data-test="count"]') as HTMLInputElement | null
      return el !== null && el.value === '10' ? true : null
    })
    const input = document.querySelector('input[data-test="count"]') as HTMLInputElement
    expect(input.value).toBe('10')
  })

  it('count is NOT in blankPaths', () => {
    const { app, form } = mountCountInput()
    apps.push(app)
    expect(form.blankPaths.value.has('count')).toBe(false)
  })

  it('storage = 0 (the slim) DOES auto-mark — bare z.number() with no .default()', async () => {
    // Anchor the other side of the contract. With no .default(),
    // storage holds the slim 0 and the side-channel kicks in:
    // the path is in blankPaths and the input renders "".
    const root = document.createElement('div')
    document.body.appendChild(root)
    const schema = z.object({ count: z.number() })
    let captured!: AnyFormReturn
    const App = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: `bare-slim-${Math.random().toString(36).slice(2)}`,
        })
        captured = form as unknown as AnyFormReturn
        return () =>
          withDirectives(h('input', { type: 'number', 'data-test': 'count' }), [
            [
              vRegister,
              form.register('count'),
              undefined,
              { number: true } as unknown as Record<string, true>,
            ],
          ])
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(root)
    apps.push(app)

    expect(captured.values['count']).toBe(0)
    expect(captured.blankPaths.value.has('count')).toBe(true)
    await waitUntil(() => {
      const el = document.querySelector('input[data-test="count"]') as HTMLInputElement | null
      return el !== null && el.value === '' ? true : null
    })
    const input = document.querySelector('input[data-test="count"]') as HTMLInputElement
    expect(input.value).toBe('')
  })
})
