// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * A function-form `defaultValues` hands the form a value the consumer may
 * still hold: a fetch cache, a store, a module constant. The form takes a copy
 * of it, as it does of a plain `defaultValues`, so its in-place writes (a
 * typed array op, a leaf edit) never reach the consumer's object.
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

type Payload = { title: string; rows: { n: string; tags: string[] }[] }

function freshPayload(): Payload {
  return {
    title: 'T',
    rows: [
      { n: 'a', tags: ['a1'] },
      { n: 'b', tags: [] },
    ],
  }
}

describe('function-form defaultValues are copied, zod-V3 adapter', () => {
  const schema = zV3.object({
    title: zV3.string(),
    rows: zV3.array(zV3.object({ n: zV3.string(), tags: zV3.array(zV3.string()) })),
  })

  it('form edits never reach the value an async factory resolved', async () => {
    const payload = freshPayload()
    const form = mountWithApp(() =>
      useFormV3({
        schema,
        key: `factory-copy-v3-${Math.random()}`,
        defaultValues: () => Promise.resolve(payload),
      })
    )
    await form.activate()
    form.swap('rows', 0, 1)
    form.setValue('rows.0.n', 'edited')
    form.append('rows.0.tags', 'added')
    form.setValue('title', 'changed')
    expect(payload).toEqual(freshPayload())
    expect(form.values.rows.map((row) => row.n)).toEqual(['edited', 'a'])
  })

  it('a sync factory is copied too', async () => {
    const payload = freshPayload()
    const form = mountWithApp(() =>
      useFormV3({
        schema,
        key: `factory-copy-sync-v3-${Math.random()}`,
        defaultValues: () => payload,
      })
    )
    await form.activate()
    form.remove('rows', 0)
    form.setValue('rows.0.n', 'edited')
    expect(payload).toEqual(freshPayload())
  })

  it('rehydrate() copies the value it loads', async () => {
    const longer = (): Payload => ({
      ...freshPayload(),
      rows: [...freshPayload().rows, { n: 'c', tags: [] }],
    })
    let payload = freshPayload()
    const form = mountWithApp(() =>
      useFormV3({
        schema,
        key: `factory-copy-rehydrate-v3-${Math.random()}`,
        defaultValues: () => Promise.resolve(payload),
      })
    )
    await form.activate()
    payload = longer()
    await form.rehydrate()
    form.swap('rows', 0, 2)
    form.append('rows.2.tags', 'added')
    expect(payload).toEqual(longer())
  })
})

describe('function-form defaultValues are copied, zod-V4 adapter', () => {
  const schema = zV4.object({
    title: zV4.string(),
    rows: zV4.array(zV4.object({ n: zV4.string(), tags: zV4.array(zV4.string()) })),
  })

  it('form edits never reach the value an async factory resolved', async () => {
    const payload = freshPayload()
    const form = mountWithApp(() =>
      useFormV4({
        schema,
        key: `factory-copy-v4-${Math.random()}`,
        defaultValues: () => Promise.resolve(payload),
      })
    )
    await form.activate()
    form.swap('rows', 0, 1)
    form.setValue('rows.0.n', 'edited')
    form.append('rows.0.tags', 'added')
    form.setValue('title', 'changed')
    expect(payload).toEqual(freshPayload())
    expect(form.values.rows.map((row) => row.n)).toEqual(['edited', 'a'])
  })

  it('a sync factory is copied too', async () => {
    const payload = freshPayload()
    const form = mountWithApp(() =>
      useFormV4({
        schema,
        key: `factory-copy-sync-v4-${Math.random()}`,
        defaultValues: () => payload,
      })
    )
    await form.activate()
    form.remove('rows', 0)
    form.setValue('rows.0.n', 'edited')
    expect(payload).toEqual(freshPayload())
  })

  it('rehydrate() copies the value it loads', async () => {
    const longer = (): Payload => ({
      ...freshPayload(),
      rows: [...freshPayload().rows, { n: 'c', tags: [] }],
    })
    let payload = freshPayload()
    const form = mountWithApp(() =>
      useFormV4({
        schema,
        key: `factory-copy-rehydrate-v4-${Math.random()}`,
        defaultValues: () => Promise.resolve(payload),
      })
    )
    await form.activate()
    payload = longer()
    await form.rehydrate()
    form.swap('rows', 0, 2)
    form.append('rows.2.tags', 'added')
    expect(payload).toEqual(longer())
  })
})
