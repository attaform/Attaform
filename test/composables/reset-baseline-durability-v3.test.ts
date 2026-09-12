// @vitest-environment jsdom
import { createApp, defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { useForm } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Zod v3 mirror of `reset-baseline-durability.test.ts` (#576). The fix
 * lives in the form store rather than in either adapter, so this pins
 * the contract end-to-end on the v3 path instead of restating every
 * case: `next` is durable, `next` is sparse, and an async factory's
 * payload is adopted the same way.
 */

function mountForm<R>(setup: () => R): { api: R; unmount: () => void } {
  let captured: R | undefined
  const App = defineComponent({
    setup() {
      captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  if (captured === undefined) throw new Error('mountForm: setup never returned')
  return {
    api: captured,
    unmount: () => {
      app.unmount()
      document.body.removeChild(root)
    },
  }
}

const address = z.object({ city: z.string(), state: z.string() })

describe('reset baseline durability, zod v3 (#576)', () => {
  it('a later reset() lands on the last reset(next), not on construction', () => {
    const { api: form, unmount } = mountForm(() =>
      useForm({ schema: address, defaultValues: { city: 'Ironton', state: 'oh' } })
    )
    form.reset({ city: 'Wellston', state: 'OH' })
    form.setValue('city', 'Portsmouth')
    form.reset()
    expect(form.values()).toEqual({ city: 'Wellston', state: 'OH' })
    expect(form.meta.dirty).toBe(false)
    unmount()
  })

  it('next is sparse: unmentioned paths keep the value they had', () => {
    const { api: form, unmount } = mountForm(() =>
      useForm({ schema: address, defaultValues: { city: 'Ironton', state: 'oh' } })
    )
    form.reset({ city: 'Wellston' })
    expect(form.values()).toEqual({ city: 'Wellston', state: 'oh' })
    form.reset({})
    expect(form.values()).toEqual({ city: 'Wellston', state: 'oh' })
    unmount()
  })

  it('reset() and resetField() agree on what "initial" means', () => {
    const { api: form, unmount } = mountForm(() =>
      useForm({ schema: address, defaultValues: { city: 'Ironton', state: 'oh' } })
    )
    form.reset({ city: 'Wellston', state: 'OH' })

    form.setValue('city', 'Portsmouth')
    form.resetField('city')
    const afterResetField = form.values()

    form.setValue('city', 'Portsmouth')
    form.reset()
    expect(form.values()).toEqual(afterResetField)
    unmount()
  })

  it('an async factory payload becomes the reset destination', async () => {
    const { api: form, unmount } = mountForm(() =>
      useForm({
        schema: address,
        defaultValues: () => Promise.resolve({ city: 'Ironton', state: 'oh' }),
      })
    )
    await form.activate()
    expect(form.meta.dirty).toBe(false)
    form.setValue('city', 'typed')
    form.reset()
    expect(form.values()).toEqual({ city: 'Ironton', state: 'oh' })
    unmount()
  })
})
