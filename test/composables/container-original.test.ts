// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createApp, createSSRApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { hydrateAttaformState, renderAttaformState } from '../../src/runtime/core/serialize'

/**
 * `fields(container).original` is the value the container started as. A row
 * follows its identity to its own baseline across the typed array ops, a row
 * added since reads `undefined`, and the baseline moves with `reset()`, async
 * defaults and `rehydrate()`. Each read is a copy, so nothing a consumer does
 * with it reaches the baseline.
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

type Seed = {
  title: string
  rows: { n: string; items: { q: string }[] }[]
  pet: { kind: 'cat'; meow: string } | { kind: 'dog'; bark: string }
}

const SEED: Seed = {
  title: 'T',
  rows: [
    { n: 'a', items: [{ q: 'a1' }] },
    { n: 'b', items: [{ q: 'b1' }, { q: 'b2' }] },
    { n: 'c', items: [] },
  ],
  pet: { kind: 'cat', meow: 'm' },
}

const ROW_A = { n: 'a', items: [{ q: 'a1' }] }
const ROW_B = { n: 'b', items: [{ q: 'b1' }, { q: 'b2' }] }
const ROW_C = { n: 'c', items: [] }

describe('fields(container).original, zod-V3 adapter', () => {
  const schema = zV3.object({
    title: zV3.string(),
    rows: zV3.array(
      zV3.object({ n: zV3.string(), items: zV3.array(zV3.object({ q: zV3.string() })) })
    ),
    pet: zV3.discriminatedUnion('kind', [
      zV3.object({ kind: zV3.literal('cat'), meow: zV3.string() }),
      zV3.object({ kind: zV3.literal('dog'), bark: zV3.string() }),
    ]),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({ schema, key: `original-v3-${Math.random()}`, defaultValues: SEED })
    )
  }

  it('reads the value each container started as', () => {
    const form = makeForm()
    expect(form.meta.original).toEqual(SEED)
    expect(form.fields('rows').original).toEqual(SEED.rows)
    expect(form.fields('rows.1').original).toEqual(ROW_B)
    expect(form.fields('rows.1.items').original).toEqual(ROW_B.items)
    expect(form.fields('rows.1.items.0').original).toEqual({ q: 'b1' })
    expect(form.fields('rows.2.items').original).toEqual([])
    expect(form.fields('pet').original).toEqual(SEED.pet)
  })

  it('a row with no edits reads its value as its original, and is not dirty', () => {
    const form = makeForm()
    form.setValue('rows.1.n', 'edited')
    for (const index of [0, 2]) {
      const row = form.fields(`rows.${index}`)
      expect(row.original).toEqual(row.value)
      expect(row.dirty).toBe(false)
    }
    expect(form.fields('rows.1').original).toEqual(ROW_B)
    expect(form.fields('rows.1').dirty).toBe(true)
  })

  it('after a removal, each row reads its own baseline', () => {
    const form = makeForm()
    form.remove('rows', 0)
    expect(form.fields('rows').original).toEqual(SEED.rows)
    expect(form.fields('rows.0').original).toEqual(ROW_B)
    expect(form.fields('rows.0.n').original).toBe('b')
    expect(form.fields('rows.0.items').original).toEqual(ROW_B.items)
    expect(form.fields('rows.0.items.1').original).toEqual({ q: 'b2' })
    expect(form.fields('rows.1').original).toEqual(ROW_C)
    expect(form.fields('rows.0').dirty).toBe(false)
  })

  it('follows a row across swap and move', () => {
    const form = makeForm()
    form.swap('rows', 0, 2)
    expect(form.fields('rows.0').original).toEqual(ROW_C)
    expect(form.fields('rows.2').original).toEqual(ROW_A)
    form.move('rows', 0, 1)
    expect(form.values.rows.map((row) => row.n)).toEqual(['b', 'c', 'a'])
    expect(form.fields('rows.0').original).toEqual(ROW_B)
    expect(form.fields('rows.1').original).toEqual(ROW_C)
    expect(form.fields('rows.2').original).toEqual(ROW_A)
  })

  it('a row added since reads undefined', () => {
    const form = makeForm()
    form.insert('rows', 1, { n: 'new', items: [] })
    form.append('rows', { n: 'last', items: [] })
    expect(form.fields('rows.1').original).toBeUndefined()
    expect(form.fields('rows.1.n').original).toBeUndefined()
    expect(form.fields('rows.2').original).toEqual(ROW_B)
    expect(form.fields('rows.4').original).toBeUndefined()
  })

  it('a nested list follows its own rows, and its parent row', () => {
    const form = makeForm()
    form.swap('rows.1.items', 0, 1)
    expect(form.fields('rows.1.items.0').original).toEqual({ q: 'b2' })
    expect(form.fields('rows.1.items').original).toEqual(ROW_B.items)
    form.remove('rows', 0)
    expect(form.fields('rows.0.items.0').original).toEqual({ q: 'b2' })
    expect(form.fields('rows.0.items.1').original).toEqual({ q: 'b1' })
  })

  it('reset() moves the baseline to the values it lands on', () => {
    const form = makeForm()
    form.remove('rows', 0)
    form.reset({ rows: [{ n: 'z', items: [{ q: 'z1' }] }] })
    expect(form.fields('rows').original).toEqual([{ n: 'z', items: [{ q: 'z1' }] }])
    expect(form.fields('rows.0').original).toEqual({ n: 'z', items: [{ q: 'z1' }] })
    form.append('rows', { n: 'y', items: [] })
    form.swap('rows', 0, 1)
    expect(form.fields('rows.1').original).toEqual({ n: 'z', items: [{ q: 'z1' }] })
    expect(form.fields('rows.0').original).toBeUndefined()
    form.reset()
    expect(form.fields('rows').original).toEqual([{ n: 'z', items: [{ q: 'z1' }] }])
  })

  it('an edit after reset() leaves the baseline alone', () => {
    const form = makeForm()
    form.reset({ rows: [{ n: 'z', items: [] }] })
    form.setValue('rows.0.n', 'edited')
    form.append('rows.0.items', { q: 'added' })
    expect(form.fields('rows.0').original).toEqual({ n: 'z', items: [] })
  })

  it('writing an original back, then editing, leaves the baseline alone', () => {
    const form = makeForm()
    form.setValue('rows.0.n', 'edited')
    form.setValue('rows.0', form.fields('rows.0').original)
    expect(form.fields('rows.0').dirty).toBe(false)
    form.setValue('rows.0.n', 'again')
    form.append('rows.0.items', { q: 'added' })
    expect(form.fields('rows.0').original).toEqual(ROW_A)
    expect(form.fields('rows').original).toEqual(SEED.rows)
  })

  it('every read shares one frozen value', () => {
    const form = makeForm()
    const rows = form.fields('rows').original
    expect(rows).toEqual(SEED.rows)
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(form.fields('rows.1').original)).toBe(true)
    expect(Object.isFrozen(form.fields('rows.1.items').original)).toBe(true)
    form.setValue('title', 'changed')
    form.setValue('rows.0.n', 'edited')
    expect(form.fields('rows').original).toBe(rows)
  })

  it('reads the variant a union started as after a switch', () => {
    const form = makeForm()
    form.setValue('pet', { kind: 'dog', bark: 'w' })
    expect(form.fields('pet').original).toEqual({ kind: 'cat', meow: 'm' })
    expect(form.fields('pet').dirty).toBe(true)
  })

  it('async defaults and rehydrate() move the baseline', async () => {
    let load: Seed = SEED
    const form = mountWithApp(() =>
      useFormV3({
        schema,
        key: `original-async-v3-${Math.random()}`,
        defaultValues: () => Promise.resolve(load),
      })
    )
    await form.activate()
    expect(form.fields('rows').original).toEqual(SEED.rows)
    expect(form.fields('rows.1').original).toEqual(ROW_B)
    form.swap('rows', 0, 1)
    load = { ...SEED, rows: [{ n: 'r', items: [] }, ROW_C] }
    await form.rehydrate()
    expect(form.fields('rows').original).toEqual([{ n: 'r', items: [] }, ROW_C])
    expect(form.fields('rows.0').original).toEqual({ n: 'r', items: [] })
    expect(form.fields('rows.1').original).toEqual(ROW_C)
    expect(form.fields('rows').dirty).toBe(false)
  })

  it('a hydrated client reads the baseline its defaults give', async () => {
    const key = `original-ssr-v3-${Math.random()}`
    const useSeeded = () => useFormV3({ schema, key, defaultValues: SEED })
    const Server = defineComponent({
      setup() {
        const form = useSeeded()
        form.setValue('rows.1.n', 'server')
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(Server).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    const payload = JSON.parse(JSON.stringify(renderAttaformState(ssrApp)))
    const handle: { form?: ReturnType<typeof useSeeded> } = {}
    const Client = defineComponent({
      setup() {
        handle.form = useSeeded()
        return () => h('div')
      },
    })
    const clientApp = createApp(Client).use(createAttaform())
    hydrateAttaformState(clientApp, payload)
    clientApp.mount(document.createElement('div'))
    apps.push(clientApp)
    const form = handle.form
    expect(form?.values.rows[1]?.n).toBe('server')
    expect(form?.fields('rows.1').original).toEqual(ROW_B)
    expect(form?.fields('rows.1').dirty).toBe(true)
    expect(form?.fields('rows').original).toEqual(SEED.rows)
  })
})

describe('fields(container).original, zod-V4 adapter', () => {
  const schema = zV4.object({
    title: zV4.string(),
    rows: zV4.array(
      zV4.object({ n: zV4.string(), items: zV4.array(zV4.object({ q: zV4.string() })) })
    ),
    pet: zV4.discriminatedUnion('kind', [
      zV4.object({ kind: zV4.literal('cat'), meow: zV4.string() }),
      zV4.object({ kind: zV4.literal('dog'), bark: zV4.string() }),
    ]),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({ schema, key: `original-v4-${Math.random()}`, defaultValues: SEED })
    )
  }

  it('reads the value each container started as', () => {
    const form = makeForm()
    expect(form.meta.original).toEqual(SEED)
    expect(form.fields('rows').original).toEqual(SEED.rows)
    expect(form.fields('rows.1').original).toEqual(ROW_B)
    expect(form.fields('rows.1.items').original).toEqual(ROW_B.items)
    expect(form.fields('rows.1.items.0').original).toEqual({ q: 'b1' })
    expect(form.fields('rows.2.items').original).toEqual([])
    expect(form.fields('pet').original).toEqual(SEED.pet)
  })

  it('a row with no edits reads its value as its original, and is not dirty', () => {
    const form = makeForm()
    form.setValue('rows.1.n', 'edited')
    for (const index of [0, 2]) {
      const row = form.fields(`rows.${index}`)
      expect(row.original).toEqual(row.value)
      expect(row.dirty).toBe(false)
    }
    expect(form.fields('rows.1').original).toEqual(ROW_B)
    expect(form.fields('rows.1').dirty).toBe(true)
  })

  it('after a removal, each row reads its own baseline', () => {
    const form = makeForm()
    form.remove('rows', 0)
    expect(form.fields('rows').original).toEqual(SEED.rows)
    expect(form.fields('rows.0').original).toEqual(ROW_B)
    expect(form.fields('rows.0.n').original).toBe('b')
    expect(form.fields('rows.0.items').original).toEqual(ROW_B.items)
    expect(form.fields('rows.0.items.1').original).toEqual({ q: 'b2' })
    expect(form.fields('rows.1').original).toEqual(ROW_C)
    expect(form.fields('rows.0').dirty).toBe(false)
  })

  it('follows a row across swap and move', () => {
    const form = makeForm()
    form.swap('rows', 0, 2)
    expect(form.fields('rows.0').original).toEqual(ROW_C)
    expect(form.fields('rows.2').original).toEqual(ROW_A)
    form.move('rows', 0, 1)
    expect(form.values.rows.map((row) => row.n)).toEqual(['b', 'c', 'a'])
    expect(form.fields('rows.0').original).toEqual(ROW_B)
    expect(form.fields('rows.1').original).toEqual(ROW_C)
    expect(form.fields('rows.2').original).toEqual(ROW_A)
  })

  it('a row added since reads undefined', () => {
    const form = makeForm()
    form.insert('rows', 1, { n: 'new', items: [] })
    form.append('rows', { n: 'last', items: [] })
    expect(form.fields('rows.1').original).toBeUndefined()
    expect(form.fields('rows.1.n').original).toBeUndefined()
    expect(form.fields('rows.2').original).toEqual(ROW_B)
    expect(form.fields('rows.4').original).toBeUndefined()
  })

  it('a nested list follows its own rows, and its parent row', () => {
    const form = makeForm()
    form.swap('rows.1.items', 0, 1)
    expect(form.fields('rows.1.items.0').original).toEqual({ q: 'b2' })
    expect(form.fields('rows.1.items').original).toEqual(ROW_B.items)
    form.remove('rows', 0)
    expect(form.fields('rows.0.items.0').original).toEqual({ q: 'b2' })
    expect(form.fields('rows.0.items.1').original).toEqual({ q: 'b1' })
  })

  it('reset() moves the baseline to the values it lands on', () => {
    const form = makeForm()
    form.remove('rows', 0)
    form.reset({ rows: [{ n: 'z', items: [{ q: 'z1' }] }] })
    expect(form.fields('rows').original).toEqual([{ n: 'z', items: [{ q: 'z1' }] }])
    expect(form.fields('rows.0').original).toEqual({ n: 'z', items: [{ q: 'z1' }] })
    form.append('rows', { n: 'y', items: [] })
    form.swap('rows', 0, 1)
    expect(form.fields('rows.1').original).toEqual({ n: 'z', items: [{ q: 'z1' }] })
    expect(form.fields('rows.0').original).toBeUndefined()
    form.reset()
    expect(form.fields('rows').original).toEqual([{ n: 'z', items: [{ q: 'z1' }] }])
  })

  it('an edit after reset() leaves the baseline alone', () => {
    const form = makeForm()
    form.reset({ rows: [{ n: 'z', items: [] }] })
    form.setValue('rows.0.n', 'edited')
    form.append('rows.0.items', { q: 'added' })
    expect(form.fields('rows.0').original).toEqual({ n: 'z', items: [] })
  })

  it('writing an original back, then editing, leaves the baseline alone', () => {
    const form = makeForm()
    form.setValue('rows.0.n', 'edited')
    form.setValue('rows.0', form.fields('rows.0').original)
    expect(form.fields('rows.0').dirty).toBe(false)
    form.setValue('rows.0.n', 'again')
    form.append('rows.0.items', { q: 'added' })
    expect(form.fields('rows.0').original).toEqual(ROW_A)
    expect(form.fields('rows').original).toEqual(SEED.rows)
  })

  it('every read shares one frozen value', () => {
    const form = makeForm()
    const rows = form.fields('rows').original
    expect(rows).toEqual(SEED.rows)
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(form.fields('rows.1').original)).toBe(true)
    expect(Object.isFrozen(form.fields('rows.1.items').original)).toBe(true)
    form.setValue('title', 'changed')
    form.setValue('rows.0.n', 'edited')
    expect(form.fields('rows').original).toBe(rows)
  })

  it('reads the variant a union started as after a switch', () => {
    const form = makeForm()
    form.setValue('pet', { kind: 'dog', bark: 'w' })
    expect(form.fields('pet').original).toEqual({ kind: 'cat', meow: 'm' })
    expect(form.fields('pet').dirty).toBe(true)
  })

  it('async defaults and rehydrate() move the baseline', async () => {
    let load: Seed = SEED
    const form = mountWithApp(() =>
      useFormV4({
        schema,
        key: `original-async-v4-${Math.random()}`,
        defaultValues: () => Promise.resolve(load),
      })
    )
    await form.activate()
    expect(form.fields('rows').original).toEqual(SEED.rows)
    expect(form.fields('rows.1').original).toEqual(ROW_B)
    form.swap('rows', 0, 1)
    load = { ...SEED, rows: [{ n: 'r', items: [] }, ROW_C] }
    await form.rehydrate()
    expect(form.fields('rows').original).toEqual([{ n: 'r', items: [] }, ROW_C])
    expect(form.fields('rows.0').original).toEqual({ n: 'r', items: [] })
    expect(form.fields('rows.1').original).toEqual(ROW_C)
    expect(form.fields('rows').dirty).toBe(false)
  })

  it('a hydrated client reads the baseline its defaults give', async () => {
    const key = `original-ssr-v4-${Math.random()}`
    const useSeeded = () => useFormV4({ schema, key, defaultValues: SEED })
    const Server = defineComponent({
      setup() {
        const form = useSeeded()
        form.setValue('rows.1.n', 'server')
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(Server).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    const payload = JSON.parse(JSON.stringify(renderAttaformState(ssrApp)))
    const handle: { form?: ReturnType<typeof useSeeded> } = {}
    const Client = defineComponent({
      setup() {
        handle.form = useSeeded()
        return () => h('div')
      },
    })
    const clientApp = createApp(Client).use(createAttaform())
    hydrateAttaformState(clientApp, payload)
    clientApp.mount(document.createElement('div'))
    apps.push(clientApp)
    const form = handle.form
    expect(form?.values.rows[1]?.n).toBe('server')
    expect(form?.fields('rows.1').original).toEqual(ROW_B)
    expect(form?.fields('rows.1').dirty).toBe(true)
    expect(form?.fields('rows').original).toEqual(SEED.rows)
  })
})
