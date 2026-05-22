// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App, type VNode } from 'vue'
import { z } from 'zod'
import { unset, useForm, type UseFormReturn } from '../../src/zod'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import { vRegister } from '../../src/runtime/core/directive'
import { waitUntil } from '../utils/form-harness'

/**
 * `<input type="text" inputmode="numeric">` bound to a `z.number()`
 * leaf whose default is `unset` must render blank on the initial
 * frame. Storage holds the slim default (0) and the path is in
 * `blankPaths`, so the directive's display-pipe should resolve
 * `displayValue.value === ''` and the post-mount DOM sync should
 * land `el.value === ''`.
 *
 * Pairs with `blank-numeric-blur-preservation.test.ts` which covers
 * `<input type="number" v-register.number>`. This file pins the
 * same initial-render contract for the plain text + inputmode case
 * the values demo uses.
 */

const schema = z.object({
  profile: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.email().optional(),
  }),
  age: z.number(),
})

type FormApi = UseFormReturn<typeof schema>

function mountAgeInput(): {
  app: App
  input: HTMLInputElement
  form: FormApi
} {
  let captured: FormApi | undefined
  const inputRef: { el: HTMLInputElement | null } = { el: null }
  const Probe = defineComponent({
    setup() {
      const form = useForm({
        schema,
        defaultValues: {
          profile: { firstName: '', lastName: '', email: undefined },
          age: unset,
        },
        key: `unset-age-${Math.random().toString(36).slice(2)}`,
      })
      captured = form
      return (): VNode =>
        withDirectives(
          h('input', {
            type: 'text',
            inputmode: 'numeric',
            'data-field': 'age',
            ref: (el: unknown) => {
              if (el instanceof HTMLInputElement) inputRef.el = el
            },
          }),
          [[vRegister, form.register('age')]]
        )
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  if (inputRef.el === null || captured === undefined) {
    throw new Error('mountAgeInput: probe did not initialise')
  }
  return { app, input: inputRef.el, form: captured }
}

describe('age: unset on z.number() — initial render shows blank input', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('age path is in blankPaths immediately after mount', () => {
    const { app, form } = mountAgeInput()
    apps.push(app)
    expect(form.blankPaths.value.has('age')).toBe(true)
    expect(form.values.age).toBe(0)
  })

  it('the input renders empty on first frame (no flash of "0")', async () => {
    const { app, input } = mountAgeInput()
    apps.push(app)
    await waitUntil(() => (input.value === '' ? true : null))
    expect(input.value).toBe('')
  })

  it('register binding displayValue is empty for the unset leaf', () => {
    const { app, form } = mountAgeInput()
    apps.push(app)
    expect(form.register('age').displayValue.value).toBe('')
  })

  it('typing a real value clears the blank mark and shows the digit', async () => {
    const { app, input, form } = mountAgeInput()
    apps.push(app)
    await waitUntil(() => (input.value === '' ? true : null))
    input.value = '7'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await waitUntil(() => (form.values.age === 7 ? true : null))
    expect(form.values.age).toBe(7)
    expect(form.blankPaths.value.has('age')).toBe(false)
    expect(input.value).toBe('7')
  })
})
