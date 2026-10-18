// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * After `rehydrate()`, `dirty` means "differs from what the factory just
 * returned". A list the factory names replaces the live one, so its rows are
 * the new baseline's rows whatever order the old ones were in, and a row the
 * new list lacks is no removal. A list the factory leaves out keeps the live
 * rows, and a reorder or removal there stays dirty.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

function mountWithApp<T>(setup: () => T): T {
  const handle: { captured?: T } = {}
  const Probe = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(Probe).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

type Load = { title?: string; rows?: { n: string }[] }

const THREE: Load = { title: 'T', rows: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] }

describe('rehydrate() and row order, zod-V3 adapter', () => {
  const schema = zV3.object({
    title: zV3.string(),
    rows: zV3.array(zV3.object({ n: zV3.string() })),
  })

  async function loaded() {
    const loads: { next: Load } = { next: THREE }
    const form = mountWithApp(() =>
      useFormV3({
        schema,
        key: `rehydrate-order-v3-${Math.random()}`,
        defaultValues: () => Promise.resolve(loads.next),
      })
    )
    await form.activate()
    return { form, loads }
  }

  it('a list the factory replaces reads pristine, whatever order its rows were in', async () => {
    const { form, loads } = await loaded()
    form.swap('rows', 0, 1)
    loads.next = { rows: [{ n: 'r' }, { n: 's' }, { n: 't' }] }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(false)
    expect(form.meta.dirty).toBe(false)
    form.swap('rows', 0, 2)
    loads.next = { rows: [{ n: 'r' }, { n: 's' }] }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(false)
    expect(form.meta.dirty).toBe(false)
  })

  it('a row the new list lacks is no removal', async () => {
    const { form, loads } = await loaded()
    form.remove('rows', 2)
    expect(form.meta.dirty).toBe(true)
    loads.next = { rows: [{ n: 'a' }, { n: 'b' }] }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(false)
    expect(form.meta.dirty).toBe(false)
  })

  it('a list the factory leaves out keeps a reorder dirty', async () => {
    const { form, loads } = await loaded()
    form.swap('rows', 0, 1)
    loads.next = { title: 'fresh' }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(true)
    expect(form.fields('title').dirty).toBe(false)
  })

  it('a list the factory leaves out keeps a removal dirty', async () => {
    const { form, loads } = await loaded()
    form.remove('rows', 2)
    loads.next = { title: 'fresh' }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(true)
    expect(form.meta.dirty).toBe(true)
  })
})

describe('rehydrate() and row order, zod-V4 adapter', () => {
  const schema = zV4.object({
    title: zV4.string(),
    rows: zV4.array(zV4.object({ n: zV4.string() })),
  })

  async function loaded() {
    const loads: { next: Load } = { next: THREE }
    const form = mountWithApp(() =>
      useFormV4({
        schema,
        key: `rehydrate-order-v4-${Math.random()}`,
        defaultValues: () => Promise.resolve(loads.next),
      })
    )
    await form.activate()
    return { form, loads }
  }

  it('a list the factory replaces reads pristine, whatever order its rows were in', async () => {
    const { form, loads } = await loaded()
    form.swap('rows', 0, 1)
    loads.next = { rows: [{ n: 'r' }, { n: 's' }, { n: 't' }] }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(false)
    expect(form.meta.dirty).toBe(false)
    form.swap('rows', 0, 2)
    loads.next = { rows: [{ n: 'r' }, { n: 's' }] }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(false)
    expect(form.meta.dirty).toBe(false)
  })

  it('a row the new list lacks is no removal', async () => {
    const { form, loads } = await loaded()
    form.remove('rows', 2)
    expect(form.meta.dirty).toBe(true)
    loads.next = { rows: [{ n: 'a' }, { n: 'b' }] }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(false)
    expect(form.meta.dirty).toBe(false)
  })

  it('a list the factory leaves out keeps a reorder dirty', async () => {
    const { form, loads } = await loaded()
    form.swap('rows', 0, 1)
    loads.next = { title: 'fresh' }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(true)
    expect(form.fields('title').dirty).toBe(false)
  })

  it('a list the factory leaves out keeps a removal dirty', async () => {
    const { form, loads } = await loaded()
    form.remove('rows', 2)
    loads.next = { title: 'fresh' }
    await form.rehydrate()
    expect(form.fields('rows').dirty).toBe(true)
    expect(form.meta.dirty).toBe(true)
  })
})
